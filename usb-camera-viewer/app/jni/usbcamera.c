/*
 * JNI bridge for UvcCamera.java. Opens a UVC camera from the file descriptor that Android's
 * UsbManager gives the app (libuvc's uvc_wrap over libusb_wrap_sys_device) and draws its frames
 * on a Surface. MJPEG frames are decoded with AImageDecoder, YUYV is converted here. Also reads
 * and sets the camera's UVC controls (brightness, focus, ...) and copies the last frame out for
 * a snapshot.
 */
#include <jni.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <android/bitmap.h>
#include <android/imagedecoder.h>
#include <android/log.h>
#include <android/native_window_jni.h>

#include <libusb.h>
#include <libuvc/libuvc.h>
/* For devh->info->stream_ifs (libuvc's public API lists the formats of the first streaming
 * interface only, uvc_get_format_descs), and devh->usb_devh for control transfers with a
 * timeout (libuvc's own control calls wait forever). */
#include <libuvc/libuvc_internal.h>

#define TAG "usbcamera"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)

/* Mode kinds, as in Modes.java. */
enum { KIND_MJPEG = 0, KIND_YUYV = 1 };

typedef struct {
    uvc_context_t *ctx;
    uvc_device_handle_t *devh;
    int kind, width, height;
    /* Guards rgba and have_frame: the frame thread decodes into rgba, snapshot copies it out. */
    pthread_mutex_t frame_lock;
    uint8_t *rgba;  /* the decoded frame, width * height * 4 */
    int have_frame; /* rgba holds a whole decoded frame */
} camera;

/* The Surface is global so the UI thread can swap it while the worker opens or closes a camera. */
static pthread_mutex_t window_lock = PTHREAD_MUTEX_INITIALIZER;
static ANativeWindow *window;
static int window_w, window_h; /* buffer size last set on window */

static atomic_int frames_received, frames_shown, frames_bad;

static void throw_io(JNIEnv *env, const char *what, int err) {
    char msg[160];
    snprintf(msg, sizeof msg, "%s: %s (%d)", what, uvc_strerror(err), err);
    LOGW("%s", msg);
    jclass io = (*env)->FindClass(env, "java/io/IOException");
    if (io) (*env)->ThrowNew(env, io, msg);
}

/* Counts a dropped frame. Logs the first five, then every power of two, so a broken stream
 * does not flood logcat. */
static void bad_frame(const char *fmt, ...) {
    int n = atomic_fetch_add(&frames_bad, 1) + 1;
    if (n > 5 && (n & (n - 1)) != 0) return;
    char msg[160];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    LOGW("bad frame %d: %s", n, msg);
}

static int decode_mjpeg(camera *cam, const uvc_frame_t *frame) {
    AImageDecoder *dec;
    int r = AImageDecoder_createFromBuffer(frame->data, frame->data_bytes, &dec);
    if (r != ANDROID_IMAGE_DECODER_SUCCESS) {
        bad_frame("AImageDecoder_createFromBuffer %d (%zu bytes)", r, frame->data_bytes);
        return 0;
    }
    const AImageDecoderHeaderInfo *info = AImageDecoder_getHeaderInfo(dec);
    int w = AImageDecoderHeaderInfo_getWidth(info), h = AImageDecoderHeaderInfo_getHeight(info);
    if (w != cam->width || h != cam->height) {
        AImageDecoder_delete(dec);
        bad_frame("JPEG is %dx%d, the mode is %dx%d", w, h, cam->width, cam->height);
        return 0;
    }
    size_t stride = (size_t) cam->width * 4;
    r = AImageDecoder_setAndroidBitmapFormat(dec, ANDROID_BITMAP_FORMAT_RGBA_8888);
    if (r == ANDROID_IMAGE_DECODER_SUCCESS)
        r = AImageDecoder_decodeImage(dec, cam->rgba, stride, stride * cam->height);
    AImageDecoder_delete(dec);
    if (r != ANDROID_IMAGE_DECODER_SUCCESS) {
        bad_frame("AImageDecoder_decodeImage %d (%zu bytes)", r, frame->data_bytes);
        return 0;
    }
    return 1;
}

static inline uint8_t clamp8(int v) { return v < 0 ? 0 : v > 255 ? 255 : (uint8_t) v; }

/* YUYV (Y0 U Y1 V per two pixels) to RGBA, BT.601 limited range. */
static int decode_yuyv(camera *cam, const uvc_frame_t *frame) {
    size_t need = (size_t) cam->width * cam->height * 2;
    if (frame->data_bytes < need) {
        bad_frame("YUYV frame has %zu of %zu bytes", frame->data_bytes, need);
        return 0;
    }
    const uint8_t *s = frame->data;
    uint8_t *d = cam->rgba;
    /* Whole 4-byte pairs only: with an odd width * height, need is not a multiple of 4, and a
     * last partial pair would read past the frame and write 4 bytes past rgba. */
    for (size_t i = 0; i + 4 <= need; i += 4, d += 8) {
        int u = s[i + 1] - 128, v = s[i + 3] - 128;
        int r = 409 * v + 128, g = -100 * u - 208 * v + 128, b = 516 * u + 128;
        for (int k = 0; k < 2; k++) {
            int y = 298 * (s[i + 2 * k] - 16);
            d[4 * k] = clamp8((y + r) >> 8);
            d[4 * k + 1] = clamp8((y + g) >> 8);
            d[4 * k + 2] = clamp8((y + b) >> 8);
            d[4 * k + 3] = 255;
        }
    }
    return 1;
}

/* Copies the decoded frame to the Surface. Call with frame_lock held. */
static void draw(camera *cam) {
    pthread_mutex_lock(&window_lock);
    if (window) {
        /* The compositor scales the buffer to the SurfaceView, which keeps the aspect ratio. */
        if (window_w != cam->width || window_h != cam->height) {
            ANativeWindow_setBuffersGeometry(window, cam->width, cam->height, WINDOW_FORMAT_RGBA_8888);
            window_w = cam->width;
            window_h = cam->height;
        }
        ANativeWindow_Buffer buf;
        if (ANativeWindow_lock(window, &buf, NULL) == 0) {
            if (buf.format == WINDOW_FORMAT_RGBA_8888 || buf.format == WINDOW_FORMAT_RGBX_8888) {
                int rows = buf.height < cam->height ? buf.height : cam->height;
                int cols = buf.width < cam->width ? buf.width : cam->width;
                for (int y = 0; y < rows; y++)
                    memcpy((uint8_t *) buf.bits + (size_t) y * buf.stride * 4,
                           cam->rgba + (size_t) y * cam->width * 4, (size_t) cols * 4);
                atomic_fetch_add(&frames_shown, 1);
            }
            ANativeWindow_unlockAndPost(window);
        }
    }
    pthread_mutex_unlock(&window_lock);
}

/* libuvc's frame thread. libuvc hands over only the newest frame, so a slow decode skips frames
 * instead of queueing them. */
static void on_frame(uvc_frame_t *frame, void *user) {
    camera *cam = user;
    atomic_fetch_add(&frames_received, 1);
    pthread_mutex_lock(&cam->frame_lock);
    /* A failed decode may leave rgba half written, so it no longer counts as a frame. */
    cam->have_frame = cam->kind == KIND_MJPEG ? decode_mjpeg(cam, frame) : decode_yuyv(cam, frame);
    if (cam->have_frame) draw(cam);
    pthread_mutex_unlock(&cam->frame_lock);
}

JNIEXPORT jlong JNICALL
Java_com_tomerg_usbcamera_UvcCamera_open(JNIEnv *env, jclass cls, jint fd) {
    (void) cls;
    /* Apps cannot list /dev/bus/usb: libusb must use only the fd that UsbManager opened. */
    libusb_set_option(NULL, LIBUSB_OPTION_NO_DEVICE_DISCOVERY);
    libusb_set_option(NULL, LIBUSB_OPTION_LOG_LEVEL, LIBUSB_LOG_LEVEL_WARNING);

    camera *cam = calloc(1, sizeof *cam);
    if (!cam) {
        throw_io(env, "calloc", UVC_ERROR_NO_MEM);
        return 0;
    }
    pthread_mutex_init(&cam->frame_lock, NULL);
    const char *what = "uvc_init";
    uvc_error_t r = uvc_init(&cam->ctx, NULL);
    if (r == UVC_SUCCESS) {
        what = "uvc_wrap";
        r = uvc_wrap(fd, cam->ctx, &cam->devh);
        if (r == UVC_SUCCESS) return (jlong) (intptr_t) cam;
        uvc_exit(cam->ctx);
    }
    pthread_mutex_destroy(&cam->frame_lock);
    free(cam);
    throw_io(env, what, r);
    return 0;
}

/* Writes {kind, width, height, fps} for each MJPEG or YUYV frame size into out (when not NULL),
 * at the size's highest frame rate. Returns the number of ints. Reads every streaming interface,
 * as uvc_get_stream_ctrl_format_size searches them all. A camera with none has no modes. */
static int list_modes(camera *cam, jint *out) {
    int n = 0;
    for (const uvc_streaming_interface_t *sif = cam->devh->info->stream_ifs; sif; sif = sif->next) {
        for (const uvc_format_desc_t *fmt = sif->format_descs; fmt; fmt = fmt->next) {
            int kind;
            if (fmt->bDescriptorSubtype == UVC_VS_FORMAT_MJPEG)
                kind = KIND_MJPEG;
            else if (fmt->bDescriptorSubtype == UVC_VS_FORMAT_UNCOMPRESSED
                     && uvc_frame_format_for_guid((uint8_t *) fmt->guidFormat) == UVC_FRAME_FORMAT_YUYV)
                kind = KIND_YUYV;
            else
                continue;
            for (const uvc_frame_desc_t *fr = fmt->frame_descs; fr; fr = fr->next) {
                /* YUYV packs two pixels in 4 bytes, so an odd width is not a valid YUYV frame. */
                if (kind == KIND_YUYV && fr->wWidth % 2) continue;
                /* Discrete intervals come as a zero-terminated list, continuous ones as min / max. */
                uint32_t shortest = fr->intervals ? 0 : fr->dwMinFrameInterval;
                for (const uint32_t *iv = fr->intervals; iv && *iv; iv++)
                    if (!shortest || *iv < shortest) shortest = *iv;
                if (!shortest) continue;
                if (out) {
                    out[n] = kind;
                    out[n + 1] = fr->wWidth;
                    out[n + 2] = fr->wHeight;
                    /* The same rounding uvc_get_stream_ctrl_format_size matches against. */
                    out[n + 3] = (jint) (10000000 / shortest);
                }
                n += 4;
            }
        }
    }
    return n;
}

JNIEXPORT jintArray JNICALL
Java_com_tomerg_usbcamera_UvcCamera_modes(JNIEnv *env, jclass cls, jlong handle) {
    (void) cls;
    camera *cam = (camera *) (intptr_t) handle;
    int n = list_modes(cam, NULL);
    jintArray out = (*env)->NewIntArray(env, n);
    if (!out) return NULL;
    jint *p = (*env)->GetIntArrayElements(env, out, NULL);
    if (!p) return NULL;
    list_modes(cam, p);
    (*env)->ReleaseIntArrayElements(env, out, p, 0);
    return out;
}

JNIEXPORT void JNICALL
Java_com_tomerg_usbcamera_UvcCamera_start(JNIEnv *env, jclass cls, jlong handle, jint kind,
                                          jint width, jint height, jint fps) {
    (void) cls;
    camera *cam = (camera *) (intptr_t) handle;
    if (cam->rgba) {
        throw_io(env, "start called twice", UVC_ERROR_BUSY);
        return;
    }
    uvc_stream_ctrl_t ctrl;
    uvc_error_t r = uvc_get_stream_ctrl_format_size(
        cam->devh, &ctrl, kind == KIND_MJPEG ? UVC_FRAME_FORMAT_MJPEG : UVC_FRAME_FORMAT_YUYV,
        width, height, fps);
    if (r != UVC_SUCCESS) {
        throw_io(env, "uvc_get_stream_ctrl_format_size", r);
        return;
    }
    LOGI("%s %dx%d %d fps: interface %d, frames up to %u bytes, %u bytes per packet",
         kind == KIND_MJPEG ? "MJPEG" : "YUYV", width, height, fps, ctrl.bInterfaceNumber,
         ctrl.dwMaxVideoFrameSize, ctrl.dwMaxPayloadTransferSize);

    cam->rgba = malloc((size_t) width * height * 4);
    if (!cam->rgba) {
        throw_io(env, "malloc", UVC_ERROR_NO_MEM);
        return;
    }
    cam->kind = kind;
    cam->width = width;
    cam->height = height;
    atomic_store(&frames_received, 0);
    atomic_store(&frames_shown, 0);
    atomic_store(&frames_bad, 0);
    r = uvc_start_streaming(cam->devh, &ctrl, on_frame, cam, 0);
    if (r != UVC_SUCCESS) throw_io(env, "uvc_start_streaming", r);
}

JNIEXPORT void JNICALL
Java_com_tomerg_usbcamera_UvcCamera_close(JNIEnv *env, jclass cls, jlong handle) {
    (void) env;
    (void) cls;
    camera *cam = (camera *) (intptr_t) handle;
    uvc_close(cam->devh); /* stops the stream and joins its threads first */
    uvc_exit(cam->ctx);
    pthread_mutex_destroy(&cam->frame_lock);
    free(cam->rgba);
    free(cam);
}

JNIEXPORT jboolean JNICALL
Java_com_tomerg_usbcamera_UvcCamera_snapshot(JNIEnv *env, jclass cls, jlong handle, jobject bitmap) {
    (void) cls;
    camera *cam = (camera *) (intptr_t) handle;
    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS
        || info.format != ANDROID_BITMAP_FORMAT_RGBA_8888
        || (int) info.width != cam->width || (int) info.height != cam->height)
        return JNI_FALSE;
    void *px;
    if (AndroidBitmap_lockPixels(env, bitmap, &px) != ANDROID_BITMAP_RESULT_SUCCESS) return JNI_FALSE;
    pthread_mutex_lock(&cam->frame_lock);
    int ok = cam->have_frame;
    if (ok)
        for (int y = 0; y < cam->height; y++)
            memcpy((uint8_t *) px + (size_t) y * info.stride,
                   cam->rgba + (size_t) y * cam->width * 4, (size_t) cam->width * 4);
    pthread_mutex_unlock(&cam->frame_lock);
    AndroidBitmap_unlockPixels(env, bitmap);
    return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_tomerg_usbcamera_UvcCamera_setSurface(JNIEnv *env, jclass cls, jobject surface) {
    (void) cls;
    ANativeWindow *next = surface ? ANativeWindow_fromSurface(env, surface) : NULL;
    pthread_mutex_lock(&window_lock);
    if (window) ANativeWindow_release(window);
    window = next;
    window_w = window_h = 0;
    pthread_mutex_unlock(&window_lock);
}

JNIEXPORT jintArray JNICALL
Java_com_tomerg_usbcamera_UvcCamera_stats(JNIEnv *env, jclass cls) {
    (void) cls;
    jint s[3] = {atomic_load(&frames_received), atomic_load(&frames_shown), atomic_load(&frames_bad)};
    jintArray out = (*env)->NewIntArray(env, 3);
    if (out) (*env)->SetIntArrayRegion(env, out, 0, 3, s);
    return out;
}

/* ---- UVC controls ------------------------------------------------------------------------ */

/* Control kinds. Java sees a switch as 0 / 1, auto exposure as 1 = auto, 0 = manual. */
enum { CTRL_RANGE, CTRL_RANGE_SIGNED, CTRL_SWITCH, CTRL_POWER_LINE, CTRL_AE_MODE };

typedef struct {
    uint8_t camera_terminal; /* 1: the camera terminal serves it, 0: the processing unit */
    uint8_t selector;
    uint8_t bit;             /* its bit in the unit's bmControls */
    uint8_t size;            /* bytes on the wire */
    uint8_t kind;
} control_info;

/* Index = control id in Controls.java, so keep both in the same order. Bits and sizes are those
 * of the Linux uvcvideo driver's control table (uvc_ctrl.c), which follows UVC 1.5 tables 3-6
 * and 3-8. Range controls answer GET_MIN, GET_MAX, GET_RES, GET_DEF; switches and power line
 * frequency only GET_DEF; auto exposure GET_DEF and GET_RES (the bitmap of its modes). */
static const control_info control_table[] = {
    {1, UVC_CT_AE_MODE_CONTROL, 1, 1, CTRL_AE_MODE},
    {1, UVC_CT_EXPOSURE_TIME_ABSOLUTE_CONTROL, 3, 4, CTRL_RANGE},
    {0, UVC_PU_GAIN_CONTROL, 9, 2, CTRL_RANGE},
    {0, UVC_PU_BRIGHTNESS_CONTROL, 0, 2, CTRL_RANGE_SIGNED},
    {0, UVC_PU_CONTRAST_CONTROL, 1, 2, CTRL_RANGE},
    {0, UVC_PU_SATURATION_CONTROL, 3, 2, CTRL_RANGE},
    {0, UVC_PU_HUE_CONTROL, 2, 2, CTRL_RANGE_SIGNED},
    {0, UVC_PU_SHARPNESS_CONTROL, 4, 2, CTRL_RANGE},
    {0, UVC_PU_GAMMA_CONTROL, 5, 2, CTRL_RANGE},
    {0, UVC_PU_BACKLIGHT_COMPENSATION_CONTROL, 8, 2, CTRL_RANGE},
    {0, UVC_PU_WHITE_BALANCE_TEMPERATURE_AUTO_CONTROL, 12, 1, CTRL_SWITCH},
    {0, UVC_PU_WHITE_BALANCE_TEMPERATURE_CONTROL, 6, 2, CTRL_RANGE},
    {0, UVC_PU_POWER_LINE_FREQUENCY_CONTROL, 10, 1, CTRL_POWER_LINE},
    {1, UVC_CT_FOCUS_AUTO_CONTROL, 17, 1, CTRL_SWITCH},
    {1, UVC_CT_FOCUS_ABSOLUTE_CONTROL, 5, 2, CTRL_RANGE},
    {1, UVC_CT_ZOOM_ABSOLUTE_CONTROL, 9, 2, CTRL_RANGE},
};
#define N_CONTROLS ((int) (sizeof control_table / sizeof control_table[0]))

/* Auto exposure modes (UVC 1.5 table 4-15). */
enum { AE_MANUAL = 1, AE_AUTO = 2, AE_SHUTTER = 4, AE_APERTURE = 8 };

#define CTRL_TIMEOUT_MS 1000

/* The id of the terminal or unit that serves c, or -1 when the camera does not declare c. */
static int control_unit(camera *cam, const control_info *c) {
    uint64_t bits;
    int id;
    if (c->camera_terminal) {
        const uvc_input_terminal_t *t = uvc_get_camera_terminal(cam->devh);
        if (!t) return -1;
        bits = t->bmControls;
        id = t->bTerminalID;
    } else {
        const uvc_processing_unit_t *p = uvc_get_processing_units(cam->devh);
        if (!p) return -1;
        bits = p->bmControls;
        id = p->bUnitID;
    }
    return (bits >> c->bit) & 1 ? id : -1;
}

static int32_t ctrl_decode(const control_info *c, const uint8_t *d) {
    switch (c->size) {
    case 1: return d[0];
    case 2: {
        uint16_t v = (uint16_t) (d[0] | d[1] << 8);
        return c->kind == CTRL_RANGE_SIGNED ? (int16_t) v : v;
    }
    default: {
        uint32_t v = (uint32_t) d[0] | (uint32_t) d[1] << 8 | (uint32_t) d[2] << 16 | (uint32_t) d[3] << 24;
        return v > INT32_MAX ? INT32_MAX : (int32_t) v;
    }
    }
}

static void ctrl_encode(const control_info *c, int32_t v, uint8_t *d) {
    for (int i = 0; i < c->size; i++) d[i] = (uint8_t) ((uint32_t) v >> (8 * i));
}

/* One GET_* request. Returns 0, or a libusb error. */
static int ctrl_get(camera *cam, const control_info *c, int unit, uint8_t req, int32_t *value) {
    uint8_t d[4] = {0};
    int r = libusb_control_transfer(cam->devh->usb_devh, 0xa1, req, c->selector << 8,
                                    unit << 8 | cam->devh->info->ctrl_if.bInterfaceNumber, d,
                                    c->size, CTRL_TIMEOUT_MS);
    if (r < 0) return r;
    if (r != c->size) return LIBUSB_ERROR_IO;
    *value = ctrl_decode(c, d);
    return 0;
}

static int ctrl_set(camera *cam, const control_info *c, int unit, int32_t value) {
    uint8_t d[4];
    ctrl_encode(c, value, d);
    int r = libusb_control_transfer(cam->devh->usb_devh, 0x21, UVC_SET_CUR, c->selector << 8,
                                    unit << 8 | cam->devh->info->ctrl_if.bInterfaceNumber, d,
                                    c->size, CTRL_TIMEOUT_MS);
    if (r < 0) return r;
    return r == c->size ? 0 : LIBUSB_ERROR_IO;
}

/* The mode to set for "auto": the default if it is an auto mode, else aperture priority (auto
 * exposure time, the usual one on webcams), else full auto. 0 when the camera has neither. */
static int ae_auto_mode(int32_t modes, int32_t def) {
    if (def == AE_APERTURE || def == AE_AUTO) return def;
    if (modes & AE_APERTURE) return AE_APERTURE;
    if (modes & AE_AUTO) return AE_AUTO;
    return 0;
}

static int32_t ae_is_auto(int32_t mode) { return (mode & (AE_AUTO | AE_APERTURE)) ? 1 : 0; }

/* The current value as Java sees it. Returns 0, or a libusb error. */
static int ctrl_current(camera *cam, const control_info *c, int unit, int32_t *value) {
    int r = ctrl_get(cam, c, unit, UVC_GET_CUR, value);
    if (r) return r;
    if (c->kind == CTRL_AE_MODE) *value = ae_is_auto(*value);
    else if (c->kind == CTRL_SWITCH) *value = *value != 0;
    return 0;
}

/* Fills {min, max, step, def, cur} as Java sees them. Returns 0, or a libusb error, or 1 when
 * the camera answers but the control is of no use (an empty range, no manual and no auto). */
static int ctrl_describe(camera *cam, const control_info *c, int unit, int32_t *out) {
    int32_t min = 0, max = 1, res = 1, def = 0, cur = 0;
    int r = ctrl_get(cam, c, unit, UVC_GET_DEF, &def);
    if (!r) r = ctrl_get(cam, c, unit, UVC_GET_CUR, &cur);
    if (r) return r;
    switch (c->kind) {
    case CTRL_RANGE:
    case CTRL_RANGE_SIGNED:
        r = ctrl_get(cam, c, unit, UVC_GET_MIN, &min);
        if (!r) r = ctrl_get(cam, c, unit, UVC_GET_MAX, &max);
        if (!r) r = ctrl_get(cam, c, unit, UVC_GET_RES, &res);
        if (r) return r;
        if (res <= 0) res = 1;
        if (max <= min) return 1;
        break;
    case CTRL_SWITCH:
        def = def != 0;
        cur = cur != 0;
        break;
    case CTRL_POWER_LINE:
        /* 0 off, 1 50 Hz, 2 60 Hz; UVC 1.5 adds 3 auto. Not every camera takes every value. */
        max = cam->devh->info->ctrl_if.bcdUVC >= 0x0150 ? 3 : 2;
        break;
    case CTRL_AE_MODE: {
        int32_t modes;
        r = ctrl_get(cam, c, unit, UVC_GET_RES, &modes);
        if (r) return r;
        min = (modes & AE_MANUAL) ? 0 : 1;
        max = ae_auto_mode(modes, def) ? 1 : 0;
        if (max < min) return 1;
        def = ae_is_auto(def);
        cur = ae_is_auto(cur);
        break;
    }
    }
    out[0] = min;
    out[1] = max;
    out[2] = res;
    out[3] = def;
    out[4] = cur;
    return 0;
}

/* Writes {id, min, max, step, def, cur} for each control the camera declares and answers into
 * out, which has room for all N_CONTROLS. Returns the number of ints. */
static int list_controls(camera *cam, jint *out) {
    int n = 0;
    for (int id = 0; id < N_CONTROLS; id++) {
        const control_info *c = &control_table[id];
        int unit = control_unit(cam, c);
        if (unit < 0) continue;
        int32_t v[5];
        int r = ctrl_describe(cam, c, unit, v);
        if (r) {
            LOGW("control %d (unit %d, selector %d) is declared but not usable: %d", id, unit, c->selector, r);
            continue;
        }
        out[n] = id;
        for (int i = 0; i < 5; i++) out[n + 1 + i] = v[i];
        n += 6;
    }
    return n;
}

JNIEXPORT jintArray JNICALL
Java_com_tomerg_usbcamera_UvcCamera_controls(JNIEnv *env, jclass cls, jlong handle) {
    (void) cls;
    camera *cam = (camera *) (intptr_t) handle;
    jint buf[N_CONTROLS * 6];
    int n = list_controls(cam, buf);
    jintArray out = (*env)->NewIntArray(env, n);
    if (out) (*env)->SetIntArrayRegion(env, out, 0, n, buf);
    return out;
}

/* The control's unit, or -1 after throwing IOException. */
static int checked_unit(JNIEnv *env, camera *cam, jint id) {
    if (id < 0 || id >= N_CONTROLS) {
        throw_io(env, "no such control", UVC_ERROR_INVALID_PARAM);
        return -1;
    }
    int unit = control_unit(cam, &control_table[id]);
    if (unit < 0) throw_io(env, "the camera does not have this control", UVC_ERROR_NOT_SUPPORTED);
    return unit;
}

JNIEXPORT jint JNICALL
Java_com_tomerg_usbcamera_UvcCamera_getControl(JNIEnv *env, jclass cls, jlong handle, jint id) {
    (void) cls;
    camera *cam = (camera *) (intptr_t) handle;
    int unit = checked_unit(env, cam, id);
    if (unit < 0) return 0;
    int32_t v = 0;
    int r = ctrl_current(cam, &control_table[id], unit, &v);
    if (r) throw_io(env, "GET_CUR", r);
    return v;
}

JNIEXPORT jint JNICALL
Java_com_tomerg_usbcamera_UvcCamera_setControl(JNIEnv *env, jclass cls, jlong handle, jint id, jint value) {
    (void) cls;
    camera *cam = (camera *) (intptr_t) handle;
    int unit = checked_unit(env, cam, id);
    if (unit < 0) return 0;
    const control_info *c = &control_table[id];
    int32_t wire = value;
    int r = 0;
    if (c->kind == CTRL_AE_MODE) {
        int32_t modes, def;
        r = ctrl_get(cam, c, unit, UVC_GET_RES, &modes);
        if (!r) r = ctrl_get(cam, c, unit, UVC_GET_DEF, &def);
        if (r) {
            throw_io(env, "auto exposure modes", r);
            return 0;
        }
        wire = value ? ae_auto_mode(modes, def) : AE_MANUAL;
    } else if (c->kind == CTRL_SWITCH) {
        wire = value != 0;
    }
    r = ctrl_set(cam, c, unit, wire);
    if (r) {
        throw_io(env, "SET_CUR", r);
        return 0;
    }
    int32_t now = 0;
    r = ctrl_current(cam, c, unit, &now);
    if (r) throw_io(env, "GET_CUR", r);
    return now;
}
