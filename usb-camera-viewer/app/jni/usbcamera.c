/*
 * JNI bridge for UvcCamera.java. Opens a UVC camera from the file descriptor that Android's
 * UsbManager gives the app (libuvc's uvc_wrap over libusb_wrap_sys_device) and draws its frames
 * on a Surface. MJPEG frames are decoded with AImageDecoder, YUYV is converted here.
 */
#include <jni.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <android/imagedecoder.h>
#include <android/log.h>
#include <android/native_window_jni.h>

#include <libusb.h>
#include <libuvc/libuvc.h>
/* For devh->info->stream_ifs: libuvc's public API lists the formats of the first streaming
 * interface only (uvc_get_format_descs). */
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
    uint8_t *rgba; /* the decoded frame, width * height * 4; only the frame thread uses it */
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

/* libuvc's frame thread. libuvc hands over only the newest frame, so a slow decode skips frames
 * instead of queueing them. */
static void on_frame(uvc_frame_t *frame, void *user) {
    camera *cam = user;
    atomic_fetch_add(&frames_received, 1);
    if (!(cam->kind == KIND_MJPEG ? decode_mjpeg(cam, frame) : decode_yuyv(cam, frame))) return;

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
    const char *what = "uvc_init";
    uvc_error_t r = uvc_init(&cam->ctx, NULL);
    if (r == UVC_SUCCESS) {
        what = "uvc_wrap";
        r = uvc_wrap(fd, cam->ctx, &cam->devh);
        if (r == UVC_SUCCESS) return (jlong) (intptr_t) cam;
        uvc_exit(cam->ctx);
    }
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
    free(cam->rgba);
    free(cam);
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
