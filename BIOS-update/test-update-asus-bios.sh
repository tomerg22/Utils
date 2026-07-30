#!/bin/bash
#
# Tests for update-asus-bios.sh
#
# Runs on any machine: no root, no ASUS board, no USB drive, no network.
# lsblk / dmidecode / curl / sha256sum are stubbed per test.
#
#   ./test-update-asus-bios.sh
#
# Each case below exists because the behaviour it pins down was previously
# wrong. See the comments for what actually broke.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./update-asus-bios.sh
source "${SCRIPT_DIR}/update-asus-bios.sh"

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
chk "stages the original .CAP name" \
    "$(ls "$dest_ok" | grep -c '^PRIME-TEST-BOARD-1838.CAP$')" "1"
chk "does not rename to <version>.CAP" \
    "$(ls "$dest_ok" | grep -c '^1838.CAP$')" "0"
chk "copies BIOSRenamer.exe too" \
    "$(ls "$dest_ok" | grep -ci 'BIOSRenamer')" "1"

dest_bad=$(mktemp -d)
EXPECTED_SHA256="deadbeef00000000000000000000000000000000000000000000000000000bad"
install_bios_update "https://example/PRIME-TEST-BOARD-1838.zip" 1838 "$dest_bad" >/dev/null 2>&1
chk "hash mismatch aborts"          "$?" "1"
chk "nothing written to the USB on mismatch" \
    "$(ls -A "$dest_bad" | wc -l | tr -d ' ')" "0"

rm -rf "$dest_ok" "$dest_bad"

# ---------------------------------------------------------------------------
echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
