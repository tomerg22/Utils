<#
.SYNOPSIS
    ASUS BIOS Update Script

.DESCRIPTION
    Automatically detects the ASUS motherboard model, checks for BIOS updates,
    downloads and prepares the update file for EZ Flash installation.

.NOTES
    After running, restart and enter BIOS (F2/Del) -> Tool -> ASUS EZ Flash 3
    Select the .CAP file from the USB drive to apply the update.
#>

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

# Configuration
$TempDir = Join-Path $env:TEMP "ASUS_BIOS_Update"
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

        do {
            $selection = Read-Host "Select drive (1-$($usbDrives.Count))"
            $selectionInt = [int]$selection
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
        [string]$Version,
        [string]$Destination
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
    $destinationPath = Join-Path $Destination $newName

    # Check if file already exists
    if (Test-Path $destinationPath) {
        Write-Host "Removing existing file: $destinationPath" -ForegroundColor Yellow
        Remove-Item -Path $destinationPath -Force
    }

    Copy-Item -Path $capFile.FullName -Destination $destinationPath -Force

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

    # Detect USB drive
    $usbDrive = Get-UsbDrive
    Write-Host "Target USB drive: $usbDrive`n" -ForegroundColor White

    # Download and prepare
    $biosPath = Install-BiosUpdate -DownloadUrl $latestInfo.DownloadUrl -Version $latestVersion -Destination $usbDrive

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
    Write-Host "  4. Select the $latestVersion.CAP file from the USB drive" -ForegroundColor White
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
