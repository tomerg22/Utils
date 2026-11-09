/* Host stub of the NDK's android/bitmap.h, for tests/native.sh. */
#pragma once
#include <jni.h>
#include <stdint.h>
enum { ANDROID_BITMAP_RESULT_SUCCESS = 0, ANDROID_BITMAP_RESULT_BAD_PARAMETER = -1 };
enum { ANDROID_BITMAP_FORMAT_NONE = 0, ANDROID_BITMAP_FORMAT_RGBA_8888 = 1, ANDROID_BITMAP_FORMAT_RGB_565 = 4 };
typedef struct {
    uint32_t width, height, stride;
    int32_t format;
    uint32_t flags;
} AndroidBitmapInfo;
int AndroidBitmap_getInfo(JNIEnv *env, jobject bitmap, AndroidBitmapInfo *info);
int AndroidBitmap_lockPixels(JNIEnv *env, jobject bitmap, void **addr);
int AndroidBitmap_unlockPixels(JNIEnv *env, jobject bitmap);
