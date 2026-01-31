#!/bin/bash
#
# ASUS BIOS Update Script for Ubuntu
#
# Automatically detects the ASUS motherboard model, checks for BIOS updates,
# downloads and prepares the update file for EZ Flash installation.
#
# After running, restart and enter BIOS (F2/Del) -> Tool -> ASUS EZ Flash 3
# Select the .CAP file from the USB drive to apply the update.

set -euo pipefail

# Configuration
TEMP_DIR="/tmp/ASUS_BIOS_Update"
DESTINATION="/mnt/kingston1"

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

    for cmd in curl jq dmidecode unzip; do
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
            esac
        done

        if ! apt-get update -qq && apt-get install -y -qq "${packages[@]}"; then
            echo -e "${RED}Failed to install dependencies${NC}"
            exit 1
        fi

        echo -e "${GREEN}Dependencies installed successfully${NC}"
    fi
}

# Get current BIOS version from system
get_current_bios_version() {
    local bios_version
    bios_version=$(dmidecode -s bios-version 2>/dev/null || echo "")

    echo -e "${CYAN}Current BIOS string: ${bios_version}${NC}" >&2

    # Extract 4-digit version number
    if [[ $bios_version =~ ([0-9]{4}) ]]; then
        echo "${BASH_REMATCH[1]}"
        return 0
    fi

    echo -e "${YELLOW}Warning: Could not parse BIOS version from: ${bios_version}${NC}" >&2
    return 1
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
    local version download_url release_date
    version=$(echo "$response" | jq -r '.Result.Obj[0].Files[0].Version // empty')
    download_url=$(echo "$response" | jq -r '.Result.Obj[0].Files[0].DownloadUrl.Global // empty')
    release_date=$(echo "$response" | jq -r '.Result.Obj[0].Files[0].ReleaseDate // empty')

    if [[ -z "$version" || -z "$download_url" ]]; then
        echo -e "${RED}No BIOS information found in API response${NC}" >&2
        return 1
    fi

    # Export variables for use in main script
    LATEST_VERSION="$version"
    DOWNLOAD_URL="$download_url"
    RELEASE_DATE="$release_date"
}

# Download and extract BIOS update
install_bios_update() {
    local download_url="$1"
    local version="$2"

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
    if ! curl -L -o "$zip_path" "$encoded_url"; then
        echo -e "${RED}Failed to download BIOS package${NC}" >&2
        return 1
    fi

    local file_size
    file_size=$(du -h "$zip_path" | cut -f1)
    echo -e "${GREEN}Downloaded: ${file_size}${NC}"

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

    # Check destination exists
    if [[ ! -d "$DESTINATION" ]]; then
        echo -e "${RED}Destination not found: ${DESTINATION}${NC}" >&2
        echo -e "${YELLOW}Make sure the drive is mounted${NC}" >&2
        return 1
    fi

    # Copy to destination with version name
    local new_name="${version}.CAP"
    local destination_path="${DESTINATION}/${new_name}"

    # Remove existing file if present
    if [[ -f "$destination_path" ]]; then
        echo -e "${YELLOW}Removing existing file: ${destination_path}${NC}"
        rm -f "$destination_path"
    fi

    cp "$cap_file" "$destination_path"

    if [[ -f "$destination_path" ]]; then
        echo -e "${GREEN}BIOS file ready: ${destination_path}${NC}"
        BIOS_PATH="$destination_path"
        return 0
    fi

    echo -e "${RED}Failed to copy BIOS file to ${destination_path}${NC}" >&2
    return 1
}

# Cleanup temporary files
cleanup() {
    if [[ -d "$TEMP_DIR" ]]; then
        rm -rf "$TEMP_DIR"
        echo -e "${GRAY}Cleaned up temporary files${NC}"
    fi
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

    # Compare versions
    if [[ "$current_version" -ge "$LATEST_VERSION" ]]; then
        echo -e "${GREEN}Your BIOS is already up to date!${NC}"
        echo -e "${GRAY}Current: ${current_version}, Latest: ${LATEST_VERSION}${NC}"
        exit 0
    fi

    echo -e "${YELLOW}Update available: ${current_version} -> ${LATEST_VERSION}${NC}"
    echo ""

    # Download and prepare
    if ! install_bios_update "$DOWNLOAD_URL" "$LATEST_VERSION"; then
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
    echo -e "${WHITE}  4. Select the ${LATEST_VERSION}.CAP file from the USB drive${NC}"
    echo -e "${WHITE}  5. Follow the on-screen instructions${NC}"
    echo ""
    echo -e "${RED}WARNING: Do not power off during BIOS update!${NC}"
    echo ""

    read -rp "Restart now to apply BIOS update? (Y/N) " restart_confirm
    if [[ "$restart_confirm" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Restarting in 5 seconds...${NC}"
        sleep 5
        reboot
    else
        echo -e "${YELLOW}Restart when ready to apply the BIOS update.${NC}"
    fi
}

main "$@"
