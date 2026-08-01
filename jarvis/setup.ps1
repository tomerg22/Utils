# Jarvis voice daemon — one-shot installer.
# Run from the project folder on a fresh Windows machine:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
# Prerequisites: Python 3.11+, Claude Code installed and signed in.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Write-Host "Installing Jarvis from $root"

# 1. Python check
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py -or (& python --version) -notmatch "3\.1[1-9]") {
    $guess = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($guess) { $python = $guess.FullName }
    else { throw "Python 3.11+ not found. Install it from python.org first." }
} else { $python = $py.Source }
Write-Host "Using Python: $python"

# 2. Virtual environment + dependencies
if (-not (Test-Path "$root\venv")) { & $python -m venv "$root\venv" }
& "$root\venv\Scripts\python.exe" -m pip install --upgrade pip -q
& "$root\venv\Scripts\python.exe" -m pip install -r "$root\requirements.txt" -q
Write-Host "Dependencies installed."

# 3. Wake-word models (Whisper downloads itself on first run)
& "$root\venv\Scripts\python.exe" -c "import openwakeword.utils as u; u.download_models(model_names=['hey_jarvis'])"

# 4. Personal config
if (-not (Test-Path "$root\jarvis_config.json")) {
    Copy-Item "$root\jarvis_config.example.json" "$root\jarvis_config.json"
    Write-Host "Created jarvis_config.json from example."
}

# 5. Claude Code permission rules for the app-control script (this path only)
$apps = ($root -replace "\\", "/") + "/jarvis_apps.ps1"
New-Item -ItemType Directory -Force "$root\.claude" | Out-Null
@"
{
  "permissions": {
    "allow": [
      "Bash(powershell -ExecutionPolicy Bypass -File ${apps}:*)",
      "Bash(powershell -ExecutionPolicy Bypass -File $apps *)",
      "Bash(powershell.exe -ExecutionPolicy Bypass -File ${apps}:*)",
      "Bash(powershell.exe -ExecutionPolicy Bypass -File $apps *)",
      "PowerShell(powershell -ExecutionPolicy Bypass -File $apps *)",
      "PowerShell(powershell.exe -ExecutionPolicy Bypass -File $apps *)"
    ]
  }
}
"@ | Out-File "$root\.claude\settings.json" -Encoding utf8
Write-Host "Permission allowlist written."

# 6. Trust the workspace so headless Claude honors the allowlist
& "$root\venv\Scripts\python.exe" -c @"
import json, os
p = os.path.expanduser('~/.claude.json')
d = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
root = r'$root'
pr = d.setdefault('projects', {})
for key in (root, root.replace('\\', '/')):
    pr.setdefault(key, {})['hasTrustDialogAccepted'] = True
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2)
print('Workspace trusted for headless permissions.')
"@

# 7. Autostart at logon (Startup shortcut) + 5-minute watchdog task
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Jarvis Voice.lnk")
$lnk.TargetPath = "$root\venv\Scripts\pythonw.exe"
$lnk.Arguments = "`"$root\jarvis_listener.py`""
$lnk.WorkingDirectory = $root
$lnk.Save()
$action = New-ScheduledTaskAction -Execute "$root\venv\Scripts\pythonw.exe" -Argument "`"$root\jarvis_listener.py`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 9999)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "JarvisVoiceWatchdog" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Autostart + watchdog registered."

# 8. Self-test (also downloads the Whisper model on first run)
& "$root\venv\Scripts\python.exe" "$root\jarvis_listener.py" --check
if ($LASTEXITCODE -ne 0) { throw "Self-check FAILED - see jarvis.log" }

# 9. Launch now
Start-Process -FilePath "$root\venv\Scripts\pythonw.exe" -ArgumentList "`"$root\jarvis_listener.py`"" -WorkingDirectory $root
Write-Host ""
Write-Host "Jarvis is listening. Say: Hey Jarvis, what time is it?"
