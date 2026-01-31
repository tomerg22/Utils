<#
.SYNOPSIS
    ASUS BIOS Update Script

.DESCRIPTION
    Automatically detects the ASUS motherboard model, checks for BIOS updates,
    downloads and prepares the update file for EZ Flash installation.

.NOTES
    After running, restart and enter BIOS (F2/Del) -> Tool -> ASUS EZ Flash 3
    Select the .CAP file from C:\ drive to apply the update.
#>

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

# Configuration
$TempDir = Join-Path $env:TEMP "ASUS_BIOS_Update"
$DestinationDrive = "C:\"

function Get-MotherboardModel {
    <#
    .SYNOPSIS
        Detects the motherboard model from the system
    #>
    $baseboard = Get-CimInstance Win32_BaseBoard
    $manufacturer = $baseboard.Manufacturer
    $product = $baseboard.Product

    if (-not $manufacturer -or -not $product) {
        throw "Failed to detect motherboard information"
    }

    Write-Host "Detected manufacturer: $manufacturer" -ForegroundColor Cyan
    Write-Host "Detected product: $product" -ForegroundColor Cyan

    # Verify it's an ASUS board
    if ($manufacturer -notmatch 'ASUS|ASUSTeK') {
        throw "This script only supports ASUS motherboards. Detected manufacturer: $manufacturer"
    }

    return $product
}

function Get-CurrentBiosVersion {
    <#
    .SYNOPSIS
        Gets the current BIOS version from the system
    #>
    $bios = Get-CimInstance Win32_BIOS
    $biosVersion = $bios.SMBIOSBIOSVersion

    Write-Host "Current BIOS string: $biosVersion" -ForegroundColor Cyan

    # Extract 4-digit version number (e.g., "1825" from various formats)
    if ($biosVersion -match '(\d{4})') {
        return $Matches[1]
    }

    Write-Warning "Could not parse BIOS version from: $biosVersion"
    return $null
}

function Get-LatestBiosInfo {
    param(
        [Parameter(Mandatory)]
        [string]$ModelName
    )
    <#
    .SYNOPSIS
        Queries ASUS API for latest BIOS information
    #>
    $modelEncoded = [System.Uri]::EscapeDataString($ModelName)
    $apiUrl = "https://www.asus.com/support/api/product.asmx/GetPDBIOS?website=global&model=$modelEncoded&pdhas498=1"

    Write-Host "Querying ASUS API for $ModelName..." -ForegroundColor Cyan

    try {
        $response = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing

        if (-not $response.Result.Obj -or $response.Result.Obj.Count -eq 0) {
            throw "No BIOS information returned from API"
        }

        # First entry is the latest
        $latest = $response.Result.Obj[0].Files[0]

        if (-not $latest) {
            throw "No BIOS files found in API response"
        }

        return @{
            Version     = $latest.Version
            Title       = $latest.Title
            Description = $latest.Description
            DownloadUrl = $latest.DownloadUrl.Global
            FileSize    = $latest.FileSize
            ReleaseDate = $latest.ReleaseDate
        }
    }
    catch {
        throw "Failed to query ASUS API: $_"
    }
}

function Install-BiosUpdate {
    param(
        [string]$DownloadUrl,
        [string]$Version
    )

    # Create temp directory
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

    # Extract original filename from URL (e.g., PRIME-B760M-K-D4-ASUS-1825.zip)
    $uri = [System.Uri]$DownloadUrl
    $originalFileName = [System.IO.Path]::GetFileName($uri.LocalPath)
    $zipPath = Join-Path $TempDir $originalFileName
    $extractPath = Join-Path $TempDir "extracted"

    # Download BIOS package
    Write-Host "Downloading BIOS update..." -ForegroundColor Cyan
    Write-Host "URL: $DownloadUrl" -ForegroundColor Gray

    $progressPreference = 'SilentlyContinue'  # Speed up download
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $zipPath -UseBasicParsing
    $progressPreference = 'Continue'

    if (-not (Test-Path $zipPath)) {
        throw "Failed to download BIOS package"
    }

    $fileSize = (Get-Item $zipPath).Length / 1MB
    Write-Host "Downloaded: $([math]::Round($fileSize, 2)) MB" -ForegroundColor Green

    # Extract using PowerShell
    Write-Host "Extracting BIOS package..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $extractPath -Force | Out-Null

    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

    # Find .CAP file
    $capFile = Get-ChildItem -Path $extractPath -Filter "*.CAP" -Recurse | Select-Object -First 1

    if (-not $capFile) {
        throw "No .CAP file found in extracted contents"
    }

    Write-Host "Found BIOS file: $($capFile.Name)" -ForegroundColor Green

    # Rename and copy to destination
    $newName = "$Version.CAP"
    $destinationPath = Join-Path $DestinationDrive $newName

    # Check if file already exists
    if (Test-Path $destinationPath) {
        Write-Host "Removing existing file: $destinationPath" -ForegroundColor Yellow
        Remove-Item -Path $destinationPath -Force
    }

    # Copy using binary read/write to preserve exact bytes
    $bytes = [System.IO.File]::ReadAllBytes($capFile.FullName)
    [System.IO.File]::WriteAllBytes($destinationPath, $bytes)

    if (Test-Path $destinationPath) {
        Write-Host "`nBIOS file ready: $destinationPath" -ForegroundColor Green
        return $destinationPath
    }

    throw "Failed to copy BIOS file to $destinationPath"
}

function Remove-TempFiles {
    <#
    .SYNOPSIS
        Cleans up temporary files
    #>
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Cleaned up temporary files" -ForegroundColor Gray
    }
}

# Main execution
try {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  ASUS BIOS Updater" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan

    # Detect motherboard model
    $modelName = Get-MotherboardModel
    Write-Host "Detected motherboard: $modelName`n" -ForegroundColor White

    # Get current BIOS version
    $currentVersion = Get-CurrentBiosVersion
    if (-not $currentVersion) {
        throw "Unable to determine current BIOS version"
    }
    Write-Host "Current BIOS version: $currentVersion`n" -ForegroundColor White

    # Get latest BIOS info from ASUS
    $latestInfo = Get-LatestBiosInfo -ModelName $modelName
    $latestVersion = $latestInfo.Version

    Write-Host "Latest BIOS version: $latestVersion" -ForegroundColor White
    Write-Host "Release date: $($latestInfo.ReleaseDate)" -ForegroundColor Gray
    Write-Host ""

    # Compare versions
    $currentInt = [int]$currentVersion
    $latestInt = [int]$latestVersion

    if ($currentInt -ge $latestInt) {
        Write-Host "Your BIOS is already up to date!" -ForegroundColor Green
        Write-Host "Current: $currentVersion, Latest: $latestVersion" -ForegroundColor Gray
        exit 0
    }

    Write-Host "Update available: $currentVersion -> $latestVersion" -ForegroundColor Yellow
    Write-Host ""

    # Download and prepare
    $biosPath = Install-BiosUpdate -DownloadUrl $latestInfo.DownloadUrl -Version $latestVersion

    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host "  BIOS Update Ready!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "BIOS file: $biosPath" -ForegroundColor White
    Write-Host ""
    Write-Host "To apply the update:" -ForegroundColor Cyan
    Write-Host "  1. Restart your computer" -ForegroundColor White
    Write-Host "  2. Enter BIOS Setup (press F2 or Del during boot)" -ForegroundColor White
    Write-Host "  3. Go to Tool -> ASUS EZ Flash 3 Utility" -ForegroundColor White
    Write-Host "  4. Select the $latestVersion.CAP file from drive C:" -ForegroundColor White
    Write-Host "  5. Follow the on-screen instructions" -ForegroundColor White
    Write-Host ""
    Write-Host "WARNING: Do not power off during BIOS update!" -ForegroundColor Red
    Write-Host ""

    $restartConfirm = Read-Host "Restart now to apply BIOS update? (Y/N)"
    if ($restartConfirm -eq 'Y' -or $restartConfirm -eq 'y') {
        Write-Host "`nRestarting in 5 seconds..." -ForegroundColor Yellow
        Start-Sleep -Seconds 5
        Restart-Computer -Force
    }
    else {
        Write-Host "`nRestart when ready to apply the BIOS update." -ForegroundColor Yellow
    }
}
catch {
    Write-Host "`nERROR: $_" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor Gray
    exit 1
}
finally {
    Remove-TempFiles
}
