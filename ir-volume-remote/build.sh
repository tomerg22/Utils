#!/usr/bin/env bash
# Build build/ir-volume.apk without Gradle: aapt2 + javac + d8 + apksigner.
# Needs: JDK 17+, Android SDK with platforms;android-36 and build-tools;36.x.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
PLATFORM="$SDK/platforms/android-36/android.jar"
BT="$(ls -d "$SDK"/build-tools/36.* | sort -V | tail -1)"
KEYSTORE="${KEYSTORE:-$HOME/.android/debug.keystore}"

[ -f "$PLATFORM" ] || { echo "missing $PLATFORM (sdkmanager 'platforms;android-36')" >&2; exit 1; }
[ -d "$BT" ] || { echo "missing build-tools 36.x (sdkmanager 'build-tools;36.0.0')" >&2; exit 1; }

rm -rf build && mkdir -p build/classes build/dex

"$BT/aapt2" link -I "$PLATFORM" --manifest app/AndroidManifest.xml -o build/base.apk

javac --release 17 -Xlint:-options -classpath "$PLATFORM" -d build/classes \
    $(find app/src -name '*.java')

"$BT/d8" --min-api 26 --lib "$PLATFORM" --output build/dex $(find build/classes -name '*.class')

cp build/base.apk build/unaligned.apk
(cd build/dex && zip -q ../unaligned.apk classes.dex)
"$BT/zipalign" -f 4 build/unaligned.apk build/aligned.apk

if [ ! -f "$KEYSTORE" ]; then
    mkdir -p "$(dirname "$KEYSTORE")"
    keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Android Debug,O=Android,C=US"
fi
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
    --out build/ir-volume.apk build/aligned.apk
"$BT/apksigner" verify build/ir-volume.apk
echo "built build/ir-volume.apk"
