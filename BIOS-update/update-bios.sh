#!/bin/bash
#
# BIOS Update Script for Ubuntu - ASUS and Dell
#
# Detects the vendor from SMBIOS, finds the newest BIOS that vendor publishes,
# verifies the download, and stages it on a FAT32 USB drive. The flash itself
# is always done by the machine's own firmware, so no vendor tool and no
# Windows is ever involved.
#
#   ASUS  restart -> BIOS (F2/Del) -> Tool -> ASUS EZ Flash 3, pick the .CAP
#   Dell  restart -> F12 -> BIOS Update -> Flash from file, pick the .exe
#
# Where the version comes from differs by vendor, because the vendors differ:
#
#   ASUS  the support API returns JSON with a version, a download URL and a
#         published sha256, so the download is hash-verified before anything
#         reaches the USB drive.
#
#   Dell  downloads.dell.com/catalog, the feed Dell Command Update consumes.
#         Not dell.com/support: that page renders its driver table only after
#         a service tag is entered or the "All <model>" tab is picked, and
#         ships the payload Caesar-shifted. The catalog is plain XML, and the
#         per-model catalog is SHA256-verified against the index before it is
#         parsed. fwupd is not an option for Dell consumer laptops, which are
#         not published to LVFS; on an XPS 15 9500 `fwupdmgr get-releases` for
#         System Firmware returns nothing regardless of fwupd version.
#
# Requires root (dmidecode, mount). Run with: sudo ./update-bios.sh

set -euo pipefail

# Configuration
TEMP_DIR="/tmp/BIOS_Update"
MOUNT_BASE="/mnt/bios-update"
CATALOG_BASE="https://downloads.dell.com"
CATALOG_INDEX_URL="${CATALOG_BASE}/catalog/CatalogIndexPC.cab"
CLEANED=0

# Which vendor's logic to use: "asus" or "dell". main() sets it from SMBIOS.
# It is left presettable so the test suite can pin one vendor's behaviour
# without a matching machine underneath it.
VENDOR="${VENDOR:-}"

# Filled in by the per-vendor lookups, read by main() and the installers.
MODEL=""
SYSTEM_ID=""
LATEST_VERSION=""
RELEASE_DATE=""
DOWNLOAD_URL=""
EXPECTED_SHA256=""
EXPECTED_SIZE="0"
BIOS_PATH=""
BIOS_FILENAME=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

# =============================================================================
# Shared helpers
# =============================================================================

check_root() {
    if [[ $EUID -ne 0 ]]; then
        echo -e "${RED}This script must be run as root (for dmidecode access)${NC}"
        echo "Run with: sudo $0"
        exit 1
    fi
}

kv() {
    local line="$1" key="$2"
    if [[ $line =~ (^|[[:space:]])${key}=\"([^\"]*)\" ]]; then
        printf '%s' "${BASH_REMATCH[2]}"
    fi
}

# Rows from the last `lsblk -P` read, so a partition can look up its parent.
LSBLK_ROWS=()

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


# =============================================================================
# Vendor selection, dependencies, dispatch
# =============================================================================

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

# Which vendor's code path to take, from the SMBIOS system manufacturer.
# Board manufacturer is deliberately not used: on a Dell laptop it names an
# ODM, while system-manufacturer is "Dell Inc." consistently.
detect_vendor() {
    local manufacturer
    manufacturer=$(dmidecode -s system-manufacturer 2>/dev/null || echo "")

    case "$manufacturer" in
        *[Aa][Ss][Uu][Ss]*) echo "asus" ;;
        *[Dd][Ee][Ll][Ll]*) echo "dell" ;;
        *)
            echo -e "${RED}Unsupported system manufacturer: ${manufacturer:-unknown}${NC}" >&2
            echo -e "${YELLOW}This script handles ASUS and Dell systems.${NC}" >&2
            return 1
            ;;
    esac
}

# Fail loudly rather than guessing. Every dispatcher below routes on $VENDOR,
# and a silent default would mean running one vendor's flashing logic against
# the other's hardware.
require_vendor() {
    if [[ -z "$VENDOR" ]]; then
        echo -e "${RED}Internal error: VENDOR is not set${NC}" >&2
        return 1
    fi
}

check_dependencies() {
    require_vendor || return 1

    local missing=() packages=() needed=(curl dmidecode sha256sum lsblk)

    case "$VENDOR" in
        asus) needed+=(jq unzip) ;;
        # iconv is needed because Dell ships the catalog XML as UTF-16; grep
        # and python both read it as NUL-separated bytes otherwise and match
        # nothing.
        dell) needed+=(cabextract iconv python3) ;;
    esac

    for cmd in "${needed[@]}"; do
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
                jq)         packages+=("jq") ;;
                unzip)      packages+=("unzip") ;;
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

# --- dispatchers -----------------------------------------------------------
#
# These keep the generic names so each vendor's implementation stays a
# self-contained unit that can be read, and tested, on its own.

get_current_bios_version() {
    require_vendor || return 1
    case "$VENDOR" in
        asus) asus_bios_version ;;
        dell) dell_bios_version ;;
    esac
}

# True when $1 >= $2, using the comparison that vendor's versions need.
version_ge() {
    require_vendor || return 1
    case "$VENDOR" in
        asus) asus_version_ge "$1" "$2" ;;
        dell) dell_version_ge "$1" "$2" ;;
    esac
}

get_latest_bios_info() {
    require_vendor || return 1
    case "$VENDOR" in
        asus) asus_latest_bios "$MODEL" ;;
        dell) fetch_model_catalog "$SYSTEM_ID" && dell_latest_bios ;;
    esac
}

install_bios_update() {
    require_vendor || return 1
    case "$VENDOR" in
        asus) asus_install_bios "$1" "$2" "$3" ;;
        dell) dell_install_bios "$1" "$2" "$3" ;;
    esac
}


# =============================================================================
# ASUS
# =============================================================================

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

asus_bios_version() {
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

asus_version_ge() {
    local a="${1#"${1%%[!0]*}"}" b="${2#"${2%%[!0]*}"}"   # strip leading zeros
    a="${a:-0}"; b="${b:-0}"
    if [[ ! "$a" =~ ^[0-9]+$ || ! "$b" =~ ^[0-9]+$ ]]; then
        echo -e "${YELLOW}Warning: non-numeric version ('$1' vs '$2'); comparing as strings${NC}" >&2
        [[ "$1" > "$2" || "$1" == "$2" ]]
        return $?
    fi
    (( 10#$a >= 10#$b ))
}

asus_latest_bios() {
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

asus_install_bios() {
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

    # Rename to <version>.CAP on the destination (e.g. 4004.CAP). EZ Flash 3
    # accepts any filename and this short name is easy to pick in the utility.
    # (USB BIOS FlashBack is different - it needs a board-specific name that
    # ASUS's BIOSRenamer.exe generates from the ORIGINAL download filename, so
    # for FlashBack run BIOSRenamer on the unzipped download rather than this.)
    local new_name="${version}.CAP"
    local destination_path="${destination}/${new_name}"

    # Remove existing file if present
    if [[ -f "$destination_path" ]]; then
        echo -e "${YELLOW}Removing existing file: ${destination_path}${NC}"
        rm -f "$destination_path"
    fi

    cp "$cap_file" "$destination_path"

    if [[ -f "$destination_path" ]]; then
        # Flush to the USB device before we report success.
        sync
        echo -e "${GREEN}BIOS file ready: ${destination_path}${NC}"
        BIOS_PATH="$destination_path"
        BIOS_FILENAME="$new_name"
        return 0
    fi

    echo -e "${RED}Failed to copy BIOS file to ${destination_path}${NC}" >&2
    return 1
}


# =============================================================================
# Dell
# =============================================================================

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

dell_bios_version() {
    local bios_version
    bios_version=$(dmidecode -s bios-version 2>/dev/null || echo "")
    bios_version="${bios_version//[[:space:]]/}"

    if [[ -z "$bios_version" ]]; then
        echo -e "${RED}Unable to read BIOS version from SMBIOS${NC}" >&2
        return 1
    fi

    echo "$bios_version"
}

dell_version_ge() {
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

dell_latest_bios() {
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

dell_install_bios() {
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


# =============================================================================
# Entry point
# =============================================================================

# Per-vendor closing instructions. Kept apart from main() because the two
# firmwares are driven completely differently.
asus_flash_instructions() {
    echo -e "${CYAN}To apply the update:${NC}"
    echo -e "${WHITE}  1. Restart your computer${NC}"
    echo -e "${WHITE}  2. Enter BIOS Setup (press F2 or Del during boot)${NC}"
    echo -e "${WHITE}  3. Go to Tool -> ASUS EZ Flash 3 Utility${NC}"
    echo -e "${WHITE}  4. Select ${BIOS_FILENAME} from the USB drive${NC}"
    echo -e "${WHITE}  5. Follow the on-screen instructions${NC}"
}

dell_flash_instructions() {
    echo -e "${CYAN}To apply the update:${NC}"
    echo -e "${WHITE}  1. Restart your computer${NC}"
    echo -e "${WHITE}  2. Tap F12 during boot for the One Time Boot menu${NC}"
    echo -e "${WHITE}  3. Choose BIOS Update -> Flash from file${NC}"
    echo -e "${WHITE}  4. Select ${BIOS_FILENAME} from the USB drive${NC}"
    echo -e "${WHITE}  5. Confirm, then let it restart on its own${NC}"
    echo ""
    echo -e "${GRAY}The file is a Windows .exe, but the F12 flasher runs it from${NC}"
    echo -e "${GRAY}firmware. No Windows is needed.${NC}"
}

# Identify the machine and fill MODEL (and SYSTEM_ID on Dell).
identify_system() {
    case "$VENDOR" in
        asus)
            MODEL=$(detect_motherboard) || return 1
            echo -e "${WHITE}Detected motherboard: ${MODEL}${NC}"
            ;;
        dell)
            MODEL=$(detect_dell_system) || return 1
            SYSTEM_ID=$(get_system_id) || return 1
            echo -e "${WHITE}Detected system: ${MODEL}${NC}"
            echo -e "${WHITE}Dell system ID: ${SYSTEM_ID}${NC}"
            ;;
    esac
}

main() {
    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}  BIOS Updater${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""

    check_root

    if ! VENDOR=$(detect_vendor); then
        exit 1
    fi
    echo -e "${WHITE}Vendor: ${VENDOR}${NC}"

    check_dependencies

    if ! identify_system; then
        exit 1
    fi
    echo ""

    local current_version
    if ! current_version=$(get_current_bios_version); then
        echo -e "${RED}Unable to determine current BIOS version${NC}"
        exit 1
    fi
    echo -e "${WHITE}Current BIOS version: ${current_version}${NC}"
    echo ""

    if ! get_latest_bios_info; then
        exit 1
    fi

    echo -e "${WHITE}Latest BIOS version: ${LATEST_VERSION}${NC}"
    echo -e "${GRAY}Release date: ${RELEASE_DATE}${NC}"
    echo ""

    if version_ge "$current_version" "$LATEST_VERSION"; then
        echo -e "${GREEN}Your BIOS is already up to date!${NC}"
        echo -e "${GRAY}Current: ${current_version}, Latest: ${LATEST_VERSION}${NC}"
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
    "${VENDOR}_flash_instructions"
    echo ""
    echo -e "${RED}WARNING: Keep the charger connected. Do not power off during${NC}"
    echo -e "${RED}the BIOS update, it can permanently damage the board.${NC}"
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

# Set trap for cleanup on exit
trap cleanup EXIT

# Only run when executed directly, so the test suite can source this file and
# exercise the functions in isolation.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
