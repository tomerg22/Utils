#!/bin/bash
#
# Dell BIOS Update Script for Ubuntu
#
# Detects the Dell system ID, looks that ID up in Dell's own update catalog
# (the same feed Dell Command Update consumes on Windows), compares the newest
# published BIOS against the running one, and stages the update on a FAT32 USB
# drive.
#
# After running, restart and press F12 -> BIOS Update -> Flash from file, then
# pick the .exe from the USB drive.
#
# Why the catalog and not fwupd: Dell does not publish every consumer model's
# BIOS to LVFS. On an XPS 15 9500 `fwupdmgr get-releases` for System Firmware
# returns "No releases found", so fwupd has nothing to offer and never will for
# that machine. The firmware's own F12 flasher reads the Windows .exe directly,
# so no Windows is involved at any point.
#
# Why not the support website: dell.com/support renders its driver table only
# after you either enter a service tag or switch to the "All <model>" tab, and
# the payload is Caesar-shifted JSON. The catalog is plain XML with hashes.
#
# Requires root (dmidecode, mount). Run with: sudo ./update-dell-bios.sh

set -euo pipefail

# Configuration
TEMP_DIR="/tmp/Dell_BIOS_Update"
MOUNT_BASE="/mnt/bios-update"
CATALOG_BASE="https://downloads.dell.com"
CATALOG_INDEX_URL="${CATALOG_BASE}/catalog/CatalogIndexPC.cab"
CLEANED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        echo -e "${RED}This script must be run as root (for dmidecode access)${NC}"
        echo "Run with: sudo $0"
        exit 1
    fi
}

# Extract one KEY="value" field from a `lsblk -P` line.
# Used instead of eval, which would execute crafted filesystem labels.
kv() {
    local line="$1" key="$2"
    if [[ $line =~ (^|[[:space:]])${key}=\"([^\"]*)\" ]]; then
        printf '%s' "${BASH_REMATCH[2]}"
    fi
}

# Rows from the last `lsblk -P` read, so a partition can look up its parent.
LSBLK_ROWS=()

# Transport (TRAN) of a device name, resolved by scanning the collected rows.
# A linear scan over a handful of block devices; avoids associative arrays so
# this works on bash 3.2 as well as the bash 5 Ubuntu ships.
tran_of() {
    local target="$1" i n
    for ((i = 0; i < ${#LSBLK_ROWS[@]}; i++)); do
        n=$(kv "${LSBLK_ROWS[$i]}" NAME)
        if [[ "$n" == "$target" ]]; then
            kv "${LSBLK_ROWS[$i]}" TRAN
            return 0
        fi
    done
}

# Mount a partition if not already mounted
mount_partition() {
    local device="$1"
    local mount_point="${MOUNT_BASE}-${device##*/}"

    if [[ ! -d "$mount_point" ]]; then
        mkdir -p "$mount_point"
    fi

    if mount -t vfat "/dev/$device" "$mount_point" 2>/dev/null; then
        echo "$mount_point"
        return 0
    fi

    echo -e "${RED}Failed to mount /dev/$device${NC}" >&2
    rmdir "$mount_point" 2>/dev/null || true
    return 1
}

# Unmount anything this script mounted.
#
# Sweeps by path rather than tracking mounts in an array. main() reads the
# chosen drive with `dest=$(detect_usb_drive)`, and command substitution runs
# that in a subshell, so any array entry appended down in mount_partition is
# gone by the time cleanup runs in the parent. Measured: the stick stayed
# mounted at /mnt/bios-update-sda1 after cleanup_mounts returned.
#
# The sweep also clears leftovers from an earlier run that died before its
# own cleanup.
cleanup_mounts() {
    local mount_point
    for mount_point in "${MOUNT_BASE}"-*; do
        # No match leaves the glob literal, which is not a directory.
        [[ -d "$mount_point" ]] || continue
        if mountpoint -q "$mount_point" 2>/dev/null; then
            umount "$mount_point" 2>/dev/null || true
            echo -e "${GRAY}Unmounted: ${mount_point}${NC}"
        fi
        rmdir "$mount_point" 2>/dev/null || true
    done
}

# Detect FAT32 USB drive (mounted or unmounted)
#
# Uses `lsblk -P` (KEY="value" pairs) rather than positional awk. With
# space-padded columnar output, awk's default field splitting shifts fields
# left whenever a column is empty, so a partition row like
#   sdb1      vfat /media/user/USB
# was read as tran=vfat, fstype=/media/user/USB and never matched.
#
# TRAN is also a *disk* property while FSTYPE/MOUNTPOINT are *partition*
# properties, so a partition row carries an empty TRAN and has to inherit its
# parent's via PKNAME.
detect_usb_drive() {
    local devices=() mount_points=() labels=()
    local i line

    LSBLK_ROWS=()
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        LSBLK_ROWS+=("$line")
    done < <(lsblk -P -o NAME,TRAN,FSTYPE,MOUNTPOINT,PKNAME,LABEL 2>/dev/null)

    if [[ ${#LSBLK_ROWS[@]} -eq 0 ]]; then
        echo -e "${RED}lsblk returned no block devices${NC}" >&2
        return 1
    fi

    for ((i = 0; i < ${#LSBLK_ROWS[@]}; i++)); do
        line="${LSBLK_ROWS[$i]}"
        local name tran fstype mp pk label transport
        name=$(kv "$line" NAME)
        tran=$(kv "$line" TRAN)
        fstype=$(kv "$line" FSTYPE)
        mp=$(kv "$line" MOUNTPOINT)
        pk=$(kv "$line" PKNAME)
        label=$(kv "$line" LABEL)

        [[ "$fstype" == "vfat" ]] || continue

        transport="$tran"
        if [[ -z "$transport" && -n "$pk" ]]; then
            transport=$(tran_of "$pk")
        fi
        [[ "$transport" == "usb" ]] || continue

        devices+=("$name")
        mount_points+=("$mp")
        labels+=("${label:-no label}")
    done

    if [[ ${#devices[@]} -eq 0 ]]; then
        echo -e "${RED}No FAT32 USB drives found${NC}" >&2
        echo -e "${YELLOW}Please insert a FAT32-formatted USB drive${NC}" >&2
        echo -e "${GRAY}Debug: lsblk -P -o NAME,TRAN,FSTYPE,MOUNTPOINT,PKNAME${NC}" >&2
        return 1
    fi

    local selected_idx=0

    if [[ ${#devices[@]} -gt 1 ]]; then
        echo -e "${YELLOW}Multiple FAT32 USB drives found:${NC}" >&2
        for i in "${!devices[@]}"; do
            local status="not mounted"
            if [[ -n "${mount_points[$i]}" ]]; then
                status="mounted at ${mount_points[$i]}"
            fi
            echo -e "  $((i+1)). ${devices[$i]} [${labels[$i]}] ($status)" >&2
        done

        local selection
        while true; do
            read -rp "Select drive (1-${#devices[@]}): " selection
            if [[ "$selection" =~ ^[0-9]+$ ]] && [[ "$selection" -ge 1 ]] && [[ "$selection" -le ${#devices[@]} ]]; then
                selected_idx=$((selection-1))
                break
            fi
            echo -e "${RED}Invalid selection${NC}" >&2
        done
    fi

    local selected_device="${devices[$selected_idx]}"
    local selected_mount="${mount_points[$selected_idx]}"

    if [[ -z "$selected_mount" ]]; then
        echo -e "${CYAN}Mounting /dev/${selected_device}...${NC}" >&2
        if ! selected_mount=$(mount_partition "$selected_device"); then
            return 1
        fi
        echo -e "${GREEN}Mounted at: ${selected_mount}${NC}" >&2
    else
        echo -e "${GREEN}Found USB drive: ${selected_device} mounted at ${selected_mount}${NC}" >&2
    fi

    echo "$selected_mount"
}

check_dependencies() {
    local missing=()
    local packages=()

    # iconv is needed because Dell ships the catalog XML as UTF-16; grep and
    # python both read it as NUL-separated bytes otherwise and match nothing.
    for cmd in curl cabextract iconv python3 dmidecode sha256sum lsblk; do
        if ! command -v "$cmd" &> /dev/null; then
            missing+=("$cmd")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${YELLOW}Missing dependencies: ${missing[*]}${NC}"
        echo -e "${CYAN}Installing dependencies...${NC}"

        for cmd in "${missing[@]}"; do
            case "$cmd" in
                curl)       packages+=("curl") ;;
                cabextract) packages+=("cabextract") ;;
                iconv)      packages+=("libc-bin") ;;
                python3)    packages+=("python3") ;;
                dmidecode)  packages+=("dmidecode") ;;
                sha256sum)  packages+=("coreutils") ;;
                lsblk)      packages+=("util-linux") ;;
            esac
        done

        if ! (apt-get update -qq && apt-get install -y -qq "${packages[@]}"); then
            echo -e "${RED}Failed to install dependencies${NC}"
            exit 1
        fi

        echo -e "${GREEN}Dependencies installed successfully${NC}"
    fi
}

# Confirm this is a Dell and report the model.
detect_dell_system() {
    local vendor product
    vendor=$(dmidecode -s system-manufacturer 2>/dev/null || echo "")
    product=$(dmidecode -s system-product-name 2>/dev/null || echo "")

    if [[ "$vendor" != *"Dell"* ]]; then
        echo -e "${RED}Not a Dell system (manufacturer: ${vendor:-unknown})${NC}" >&2
        return 1
    fi

    if [[ -z "$product" ]]; then
        echo -e "${RED}Unable to read system product name${NC}" >&2
        return 1
    fi

    echo "$product"
}

# Dell's 4-hex "System ID", which is what the catalog keys models on. It is the
# SMBIOS SKU number, e.g. 097D for an XPS 15 9500. The model *name* is not
# usable as a key: the catalog calls that same machine "XPS Notebook 9500".
get_system_id() {
    local sku
    sku=$(cat /sys/class/dmi/id/product_sku 2>/dev/null || echo "")
    if [[ -z "$sku" || "$sku" == "To be filled by O.E.M." ]]; then
        sku=$(dmidecode -s system-sku-number 2>/dev/null || echo "")
    fi

    sku="${sku//[[:space:]]/}"
    if [[ ! "$sku" =~ ^[0-9A-Fa-f]{3,4}$ ]]; then
        echo -e "${YELLOW}Warning: unexpected system ID '${sku}'${NC}" >&2
    fi
    if [[ -z "$sku" ]]; then
        echo -e "${RED}Unable to read the Dell system ID (SMBIOS SKU number)${NC}" >&2
        return 1
    fi

    echo "$sku"
}

# Running BIOS version, e.g. 1.40.0.
#
# Note this is not the same thing as /sys/class/dmi/id/bios_date. That field is
# the firmware *build* date baked into the image, which can be months earlier
# than Dell's publish date for the same version. Compare versions, not dates.
get_current_bios_version() {
    local bios_version
    bios_version=$(dmidecode -s bios-version 2>/dev/null || echo "")
    bios_version="${bios_version//[[:space:]]/}"

    if [[ -z "$bios_version" ]]; then
        echo -e "${RED}Unable to read BIOS version from SMBIOS${NC}" >&2
        return 1
    fi

    echo "$bios_version"
}

# Compare dotted versions field by field, e.g. 1.40.0 vs 1.9.0.
# A plain string comparison gets this wrong ("1.40.0" < "1.9.0" lexically), and
# the ASUS script's integer compare does not apply because Dell versions are
# multi-field. Missing fields count as zero, so 1.40 == 1.40.0.
# Returns true when $1 >= $2.
version_ge() {
    local a="$1" b="$2" i ai bi
    local -a af=() bf=()
    IFS='.' read -r -a af <<< "$a"
    IFS='.' read -r -a bf <<< "$b"

    for ((i = 0; i < 4; i++)); do
        ai="${af[$i]:-0}"; bi="${bf[$i]:-0}"
        # Non-numeric field: fall back to a string compare and say so, rather
        # than letting bash arithmetic error out under `set -e`.
        if [[ ! "$ai" =~ ^[0-9]+$ || ! "$bi" =~ ^[0-9]+$ ]]; then
            echo -e "${YELLOW}Warning: non-numeric version field ('$a' vs '$b'); comparing as strings${NC}" >&2
            [[ "$a" > "$b" || "$a" == "$b" ]]
            return $?
        fi
        (( 10#$ai > 10#$bi )) && return 0
        (( 10#$ai < 10#$bi )) && return 1
    done
    return 0
}

# Download Dell's catalog index, find this system ID's per-model catalog, fetch
# and verify it, and leave the decoded XML at $TEMP_DIR/model.xml.
fetch_model_catalog() {
    local system_id="$1"

    mkdir -p "$TEMP_DIR"

    echo -e "${CYAN}Downloading Dell catalog index...${NC}" >&2
    if ! curl -sSL --fail -o "${TEMP_DIR}/CatalogIndexPC.cab" "$CATALOG_INDEX_URL"; then
        echo -e "${RED}Failed to download ${CATALOG_INDEX_URL}${NC}" >&2
        return 1
    fi

    # cabextract warns about trailing bytes on Dell's cabs (they append a
    # signature block); the extraction itself is fine, so only a hard failure
    # is treated as an error.
    if ! cabextract -q -d "$TEMP_DIR" "${TEMP_DIR}/CatalogIndexPC.cab" 2>/dev/null; then
        echo -e "${RED}Failed to extract the catalog index${NC}" >&2
        return 1
    fi

    iconv -f UTF-16 -t UTF-8 "${TEMP_DIR}/CatalogIndexPC.xml" -o "${TEMP_DIR}/index.xml"

    local model_path model_sha model_name
    if ! read -r model_path model_sha model_name < <(
        python3 - "$system_id" "${TEMP_DIR}/index.xml" <<'PY'
import re, sys
system_id, path = sys.argv[1], sys.argv[2]
xml = open(path, encoding="utf-8", errors="ignore").read()
for block in re.findall(r"<GroupManifest\b.*?</GroupManifest>", xml, re.S):
    if not re.search(r'systemID="%s"' % re.escape(system_id), block, re.I):
        continue
    m = re.search(r'<ManifestInformation\b[^>]*\bpath="([^"]+)"', block)
    h = re.search(r'<Hash algorithm="SHA256">([0-9a-fA-F]+)</Hash>', block)
    n = re.search(r"<Display lang=\"en\"><!\[CDATA\[(.*?)\]\]>", block, re.S)
    if m:
        print(m.group(1), (h.group(1).lower() if h else "-"), (n.group(1).strip() if n else "-"))
        break
PY
    ); then
        echo -e "${RED}System ID ${system_id} not found in Dell's catalog index${NC}" >&2
        return 1
    fi

    if [[ -z "${model_path:-}" ]]; then
        echo -e "${RED}System ID ${system_id} not found in Dell's catalog index${NC}" >&2
        return 1
    fi

    echo -e "${GRAY}Catalog: ${model_name:-unknown} (${model_path})${NC}" >&2

    echo -e "${CYAN}Downloading model catalog...${NC}" >&2
    if ! curl -sSL --fail -o "${TEMP_DIR}/model.cab" "${CATALOG_BASE}/${model_path}"; then
        echo -e "${RED}Failed to download ${CATALOG_BASE}/${model_path}${NC}" >&2
        return 1
    fi

    if [[ "$model_sha" != "-" ]]; then
        local actual
        actual=$(sha256sum "${TEMP_DIR}/model.cab" | awk '{print $1}')
        if [[ "$actual" != "$model_sha" ]]; then
            echo -e "${RED}Model catalog checksum mismatch${NC}" >&2
            echo -e "${GRAY}  expected ${model_sha}${NC}" >&2
            echo -e "${GRAY}  got      ${actual}${NC}" >&2
            return 1
        fi
        echo -e "${GREEN}Model catalog verified (SHA256)${NC}" >&2
    fi

    rm -f "${TEMP_DIR}"/*097D*.xml "${TEMP_DIR}"/Catalog*.xml 2>/dev/null || true
    cabextract -q -d "$TEMP_DIR" "${TEMP_DIR}/model.cab" 2>/dev/null || true

    local extracted
    extracted=$(find "$TEMP_DIR" -maxdepth 1 -name '*.xml' ! -name 'index.xml' ! -name 'model.xml' | head -1)
    if [[ -z "$extracted" ]]; then
        echo -e "${RED}Model catalog contained no XML${NC}" >&2
        return 1
    fi

    iconv -f UTF-16 -t UTF-8 "$extracted" -o "${TEMP_DIR}/model.xml" 2>/dev/null \
        || cp "$extracted" "${TEMP_DIR}/model.xml"
}

# Pick the newest BIOS component out of the model catalog.
# Sets LATEST_VERSION, RELEASE_DATE, DOWNLOAD_URL, EXPECTED_SIZE.
get_latest_bios_info() {
    local line
    if ! line=$(python3 - "${TEMP_DIR}/model.xml" <<'PY'
import re, sys
xml = open(sys.argv[1], encoding="utf-8", errors="ignore").read()
best = None
for c in re.findall(r"<SoftwareComponent\b.*?</SoftwareComponent>", xml, re.S):
    if not re.search(r'<ComponentType[^>]*value="BIOS"', c):
        continue
    ver = re.search(r'\bdellVersion="([^"]+)"', c)
    path = re.search(r'\bpath="([^"]+)"', c)
    if not ver or not path:
        continue
    date = re.search(r'\breleaseDate="([^"]+)"', c)
    size = re.search(r'\bsize="(\d+)"', c)
    def key(v):
        return [int(x) if x.isdigit() else 0 for x in (v.split(".") + ["0"] * 4)[:4]]
    cand = (key(ver.group(1)), ver.group(1), path.group(1),
            date.group(1) if date else "unknown", size.group(1) if size else "0")
    if best is None or cand[0] > best[0]:
        best = cand
if best:
    print("%s\t%s\t%s\t%s" % (best[1], best[2], best[3], best[4]))
PY
    ) || [[ -z "$line" ]]; then
        echo -e "${RED}No BIOS component found in the model catalog${NC}" >&2
        return 1
    fi

    local version path date size
    IFS=$'\t' read -r version path date size <<< "$line"

    LATEST_VERSION="$version"
    DOWNLOAD_URL="${CATALOG_BASE}/${path}"
    RELEASE_DATE="$date"
    EXPECTED_SIZE="$size"
}

# Download the BIOS .exe and stage it on the USB drive.
install_bios_update() {
    local download_url="$1"
    local version="$2"
    local destination="$3"

    BIOS_FILENAME="${download_url##*/}"
    local staged="${TEMP_DIR}/${BIOS_FILENAME}"

    echo -e "${CYAN}Downloading BIOS ${version}...${NC}"
    if ! curl -sSL --fail -o "$staged" "$download_url"; then
        echo -e "${RED}Download failed: ${download_url}${NC}" >&2
        return 1
    fi

    # The catalog carries a size but no per-file hash for BIOS components, so
    # size is the only integrity check available here. It still catches a
    # truncated transfer or an HTML error page saved as the payload.
    local actual_size
    actual_size=$(stat -c %s "$staged")
    if [[ "$EXPECTED_SIZE" != "0" && "$actual_size" != "$EXPECTED_SIZE" ]]; then
        echo -e "${RED}Size mismatch: expected ${EXPECTED_SIZE} bytes, got ${actual_size}${NC}" >&2
        return 1
    fi
    echo -e "${GREEN}Downloaded ${actual_size} bytes (matches catalog)${NC}"

    if ! cp "$staged" "${destination}/${BIOS_FILENAME}"; then
        echo -e "${RED}Failed to copy the BIOS file to ${destination}${NC}" >&2
        return 1
    fi
    sync

    BIOS_PATH="${destination}/${BIOS_FILENAME}"
}

cleanup() {
    [[ $CLEANED -eq 1 ]] && return 0
    CLEANED=1
    cleanup_mounts
    rm -rf "$TEMP_DIR"
}

main() {
    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}  Dell BIOS Updater${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""

    check_root
    check_dependencies

    local model_name
    if ! model_name=$(detect_dell_system); then
        exit 1
    fi
    echo -e "${WHITE}Detected system: ${model_name}${NC}"

    local system_id
    if ! system_id=$(get_system_id); then
        exit 1
    fi
    echo -e "${WHITE}Dell system ID: ${system_id}${NC}"
    echo ""

    local current_version
    if ! current_version=$(get_current_bios_version); then
        exit 1
    fi
    echo -e "${WHITE}Current BIOS version: ${current_version}${NC}"
    echo ""

    if ! fetch_model_catalog "$system_id"; then
        exit 1
    fi

    if ! get_latest_bios_info; then
        exit 1
    fi

    echo -e "${WHITE}Latest BIOS version: ${LATEST_VERSION}${NC}"
    echo -e "${GRAY}Release date: ${RELEASE_DATE}${NC}"
    echo ""

    if version_ge "$current_version" "$LATEST_VERSION"; then
        echo -e "${GREEN}Your BIOS is already up to date!${NC}"
        echo -e "${GRAY}Current: ${current_version}, Latest: ${LATEST_VERSION}${NC}"
        cleanup
        exit 0
    fi

    echo -e "${YELLOW}Update available: ${current_version} -> ${LATEST_VERSION}${NC}"
    echo ""

    local usb_destination
    if ! usb_destination=$(detect_usb_drive); then
        exit 1
    fi
    echo -e "${WHITE}Target USB drive: ${usb_destination}${NC}"
    echo ""

    if ! install_bios_update "$DOWNLOAD_URL" "$LATEST_VERSION" "$usb_destination"; then
        exit 1
    fi

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  BIOS Update Ready!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "${WHITE}BIOS file: ${BIOS_PATH}${NC}"
    echo ""
    echo -e "${CYAN}To apply the update:${NC}"
    echo -e "${WHITE}  1. Restart your computer${NC}"
    echo -e "${WHITE}  2. Tap F12 during boot for the One Time Boot menu${NC}"
    echo -e "${WHITE}  3. Choose BIOS Update -> Flash from file${NC}"
    echo -e "${WHITE}  4. Select ${BIOS_FILENAME} from the USB drive${NC}"
    echo -e "${WHITE}  5. Confirm, then let it restart on its own${NC}"
    echo ""
    echo -e "${GRAY}The file is a Windows .exe, but the F12 flasher runs it from${NC}"
    echo -e "${GRAY}firmware. No Windows is needed.${NC}"
    echo ""
    echo -e "${RED}WARNING: Keep the charger connected. Do not power off during${NC}"
    echo -e "${RED}the BIOS update, it can permanently damage the system board.${NC}"
    echo ""

    # Unmount before any restart so USB writes are flushed
    cleanup
}

trap cleanup EXIT INT TERM

main "$@"
