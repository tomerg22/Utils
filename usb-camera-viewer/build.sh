#!/usr/bin/env bash
# Build build/usb-camera.apk without Gradle: libusb + libuvc + the JNI bridge with the NDK's
# clang, then aapt2 + javac + d8 + apksigner.
# Needs: JDK 17+, git, Android SDK with platforms;android-36, build-tools;36.x and an NDK.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
PLATFORM="$SDK/platforms/android-36/android.jar"
BT="$(ls -d "$SDK"/build-tools/36.* | sort -V | tail -1)"
NDK="${ANDROID_NDK_HOME:-$( (ls -d "$SDK"/ndk/* 2>/dev/null || true) | sort -V | tail -1)}"
KEYSTORE="${KEYSTORE:-$HOME/.android/debug.keystore}"
MIN_API=30 # AImageDecoder, which decodes the MJPEG frames, needs Android 11
# Isochronous packets per USB transfer in libuvc. Its default of 32 failed on a POCO X6 Pro
# with ENOMEM; see README.
PACKETS="${PACKETS:-8}"

# libusb and libuvc are fetched into third_party/ at these commits.
LIBUSB_URL=https://github.com/libusb/libusb.git
LIBUSB_COMMIT=87a55632db62c9bdc58cd31d3ccfa673f1bb017f # v1.0.30
LIBUVC_URL=https://github.com/libuvc/libuvc.git
LIBUVC_COMMIT=448d78b9aa4f54172c1ca5b5d1b4a6b9b93f7957 # v0.0.9
LIBUVC_VERSION=0.0.9

[ -f "$PLATFORM" ] || { echo "missing $PLATFORM (sdkmanager 'platforms;android-36')" >&2; exit 1; }
[ -d "$BT" ] || { echo "missing build-tools 36.x (sdkmanager 'build-tools;36.0.0')" >&2; exit 1; }
[ -d "$NDK" ] || { echo "missing NDK (sdkmanager 'ndk;28.2.13676358')" >&2; exit 1; }
CC="$(ls -d "$NDK"/toolchains/llvm/prebuilt/*/bin | head -1)/aarch64-linux-android$MIN_API-clang"

fetch() { # fetch <dir> <url> <commit>: a shallow checkout of one commit, kept between builds
    if [ "$(git -C "third_party/$1" rev-parse HEAD 2>/dev/null)" != "$3" ]; then
        rm -rf "third_party/$1"
        git init -q "third_party/$1"
        git -C "third_party/$1" fetch -q --depth 1 "$2" "$3"
        git -C "third_party/$1" checkout -q FETCH_HEAD
    fi
}
fetch libusb "$LIBUSB_URL" "$LIBUSB_COMMIT"
fetch libuvc "$LIBUVC_URL" "$LIBUVC_COMMIT"

rm -rf build && mkdir -p build/classes build/dex build/obj build/gen/libuvc build/lib/arm64-v8a

# libuvc's CMake normally writes this header. No libjpeg: AImageDecoder decodes MJPEG.
IFS=. read -r major minor patch <<< "$LIBUVC_VERSION"
sed -e "s/@libuvc_VERSION_MAJOR@/$major/g" -e "s/@libuvc_VERSION_MINOR@/$minor/g" \
    -e "s/@libuvc_VERSION_PATCH@/$patch/g" -e "s/@libuvc_VERSION@/$LIBUVC_VERSION/g" \
    -e "s|#cmakedefine LIBUVC_HAS_JPEG 1|/* #undef LIBUVC_HAS_JPEG */|" \
    third_party/libuvc/include/libuvc/libuvc_config.h.in > build/gen/libuvc/libuvc_config.h

CFLAGS=(-fPIC -O2 -fvisibility=hidden -pthread -DLIBUVC_PACKETS_PER_TRANSFER_MAX="$PACKETS"
    -Ithird_party/libusb/android -Ithird_party/libusb/libusb -Ithird_party/libusb/libusb/os
    -Ibuild/gen -Ithird_party/libuvc/include)
# The source lists of libusb's android/jni/libusb.mk and libuvc's CMakeLists.txt (minus libjpeg).
for f in core descriptor hotplug io sync strerror os/linux_usbfs os/events_posix \
    os/threads_posix os/linux_netlink; do
    "$CC" "${CFLAGS[@]}" -w -c "third_party/libusb/libusb/$f.c" -o "build/obj/libusb_${f##*/}.o"
done
for f in ctrl ctrl-gen device diag frame init misc stream; do
    "$CC" "${CFLAGS[@]}" -w -c "third_party/libuvc/src/$f.c" -o "build/obj/libuvc_$f.o"
done
"$CC" "${CFLAGS[@]}" -Wall -Wextra -c app/jni/usbcamera.c -o build/obj/usbcamera.o
"$CC" -shared -Wl,--no-undefined -Wl,-z,max-page-size=16384 \
    -o build/lib/arm64-v8a/libusbcamera.so build/obj/*.o -llog -landroid -ljnigraphics

"$BT/aapt2" compile --dir app/res -o build/res.zip
"$BT/aapt2" link -I "$PLATFORM" --manifest app/AndroidManifest.xml -o build/base.apk build/res.zip

javac --release 17 -encoding UTF-8 -Xlint:-options -classpath "$PLATFORM" -d build/classes \
    $(find app/src -name '*.java')

"$BT/d8" --min-api "$MIN_API" --lib "$PLATFORM" --output build/dex $(find build/classes -name '*.class')

cp build/base.apk build/unaligned.apk
(cd build/dex && zip -q ../unaligned.apk classes.dex)
(cd build && zip -q unaligned.apk lib/arm64-v8a/libusbcamera.so)
"$BT/zipalign" -f 4 build/unaligned.apk build/aligned.apk

if [ ! -f "$KEYSTORE" ]; then
    mkdir -p "$(dirname "$KEYSTORE")"
    keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Android Debug,O=Android,C=US"
fi
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
    --out build/usb-camera.apk build/aligned.apk
"$BT/apksigner" verify build/usb-camera.apk
echo "built build/usb-camera.apk"
