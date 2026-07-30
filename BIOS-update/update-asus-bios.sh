#!/bin/bash
#
# ASUS BIOS Update Script for Ubuntu
#
# Automatically detects the ASUS motherboard model, checks for BIOS updates,
# downloads and prepares the update file for EZ Flash installation.
#
# After running, restart and enter BIOS (F2/Del) -> Tool -> ASUS EZ Flash 3
# Select the .CAP file from the USB drive to apply the update.
#
# Requires root (dmidecode, mount). Run with: sudo ./update-asus-bios.sh

set -euo pipefail

# Configuration
TEMP_DIR="/tmp/ASUS_BIOS_Update"
MOUNT_BASE="/mnt/bios-update"
TEMP_MOUNTS=()
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

    # Create mount point
    if [[ ! -d "$mount_point" ]]; then
        mkdir -p "$mount_point"
    fi

    # Mount the partition
    if mount -t vfat "/dev/$device" "$mount_point" 2>/dev/null; then
        TEMP_MOUNTS+=("$mount_point")
        echo "$mount_point"
        return 0
    fi

    echo -e "${RED}Failed to mount /dev/$device${NC}" >&2
    rmdir "$mount_point" 2>/dev/null || true
    return 1
}

# Cleanup temporary mounts
cleanup_mounts() {
    # Length check first: expanding an empty array under `set -u` errors on
    # bash < 4.4.
    [[ ${#TEMP_MOUNTS[@]} -eq 0 ]] && return 0
    local mount_point
    for mount_point in "${TEMP_MOUNTS[@]}"; do
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
# properties, so they never appear on the same row. PKNAME links a partition
# back to its parent disk, and the transport is resolved from there.
detect_usb_drive() {
    local devices=() mount_points=() labels=()
    local i line

    # Pass 1: collect every row. Kept in a plain indexed array rather than an
    # associative one so this also runs on bash 3.2.
    LSBLK_ROWS=()
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        LSBLK_ROWS+=("$line")
    done < <(lsblk -P -o NAME,TRAN,FSTYPE,MOUNTPOINT,PKNAME,LABEL 2>/dev/null)

    if [[ ${#LSBLK_ROWS[@]} -eq 0 ]]; then
        echo -e "${RED}lsblk returned no block devices${NC}" >&2
        return 1
    fi

    # Pass 2: keep vfat filesystems whose own or parent transport is usb.
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
        # Multiple drives found - let user choose
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

    # If not mounted, mount it
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

# Detect motherboard model from system
detect_motherboard() {
    local manufacturer
    local product

    manufacturer=$(dmidecode -s baseboard-manufacturer 2>/dev/null || echo "")
    product=$(dmidecode -s baseboard-product-name 2>/dev/null || echo "")

    if [[ -z "$manufacturer" || -z "$product" ]]; then
        echo -e "${RED}Failed to detect motherboard information${NC}" >&2
        return 1
    fi

    echo -e "${CYAN}Detected manufacturer: ${manufacturer}${NC}" >&2
    echo -e "${CYAN}Detected product: ${product}${NC}" >&2

    # Verify it's an ASUS board
    if [[ ! "$manufacturer" =~ [Aa][Ss][Uu][Ss] ]]; then
        echo -e "${RED}This script only supports ASUS motherboards${NC}" >&2
        echo -e "${RED}Detected manufacturer: ${manufacturer}${NC}" >&2
        return 1
    fi

    # Return the product name (this is what ASUS API expects)
    echo "$product"
}

# Check and install required dependencies
check_dependencies() {
    local missing=()
    local packages=()

    for cmd in curl jq dmidecode unzip sha256sum lsblk; do
        if ! command -v "$cmd" &> /dev/null; then
            missing+=("$cmd")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${YELLOW}Missing dependencies: ${missing[*]}${NC}"
        echo -e "${CYAN}Installing dependencies...${NC}"

        # Map commands to package names
        for cmd in "${missing[@]}"; do
            case "$cmd" in
                curl)      packages+=("curl") ;;
                jq)        packages+=("jq") ;;
                dmidecode) packages+=("dmidecode") ;;
                unzip)     packages+=("unzip") ;;
                sha256sum) packages+=("coreutils") ;;
                lsblk)     packages+=("util-linux") ;;
            esac
        done

        if ! (apt-get update -qq && apt-get install -y -qq "${packages[@]}"); then
            echo -e "${RED}Failed to install dependencies${NC}"
            exit 1
        fi

        echo -e "${GREEN}Dependencies installed successfully${NC}"
    fi
}

# Get current BIOS version from system
#
# ASUS reports a bare 4-digit version, but the SMBIOS string is free-form and
# can carry other numbers (dates, vendor versions). Prefer a standalone
# 4-digit token; if several exist, take the last and say so rather than
# silently trusting the first match.
get_current_bios_version() {
    local bios_version
    bios_version=$(dmidecode -s bios-version 2>/dev/null || echo "")

    echo -e "${CYAN}Current BIOS string: ${bios_version}${NC}" >&2

    local -a tokens=()
    local tok
    # Split on runs of non-digits, then keep whole 4-digit tokens. A single
    # regex with trailing context would not work: with `grep -o` the context
    # character of one match consumes the leading context of the next, so
    # "... 2026 1838" would yield only 2026.
    while read -r tok; do
        [[ -n "$tok" ]] && tokens+=("$tok")
    done < <(tr -cs '0-9' '\n' <<<"$bios_version" | grep -xE '[0-9]{4}' || true)

    if [[ ${#tokens[@]} -eq 0 ]]; then
        echo -e "${YELLOW}Warning: Could not parse a 4-digit BIOS version from: ${bios_version}${NC}" >&2
        return 1
    fi

    if [[ ${#tokens[@]} -gt 1 ]]; then
        echo -e "${YELLOW}Warning: multiple 4-digit values in BIOS string (${tokens[*]}); using last${NC}" >&2
    fi

    # Computed index rather than ${tokens[-1]}: negative subscripts need bash 4.3
    echo "${tokens[$((${#tokens[@]} - 1))]}"
}

# Compare two BIOS versions numerically.
# Forces base 10: bash arithmetic reads a leading zero as octal, so "0805"
# errors ("value too great for base") and "0710" is silently read as 456.
version_ge() {
    local a="${1#"${1%%[!0]*}"}" b="${2#"${2%%[!0]*}"}"   # strip leading zeros
    a="${a:-0}"; b="${b:-0}"
    if [[ ! "$a" =~ ^[0-9]+$ || ! "$b" =~ ^[0-9]+$ ]]; then
        echo -e "${YELLOW}Warning: non-numeric version ('$1' vs '$2'); comparing as strings${NC}" >&2
        [[ "$1" > "$2" || "$1" == "$2" ]]
        return $?
    fi
    (( 10#$a >= 10#$b ))
}

# Query ASUS API for latest BIOS information
get_latest_bios_info() {
    local model_name="$1"
    local model_encoded
    local api_url

    model_encoded=$(echo "$model_name" | sed 's/ /%20/g')
    api_url="https://www.asus.com/support/api/product.asmx/GetPDBIOS?website=global&model=${model_encoded}&pdhas498=1"

    echo -e "${CYAN}Querying ASUS API for ${model_name}...${NC}"

    local response
    response=$(curl -s "$api_url")

    if [[ -z "$response" ]]; then
        echo -e "${RED}Failed to query ASUS API${NC}" >&2
        return 1
    fi

    # Parse JSON response - extract first (latest) BIOS entry
    local version download_url release_date sha256
    version=$(echo "$response" | jq -r '.Result.Obj[0].Files[0].Version // empty')
    download_url=$(echo "$response" | jq -r '.Result.Obj[0].Files[0].DownloadUrl.Global // empty')
    release_date=$(echo "$response" | jq -r '.Result.Obj[0].Files[0].ReleaseDate // empty')
    sha256=$(echo "$response" | jq -r '.Result.Obj[0].Files[0].sha256 // empty')

    if [[ -z "$version" || -z "$download_url" ]]; then
        echo -e "${RED}No BIOS information found in API response${NC}" >&2
        return 1
    fi

    # Export variables for use in main script
    LATEST_VERSION="$version"
    DOWNLOAD_URL="$download_url"
    RELEASE_DATE="$release_date"
    EXPECTED_SHA256=$(printf '%s' "$sha256" | tr 'A-Z' 'a-z')
}

# Download and extract BIOS update
install_bios_update() {
    local download_url="$1"
    local version="$2"
    local destination="$3"

    # Create temp directory
    rm -rf "$TEMP_DIR"
    mkdir -p "$TEMP_DIR"

    # Extract original filename from URL
    local original_filename
    original_filename=$(basename "${download_url%%\?*}")
    local zip_path="${TEMP_DIR}/${original_filename}"
    local extract_path="${TEMP_DIR}/extracted"

    # Download BIOS package
    echo -e "${CYAN}Downloading BIOS update...${NC}"
    echo -e "${GRAY}URL: ${download_url}${NC}"

    # Encode spaces in URL
    local encoded_url="${download_url// /%20}"
    if ! curl -fL -o "$zip_path" "$encoded_url"; then
        echo -e "${RED}Failed to download BIOS package${NC}" >&2
        return 1
    fi

    local file_size
    file_size=$(du -h "$zip_path" | cut -f1)
    echo -e "${GREEN}Downloaded: ${file_size}${NC}"

    # Verify integrity BEFORE anything gets written to the USB drive.
    # A corrupted .CAP flashed by EZ Flash can leave the board unbootable,
    # so a failed check is fatal, never a warning.
    if [[ -n "${EXPECTED_SHA256:-}" ]]; then
        echo -e "${CYAN}Verifying SHA-256 against ASUS-published hash...${NC}"
        local actual_sha
        actual_sha=$(sha256sum "$zip_path" | awk '{print $1}' | tr 'A-Z' 'a-z')
        if [[ "$actual_sha" != "$EXPECTED_SHA256" ]]; then
            echo -e "${RED}SHA-256 MISMATCH - refusing to continue${NC}" >&2
            echo -e "${RED}  expected: ${EXPECTED_SHA256}${NC}" >&2
            echo -e "${RED}  actual:   ${actual_sha}${NC}" >&2
            echo -e "${YELLOW}The download is corrupt or tampered with. Do not flash it.${NC}" >&2
            return 1
        fi
        echo -e "${GREEN}SHA-256 verified: ${actual_sha}${NC}"
    else
        echo -e "${YELLOW}Warning: ASUS published no SHA-256 for this release${NC}"
        echo -e "${CYAN}Falling back to archive integrity test...${NC}"
        if ! unzip -tq "$zip_path"; then
            echo -e "${RED}Archive is corrupt - refusing to continue${NC}" >&2
            return 1
        fi
        echo -e "${GREEN}Archive integrity OK${NC}"
    fi

    # Extract
    echo -e "${CYAN}Extracting BIOS package...${NC}"
    mkdir -p "$extract_path"

    if ! unzip -q "$zip_path" -d "$extract_path"; then
        echo -e "${RED}Failed to extract BIOS package${NC}" >&2
        return 1
    fi

    # Find .CAP file
    local cap_file
    cap_file=$(find "$extract_path" -iname "*.CAP" -type f | head -n 1)

    if [[ -z "$cap_file" ]]; then
        echo -e "${RED}No .CAP file found in extracted contents${NC}" >&2
        return 1
    fi

    echo -e "${GREEN}Found BIOS file: $(basename "$cap_file")${NC}"

    # Keep ASUS's original filename. It already encodes board and version
    # (e.g. PRIME-B760M-K-D4-ASUS-1838.CAP), and USB BIOS FlashBack expects a
    # specific board name that renaming to "<version>.CAP" would destroy.
    # ASUS ships BIOSRenamer.exe in the archive for exactly that purpose.
    local cap_name
    cap_name=$(basename "$cap_file")
    local destination_path="${destination}/${cap_name}"

    # Remove existing file if present
    if [[ -f "$destination_path" ]]; then
        echo -e "${YELLOW}Removing existing file: ${destination_path}${NC}"
        rm -f "$destination_path"
    fi

    cp "$cap_file" "$destination_path"

    # Copy BIOSRenamer alongside if present - needed to rename the .CAP for
    # USB BIOS FlashBack (the rear-panel button method).
    local renamer
    renamer=$(find "$extract_path" -iname "BIOSRenamer*.exe" -type f | head -n 1)
    if [[ -n "$renamer" ]]; then
        cp "$renamer" "${destination}/$(basename "$renamer")" 2>/dev/null || true
        echo -e "${GRAY}Also copied $(basename "$renamer") (for USB BIOS FlashBack)${NC}"
    fi

    if [[ -f "$destination_path" ]]; then
        # Flush to the USB device before we report success.
        sync
        echo -e "${GREEN}BIOS file ready: ${destination_path}${NC}"
        BIOS_PATH="$destination_path"
        BIOS_FILENAME="$cap_name"
        return 0
    fi

    echo -e "${RED}Failed to copy BIOS file to ${destination_path}${NC}" >&2
    return 1
}

# Cleanup temporary files and mounts (idempotent - also runs from the EXIT trap)
cleanup() {
    if [[ $CLEANED -eq 1 ]]; then
        return 0
    fi
    CLEANED=1

    if [[ -d "$TEMP_DIR" ]]; then
        rm -rf "$TEMP_DIR"
        echo -e "${GRAY}Cleaned up temporary files${NC}"
    fi
    cleanup_mounts
}

# Set trap for cleanup on exit
trap cleanup EXIT

# Main execution
main() {
    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}  ASUS BIOS Updater${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""

    check_root
    check_dependencies

    # Detect motherboard model
    local model_name
    if ! model_name=$(detect_motherboard); then
        echo -e "${RED}Unable to detect motherboard model${NC}"
        exit 1
    fi
    echo -e "${WHITE}Detected motherboard: ${model_name}${NC}"
    echo ""

    # Get current BIOS version
    local current_version
    if ! current_version=$(get_current_bios_version); then
        echo -e "${RED}Unable to determine current BIOS version${NC}"
        exit 1
    fi
    echo -e "${WHITE}Current BIOS version: ${current_version}${NC}"
    echo ""

    # Get latest BIOS info from ASUS
    if ! get_latest_bios_info "$model_name"; then
        exit 1
    fi

    echo -e "${WHITE}Latest BIOS version: ${LATEST_VERSION}${NC}"
    echo -e "${GRAY}Release date: ${RELEASE_DATE}${NC}"
    echo ""

    # Compare versions (base-10 safe)
    if version_ge "$current_version" "$LATEST_VERSION"; then
        echo -e "${GREEN}Your BIOS is already up to date!${NC}"
        echo -e "${GRAY}Current: ${current_version}, Latest: ${LATEST_VERSION}${NC}"
        exit 0
    fi

    echo -e "${YELLOW}Update available: ${current_version} -> ${LATEST_VERSION}${NC}"
    echo ""

    # Detect USB drive
    local usb_destination
    if ! usb_destination=$(detect_usb_drive); then
        exit 1
    fi
    echo -e "${WHITE}Target USB drive: ${usb_destination}${NC}"
    echo ""

    # Download and prepare
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
    echo -e "${WHITE}  2. Enter BIOS Setup (press F2 or Del during boot)${NC}"
    echo -e "${WHITE}  3. Go to Tool -> ASUS EZ Flash 3 Utility${NC}"
    echo -e "${WHITE}  4. Select ${BIOS_FILENAME} from the USB drive${NC}"
    echo -e "${WHITE}  5. Follow the on-screen instructions${NC}"
    echo ""
    echo -e "${RED}WARNING: Do not power off during BIOS update!${NC}"
    echo ""

    # Unmount before any restart so USB writes are flushed
    cleanup

    read -rp "Restart now to apply BIOS update? (Y/N) " restart_confirm
    if [[ "$restart_confirm" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Restarting...${NC}"
        reboot
    else
        echo -e "${YELLOW}Restart when ready to apply the BIOS update.${NC}"
    fi
}

main "$@"
