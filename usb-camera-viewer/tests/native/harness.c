/*
 * Host test of app/jni/usbcamera.c: compiles it on the build machine with stub Android headers,
 * stub libuvc / libusb calls and a fake camera behind libusb_control_transfer. Checks the UVC
 * control list, value encoding, auto exposure modes, error paths, the snapshot copy and the
 * frame lock. Run with tests/native.sh (ASan and UBSan on).
 */
#include "../../app/jni/usbcamera.c"

#include <stdarg.h>

static int failures, checks;

#define CHECK(ok, ...)                                    \
    do {                                                  \
        checks++;                                         \
        if (!(ok)) {                                      \
            failures++;                                   \
            printf("FAIL line %d: ", __LINE__);           \
            printf(__VA_ARGS__);                          \
            printf("\n");                                 \
        }                                                 \
    } while (0)

/* ---- Stubs ------------------------------------------------------------------------------- */

int __android_log_print(int prio, const char *tag, const char *fmt, ...) {
    (void) prio;
    (void) tag;
    (void) fmt;
    return 0;
}

int AImageDecoder_createFromBuffer(const void *buffer, size_t length, AImageDecoder **out) {
    (void) buffer;
    (void) length;
    (void) out;
    return ANDROID_IMAGE_DECODER_BAD_PARAMETER; /* every MJPEG frame is bad here */
}
const AImageDecoderHeaderInfo *AImageDecoder_getHeaderInfo(const AImageDecoder *d) { (void) d; return NULL; }
int32_t AImageDecoderHeaderInfo_getWidth(const AImageDecoderHeaderInfo *i) { (void) i; return 0; }
int32_t AImageDecoderHeaderInfo_getHeight(const AImageDecoderHeaderInfo *i) { (void) i; return 0; }
int AImageDecoder_setAndroidBitmapFormat(AImageDecoder *d, int32_t f) { (void) d; (void) f; return -1; }
int AImageDecoder_decodeImage(AImageDecoder *d, void *p, size_t s, size_t n) { (void) d; (void) p; (void) s; (void) n; return -1; }
void AImageDecoder_delete(AImageDecoder *d) { (void) d; }

/* A window whose rows are 3 pixels longer than asked, so the stride matters. */
static struct {
    int width, height, stride, posts, released;
    uint8_t *bits;
} win;
ANativeWindow *ANativeWindow_fromSurface(JNIEnv *env, jobject surface) {
    (void) env;
    return surface ? (ANativeWindow *) &win : NULL;
}
void ANativeWindow_release(ANativeWindow *w) { (void) w; win.released++; }
int32_t ANativeWindow_setBuffersGeometry(ANativeWindow *w, int32_t width, int32_t height, int32_t format) {
    (void) w;
    (void) format;
    free(win.bits);
    win.width = width;
    win.height = height;
    win.stride = width + 3;
    win.bits = calloc((size_t) win.stride * height * 4, 1);
    return 0;
}
int32_t ANativeWindow_lock(ANativeWindow *w, ANativeWindow_Buffer *b, ARect *dirty) {
    (void) w;
    (void) dirty;
    if (!win.bits) return -1;
    memset(b, 0, sizeof *b);
    b->width = win.width;
    b->height = win.height;
    b->stride = win.stride;
    b->format = WINDOW_FORMAT_RGBA_8888;
    b->bits = win.bits;
    return 0;
}
int32_t ANativeWindow_unlockAndPost(ANativeWindow *w) { (void) w; win.posts++; return 0; }

/* A bitmap is a jobject pointing at one of these. */
typedef struct {
    AndroidBitmapInfo info;
    uint8_t *pixels;
    int locked;
} fake_bitmap;
int AndroidBitmap_getInfo(JNIEnv *env, jobject bitmap, AndroidBitmapInfo *info) {
    (void) env;
    *info = ((fake_bitmap *) bitmap)->info;
    return ANDROID_BITMAP_RESULT_SUCCESS;
}
int AndroidBitmap_lockPixels(JNIEnv *env, jobject bitmap, void **addr) {
    (void) env;
    fake_bitmap *b = (fake_bitmap *) bitmap;
    b->locked++;
    *addr = b->pixels;
    return ANDROID_BITMAP_RESULT_SUCCESS;
}
int AndroidBitmap_unlockPixels(JNIEnv *env, jobject bitmap) {
    (void) env;
    ((fake_bitmap *) bitmap)->locked--;
    return ANDROID_BITMAP_RESULT_SUCCESS;
}

/* libuvc: only what usbcamera.c calls. */
static uvc_device_info_t dev_info;
static uvc_device_handle_t dev_handle;
static uvc_input_terminal_t *test_term;
static uvc_processing_unit_t *test_pu;
const char *uvc_strerror(uvc_error_t err) { (void) err; return "error"; }
enum uvc_frame_format uvc_frame_format_for_guid(uint8_t guid[16]) { (void) guid; return UVC_FRAME_FORMAT_UNKNOWN; }
uvc_error_t uvc_get_stream_ctrl_format_size(uvc_device_handle_t *devh, uvc_stream_ctrl_t *ctrl,
                                            enum uvc_frame_format format, int width, int height, int fps) {
    (void) devh; (void) format; (void) width; (void) height; (void) fps;
    memset(ctrl, 0, sizeof *ctrl);
    return UVC_SUCCESS;
}
uvc_error_t uvc_start_streaming(uvc_device_handle_t *devh, uvc_stream_ctrl_t *ctrl,
                                uvc_frame_callback_t *cb, void *user, uint8_t flags) {
    (void) devh; (void) ctrl; (void) cb; (void) user; (void) flags;
    return UVC_SUCCESS;
}
uvc_error_t uvc_init(uvc_context_t **ctx, struct libusb_context *usb_ctx) {
    (void) usb_ctx;
    *ctx = (uvc_context_t *) &dev_info; /* never dereferenced */
    return UVC_SUCCESS;
}
uvc_error_t uvc_wrap(int fd, uvc_context_t *context, uvc_device_handle_t **devh) {
    (void) fd;
    (void) context;
    *devh = &dev_handle;
    return UVC_SUCCESS;
}
void uvc_exit(uvc_context_t *ctx) { (void) ctx; }
void uvc_close(uvc_device_handle_t *devh) { (void) devh; }
const uvc_input_terminal_t *uvc_get_camera_terminal(uvc_device_handle_t *devh) { (void) devh; return test_term; }
const uvc_processing_unit_t *uvc_get_processing_units(uvc_device_handle_t *devh) { (void) devh; return test_pu; }
int LIBUSB_CALLV libusb_set_option(libusb_context *ctx, enum libusb_option option, ...) {
    (void) ctx;
    (void) option;
    return 0;
}

/* ---- The fake camera's controls -------------------------------------------------------- */

#define CT_ID 1
#define PU_ID 2
#define IFNUM 3

typedef struct {
    int unit, selector, size, is_signed;
    int has_range;   /* answers GET_MIN, GET_MAX, GET_RES */
    int has_res;     /* answers GET_RES alone (auto exposure's mode bitmap) */
    int is_ae;       /* SET_CUR takes one mode bit that GET_RES lists */
    int broken;      /* stalls every request */
    int short_reply; /* answers one byte short */
    int32_t min, max, res, def, cur;
    int requests, sets;
    int32_t last_set;
} fake_ctrl;

static fake_ctrl fakes[32];
static int n_fakes, transfers, bad_timeouts, bad_interface;

static fake_ctrl *fake(int unit, int selector, int size) {
    fake_ctrl *f = &fakes[n_fakes++];
    memset(f, 0, sizeof *f);
    f->unit = unit;
    f->selector = selector;
    f->size = size;
    f->res = 1;
    return f;
}

static fake_ctrl *range(int unit, int selector, int size, int32_t min, int32_t max, int32_t res, int32_t def, int32_t cur) {
    fake_ctrl *f = fake(unit, selector, size);
    f->has_range = 1;
    f->min = min;
    f->max = max;
    f->res = res;
    f->def = def;
    f->cur = cur;
    return f;
}

static fake_ctrl *plain(int unit, int selector, int32_t def, int32_t cur) {
    fake_ctrl *f = fake(unit, selector, 1);
    f->def = def;
    f->cur = cur;
    return f;
}

static fake_ctrl *ae(int32_t modes, int32_t def, int32_t cur) {
    fake_ctrl *f = fake(CT_ID, UVC_CT_AE_MODE_CONTROL, 1);
    f->is_ae = 1;
    f->has_res = 1;
    f->res = modes;
    f->def = def;
    f->cur = cur;
    return f;
}

int LIBUSB_CALL libusb_control_transfer(libusb_device_handle *h, uint8_t type, uint8_t req, uint16_t value,
                                        uint16_t index, unsigned char *data, uint16_t len, unsigned int timeout) {
    (void) h;
    transfers++;
    if (timeout != 1000) bad_timeouts++; /* a literal: the code's macro could be wrong too */
    if ((index & 0xff) != IFNUM) bad_interface++;
    fake_ctrl *f = NULL;
    for (int i = 0; i < n_fakes; i++)
        if (fakes[i].unit == index >> 8 && fakes[i].selector == value >> 8) f = &fakes[i];
    if (!f) return LIBUSB_ERROR_PIPE;
    f->requests++;
    if (f->broken) return LIBUSB_ERROR_PIPE;
    if (len != f->size) return LIBUSB_ERROR_OVERFLOW; /* the app must ask for the right size */
    if (type == 0x21) {
        if (req != UVC_SET_CUR) return LIBUSB_ERROR_PIPE;
        uint32_t raw = 0;
        for (int i = 0; i < len; i++) raw |= (uint32_t) data[i] << (8 * i);
        int32_t v = f->is_signed ? (int16_t) raw : (int32_t) raw;
        if (f->is_ae && (!(v & f->res) || (v & (v - 1)))) return LIBUSB_ERROR_PIPE;
        if (f->has_range && (v < f->min || v > f->max)) return LIBUSB_ERROR_PIPE;
        f->cur = v;
        f->sets++;
        f->last_set = v;
        return len;
    }
    if (type != 0xa1) return LIBUSB_ERROR_INVALID_PARAM;
    int32_t v;
    switch (req) {
    case UVC_GET_CUR: v = f->cur; break;
    case UVC_GET_DEF: v = f->def; break;
    case UVC_GET_MIN: if (!f->has_range) return LIBUSB_ERROR_PIPE; v = f->min; break;
    case UVC_GET_MAX: if (!f->has_range) return LIBUSB_ERROR_PIPE; v = f->max; break;
    case UVC_GET_RES: if (!f->has_range && !f->has_res) return LIBUSB_ERROR_PIPE; v = f->res; break;
    default: return LIBUSB_ERROR_PIPE;
    }
    for (int i = 0; i < len; i++) data[i] = (uint8_t) ((uint32_t) v >> (8 * i));
    return f->short_reply ? len - 1 : len;
}

/* ---- Fake JNI ------------------------------------------------------------------------------ */

typedef struct {
    jsize n;
    jint *data;
} fake_array;

static fake_array *arrays[64];
static int n_arrays, throws;
static char thrown[256];

static jintArray JNICALL new_int_array(JNIEnv *env, jsize n) {
    (void) env;
    fake_array *a = calloc(1, sizeof *a);
    a->n = n;
    a->data = calloc(n ? (size_t) n : 1, sizeof(jint));
    arrays[n_arrays++] = a;
    return (jintArray) a;
}
static void JNICALL set_int_array_region(JNIEnv *env, jintArray arr, jsize start, jsize len, const jint *buf) {
    (void) env;
    fake_array *a = (fake_array *) arr;
    if (start < 0 || len < 0 || start + len > a->n) {
        printf("FAIL SetIntArrayRegion out of bounds: %d + %d > %d\n", start, len, a->n);
        failures++;
        return;
    }
    memcpy(a->data + start, buf, (size_t) len * sizeof(jint));
}
static jint *JNICALL get_int_array_elements(JNIEnv *env, jintArray arr, jboolean *copy) {
    (void) env;
    (void) copy;
    return ((fake_array *) arr)->data;
}
static void JNICALL release_int_array_elements(JNIEnv *env, jintArray arr, jint *e, jint mode) {
    (void) env; (void) arr; (void) e; (void) mode;
}
static jclass JNICALL find_class(JNIEnv *env, const char *name) {
    (void) env;
    (void) name;
    return (jclass) &throws; /* any non-NULL pointer */
}
static jint JNICALL throw_new(JNIEnv *env, jclass cls, const char *msg) {
    (void) env;
    (void) cls;
    throws++;
    snprintf(thrown, sizeof thrown, "%s", msg);
    return 0;
}

static struct JNINativeInterface_ jni_table;
static JNIEnv jni = &jni_table;

/* ---- Helpers ------------------------------------------------------------------------------- */

static uvc_input_terminal_t term;
static uvc_processing_unit_t pu;

/* A camera with no units and no fake controls; tests add what they need. */
static camera *new_camera(uint16_t bcd) {
    n_fakes = 0;
    memset(&dev_info, 0, sizeof dev_info);
    memset(&dev_handle, 0, sizeof dev_handle);
    dev_info.ctrl_if.bInterfaceNumber = IFNUM;
    dev_info.ctrl_if.bcdUVC = bcd;
    dev_handle.info = &dev_info;
    dev_handle.usb_devh = (libusb_device_handle *) &dev_info; /* never dereferenced */
    memset(&term, 0, sizeof term);
    memset(&pu, 0, sizeof pu);
    term.bTerminalID = CT_ID;
    term.wTerminalType = UVC_ITT_CAMERA;
    pu.bUnitID = PU_ID;
    test_term = &term;
    test_pu = &pu;
    return (camera *) (intptr_t) Java_com_tomerg_usbcamera_UvcCamera_open(&jni, NULL, 7);
}

static fake_array *list(camera *cam) {
    return (fake_array *) Java_com_tomerg_usbcamera_UvcCamera_controls(&jni, NULL, (jlong) (intptr_t) cam);
}

/* The 5 values {min, max, step, def, cur} of control id in a list, or NULL. */
static const jint *entry(fake_array *a, int id) {
    for (int i = 0; i + 6 <= a->n; i += 6)
        if (a->data[i] == id) return &a->data[i + 1];
    return NULL;
}

static void expect_entry(fake_array *a, int id, jint min, jint max, jint step, jint def, jint cur, const char *what) {
    const jint *e = entry(a, id);
    CHECK(e != NULL, "%s: listed", what);
    if (!e) return;
    CHECK(e[0] == min && e[1] == max && e[2] == step && e[3] == def && e[4] == cur,
          "%s: got {%d, %d, %d, %d, %d}, want {%d, %d, %d, %d, %d}", what, e[0], e[1], e[2], e[3], e[4],
          min, max, step, def, cur);
}

static jint set(camera *cam, int id, int value) {
    return Java_com_tomerg_usbcamera_UvcCamera_setControl(&jni, NULL, (jlong) (intptr_t) cam, id, value);
}

static jint get(camera *cam, int id) {
    return Java_com_tomerg_usbcamera_UvcCamera_getControl(&jni, NULL, (jlong) (intptr_t) cam, id);
}

/* Ids, as in Controls.java. */
enum { AUTO_EXPOSURE, EXPOSURE, GAIN, BRIGHTNESS, CONTRAST, SATURATION, HUE, SHARPNESS, GAMMA,
       BACKLIGHT, AUTO_WB, WB, POWER_LINE, AUTOFOCUS, FOCUS, ZOOM };

static void close_camera(camera *cam) {
    Java_com_tomerg_usbcamera_UvcCamera_close(&jni, NULL, (jlong) (intptr_t) cam);
}

/* ---- Tests --------------------------------------------------------------------------------- */

static void test_autofocus_webcam(void) {
    camera *cam = new_camera(0x0100);
    /* Declared and working, except hue, gain and gamma. */
    pu.bmControls = 1u << 0 | 1u << 1 | 1u << 2 | 1u << 5 | 1u << 6 | 1u << 9 | 1u << 10 | 1u << 12;
    range(PU_ID, UVC_PU_GAMMA_CONTROL, 2, 100, 100, 1, 100, 100); /* an empty range: left out */
    term.bmControls = 1u << 1 | 1u << 3 | 1u << 5 | 1u << 17;
    fake_ctrl *bright = range(PU_ID, UVC_PU_BRIGHTNESS_CONTROL, 2, -64, 64, 1, 0, -10);
    bright->is_signed = 1;
    range(PU_ID, UVC_PU_CONTRAST_CONTROL, 2, 0, 100, 1, 50, 50);
    fake_ctrl *hue = range(PU_ID, UVC_PU_HUE_CONTROL, 2, -40, 40, 1, 0, 0);
    hue->broken = 1; /* declared, stalls: left out */
    fake_ctrl *gain = range(PU_ID, UVC_PU_GAIN_CONTROL, 2, 0, 100, 1, 0, 0);
    gain->short_reply = 1; /* declared, answers short: left out */
    range(PU_ID, UVC_PU_WHITE_BALANCE_TEMPERATURE_CONTROL, 2, 2800, 6500, 10, 4600, 4600);
    plain(PU_ID, UVC_PU_WHITE_BALANCE_TEMPERATURE_AUTO_CONTROL, 1, 1);
    plain(PU_ID, UVC_PU_POWER_LINE_FREQUENCY_CONTROL, 1, 1);
    fake_ctrl *ae_mode = ae(AE_MANUAL | AE_APERTURE, AE_APERTURE, AE_APERTURE);
    fake_ctrl *exposure = range(CT_ID, UVC_CT_EXPOSURE_TIME_ABSOLUTE_CONTROL, 4, 3, 100000, 1, 156, 250);
    range(CT_ID, UVC_CT_FOCUS_ABSOLUTE_CONTROL, 2, 0, 255, 5, 0, 30);
    plain(CT_ID, UVC_CT_FOCUS_AUTO_CONTROL, 1, 0);
    /* Present but not declared in bmControls: never asked. */
    fake_ctrl *zoom = range(CT_ID, UVC_CT_ZOOM_ABSOLUTE_CONTROL, 2, 100, 500, 1, 100, 100);
    fake_ctrl *sharp = range(PU_ID, UVC_PU_SHARPNESS_CONTROL, 2, 0, 7, 1, 3, 3);

    fake_array *a = list(cam);
    CHECK(a->n == 9 * 6, "webcam: 9 controls listed, got %d ints", a->n);
    int order[] = {AUTO_EXPOSURE, EXPOSURE, BRIGHTNESS, CONTRAST, AUTO_WB, WB, POWER_LINE, AUTOFOCUS, FOCUS};
    for (int i = 0; i < 9 && i * 6 < a->n; i++)
        CHECK(a->data[i * 6] == order[i], "webcam: entry %d is id %d, want %d", i, a->data[i * 6], order[i]);
    expect_entry(a, AUTO_EXPOSURE, 0, 1, 1, 1, 1, "auto exposure");
    expect_entry(a, EXPOSURE, 3, 100000, 1, 156, 250, "exposure");
    expect_entry(a, BRIGHTNESS, -64, 64, 1, 0, -10, "brightness (signed)");
    expect_entry(a, CONTRAST, 0, 100, 1, 50, 50, "contrast");
    expect_entry(a, AUTO_WB, 0, 1, 1, 1, 1, "auto white balance");
    expect_entry(a, WB, 2800, 6500, 10, 4600, 4600, "white balance");
    expect_entry(a, POWER_LINE, 0, 2, 1, 1, 1, "power line, UVC 1.0");
    expect_entry(a, AUTOFOCUS, 0, 1, 1, 1, 0, "autofocus");
    expect_entry(a, FOCUS, 0, 255, 5, 0, 30, "focus");
    CHECK(entry(a, HUE) == NULL && entry(a, GAIN) == NULL, "stalling and short controls left out");
    CHECK(entry(a, GAMMA) == NULL, "a control with an empty range left out");
    CHECK(zoom->requests == 0 && sharp->requests == 0, "undeclared controls never asked: %d %d",
          zoom->requests, sharp->requests);

    /* Auto exposure: 0 sends manual, 1 the auto mode the camera has. */
    int before = throws;
    CHECK(set(cam, AUTO_EXPOSURE, 0) == 0 && ae_mode->last_set == AE_MANUAL, "auto exposure off sends manual (%d)", ae_mode->last_set);
    CHECK(set(cam, AUTO_EXPOSURE, 1) == 1 && ae_mode->last_set == AE_APERTURE, "auto exposure on sends aperture priority (%d)", ae_mode->last_set);
    /* Signed and 4-byte values round trip. */
    CHECK(set(cam, BRIGHTNESS, -20) == -20 && bright->cur == -20, "brightness -20 (camera has %d)", bright->cur);
    CHECK(set(cam, EXPOSURE, 70000) == 70000 && exposure->cur == 70000, "exposure 70000 (camera has %d)", exposure->cur);
    fake_ctrl *af = NULL;
    for (int i = 0; i < n_fakes; i++)
        if (fakes[i].selector == UVC_CT_FOCUS_AUTO_CONTROL && fakes[i].unit == CT_ID) af = &fakes[i];
    CHECK(set(cam, AUTOFOCUS, 7) == 1 && af->last_set == 1, "a switch sends 0 or 1 (sent %d)", af->last_set);
    CHECK(get(cam, AUTOFOCUS) == 1, "get autofocus");
    CHECK(get(cam, AUTO_EXPOSURE) == 1, "get auto exposure");
    CHECK(throws == before, "no exception on good sets: %s", thrown);

    /* Refused and missing controls throw and do not crash. */
    before = throws;
    set(cam, BRIGHTNESS, 500);
    CHECK(throws == before + 1 && bright->cur == -20, "out of range: one exception, value kept");
    set(cam, ZOOM, 200);
    CHECK(throws == before + 2 && strstr(thrown, "does not have") && zoom->requests == 0, "undeclared zoom: %s", thrown);
    set(cam, 99, 1);
    CHECK(throws == before + 3 && strstr(thrown, "no such control"), "id 99: %s", thrown);
    set(cam, -1, 1);
    CHECK(throws == before + 4, "id -1");
    get(cam, HUE);
    CHECK(throws == before + 5, "get a stalling control throws");

    CHECK(bad_timeouts == 0, "every control transfer has the 1 s timeout (%d without)", bad_timeouts);
    CHECK(bad_interface == 0, "every control transfer names the control interface (%d wrong)", bad_interface);
    close_camera(cam);
}

static void test_power_line_uvc15(void) {
    camera *cam = new_camera(0x0150);
    pu.bmControls = 1u << 10;
    plain(PU_ID, UVC_PU_POWER_LINE_FREQUENCY_CONTROL, 1, 2);
    fake_array *a = list(cam);
    expect_entry(a, POWER_LINE, 0, 3, 1, 1, 2, "power line, UVC 1.5");
    close_camera(cam);
}

static void test_ae_modes(void) {
    struct { int32_t modes, def, cur; int listed; jint min, max, def_ui, cur_ui, auto_sent; } cases[] = {
        {AE_MANUAL | AE_AUTO, AE_MANUAL, AE_MANUAL, 1, 0, 1, 0, 0, AE_AUTO},
        {AE_MANUAL | AE_AUTO | AE_APERTURE, AE_AUTO, AE_AUTO, 1, 0, 1, 1, 1, AE_AUTO},
        {AE_MANUAL | AE_APERTURE, AE_MANUAL, AE_APERTURE, 1, 0, 1, 0, 1, AE_APERTURE},
        {AE_MANUAL | AE_AUTO | AE_APERTURE, AE_MANUAL, AE_MANUAL, 1, 0, 1, 0, 0, AE_APERTURE},
        {AE_APERTURE, AE_APERTURE, AE_APERTURE, 1, 1, 1, 1, 1, AE_APERTURE}, /* auto only */
        {AE_MANUAL, AE_MANUAL, AE_MANUAL, 1, 0, 0, 0, 0, 0},                 /* manual only */
        {AE_SHUTTER, AE_SHUTTER, AE_SHUTTER, 0, 0, 0, 0, 0, 0},              /* neither: left out */
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        camera *cam = new_camera(0x0100);
        term.bmControls = 1u << 1;
        fake_ctrl *f = ae(cases[i].modes, cases[i].def, cases[i].cur);
        fake_array *a = list(cam);
        CHECK((entry(a, AUTO_EXPOSURE) != NULL) == cases[i].listed, "ae case %zu: listed", i);
        if (cases[i].listed) {
            expect_entry(a, AUTO_EXPOSURE, cases[i].min, cases[i].max, 1, cases[i].def_ui, cases[i].cur_ui, "ae case");
            if (cases[i].auto_sent) {
                set(cam, AUTO_EXPOSURE, 1);
                CHECK(f->last_set == cases[i].auto_sent, "ae case %zu: auto sends %d, want %d", i, f->last_set, cases[i].auto_sent);
            }
        }
        close_camera(cam);
    }
}

static void test_missing_units(void) {
    camera *cam = new_camera(0x0100);
    pu.bmControls = 1u << 0;
    range(PU_ID, UVC_PU_BRIGHTNESS_CONTROL, 2, 0, 255, 1, 128, 128);
    range(CT_ID, UVC_CT_FOCUS_ABSOLUTE_CONTROL, 2, 0, 255, 1, 0, 0);
    test_term = NULL; /* no camera terminal */
    fake_array *a = list(cam);
    CHECK(a->n == 6 && entry(a, BRIGHTNESS), "no camera terminal: processing unit controls only");
    int before = throws;
    set(cam, FOCUS, 10);
    CHECK(throws == before + 1, "no camera terminal: focus throws");
    test_pu = NULL;
    a = list(cam);
    CHECK(a->n == 0, "no units: empty list (%d)", a->n);
    close_camera(cam);
}

static void test_frames_and_snapshot(void) {
    camera *cam = new_camera(0x0100);
    jlong h = (jlong) (intptr_t) cam;
    /* A 4×2 YUYV frame: 2 pixel pairs per row. */
    Java_com_tomerg_usbcamera_UvcCamera_start(&jni, NULL, h, KIND_YUYV, 4, 2, 30);
    CHECK(cam->rgba && !cam->have_frame, "started, no frame yet");
    Java_com_tomerg_usbcamera_UvcCamera_setSurface(&jni, NULL, (jobject) &win);

    fake_bitmap bm = {{4, 2, 4 * 4 + 8, ANDROID_BITMAP_FORMAT_RGBA_8888, 0}, NULL, 0};
    bm.pixels = malloc((size_t) bm.info.stride * 2);
    memset(bm.pixels, 0xAB, (size_t) bm.info.stride * 2);
    CHECK(!Java_com_tomerg_usbcamera_UvcCamera_snapshot(&jni, NULL, h, (jobject) &bm), "no frame: no snapshot");

    uint8_t yuyv[16];
    for (int i = 0; i < 16; i++) yuyv[i] = (uint8_t) (16 + i * 13);
    uvc_frame_t frame = {0};
    frame.data = yuyv;
    frame.data_bytes = sizeof yuyv;
    on_frame(&frame, cam);
    CHECK(cam->have_frame, "a good YUYV frame counts");
    CHECK(win.posts == 1 && win.width == 4 && win.height == 2, "drawn once at 4×2");
    for (int y = 0; y < 2; y++)
        CHECK(!memcmp(win.bits + (size_t) y * win.stride * 4, cam->rgba + y * 16, 16), "window row %d", y);

    CHECK(Java_com_tomerg_usbcamera_UvcCamera_snapshot(&jni, NULL, h, (jobject) &bm), "snapshot after a frame");
    CHECK(bm.locked == 0, "bitmap unlocked");
    for (int y = 0; y < 2; y++) {
        CHECK(!memcmp(bm.pixels + (size_t) y * bm.info.stride, cam->rgba + y * 16, 16), "snapshot row %d", y);
        for (int x = 16; x < (int) bm.info.stride; x++)
            CHECK(bm.pixels[(size_t) y * bm.info.stride + x] == 0xAB, "row %d padding byte %d untouched", y, x);
    }
    fake_bitmap small = bm;
    small.info.width = 3;
    CHECK(!Java_com_tomerg_usbcamera_UvcCamera_snapshot(&jni, NULL, h, (jobject) &small), "wrong size: refused");
    fake_bitmap rgb565 = bm;
    rgb565.info.format = ANDROID_BITMAP_FORMAT_RGB_565;
    CHECK(!Java_com_tomerg_usbcamera_UvcCamera_snapshot(&jni, NULL, h, (jobject) &rgb565), "wrong format: refused");

    /* A short frame: no longer a whole frame, so no snapshot until the next good one. */
    frame.data_bytes = 10;
    on_frame(&frame, cam);
    CHECK(!cam->have_frame && win.posts == 1, "a short frame: dropped, not drawn");
    CHECK(!Java_com_tomerg_usbcamera_UvcCamera_snapshot(&jni, NULL, h, (jobject) &bm), "after a bad frame: no snapshot");
    frame.data_bytes = sizeof yuyv;
    on_frame(&frame, cam);
    CHECK(cam->have_frame && win.posts == 2, "the next good frame counts again");

    Java_com_tomerg_usbcamera_UvcCamera_setSurface(&jni, NULL, NULL);
    close_camera(cam);
    free(bm.pixels);
}

/* The frame thread and snapshots at the same time: run under ThreadSanitizer by native.sh. */
static void *frames(void *arg) {
    camera *cam = arg;
    uint8_t yuyv[64 * 32 * 2];
    memset(yuyv, 0x80, sizeof yuyv);
    uvc_frame_t frame = {0};
    frame.data = yuyv;
    for (int i = 0; i < 2000; i++) {
        frame.data_bytes = i % 7 == 3 ? 100 : sizeof yuyv; /* some bad frames */
        on_frame(&frame, cam);
    }
    return NULL;
}

static void test_snapshot_race(void) {
    camera *cam = new_camera(0x0100);
    jlong h = (jlong) (intptr_t) cam;
    Java_com_tomerg_usbcamera_UvcCamera_start(&jni, NULL, h, KIND_YUYV, 64, 32, 30);
    fake_bitmap bm = {{64, 32, 64 * 4, ANDROID_BITMAP_FORMAT_RGBA_8888, 0}, NULL, 0};
    bm.pixels = malloc((size_t) bm.info.stride * 32);
    pthread_t t;
    pthread_create(&t, NULL, frames, cam);
    int got = 0;
    for (int i = 0; i < 2000; i++) got += Java_com_tomerg_usbcamera_UvcCamera_snapshot(&jni, NULL, h, (jobject) &bm);
    pthread_join(t, NULL);
    CHECK(1, "race run done (%d snapshots)", got);
    free(bm.pixels);
    close_camera(cam);
}

int main(void) {
    jni_table.NewIntArray = new_int_array;
    jni_table.SetIntArrayRegion = set_int_array_region;
    jni_table.GetIntArrayElements = get_int_array_elements;
    jni_table.ReleaseIntArrayElements = release_int_array_elements;
    jni_table.FindClass = find_class;
    jni_table.ThrowNew = throw_new;

    test_autofocus_webcam();
    test_power_line_uvc15();
    test_ae_modes();
    test_missing_units();
    test_frames_and_snapshot();
    test_snapshot_race();

    for (int i = 0; i < n_arrays; i++) {
        free(arrays[i]->data);
        free(arrays[i]);
    }
    free(win.bits);
    printf("native: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
