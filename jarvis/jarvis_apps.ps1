# App-control helper for the Jarvis voice daemon.
# The headless Claude session is only allowed to run THIS script (see
# ..\.claude\settings.json), so keep the action list closed: no arbitrary
# process launching, only http/https URLs.
param(
    [Parameter(Mandatory = $true)][string]$Action,
    [string]$Arg
)

$ErrorActionPreference = "Stop"

Add-Type -Name Media -Namespace Jarvis -MemberDefinition @'
[DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@

function Press-MediaKey([byte]$vk) {
    [Jarvis.Media]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
    [Jarvis.Media]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
}

function Get-SteamLibraries {
    try { $root = (Get-ItemProperty "HKCU:\Software\Valve\Steam" -ErrorAction Stop).SteamPath }
    catch { $root = "C:\Program Files (x86)\Steam" }
    $root = $root -replace "/", "\"
    $libs = @("$root\steamapps")
    $vdf = "$root\steamapps\libraryfolders.vdf"
    if (Test-Path $vdf) {
        foreach ($m in (Select-String -Path $vdf -Pattern '"path"\s+"([^"]+)"' -AllMatches).Matches) {
            $libs += ($m.Groups[1].Value -replace "\\\\", "\") + "\steamapps"
        }
    }
    $libs | Sort-Object -Unique | Where-Object { Test-Path $_ }
}

function Get-SteamGames {
    foreach ($lib in Get-SteamLibraries) {
        foreach ($f in Get-ChildItem "$lib\appmanifest_*.acf" -ErrorAction SilentlyContinue) {
            $txt = Get-Content $f.FullName -Raw
            if ($txt -notmatch '"appid"\s+"(\d+)"') { continue }
            $appid = $Matches[1]
            if ($txt -notmatch '"name"\s+"([^"]+)"') { continue }
            $name = $Matches[1]
            if ($name -match 'Steamworks Common|Redistributab|Runtime|Proton') { continue }
            $dir = if ($txt -match '"installdir"\s+"([^"]+)"') { $Matches[1] } else { "" }
            [PSCustomObject]@{ AppId = $appid; Name = $name; InstallDir = $dir; Lib = $lib }
        }
    }
}

$apps = @{
    chrome   = "chrome"
    whatsapp = "WhatsApp"
    spotify  = "Spotify"
    steam    = "steam"
    discord  = "Discord"
}

switch ($Action.ToLower()) {
    "launch-chrome" {
        if ($Arg -and $Arg -match '^https?://') { Start-Process chrome $Arg -WindowStyle Minimized; "Chrome opened at $Arg." }
        else { Start-Process chrome -WindowStyle Minimized; "Chrome launched." }
    }
    "launch-whatsapp" { Start-Process "whatsapp:" -WindowStyle Minimized; "WhatsApp launched." }
    "launch-claude" {
        $app = Get-StartApps | Where-Object { $_.Name -eq "Claude" } | Select-Object -First 1
        if ($app) { Start-Process "explorer.exe" "shell:AppsFolder\$($app.AppID)" -WindowStyle Minimized; "Claude Desktop launched." }
        else { "Claude Desktop not found in Start apps." }
    }
    "close-claude" {
        # Desktop app only — the Jarvis daemon's own claude.exe CLI sessions
        # share the process name and must survive this.
        Get-Process -Name claude -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -like "*WindowsApps*Claude*" } |
            Stop-Process -Force -ErrorAction SilentlyContinue
        "Claude Desktop closed."
        break
    }
    "launch-spotify"  { Start-Process "spotify:" -WindowStyle Minimized; "Spotify launched." }
    "launch-steam"    { Start-Process "steam://open/main" -WindowStyle Minimized; "Steam launched." }
    "launch-discord"  {
        $upd = "$env:LOCALAPPDATA\Discord\Update.exe"
        if (Test-Path $upd) { Start-Process $upd -ArgumentList "--processStart", "Discord.exe" -WindowStyle Minimized }
        else { Start-Process "discord:" -WindowStyle Minimized }
        "Discord launched."
    }
    "open-url" {
        if ($Arg -match '^https?://') { Start-Process chrome $Arg; "Opened $Arg in Chrome." }
        else { "Refused: only http/https URLs are allowed." }
    }
    "list-games" {
        $games = @(Get-SteamGames)
        if ($games) { ($games | Sort-Object Name | ForEach-Object { "$($_.AppId)|$($_.Name)" }) -join "`n" }
        else { "No Steam games found." }
    }
    "launch-game" {
        if ($Arg -notmatch '^\d+$') { "launch-game needs a numeric appid (use list-games)." }
        else { Start-Process "steam://rungameid/$Arg"; "Game $Arg launching." }
    }
    "close-game" {
        if ($Arg -notmatch '^\d+$') { "close-game needs a numeric appid (use list-games)."; break }
        $game = Get-SteamGames | Where-Object { $_.AppId -eq $Arg } | Select-Object -First 1
        if (-not $game -or -not $game.InstallDir) { "Game $Arg not found in library."; break }
        $dir = Join-Path $game.Lib "common\$($game.InstallDir)"
        $procs = Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }
        if ($procs) { $procs | Stop-Process -Force -ErrorAction SilentlyContinue; "$($game.Name) closed." }
        else { "$($game.Name) is not running." }
        break
    }
    { $_ -like "close-*" } {
        $name = $Action.ToLower() -replace '^close-', ''
        if ($apps.ContainsKey($name)) {
            Stop-Process -Name $apps[$name] -Force -ErrorAction SilentlyContinue
            "$name closed."
        } else { "Unknown app: $name. Known: $($apps.Keys -join ', ')." }
    }
    "play-pause"     { Press-MediaKey 0xB3; "Play/pause toggled." }
    "next-track"     { Press-MediaKey 0xB0; "Next track." }
    "previous-track" { Press-MediaKey 0xB1; "Previous track." }
    "volume-up"      { 1..5 | ForEach-Object { Press-MediaKey 0xAF }; "Volume up." }
    "volume-down"    { 1..5 | ForEach-Object { Press-MediaKey 0xAE }; "Volume down." }
    "mute"           { Press-MediaKey 0xAD; "Mute toggled." }
    "sleep" {
        # True S3 sleep, not hibernate (hibernate is enabled on this system,
        # so the rundll32 SetSuspendState trick would hibernate instead).
        Add-Type -AssemblyName System.Windows.Forms
        "Sleeping."
        [System.Windows.Forms.Application]::SetSuspendState(
            [System.Windows.Forms.PowerState]::Suspend, $false, $false) | Out-Null
        break
    }
    "status" {
        $lines = foreach ($k in $apps.Keys | Sort-Object) {
            $running = $null -ne (Get-Process -Name $apps[$k] -ErrorAction SilentlyContinue)
            "{0}: {1}" -f $k, $(if ($running) { "running" } else { "not running" })
        }
        $desktop = Get-Process -Name claude -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -like "*WindowsApps*Claude*" }
        $lines += "claude: $(if ($desktop) { 'running' } else { 'not running' })"
        $lines -join "`n"
    }
    default {
        "Unknown action '$Action'. Actions: launch-chrome [url], launch-whatsapp, launch-spotify, launch-steam, launch-discord, launch-claude, close-<app>, close-claude, open-url <url>, play-pause, next-track, previous-track, volume-up, volume-down, mute, status"
    }
}
