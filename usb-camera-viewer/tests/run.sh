#!/usr/bin/env bash
# Java tests of the plain-Java parts (Modes, Picture, Controls). Plain JDK, no Android SDK needed.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
src=app/src/com/tomerg/usbcamera
javac -encoding UTF-8 -d "$out" "$src/Modes.java" "$src/Picture.java" "$src/Controls.java" \
    tests/ModesTest.java tests/PictureTest.java tests/ControlsTest.java
status=0
for t in ModesTest com.tomerg.usbcamera.PictureTest ControlsTest; do
    java -cp "$out" "$t" || status=1
done
exit $status
