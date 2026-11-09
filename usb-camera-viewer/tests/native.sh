#!/usr/bin/env bash
# Host test of the native side (app/jni/usbcamera.c) with stub Android headers and a fake
# camera: once with AddressSanitizer + UndefinedBehaviorSanitizer, once with ThreadSanitizer.
# Needs clang, a JDK (for jni.h) and third_party/ (fetched by ./build.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d third_party/libuvc ] || { echo "third_party/ missing: run ./build.sh once" >&2; exit 1; }
JAVA_HOME="${JAVA_HOME:-$(java -XshowSettings:properties -version 2>&1 | awk -F'= ' '/java.home/ {print $2}')}"
JNI_MD="$(dirname "$(find "$JAVA_HOME/include" -name jni_md.h | head -1)")"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

# The header libuvc's CMake writes, as in build.sh.
mkdir -p "$out/gen/libuvc"
sed -e "s/@libuvc_VERSION_MAJOR@/0/g" -e "s/@libuvc_VERSION_MINOR@/0/g" \
    -e "s/@libuvc_VERSION_PATCH@/9/g" -e "s/@libuvc_VERSION@/0.0.9/g" \
    -e "s|#cmakedefine LIBUVC_HAS_JPEG 1|/* #undef LIBUVC_HAS_JPEG */|" \
    third_party/libuvc/include/libuvc/libuvc_config.h.in > "$out/gen/libuvc/libuvc_config.h"

FLAGS=(-std=c11 -g -O1 -Wall -Wextra -Werror -pthread -Itests/native/stubs -I"$JAVA_HOME/include"
    -I"$JNI_MD" -Ithird_party/libusb/libusb -I"$out/gen" -Ithird_party/libuvc/include)
clang "${FLAGS[@]}" -fsanitize=address,undefined -fno-sanitize-recover=all \
    tests/native/harness.c -o "$out/asan"
clang "${FLAGS[@]}" -fsanitize=thread tests/native/harness.c -o "$out/tsan"
echo "ASan + UBSan:"
"$out/asan"
echo "TSan:"
TSAN_OPTIONS=halt_on_error=1 "$out/tsan"
