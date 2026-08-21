#!/usr/bin/env bash
# Download AliExpress product images and make their printed text readable.
#
#   labels.sh fetch <outdir> <url> [url...]     # download + convert to PNG
#   labels.sh crop  <file.png> <top> <left> <h> <w> [longEdge]
#
# WHY THIS EXISTS (measured 2026-08-21)
# A RUIHONG RH-15W listing states its output current NOWHERE in text — not in
# the variant selector (voltage only, labelled "Color"), not in the spec table
# (certification "NONE", capacity ">1000VA" for a 59 g part). The rating
# "OUTPUT: 9V1.6A" is silkscreened on the case and readable in gallery image 1.
# Reasoning from a customer review instead produced "~5W / ~0.55A" — wrong by
# about 3x. For hardware, the label in the photo IS the manufacturer's spec.
#
# THREE GOTCHAS, all of which cost time:
#
# 1. The bytes are WebP even when the URL ends in .jpg. `file` reports
#    "RIFF ... Web/P". The Read tool needs PNG, so convert every download.
# 2. Python PIL is NOT installed on this machine. Use macOS `sips`, which is.
#    `sips` crops with `-c <height> <width> --cropOffset <top> <left>`
#    (height BEFORE width, offsets AFTER — easy to get backwards).
# 3. A full 800x800 product shot renders the case label too small to read.
#    Crop to the label and upscale, or the text is a smudge. Reading the
#    uncropped image is what let "9V1.6A" go unnoticed on the first pass.
#
# Pass a Referer; some CDN edges refuse bare requests.

set -euo pipefail

REFERER="https://he.aliexpress.com/"

die() { echo "labels.sh: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

cmd_fetch() {
  [ $# -ge 2 ] || die "usage: labels.sh fetch <outdir> <url> [url...]"
  local outdir="$1"; shift
  mkdir -p "$outdir"
  have sips || die "sips not found (macOS only). Convert WebP->PNG some other way."

  local i=0 url out
  for url in "$@"; do
    i=$((i + 1))
    out="$outdir/img$i"
    if ! curl -fsS --max-time 30 -H "Referer: $REFERER" -o "$out.bin" "$url"; then
      echo "  img$i  FETCH-FAILED  $url" >&2
      continue
    fi
    # Downloads are WebP regardless of the URL extension — see gotcha 1.
    if sips -s format png "$out.bin" --out "$out.png" >/dev/null 2>&1; then
      printf '  %-8s %s  %s\n' "img$i.png" \
        "$(sips -g pixelWidth -g pixelHeight "$out.png" 2>/dev/null | awk '/pixel/{printf "%s ", $2}')" \
        "$url"
      rm -f "$out.bin"
    else
      echo "  img$i  CONVERT-FAILED (kept as .bin: $(file -b "$out.bin" | cut -c1-40))" >&2
    fi
  done
  echo
  echo "Now READ each PNG. Look for a silkscreened label: OUTPUT / INPUT / model"
  echo "number / a dimensions drawing. If the text is too small, crop it:"
  echo "  labels.sh crop $outdir/img1.png <top> <left> <h> <w>"
}

cmd_crop() {
  [ $# -ge 5 ] || die "usage: labels.sh crop <file.png> <top> <left> <h> <w> [longEdge]"
  local f="$1" top="$2" left="$3" h="$4" w="$5" edge="${6:-900}"
  [ -f "$f" ] || die "no such file: $f"
  have sips || die "sips not found (macOS only)"
  local out="${f%.png}-crop.png"
  # NOTE the argument order: -c HEIGHT WIDTH, then --cropOffset TOP LEFT.
  sips -c "$h" "$w" --cropOffset "$top" "$left" "$f" --out "$out" >/dev/null
  sips -Z "$edge" "$out" >/dev/null
  echo "$out  ($(sips -g pixelWidth -g pixelHeight "$out" | awk '/pixel/{printf "%s ", $2}'))"
}

case "${1:-}" in
  fetch) shift; cmd_fetch "$@" ;;
  crop)  shift; cmd_crop  "$@" ;;
  *) die "usage: labels.sh {fetch|crop} ..." ;;
esac
