/* Host stub of the NDK's android/imagedecoder.h, for tests/native.sh. */
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <android/bitmap.h>
typedef struct AImageDecoder AImageDecoder;
typedef struct AImageDecoderHeaderInfo AImageDecoderHeaderInfo;
enum { ANDROID_IMAGE_DECODER_SUCCESS = 0, ANDROID_IMAGE_DECODER_BAD_PARAMETER = -4 };
int AImageDecoder_createFromBuffer(const void *buffer, size_t length, AImageDecoder **out);
const AImageDecoderHeaderInfo *AImageDecoder_getHeaderInfo(const AImageDecoder *decoder);
int32_t AImageDecoderHeaderInfo_getWidth(const AImageDecoderHeaderInfo *info);
int32_t AImageDecoderHeaderInfo_getHeight(const AImageDecoderHeaderInfo *info);
int AImageDecoder_setAndroidBitmapFormat(AImageDecoder *decoder, int32_t format);
int AImageDecoder_decodeImage(AImageDecoder *decoder, void *pixels, size_t stride, size_t size);
void AImageDecoder_delete(AImageDecoder *decoder);
