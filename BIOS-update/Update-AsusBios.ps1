<#
.SYNOPSIS
    ASUS BIOS Update Script

.DESCRIPTION
    Automatically detects the ASUS motherboard model, checks for BIOS updates,
    downloads and prepares the update file for EZ Flash installation.

    The downloaded package is verified against the SHA-256 hash ASUS publishes
    in its own API before anything is written to the USB drive.

.NOTES
    After running, restart and enter BIOS (F2/Del) -> Tool -> ASUS EZ Flash 3
    Select the .CAP file from the USB drive to apply the update.
#>

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

# Configuration
# GetTempPath() resolves %TEMP% on Windows and never returns null, unlike
# $env:TEMP which is unset on non-Windows hosts.
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "ASUS_BIOS_Update"
$script:TempDriveLetters = @()

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

function Get-NextAvailableDriveLetter {
    <#
    .SYNOPSIS
        Finds the next available drive letter
    #>
    $usedLetters = (Get-Volume | Where-Object { $_.DriveLetter }).DriveLetter
    $available = [char[]]('D'..'Z') | Where-Object { $_ -notin $usedLetters }
    if ($available.Count -eq 0) {
        throw "No available drive letters"
    }
    return $available[0]
}

function Mount-UsbPartition {
    <#
    .SYNOPSIS
        Assigns a drive letter to an unmounted partition
    #>
    param(
        [Parameter(Mandatory)]
        [string]$PartitionId
    )

    $driveLetter = Get-NextAvailableDriveLetter
    $partition = Get-Partition | Where-Object { $_.UniqueId -eq $PartitionId }

    if (-not $partition) {
        throw "Partition not found: $PartitionId"
    }

    $partition | Set-Partition -NewDriveLetter $driveLetter
    $script:TempDriveLetters += $driveLetter

    Write-Host "Assigned drive letter ${driveLetter}: to partition" -ForegroundColor Cyan
    return "${driveLetter}:"
}

function Remove-TempDriveLetters {
    <#
    .SYNOPSIS
        Removes temporarily assigned drive letters
    #>
    foreach ($letter in $script:TempDriveLetters) {
        try {
            $partition = Get-Partition -DriveLetter $letter -ErrorAction SilentlyContinue
            if ($partition) {
                $partition | Remove-PartitionAccessPath -AccessPath "${letter}:\" -ErrorAction SilentlyContinue
                Write-Host "Removed drive letter ${letter}:" -ForegroundColor Gray
            }
        }
        catch {
            # Ignore errors during cleanup
        }
    }
}

function Get-UsbDrive {
    <#
    .SYNOPSIS
        Detects FAT32-formatted USB drives (mounted or unmounted)
    #>
    $usbDrives = @()

    # Get USB disk drives
    $usbDisks = Get-CimInstance Win32_DiskDrive | Where-Object { $_.InterfaceType -eq 'USB' }

    foreach ($disk in $usbDisks) {
        # Get partitions for this disk
        $partitions = Get-CimInstance -Query "ASSOCIATORS OF {Win32_DiskDrive.DeviceID='$($disk.DeviceID)'} WHERE AssocClass=Win32_DiskDriveToDiskPartition"

        foreach ($partition in $partitions) {
            # Get the partition object for potential mounting
            $diskNumber = $disk.DeviceID -replace '.*PHYSICALDRIVE(\d+).*', '$1'
            $partObj = Get-Partition -DiskNumber $diskNumber -ErrorAction SilentlyContinue |
                       Where-Object { $_.Offset -eq $partition.StartingOffset }

            # Get logical disks (drive letters) for this partition
            $logicalDisks = Get-CimInstance -Query "ASSOCIATORS OF {Win32_DiskPartition.DeviceID='$($partition.DeviceID)'} WHERE AssocClass=Win32_LogicalDiskToPartition"

            if ($logicalDisks) {
                foreach ($logicalDisk in $logicalDisks) {
                    $volume = Get-Volume -DriveLetter $logicalDisk.DeviceID.TrimEnd(':') -ErrorAction SilentlyContinue
                    if ($volume -and $volume.FileSystem -eq 'FAT32') {
                        $usbDrives += @{
                            DriveLetter  = $logicalDisk.DeviceID
                            Label        = $volume.FileSystemLabel
                            Size         = [math]::Round($volume.Size / 1GB, 2)
                            Model        = $disk.Model
                            IsMounted    = $true
                            PartitionId  = $null
                        }
                    }
                }
            }
            elseif ($partObj) {
                # Partition exists but no drive letter - check if FAT32
                # Try to get volume info via partition
                $volume = Get-Volume -Partition $partObj -ErrorAction SilentlyContinue
                if ($volume -and $volume.FileSystem -eq 'FAT32') {
                    $usbDrives += @{
                        DriveLetter  = $null
                        Label        = $volume.FileSystemLabel
                        Size         = [math]::Round($volume.Size / 1GB, 2)
                        Model        = $disk.Model
                        IsMounted    = $false
                        PartitionId  = $partObj.UniqueId
                    }
                }
            }
        }
    }

    if ($usbDrives.Count -eq 0) {
        throw "No FAT32-formatted USB drives found. Please insert a FAT32 USB drive."
    }

    $selectedIdx = 0

    if ($usbDrives.Count -gt 1) {
        # Multiple drives - let user choose
        Write-Host "Multiple FAT32 USB drives found:" -ForegroundColor Yellow
        for ($i = 0; $i -lt $usbDrives.Count; $i++) {
            $drive = $usbDrives[$i]
            $status = if ($drive.IsMounted) { $drive.DriveLetter } else { "not mounted" }
            Write-Host "  $($i + 1). [$($drive.Label)] - $($drive.Model) ($($drive.Size) GB) - $status"
        }

        # Reject non-numeric input instead of letting [int] throw
        $selectionInt = 0
        do {
            $selection = Read-Host "Select drive (1-$($usbDrives.Count))"
            if (-not [int]::TryParse($selection, [ref]$selectionInt)) {
                Write-Host "Invalid selection" -ForegroundColor Red
                $selectionInt = 0
            }
        } while ($selectionInt -lt 1 -or $selectionInt -gt $usbDrives.Count)

        $selectedIdx = $selectionInt - 1
    }

    $selected = $usbDrives[$selectedIdx]

    if (-not $selected.IsMounted) {
        Write-Host "Mounting partition..." -ForegroundColor Cyan
        $driveLetter = Mount-UsbPartition -PartitionId $selected.PartitionId
        Write-Host "Mounted at: $driveLetter" -ForegroundColor Green
        return $driveLetter
    }

    Write-Host "Found USB drive: $($selected.DriveLetter) [$($selected.Label)] ($($selected.Size) GB)" -ForegroundColor Green
    return $selected.DriveLetter
}

function Get-CurrentBiosVersion {
    <#
    .SYNOPSIS
        Gets the current BIOS version from the system

    .DESCRIPTION
        ASUS reports a bare 4-digit version, but the SMBIOS string is free-form
        and can carry other numbers (dates, vendor versions). Prefer a
        standalone 4-digit token; if several exist, take the last and warn
        rather than silently trusting the first match.
    #>
    $bios = Get-CimInstance Win32_BIOS
    $biosVersion = $bios.SMBIOSBIOSVersion

    Write-Host "Current BIOS string: $biosVersion" -ForegroundColor Cyan

    # @(...) forces an array. Without it, a single match makes $tokens a scalar
    # [string], and $tokens[-1] then indexes the last CHARACTER ("1825" -> "5")
    # instead of the last token. With >=2 matches it was already an array, so
    # the bug only bit the common single-version case.
    $tokens = @(
        [regex]::Matches($biosVersion, '(?<![0-9])[0-9]{4}(?![0-9])') |
            ForEach-Object { $_.Value }
    )

    if ($tokens.Count -eq 0) {
        Write-Warning "Could not parse a 4-digit BIOS version from: $biosVersion"
        return $null
    }

    if ($tokens.Count -gt 1) {
        Write-Warning "Multiple 4-digit values in BIOS string ($($tokens -join ', ')); using last"
    }

    return $tokens[-1]
}

function Test-VersionGreaterOrEqual {
    <#
    .SYNOPSIS
        Numeric BIOS version comparison that tolerates leading zeros and
        falls back to a string compare for non-numeric versions.
    #>
    param(
        [Parameter(Mandatory)][string]$Current,
        [Parameter(Mandatory)][string]$Latest
    )

    $a = 0; $b = 0
    if ([int]::TryParse($Current, [ref]$a) -and [int]::TryParse($Latest, [ref]$b)) {
        return ($a -ge $b)
    }

    Write-Warning "Non-numeric version ('$Current' vs '$Latest'); comparing as strings"
    return ([string]::Compare($Current, $Latest, $true) -ge 0)
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
            Sha256      = $latest.sha256
        }
    }
    catch {
        throw "Failed to query ASUS API: $_"
    }
}

function Install-BiosUpdate {
    param(
        [string]$DownloadUrl,
        [string]$Version,
        [string]$Destination,
        [string]$ExpectedSha256
    )

    # Create temp directory
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

    # Extract original filename from URL (e.g., PRIME-B760M-K-D4-ASUS-1838.zip)
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

    # Verify integrity BEFORE anything gets written to the USB drive.
    # A corrupted .CAP flashed by EZ Flash can leave the board unbootable,
    # so a failed check is fatal, never a warning.
    if ($ExpectedSha256) {
        Write-Host "Verifying SHA-256 against ASUS-published hash..." -ForegroundColor Cyan
        $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash
        if ($actual -ne $ExpectedSha256.ToUpperInvariant()) {
            throw ("SHA-256 MISMATCH - refusing to continue.`n" +
                   "  expected: $($ExpectedSha256.ToUpperInvariant())`n" +
                   "  actual:   $actual`n" +
                   "The download is corrupt or tampered with. Do not flash it.")
        }
        Write-Host "SHA-256 verified: $actual" -ForegroundColor Green
    }
    else {
        Write-Warning "ASUS published no SHA-256 for this release; cannot verify the download"
    }

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

    # Keep ASUS's original filename. It already encodes board and version
    # (e.g. PRIME-B760M-K-D4-ASUS-1838.CAP), and USB BIOS FlashBack expects a
    # specific board name that renaming to "<version>.CAP" would destroy.
    # ASUS ships BIOSRenamer.exe in the archive for exactly that purpose.
    $destinationPath = Join-Path $Destination $capFile.Name

    # Check if file already exists
    if (Test-Path $destinationPath) {
        Write-Host "Removing existing file: $destinationPath" -ForegroundColor Yellow
        Remove-Item -Path $destinationPath -Force
    }

    Copy-Item -Path $capFile.FullName -Destination $destinationPath -Force

    # Copy BIOSRenamer alongside if present - needed to rename the .CAP for
    # USB BIOS FlashBack (the rear-panel button method).
    $renamer = Get-ChildItem -Path $extractPath -Filter "BIOSRenamer*.exe" -Recurse |
               Select-Object -First 1
    if ($renamer) {
        Copy-Item -Path $renamer.FullName -Destination (Join-Path $Destination $renamer.Name) -Force -ErrorAction SilentlyContinue
        Write-Host "Also copied $($renamer.Name) (for USB BIOS FlashBack)" -ForegroundColor Gray
    }

    if (Test-Path $destinationPath) {
        Write-Host "`nBIOS file ready: $destinationPath" -ForegroundColor Green
        return $destinationPath
    }

    throw "Failed to copy BIOS file to $destinationPath"
}

function Remove-TempFiles {
    <#
    .SYNOPSIS
        Cleans up temporary files and drive letters
    #>
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Cleaned up temporary files" -ForegroundColor Gray
    }
    Remove-TempDriveLetters
}

# When dot-sourced (by Test-UpdateAsusBios.ps1) stop here, exposing only the
# functions above so they can be tested in isolation.
if ($MyInvocation.InvocationName -eq '.') { return }

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
    if (Test-VersionGreaterOrEqual -Current $currentVersion -Latest $latestVersion) {
        Write-Host "Your BIOS is already up to date!" -ForegroundColor Green
        Write-Host "Current: $currentVersion, Latest: $latestVersion" -ForegroundColor Gray
        exit 0
    }

    Write-Host "Update available: $currentVersion -> $latestVersion" -ForegroundColor Yellow
    Write-Host ""

    # Detect USB drive
    $usbDrive = Get-UsbDrive
    Write-Host "Target USB drive: $usbDrive`n" -ForegroundColor White

    # Download and prepare
    $biosPath = Install-BiosUpdate -DownloadUrl $latestInfo.DownloadUrl `
                                   -Version $latestVersion `
                                   -Destination $usbDrive `
                                   -ExpectedSha256 $latestInfo.Sha256
    $biosFileName = [System.IO.Path]::GetFileName($biosPath)

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
    Write-Host "  4. Select $biosFileName from the USB drive" -ForegroundColor White
    Write-Host "  5. Follow the on-screen instructions" -ForegroundColor White
    Write-Host ""
    Write-Host "WARNING: Do not power off during BIOS update!" -ForegroundColor Red
    Write-Host ""

    # Clean up before potential restart
    Remove-TempFiles

    $restartConfirm = Read-Host "Restart now to apply BIOS update? (Y/N)"
    if ($restartConfirm -eq 'Y' -or $restartConfirm -eq 'y') {
        Write-Host "`nRestarting..." -ForegroundColor Yellow
        Restart-Computer
    }
    else {
        Write-Host "`nRestart when ready to apply the BIOS update." -ForegroundColor Yellow
    }
}
catch {
    Remove-TempFiles
    Write-Host "`nERROR: $_" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor Gray
    exit 1
}
