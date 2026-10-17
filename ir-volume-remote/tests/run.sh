#!/usr/bin/env bash
# Encoder round-trip tests. Plain JDK, no Android SDK needed.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
javac -d "$out" app/src/com/tomerg/irvolume/IrCodes.java tests/IrCodesTest.java
java -cp "$out" IrCodesTest
