#!/usr/bin/env bash
# Download AliExpress product images and make their printed text readable.
#
#   labels.sh fetch <outdir> <url> [url...]     # download + convert to PNG
#   labels.sh crop  <file.png> <top> <left> <h> <w> [longEdge]
#   labels.sh sheet <dir> [per-sheet=12] [cell=500]   # numbered contact sheets
#   labels.sh same  <dir> <dir> [dir...]        # which listings are one product
#
# For `same`, fetch each listing into its own directory named by its id
# (labels.sh fetch <out>/<id> ...): see same.mjs. For `sheet`, read every
# sheet: the red number on a tile is its img<N>.png, the file to crop.
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

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# Contact sheets: every img<N>.png of <dir> on numbered sheets of <per> images.
# WHY (measured 2026-11-08): reading every image one Read call at a time meant
# 434 calls in one session; ffmpeg here could not start (a missing libjxl
# library). sheet.swift uses AppKit, which ships with macOS. It is compiled
# once and kept in ~/.cache/aliexpress-finder, keyed by its own md5.
cmd_sheet() {
  [ $# -ge 1 ] || die "usage: labels.sh sheet <dir> [per-sheet=12] [cell=500]"
  local dir="$1" per="${2:-12}" cell="${3:-500}"
  [ -d "$dir" ] || die "no such directory: $dir"
  case "$per$cell" in *[!0-9]*) die "per-sheet and cell must be whole numbers, got $per and $cell" ;; esac
  [ "$per" -ge 1 ] && [ "$cell" -ge 16 ] || die "per-sheet must be 1 or more and cell 16 or more"
  have swiftc || die "swiftc not found: install the Xcode command line tools (xcode-select --install)"
  local src="$HERE/sheet.swift" cache="${XDG_CACHE_HOME:-$HOME/.cache}/aliexpress-finder" sum bin
  sum="$(md5 -q "$src" 2>/dev/null || md5sum "$src" | cut -c1-32)"
  bin="$cache/sheet-$sum"
  if [ ! -x "$bin" ]; then
    mkdir -p "$cache"
    swiftc -O "$src" -o "$bin.tmp.$$" >/dev/null 2>&1 || { rm -f "$bin.tmp.$$"; die "sheet.swift did not compile: swiftc -O $src"; }
    mv "$bin.tmp.$$" "$bin"
  fi
  local nums
  nums="$(ls "$dir" | sed -n 's/^img\([0-9][0-9]*\)\.png$/\1/p' | sort -n)"
  [ -n "$nums" ] || die "no img<N>.png in $dir: run labels.sh fetch into it first"
  local n part=1 count=0 total=0 batch=""
  # One sheet per <per> numbers. A plain string, not an array: an empty array
  # under `set -u` is an error in the bash 3.2 macOS ships.
  for n in $nums; do
    batch="$batch $n"; count=$((count + 1)); total=$((total + 1))
    if [ "$count" -eq "$per" ]; then sheet_one "$dir" "$cell" "$bin" "$part" $batch; part=$((part + 1)); count=0; batch=""; fi
  done
  [ -z "$batch" ] || sheet_one "$dir" "$cell" "$bin" "$part" $batch
  echo
  echo "$total images on the sheets above. Read every sheet. The red number on a tile is its"
  echo "img<N>.png: crop that file to read small print (labels.sh crop $dir/img<N>.png ...)."
}

# One sheet: the numbers after the first four arguments, never none.
sheet_one() {
  local dir="$1" cell="$2" bin="$3" part="$4"; shift 4
  local out="$dir/sheet-$part.png" first="$1" last n
  local -a args
  for n in "$@"; do args+=("$n:$dir/img$n.png"); last="$n"; done
  "$bin" "$out" "$cell" "${args[@]}" >/dev/null || die "could not write $out"
  echo "$out  ($# images: img$first to img$last)"
}

cmd_same() {
  have node || die "node not found"
  exec node "$HERE/same.mjs" "$@"
}

case "${1:-}" in
  fetch) shift; cmd_fetch "$@" ;;
  crop)  shift; cmd_crop  "$@" ;;
  sheet) shift; cmd_sheet "$@" ;;
  same)  shift; cmd_same  "$@" ;;
  *) die "usage: labels.sh {fetch|crop|sheet|same} ..." ;;
esac
