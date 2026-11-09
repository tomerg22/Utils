/* Host stub of the NDK's android/native_window_jni.h, for tests/native.sh. */
#pragma once
#include <jni.h>
#include <stdint.h>
typedef struct ANativeWindow ANativeWindow;
typedef struct ARect ARect;
enum { WINDOW_FORMAT_RGBA_8888 = 1, WINDOW_FORMAT_RGBX_8888 = 2, WINDOW_FORMAT_RGB_565 = 4 };
typedef struct {
    int32_t width, height, stride, format;
    void *bits;
    uint32_t reserved[6];
} ANativeWindow_Buffer;
ANativeWindow *ANativeWindow_fromSurface(JNIEnv *env, jobject surface);
void ANativeWindow_release(ANativeWindow *window);
int32_t ANativeWindow_setBuffersGeometry(ANativeWindow *window, int32_t width, int32_t height, int32_t format);
int32_t ANativeWindow_lock(ANativeWindow *window, ANativeWindow_Buffer *buffer, ARect *dirty);
int32_t ANativeWindow_unlockAndPost(ANativeWindow *window);
