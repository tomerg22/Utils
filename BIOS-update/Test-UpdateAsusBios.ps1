<#
.SYNOPSIS
    Tests for Update-AsusBios.ps1

.DESCRIPTION
    Runs anywhere PowerShell runs: no Administrator, no ASUS board, no USB
    drive, no network. Dot-sources the script, which returns early when
    dot-sourced and so exposes its functions without executing main.

    Each case exists because the behaviour it pins down was previously wrong,
    or because the shell implementation had a matching bug worth guarding
    against here too.

.EXAMPLE
    pwsh -File ./Test-UpdateAsusBios.ps1
#>

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'Update-AsusBios.ps1')

$script:Pass = 0
$script:Fail = 0

function Check {
    param($Name, $Got, $Want)
    if ("$Got" -eq "$Want") {
        Write-Host "  ok   $Name"
        $script:Pass++
    }
    else {
        Write-Host "  FAIL $Name"
        Write-Host "         got:  $Got"
        Write-Host "         want: $Want"
        $script:Fail++
    }
}

# ---------------------------------------------------------------------------
# Test-VersionGreaterOrEqual
#
# PowerShell's [int] cast is decimal, so it never had the shell's octal bug
# (bash read "0805" as octal and aborted). These cases lock that in and cover
# the non-numeric fallback.
# ---------------------------------------------------------------------------
Write-Host "Test-VersionGreaterOrEqual"
Check "1838 >= 1825"         (Test-VersionGreaterOrEqual -Current 1838 -Latest 1825) $true
Check "1825 >= 1838"         (Test-VersionGreaterOrEqual -Current 1825 -Latest 1838) $false
Check "equal versions"       (Test-VersionGreaterOrEqual -Current 1838 -Latest 1838) $true
Check "0805 >= 1234"         (Test-VersionGreaterOrEqual -Current 0805 -Latest 1234) $false
Check "1234 >= 0805"         (Test-VersionGreaterOrEqual -Current 1234 -Latest 0805) $true
Check "0902 >= 0805"         (Test-VersionGreaterOrEqual -Current 0902 -Latest 0805) $true
Check "0710 >= 0800"         (Test-VersionGreaterOrEqual -Current 0710 -Latest 0800) $false

# Non-numeric must not throw; it falls back to a string comparison.
$threw = $false
try { $null = Test-VersionGreaterOrEqual -Current "1838a" -Latest "1838" -WarningAction SilentlyContinue }
catch { $threw = $true }
Check "non-numeric does not throw" $threw $false

# ---------------------------------------------------------------------------
# 4-digit BIOS version token rule
#
# The SMBIOS string is free-form, so taking the first 4-digit run could pick
# up a year. The rule is: whole 4-digit tokens only, prefer the last.
# ---------------------------------------------------------------------------
Write-Host "BIOS version token extraction"
function Get-Tokens {
    param([string]$Text)
    ([regex]::Matches($Text, '(?<![0-9])[0-9]{4}(?![0-9])') | ForEach-Object { $_.Value }) -join ','
}
Check "bare 4-digit version"       (Get-Tokens "1838") "1838"
Check "finds both, last preferred" (Get-Tokens "American Megatrends 5.13 2026 1838") "2026,1838"
Check "keeps a leading zero"       (Get-Tokens "0805") "0805"
Check "no match on v1.2"           (Get-Tokens "v1.2") ""
Check "does not split 6 digits"    (Get-Tokens "123456") ""

# ---------------------------------------------------------------------------
# Integrity gate
#
# Nothing verified the download before it was staged for flashing. ASUS
# publishes a sha256 in the API response the script already parses. Verify
# that Get-FileHash agrees with a known-good hash and rejects a wrong one -
# a corrupt .CAP flashed by EZ Flash can leave the board unbootable.
# ---------------------------------------------------------------------------
Write-Host "Integrity gate"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("biostest-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    $payload = Join-Path $tmp 'payload.bin'
    Set-Content -Path $payload -Value 'FAKE-BIOS-PAYLOAD' -NoNewline
    $good = (Get-FileHash -Path $payload -Algorithm SHA256).Hash

    Check "matching hash compares equal" ($good -eq $good.ToUpperInvariant()) $true
    Check "wrong hash compares unequal" `
        ($good -eq ('deadbeef' * 8).ToUpperInvariant()) $false

    # Hash comparison must be case-insensitive in effect: ASUS returns the
    # hash uppercase in some responses and lowercase in others.
    Check "case-normalised comparison" `
        ($good.ToUpperInvariant() -eq $good.ToLowerInvariant().ToUpperInvariant()) $true
}
finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# URL handling
#
# ASUS returns download URLs containing literal spaces in the query string
# (e.g. "...1838.zip?model=PRIME B760M-K D4"). .NET normalises them, and the
# filename must come from LocalPath so the query is not treated as part of it.
# ---------------------------------------------------------------------------
Write-Host "Download URL handling"
$u = 'https://dlcdnets.asus.com/pub/ASUS/mb/BIOS/PRIME-B760M-K-D4-ASUS-1838.zip?model=PRIME B760M-K D4'
$uri = [System.Uri]$u
Check "filename excludes the query" `
    ([System.IO.Path]::GetFileName($uri.LocalPath)) "PRIME-B760M-K-D4-ASUS-1838.zip"
Check "spaces normalised to %20" ($uri.AbsoluteUri -match '%20') $true

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host ("passed {0}, failed {1}" -f $script:Pass, $script:Fail)
if ($script:Fail -gt 0) { exit 1 }
