#!/usr/bin/env bash
# Download AliExpress product images and make their printed text readable.
#
#   labels.sh fetch [--desc] [--fresh] <dir> <url> [url...]   # download + convert to PNG
#   labels.sh crop  <file.png> <top> <left> <h> <w> [longEdge]
#   labels.sh sheet <dir> [per-sheet=12] [cell=500]           # numbered contact sheets
#   labels.sh same  <dir> <dir> [dir...]                      # which listings are one product
#
# ONE DIRECTORY PER LISTING, named by its id: <out>/<id>. The gallery and the
# option images go in as img<N>.png; with --desc, the description images go in
# as desc<N>.png. `same` compares only img<N>.png, because stores reuse the
# same description banners on different products. Numbering goes on after the
# highest file already in the directory, so a listing fetched in several calls
# keeps every image; --fresh first removes the directory's own img*, desc* and
# sheet-* files, to fetch a listing again from scratch. Measured 2026-11-08
# (review of 58c8a00): numbering restarted at img1 on every call, so a second
# call overwrote the first one's images and a reused directory kept the last
# listing's extra ones, and the sheets and `same` then read the wrong photos.
# For `sheet`, read every sheet: the red label on a tile is its file (3 is
# img3.png, d3 is desc3.png), the one to crop.
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

# The highest <prefix><N> number in <dir> (.png or a kept .bin), 0 when none.
last_number() {
  local n
  n="$(ls "$1" | sed -n -E "s/^$2([0-9]+)\.(png|bin)$/\1/p" | sort -n | tail -n 1)"
  echo "${n:-0}"
}

cmd_fetch() {
  local prefix=img fresh=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --desc) prefix=desc; shift ;;
      --fresh) fresh=1; shift ;;
      --*) die "unknown fetch option $1 (known: --desc, --fresh)" ;;
      *) break ;;
    esac
  done
  [ $# -ge 2 ] || die "usage: labels.sh fetch [--desc] [--fresh] <dir> <url> [url...]"
  local outdir="$1"; shift
  mkdir -p "$outdir"
  have sips || die "sips not found (macOS only). Convert WebP->PNG some other way."
  if [ "$fresh" -eq 1 ]; then
    # Only this tool's own files: img*, desc* (with their crops) and sheet-*.
    find "$outdir" -maxdepth 1 -type f \( -name 'img*.png' -o -name 'img*.bin' -o -name 'desc*.png' \
      -o -name 'desc*.bin' -o -name 'sheet-*.png' \) -delete
  fi

  local i url out
  i="$(last_number "$outdir" "$prefix")"
  [ "$i" -eq 0 ] || echo "  (going on after $prefix$i: the images already in $outdir stay; --fresh starts over)"
  for url in "$@"; do
    i=$((i + 1))
    out="$outdir/$prefix$i"
    if ! curl -fsS --max-time 30 -H "Referer: $REFERER" -o "$out.bin" "$url"; then
      rm -f "$out.bin"
      echo "  $prefix$i  FETCH-FAILED  $url" >&2
      continue
    fi
    # Downloads are WebP regardless of the URL extension — see gotcha 1.
    if sips -s format png "$out.bin" --out "$out.png" >/dev/null 2>&1; then
      printf '  %-9s %s  %s\n' "$prefix$i.png" \
        "$(sips -g pixelWidth -g pixelHeight "$out.png" 2>/dev/null | awk '/pixel/{printf "%s ", $2}')" \
        "$url"
      rm -f "$out.bin"
    else
      echo "  $prefix$i  CONVERT-FAILED (kept as .bin: $(file -b "$out.bin" | cut -c1-40))" >&2
    fi
  done
  echo
  echo "Now READ every image: labels.sh sheet $outdir puts them on numbered sheets."
  echo "Look for a silkscreened label: OUTPUT / INPUT / model number / a dimensions"
  echo "drawing. If the text is too small, crop it:"
  echo "  labels.sh crop $outdir/${prefix}1.png <top> <left> <h> <w>"
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

# Contact sheets: every img<N>.png, then every desc<N>.png, of <dir> on
# numbered sheets of <per> images.
# WHY (measured 2026-11-08): reading every image one Read call at a time meant
# 434 calls in one session; ffmpeg here could not start (a missing libjxl
# library). sheet.swift uses AppKit, which ships with macOS. It is compiled
# once and kept in ~/.cache/aliexpress-finder, keyed by its own md5.
# An image sheet.swift cannot decode is a blank tile; it is named, and the
# exit status is 3, because a blank tile looks like a white product photo and
# was counted as read (review of 58c8a00: its "could not be read" line went to
# /dev/null). Old sheet-*.png files go first, so no sheet from an earlier run
# stays beside the new ones.
UNREADABLE=""
cmd_sheet() {
  [ $# -ge 1 ] || die "usage: labels.sh sheet <dir> [per-sheet=12] [cell=500]"
  local dir="$1" per="${2:-12}" cell="${3:-500}"
  [ -d "$dir" ] || die "no such directory: $dir"
  case "$per$cell" in *[!0-9]*) die "per-sheet and cell must be whole numbers, got $per and $cell" ;; esac
  [ "$per" -ge 1 ] && [ "$cell" -ge 16 ] || die "per-sheet must be 1 or more and cell 16 or more"
  have swiftc || die "swiftc not found: install the Xcode command line tools (xcode-select --install)"
  local src="$HERE/sheet.swift" cache="${XDG_CACHE_HOME:-$HOME/.cache}/aliexpress-finder" sum bin log
  sum="$(md5 -q "$src" 2>/dev/null || md5sum "$src" | cut -c1-32)"
  bin="$cache/sheet-$sum"
  if [ ! -x "$bin" ]; then
    mkdir -p "$cache" || die "cannot create $cache"
    # The compiler's own words are kept: every failure used to read "did not
    # compile", a read-only cache directory too (review of 58c8a00).
    log="$(mktemp "${TMPDIR:-/tmp}/aef-swiftc.XXXXXX")"
    if ! swiftc -O "$src" -o "$bin.tmp.$$" >"$log" 2>&1; then
      rm -f "$bin.tmp.$$"
      local said
      said="$(tail -n 5 "$log" | tr '\n' ' ')"
      rm -f "$log"
      die "could not build sheet.swift into $cache. swiftc said: $said"
    fi
    rm -f "$log"
    mv "$bin.tmp.$$" "$bin"
  fi
  find "$dir" -maxdepth 1 -type f -name 'sheet-*.png' -delete
  local tokens
  tokens="$(ls "$dir" | sed -n -E 's/^img([0-9]+)\.png$/\1/p' | sort -n | sed 's/^/img:/')
$(ls "$dir" | sed -n -E 's/^desc([0-9]+)\.png$/\1/p' | sort -n | sed 's/^/desc:/')"
  tokens="$(echo "$tokens" | sed '/^$/d')"
  [ -n "$tokens" ] || die "no img<N>.png or desc<N>.png in $dir: run labels.sh fetch into it first"
  local t part=1 count=0 total=0 batch=""
  # One sheet per <per> files. A plain string, not an array: an empty array
  # under `set -u` is an error in the bash 3.2 macOS ships.
  for t in $tokens; do
    batch="$batch $t"; count=$((count + 1)); total=$((total + 1))
    if [ "$count" -eq "$per" ]; then sheet_one "$dir" "$cell" "$bin" "$part" $batch; part=$((part + 1)); count=0; batch=""; fi
  done
  [ -z "$batch" ] || sheet_one "$dir" "$cell" "$bin" "$part" $batch
  echo
  echo "$total images on the sheets above. Read every sheet. The red label on a tile is its"
  echo "file (3 = img3.png, d3 = desc3.png): crop that file to read small print."
  if [ -n "$UNREADABLE" ]; then
    echo "COULD NOT READ:$UNREADABLE. Their tiles are blank: those images are NOT read." >&2
    exit 3
  fi
}

# One sheet: the img:<N> / desc:<N> tokens after the first four arguments, never none.
sheet_one() {
  local dir="$1" cell="$2" bin="$3" part="$4"; shift 4
  local out="$dir/sheet-$part.png" first="" last="" t kind n label file said
  local -a args
  for t in "$@"; do
    kind="${t%%:*}"; n="${t#*:}"
    if [ "$kind" = desc ]; then label="d$n"; else label="$n"; fi
    file="$kind$n"
    args+=("$label:$dir/$file.png")
    [ -n "$first" ] || first="$file"
    last="$file"
  done
  said="$("$bin" "$out" "$cell" "${args[@]}")" || die "could not write $out"
  # sheet.swift ends its line with "unreadable:<label>,<label>" for each image it could not decode.
  case "$said" in
    *unreadable:*)
      local bad="${said##*unreadable:}"
      bad="$(echo "$bad" | tr ',' ' ' | sed -E 's/(^| )d([0-9]+)/\1desc\2/g; s/(^| )([0-9]+)/\1img\2/g')"
      UNREADABLE="$UNREADABLE $bad"
      echo "$out  ($# images: $first to $last; COULD NOT READ: $bad)"
      ;;
    *) echo "$out  ($# images: $first to $last)" ;;
  esac
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
