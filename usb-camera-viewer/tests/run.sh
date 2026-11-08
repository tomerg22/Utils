#!/usr/bin/env bash
# Mode-pick tests. Plain JDK, no Android SDK needed.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
javac -encoding UTF-8 -d "$out" app/src/com/tomerg/usbcamera/Modes.java tests/ModesTest.java
java -cp "$out" ModesTest
