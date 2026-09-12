#!/bin/bash
#
# Tests for update-bios.sh - both vendor code paths
#
# Runs on any machine: no root, no ASUS board, no Dell, no USB drive, no
# network. lsblk / dmidecode / curl / sha256sum / mountpoint are stubbed per
# test, and Dell's catalog is a local XML fixture.
#
#   ./test-update-bios.sh
#
# Each case below exists because the behaviour it pins down was previously
# wrong. See the comments for what actually broke.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./update-bios.sh
source "${SCRIPT_DIR}/update-bios.sh"

# The dispatchers in update-bios.sh route on $VENDOR. Set it rather than
# letting detect_vendor decide from the hardware underneath, so both paths are
# exercised on any machine. The Dell section flips it later.
VENDOR=asus

# The sourced script sets `-e` and installs an EXIT trap for its own run. Both
# have to go here: several tests deliberately exercise failure paths, which
# `-e` would turn into an aborted test run.
set +e
trap - EXIT

PASS=0
FAIL=0

chk() {
    local name="$1" got="$2" want="$3"
    if [[ "$got" == "$want" ]]; then
        printf '  ok   %s\n' "$name"
        PASS=$((PASS + 1))
    else
        printf '  FAIL %s\n         got:  %s\n         want: %s\n' "$name" "$got" "$want"
        FAIL=$((FAIL + 1))
    fi
}

# Count files in a directory matching a glob, case-insensitively. Replaces
# `ls | grep -c`, which shellcheck flags (SC2010) and which mis-handles awkward
# filenames. The shopt changes stay inside the command substitution's subshell.
# nullglob alone is not enough: it only suppresses a pattern that contains a
# globbing character. A literal filename is not a glob, so an unmatched one
# survives as a word and would be counted. Hence the -e guard.
count_glob() {
    local dir="$1" pat="$2" n=0 f
    shopt -s nullglob nocaseglob
    for f in "$dir"/$pat; do
        [[ -e "$f" ]] && n=$((n + 1))
    done
    printf '%d' "$n"
}

# macOS ships sha256sum-less; shasum is equivalent.
if ! command -v sha256sum >/dev/null 2>&1; then
    sha256sum() { shasum -a 256 "$@"; }
fi

# ---------------------------------------------------------------------------
# detect_usb_drive
#
# The original parsed columnar `lsblk` output with positional awk. Two faults
# compounded: awk's default field splitting shifts fields left when a column is
# empty, and TRAN is a *disk* property while FSTYPE/MOUNTPOINT are *partition*
# properties, so they never share a row. A partition row was read as
# tran=vfat, fstype=/media/user/USB and never matched - detection always
# reported "No FAT32 USB drives found".
# ---------------------------------------------------------------------------
echo "detect_usb_drive"

lsblk() {
    cat <<'ROWS'
NAME="sda" TRAN="sata" FSTYPE="" MOUNTPOINT="" PKNAME="" LABEL=""
NAME="sda1" TRAN="" FSTYPE="ext4" MOUNTPOINT="/" PKNAME="sda" LABEL=""
NAME="sdb" TRAN="usb" FSTYPE="" MOUNTPOINT="" PKNAME="" LABEL=""
NAME="sdb1" TRAN="" FSTYPE="vfat" MOUNTPOINT="/media/user/USB" PKNAME="sdb" LABEL="BIOSUSB"
ROWS
}
chk "finds mounted FAT32 usb via parent disk TRAN" \
    "$(detect_usb_drive 2>/dev/null)" "/media/user/USB"

# An internal EFI system partition is also vfat. It must never be offered as
# the target, or the BIOS file would be written to /boot/efi.
lsblk() {
    cat <<'ROWS'
NAME="nvme0n1" TRAN="nvme" FSTYPE="" MOUNTPOINT="" PKNAME="" LABEL=""
NAME="nvme0n1p1" TRAN="" FSTYPE="vfat" MOUNTPOINT="/boot/efi" PKNAME="nvme0n1" LABEL=""
ROWS
}
chk "ignores internal /boot/efi vfat" \
    "$(detect_usb_drive 2>/dev/null || true)" ""

# Unmounted stick: must be mounted, and the mount point returned.
lsblk() {
    cat <<'ROWS'
NAME="sdc" TRAN="usb" FSTYPE="" MOUNTPOINT="" PKNAME="sdc" LABEL=""
NAME="sdc1" TRAN="" FSTYPE="vfat" MOUNTPOINT="" PKNAME="sdc" LABEL="MYUSB"
ROWS
}
mount_partition() { echo "/mnt/bios-update-$1"; }
chk "mounts an unmounted FAT32 usb" \
    "$(detect_usb_drive 2>/dev/null)" "/mnt/bios-update-sdc1"

# No block devices at all must fail, not return an empty destination that
# would later be used as a copy target.
lsblk() { printf ''; }
chk "fails when lsblk returns nothing" \
    "$(detect_usb_drive >/dev/null 2>&1; echo $?)" "1"

# ---------------------------------------------------------------------------
# version_ge
#
# The original used `[[ $a -ge $b ]]`, which evaluates arithmetically and so
# reads a leading zero as octal. "0805" aborted with "value too great for
# base" and the error fell through to "update available" - which could have
# flashed a downgrade. "0710" was silently compared as decimal 456.
# ---------------------------------------------------------------------------
echo "version_ge"
ge() { if version_ge "$1" "$2" 2>/dev/null; then echo yes; else echo no; fi; }

chk "1838 >= 1825"          "$(ge 1838 1825)" "yes"
chk "1825 >= 1838"          "$(ge 1825 1838)" "no"
chk "equal versions"        "$(ge 1838 1838)" "yes"
chk "0805 >= 1234 (octal)"  "$(ge 0805 1234)" "no"
chk "1234 >= 0805 (octal)"  "$(ge 1234 0805)" "yes"
chk "0902 >= 0805"          "$(ge 0902 0805)" "yes"
chk "0805 >= 0902"          "$(ge 0805 0902)" "no"
chk "0710 >= 0800"          "$(ge 0710 0800)" "no"
chk "0800 >= 0710"          "$(ge 0800 0710)" "yes"
chk "non-numeric no crash"  "$(ge 1838a 1838)" "yes"

# ---------------------------------------------------------------------------
# get_current_bios_version
#
# The SMBIOS string is free-form. The original took the first 4-digit run,
# which could pick up a year. A single regex with trailing context does not
# work either: with `grep -o` one match's context character consumes the
# next match's leading context, so "... 2026 1838" yielded only 2026.
# ---------------------------------------------------------------------------
echo "get_current_bios_version"

dmidecode() { echo "1838"; }
chk "bare 4-digit version" "$(get_current_bios_version 2>/dev/null)" "1838"

dmidecode() { echo "American Megatrends 5.13 2026 1838"; }
chk "prefers the last 4-digit token" "$(get_current_bios_version 2>/dev/null)" "1838"

dmidecode() { echo "0805"; }
chk "keeps a leading zero" "$(get_current_bios_version 2>/dev/null)" "0805"

dmidecode() { echo "v1.2"; }
chk "fails when no 4-digit token" \
    "$(get_current_bios_version 2>/dev/null || echo FAILED)" "FAILED"

dmidecode() { echo "123456"; }
chk "does not split a 6-digit number" \
    "$(get_current_bios_version 2>/dev/null || echo FAILED)" "FAILED"

# ---------------------------------------------------------------------------
# install_bios_update - integrity gate
#
# Nothing verified the download before it was staged for flashing. ASUS
# publishes a sha256 in the same API response the script already parses.
# A mismatch must abort BEFORE anything is written to the USB drive, because
# a corrupt .CAP flashed by EZ Flash can leave the board unbootable.
# ---------------------------------------------------------------------------
echo "install_bios_update integrity gate"

FIXTURE_DIR=$(mktemp -d)
trap 'rm -rf "$FIXTURE_DIR"' EXIT

# Build a fake BIOS package: a zip holding a .CAP and BIOSRenamer.exe.
mkdir -p "${FIXTURE_DIR}/src"
printf 'FAKE-CAP-PAYLOAD' > "${FIXTURE_DIR}/src/PRIME-TEST-BOARD-1838.CAP"
printf 'FAKE-EXE' > "${FIXTURE_DIR}/src/BIOSRenamer.exe"
( cd "${FIXTURE_DIR}/src" && zip -q "${FIXTURE_DIR}/bios.zip" . -r )
GOOD_SHA=$(sha256sum "${FIXTURE_DIR}/bios.zip" | awk '{print $1}' | tr 'A-Z' 'a-z')

# curl stub: serve the fixture instead of downloading.
curl() {
    local out=""
    while [[ $# -gt 0 ]]; do
        [[ "$1" == "-o" ]] && { out="$2"; shift; }
        shift
    done
    [[ -n "$out" ]] && cp "${FIXTURE_DIR}/bios.zip" "$out"
}

dest_ok=$(mktemp -d)
EXPECTED_SHA256="$GOOD_SHA"
install_bios_update "https://example/PRIME-TEST-BOARD-1838.zip" 1838 "$dest_ok" >/dev/null 2>&1
chk "valid hash is accepted"        "$?" "0"
chk "stages as <version>.CAP" \
    "$(count_glob "$dest_ok" '1838.CAP')" "1"
chk "does not keep the long ASUS name" \
    "$(count_glob "$dest_ok" 'PRIME-TEST-BOARD-1838.CAP')" "0"
# BIOSRenamer is for FlashBack and needs ASUS's original filename; it must not
# be shipped next to a renamed <version>.CAP where it would be useless.
chk "does not copy BIOSRenamer" \
    "$(count_glob "$dest_ok" '*BIOSRenamer*')" "0"

dest_bad=$(mktemp -d)
# shellcheck disable=SC2034  # read by asus_install_bios in the sourced script
EXPECTED_SHA256="deadbeef00000000000000000000000000000000000000000000000000000bad"
install_bios_update "https://example/PRIME-TEST-BOARD-1838.zip" 1838 "$dest_bad" >/dev/null 2>&1
chk "hash mismatch aborts"          "$?" "1"
chk "nothing written to the USB on mismatch" \
    "$(ls -A "$dest_bad" | wc -l | tr -d ' ')" "0"

rm -rf "$dest_ok" "$dest_bad"

# ---------------------------------------------------------------------------
# cleanup_mounts - mount leak regression
#
# main() reads the drive with `dest=$(detect_usb_drive)`. Command substitution
# runs that in a subshell, so the mount recorded in an array down inside
# mount_partition was discarded and cleanup_mounts unmounted nothing. Measured
# live: the stick stayed mounted at /mnt/bios-update-sda1 after cleanup
# returned. The sweep has to clear a directory it never saw created.
# ---------------------------------------------------------------------------
echo
echo "cleanup_mounts (mount leak regression)"

MOUNT_SANDBOX=$(mktemp -d)
MOUNT_BASE="${MOUNT_SANDBOX}/bios-update"
# Nothing is really mounted under a temp dir, so umount is never reached.
mountpoint() { return 1; }

( mkdir -p "${MOUNT_BASE}-sdz1" )   # created in a subshell, exactly as the bug was
cleanup_mounts >/dev/null 2>&1
chk "sweeps a mount dir it never recorded" \
    "$(count_glob "$MOUNT_SANDBOX" 'bios-update-*')" "0"

mkdir -p "${MOUNT_BASE}-stale"      # left by a run that died before cleanup
cleanup_mounts >/dev/null 2>&1
chk "clears leftovers from an earlier run" \
    "$([[ -d "${MOUNT_BASE}-stale" ]] && echo present || echo gone)" "gone"

cleanup_mounts >/dev/null 2>&1
chk "no-match glob is not mistaken for a path" \
    "$([[ -e "${MOUNT_BASE}-*" ]] && echo created || echo clean)" "clean"

rm -rf "$MOUNT_SANDBOX"
unset -f mountpoint

# ---------------------------------------------------------------------------
# Dependency ordering
#
# The merge put detect_vendor ahead of dependency installation, but
# detect_vendor shells out to dmidecode. A machine without it reported
# "Unsupported system manufacturer: unknown" and exited, pointing at the wrong
# problem entirely.
# ---------------------------------------------------------------------------
echo
echo "dependency ordering"

INSTALL_LOG=()
install_missing() { INSTALL_LOG+=("$@"); }

INSTALL_LOG=()
check_common_dependencies
chk "dmidecode is a common dep, not a vendor one" \
    "$(printf '%s\n' "${INSTALL_LOG[@]}" | grep -c '^dmidecode$')" "1"

MAIN_BODY=$(awk '/^main\(\) \{/,/^\}$/' "${SCRIPT_DIR}/update-bios.sh")
chk "main installs common deps before detecting the vendor" \
    "$(printf '%s' "$MAIN_BODY" | grep -oE 'check_common_dependencies|detect_vendor' | head -1)" \
    "check_common_dependencies"
chk "vendor deps are installed after detection" \
    "$(printf '%s' "$MAIN_BODY" | grep -oE 'detect_vendor|check_vendor_dependencies' | head -1)" \
    "detect_vendor"

# ---------------------------------------------------------------------------
# Dell code path
#
# Everything above pins ASUS behaviour. The Dell half of update-bios.sh had no
# coverage at all until these.
# ---------------------------------------------------------------------------
echo
echo "dell_version_ge"

VENDOR=dell

ge() { version_ge "$1" "$2" && echo ge || echo lt; }
# Dell versions are dotted. A string compare puts 1.40.0 below 1.9.0, and the
# ASUS integer compare cannot read them at all.
chk "equal versions"            "$(ge 1.40.0 1.40.0)" "ge"
chk "1.40.0 beats 1.9.0"        "$(ge 1.40.0 1.9.0)"  "ge"
chk "1.9.0 loses to 1.40.0"     "$(ge 1.9.0 1.40.0)"  "lt"
chk "missing field counts as 0" "$(ge 1.40 1.40.0)"   "ge"
chk "1.39.0 loses to 1.40.0"    "$(ge 1.39.0 1.40.0)" "lt"
chk "patch field is compared"   "$(ge 1.40.1 1.40.0)" "ge"
# An earlier field must settle it outright. Without the early return on
# greater-than, 1.40.0 vs 1.9.9 falls through to the patch field, sees 0 < 9
# and wrongly reports a downgrade as an upgrade.
chk "earlier field beats a later one"  "$(ge 1.40.0 1.9.9)" "ge"
chk "and the reverse"                  "$(ge 1.9.9 1.40.0)" "lt"

echo
echo "get_system_id"

# The catalog keys models on Dell's 4-hex System ID, the SMBIOS SKU number,
# because the model name is not a stable key: SMBIOS says "XPS 15 9500" while
# the catalog says "XPS Notebook 9500".
#
# /sys/class/dmi/id/product_sku is read first and does exist on a real Dell, so
# it is stubbed away here to make the dmidecode fallback deterministic on any
# machine.
# shellcheck disable=SC2120  # a stub for the real `cat`; callers pass args
cat() { [[ "${1:-}" == /sys/class/dmi/id/product_sku ]] && return 1; command cat "$@"; }
SKU=""
dmidecode() { echo "$SKU"; }

SKU="097D";   chk "reads the SKU"               "$(get_system_id 2>/dev/null)" "097D"
SKU=" 097D "; chk "strips surrounding space"    "$(get_system_id 2>/dev/null)" "097D"
SKU="";       chk "fails when there is no SKU"  "$(get_system_id 2>/dev/null || echo FAILED)" "FAILED"

unset -f cat dmidecode

echo
echo "dell_latest_bios (catalog parsing)"

# Catalogs list every release ever published, unordered - a real XPS 15 9500
# catalog carries 31 BIOS entries. Picking the last one, or the one with the
# newest date string, gives the wrong answer; it has to be the highest version.
TEMP_DIR=$(mktemp -d)
cat > "${TEMP_DIR}/model.xml" <<'XML'
<Manifest baseLocation="downloads.dell.com">
  <SoftwareComponent dellVersion="1.9.0" releaseDate="March 01, 2024" path="F1/1/XPS_9500_1.9.0.exe" size="111">
    <ComponentType value="BIOS"/>
  </SoftwareComponent>
  <SoftwareComponent dellVersion="1.40.0" releaseDate="January 14, 2026" path="F2/1/XPS_9500_1.40.0.exe" size="27984968">
    <ComponentType value="BIOS"/>
  </SoftwareComponent>
  <SoftwareComponent dellVersion="1.39.0" releaseDate="September 16, 2025" path="F3/1/XPS_9500_1.39.0.exe" size="222">
    <ComponentType value="BIOS"/>
  </SoftwareComponent>
  <SoftwareComponent dellVersion="9.9.9" releaseDate="January 01, 2030" path="F4/1/not-a-bios.exe" size="333">
    <ComponentType value="Driver"/>
  </SoftwareComponent>
</Manifest>
XML

dell_latest_bios
chk "picks the highest version, not the last entry" "$LATEST_VERSION" "1.40.0"
chk "ignores non-BIOS components"                   "$DOWNLOAD_URL" \
    "https://downloads.dell.com/F2/1/XPS_9500_1.40.0.exe"
chk "carries the release date"                      "$RELEASE_DATE"  "January 14, 2026"
chk "carries the size for the integrity check"      "$EXPECTED_SIZE" "27984968"

printf '<Manifest></Manifest>' > "${TEMP_DIR}/model.xml"
dell_latest_bios >/dev/null 2>&1
chk "fails when the catalog has no BIOS component"  "$?" "1"

echo
echo "dell_install_bios size gate"

# Dell's catalog publishes no per-file hash for BIOS components, so the
# declared size is the only integrity check. It still has to catch a truncated
# transfer or an HTML error page saved as the payload.
PAYLOAD="${TEMP_DIR}/payload"
: > "$PAYLOAD"
for _ in $(seq 1 100); do printf 'X' >> "$PAYLOAD"; done

curl() {
    local out=""
    while [[ $# -gt 0 ]]; do
        [[ "$1" == "-o" ]] && { out="$2"; shift; }
        shift
    done
    [[ -n "$out" ]] && cp "$PAYLOAD" "$out"
}

d_ok=$(mktemp -d)
EXPECTED_SIZE=100
install_bios_update "https://example/XPS_9500_1.40.0.exe" 1.40.0 "$d_ok" >/dev/null 2>&1
chk "correct size is accepted"   "$?" "0"
chk "staged on the USB"          "$(count_glob "$d_ok" 'XPS_9500_1.40.0.exe')" "1"

d_bad=$(mktemp -d)
EXPECTED_SIZE=999999
install_bios_update "https://example/XPS_9500_1.40.0.exe" 1.40.0 "$d_bad" >/dev/null 2>&1
chk "size mismatch aborts"       "$?" "1"
chk "nothing written to the USB on a size mismatch" \
    "$(ls -A "$d_bad" | wc -l | tr -d ' ')" "0"

rm -rf "$d_ok" "$d_bad" "$TEMP_DIR"
# shellcheck disable=SC2034  # read by the dispatchers in the sourced script
VENDOR=asus

# ---------------------------------------------------------------------------
echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
