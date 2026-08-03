# TV Control — Sync a Samsung TV (2nd Monitor) with Windows Sleep/Wake

Automatically turns a Samsung Smart TV used as a second monitor **off** when
Windows puts the displays to sleep (idle timeout or Sleep button) and **on**
again when the PC wakes — over the local network, with no extra hardware.

Without this, a TV used as a PC monitor just loses signal when the PC sleeps:
it sits on a "no signal / check source" dialog indefinitely (or until a slow
built-in timeout), and never comes back on by itself.

## How it works

```
┌─────────────────────────── Windows PC ───────────────────────────┐
│                                                                  │
│  Task Scheduler (at logon, hidden)                               │
│      └── tv_listener.py                                          │
│            • GUID_CONSOLE_DISPLAY_STATE → display slept/woke     │
│            • PBT_APMSUSPEND/RESUME      → system suspend/resume  │
│                     │                                            │
│                     ▼                                            │
│          tv_control.py                                           │
│            • power_off() ── WebSocket KEY_POWER ──────────┐      │
│            • power_on()  ── Wake-on-LAN burst ────────────┤      │
│            • resolve_tv_ip() ── MAC-based rediscovery     │      │
└───────────────────────────────────────────────────────────┼──────┘
                                                            ▼
                                            Samsung Tizen Smart TV (WiFi/LAN)
```

- **Off**: sends `KEY_POWER` over Samsung's local WebSocket remote-control API
  (`wss://TV:8002/api/v2/channels/samsung.remote.control`), authenticated by a
  pairing token the TV grants once. `KEY_POWER` is a **toggle** — this TV
  ignores `KEY_POWEROFF`, `KEY_POWER_OFF` and `KEY_STANDBY` completely (all
  three verified against the device; Samsung maps them onto `KEY_POWER` on
  2016+ sets), so exactly one send per on/off cycle is guaranteed.
- **On**: sends Wake-on-LAN magic packets. WiFi radios in standby only listen
  periodically, so packets are repeated across ~12 s (broadcast + unicast,
  ports 9 and 7) — a single packet is often missed.
- **Warm connection**: a connection is held open and rotated every 20 s.
  Opening one costs ~1.3 s and *never* completes once the system starts
  suspending; sending on an established socket takes ~3 ms. It is rotated on
  a timer rather than health-checked, because the TV silently closes idle
  sockets at ~60 s and `ping()` does not reliably raise on a socket the peer
  has already closed. The replacement is established before the old one is
  dropped, so suspend cannot land in a reconnect gap.
- **IP changes**: the TV is identified by its **MAC address**. The current IP
  is cached and verified before each use; if stale, the subnet is ARP-scanned
  for the MAC and the cache updated. DHCP reassignments are handled
  automatically (a router-side DHCP reservation is still nice to have).
- **Safe repeats**: the listener tracks whether it believes the TV is already
  off and skips redundant toggles, since a second `KEY_POWER` would switch the
  TV back **on**. A time-based debounce is not sufficient: the gap between the
  display-off event and the suspend event has been observed at both 4 ms and
  23.5 s on the same machine. `power_on` clears the flag. Manual (CLI) calls
  additionally check real state via `http://TV:8001/api/v2/`.
- **Restart-safe**: Windows delivers the *current* display state immediately
  when the listener registers. That first event is deliberately ignored, so a
  logon/watchdog restart never re-asserts TV power — it won't switch the TV
  back on after you deliberately turned it off.
- **Sleep path**: the listener registers `RegisterSuspendResumeNotification`
  from a normal hidden **top-level** window. This matters: a message-only
  (`HWND_MESSAGE`) window never receives broadcast `WM_POWERBROADCAST`, so
  suspend/resume events silently never arrive at all, while the targeted
  display-state notifications still do — a confusing half-working state.
  After sending, the handler dwells and the socket sets `TCP_NODELAY`, because
  `ws.send()` only fills the socket buffer and the NIC can go down before those
  bytes are ever transmitted. Windows grants roughly **2 s** to handle
  `PBT_APMSUSPEND` and that deadline is [hard-coded and not
  configurable](https://devblogs.microsoft.com/oldnewthing/20111124-00/?p=9043)
  (it was 20 s until Vista), so the dwell is sized to spend most of it —
  `SUSPEND_DWELL` (1.5 s) against a `SUSPEND_BUDGET` of 2 s, tuned in
  `tv_control.py` alone rather than split across both files. That long dwell
  applies **only** on the suspend path (`power_off(suspending=True)`);
  everywhere else `NORMAL_DWELL` (0.3 s) is enough, since nothing is racing
  the send. On the suspend path the fallbacks are skipped entirely — a fresh
  connect costs ~1.3 s and an ARP rediscovery ~2 s more, so neither can finish
  before the deadline and they would only obscure the log.
- **Manual sleep should use `sleep_pc.py`, not the Start menu.** The suspend
  hook is best-effort, not a guarantee. Measured on one machine:

  | Sequence | Result |
  |---|---|
  | display-off, then suspend 23.5 s later | off command lands |
  | straight to suspend, no display-off first | off command lost |

  In the second case the network is gone before anything can be delivered,
  and there is no way to detect the loss: this TV sends **no** acknowledgement
  and does not even close the socket as it powers off (verified — it answered
  nothing for 6.5 s while going into standby). `sleep_pc.py` inverts the
  order instead of racing it: TV off → *confirmed* off (~2.6 s) → suspend.

## Requirements

- Windows 10/11 PC and a **Samsung Tizen Smart TV (2016+)** on the **same
  LAN/subnet** (TV can be on WiFi; PC wired is fine)
- Python 3.9+ with packages: `websocket-client`, `wakeonlan`, `pywin32`
- TV settings:
  - **Settings → General → External Device Manager → Device Connection
    Manager** (naming varies): allow connections / "IP Remote" enabled
  - Network standby / "Power On with Mobile" enabled if present (lets WoL work)

The TV is only used as a *display* over HDMI as usual — the network is used
purely for control commands, no video streams over it.

## Setup on a new system

### 1. Install dependencies

```powershell
winget install Python.Python.3.12
py -3 -m pip install websocket-client wakeonlan pywin32
```

### 2. Copy this folder

Place it at e.g. `C:\Users\<you>\tv-control\`. Delete any `tv-token.txt` and
`tv-ip-cache.txt` from the previous machine/TV.

### 3. Find your TV

With the TV **on**, get its IP from Settings → General → Network → Network
Status (or your router's client list), then confirm the API responds and grab
the WiFi MAC:

```powershell
curl http://<TV_IP>:8001/api/v2/
```

The JSON response includes `"wifiMac"`, `"modelName"`, and
`"PowerState":"on"` — if this fails, the TV isn't reachable/supported.

### 4. Create your config

Copy the example and fill in your own values:

```powershell
Copy-Item tv-config.example.json tv-config.json
```

```json
{
  "tv_mac": "AA:BB:CC:DD:EE:FF",
  "last_known_ip": "192.168.1.50",
  "subnet_prefix": "192.168.1."
}
```

`tv_mac` is the `wifiMac` from step 3, `last_known_ip` the TV's current IP,
and `subnet_prefix` your LAN's /24 prefix (used for the ARP rediscovery scan).
`tv-config.json` is gitignored, along with the pairing token and logs.

### 5. Pair with the TV (one-time)

```powershell
cd C:\Users\<you>\tv-control
py -3 tv_control.py off
```

The TV shows an on-screen prompt — **approve it with the TV remote**. The
granted token is saved to `tv-token.txt` and reused forever after. (The TV
will also turn off if pairing succeeds; turn it back on with
`py -3 tv_control.py on`.)

### 6. Test both directions

```powershell
py -3 tv_control.py status   # prints resolved IP + on/off state
py -3 tv_control.py off      # TV should power off
py -3 tv_control.py on       # TV should power on within ~15 s
```

Don't proceed until all three work.

### 7. Create an isolated Python host (recommended)

The listener is a long-running `pythonw.exe` process. A very common way to
restart *other* Python daemons is `Get-Process pythonw | Stop-Process`, which
kills **every** `pythonw.exe` on the machine — silently taking this listener
down as collateral (it leaves no crash log; the task just shows exit code
`0xFFFFFFFF`). Running under a distinctly-named copy of the interpreter makes
the listener immune to those blanket kills:

```powershell
$py = "$env:LOCALAPPDATA\Programs\Python\Python312"
Copy-Item "$py\pythonw.exe" "$py\pyw_tvcontrol.exe" -Force
```

Keep the copy **inside** the Python install directory — the interpreter locates
`python312.dll` and its standard library relative to the executable's path.

### 8. Register the background listener

```powershell
$host_exe = "$env:LOCALAPPDATA\Programs\Python\Python312\pyw_tvcontrol.exe"
$dir      = "C:\Users\<you>\tv-control"
$action   = New-ScheduledTaskAction -Execute $host_exe -Argument "`"$dir\tv_listener.py`"" -WorkingDirectory $dir
$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName "TV Control - Monitor Sync" -Action $action -Trigger $t1,$t2 -Settings $settings -Force
Start-ScheduledTask -TaskName "TV Control - Monitor Sync"
```

Two triggers on purpose: **at logon** for normal startup, plus a **5-minute
repeating trigger as a self-healing watchdog**. `MultipleInstances IgnoreNew`
means the repeat is a no-op while the listener is alive, and restarts it within
5 minutes if it ever dies for any reason.

### 9. Use `Sleep-PC.cmd` for manual sleep

Bind `Sleep-PC.cmd` to a shortcut, hotkey, or voice-assistant "sleep" command
and use it instead of the Start menu's Sleep. It switches the TV off, waits
until the TV confirms it (typically ~2.6 s), and only then suspends.

Idle-timeout sleep and wake-up are handled automatically by the listener and
need no action.

### 10. Verify end-to-end

Let the monitors time out (or press Sleep): TV turns off. Wake the PC: TV
turns on within ~15 s. Check `tv_listener.log` in the folder to see events:

```
2026-08-01 19:50:53 Registered for GUID_CONSOLE_DISPLAY_STATE notifications
2026-08-01 19:50:53 Registered for suspend/resume notifications
2026-08-01 20:14:02 Display OFF -> turning TV off
2026-08-01 20:31:47 Display ON -> turning TV on
```

## Files

| File | Purpose |
|---|---|
| `tv_control.py` | Core library + CLI (`status` / `off` / `on`) |
| `tv_listener.py` | Background event listener (run by Task Scheduler) |
| `sleep_pc.py` | TV off → confirm → suspend. Use for manual sleep |
| `Sleep-PC.cmd` | Launcher for the above (bind to a hotkey / voice command) |
| `tv-config.json` | Your TV's MAC / IP / subnet (gitignored) |
| `tv-token.txt` | Pairing token granted by the TV (created on first pair) |
| `tv-state.json` | Believed power state, shared between processes |
| `tv-ip-cache.txt` | Last verified TV IP (auto-managed) |
| `tv_listener.log` | Listener activity log (auto-created) |

The interpreter copy `pyw_tvcontrol.exe` lives in the Python install directory
(see step 7), not in this folder.

## Troubleshooting

- **TV ignores the off command** — pairing token invalid/revoked: delete
  `tv-token.txt`, run `py -3 tv_control.py off`, approve the TV prompt again.
  Also check the TV's Device Connection Manager hasn't blocked/denied the
  client (named `claude-tv-control`).
- **TV won't wake via WoL** — enable the TV's network-standby / "Power On with
  Mobile" setting; prefer a DHCP reservation; some TVs deep-sleep after long
  off periods (hours) and can then only be woken with the physical remote.
- **Nothing happens on sleep/wake** — check the scheduled task is Running
  (`Get-ScheduledTask "TV Control - Monitor Sync"`), and look at
  `tv_listener.log`. If the log shows events but the TV doesn't react, test
  `tv_control.py off`/`on` manually.
- **Listener disappears with no error in the log** — something killed the
  process externally. The tell-tale signs are a `LastTaskResult` of
  `4294967295` (`0xFFFFFFFF`, i.e. `TerminateProcess`) from
  `Get-ScheduledTaskInfo`, and *no* matching Application-log crash event.
  The usual culprit is another tool's restart routine running
  `Get-Process pythonw | Stop-Process`. Step 7's renamed host executable
  prevents this; verify with `Get-Process pythonw` — the listener should
  **not** appear in that list (look for `pyw_tvcontrol` instead).
- **TV switches off then straight back on** — two `KEY_POWER` toggles were
  sent (display-off and suspend both firing). Check the log for two sends
  without a `skipped, TV already believed off` line between them.
- **TV never switches off on sleep** — read the log line at the moment of
  suspend. `warm send failed at socket age N` means the held socket was dead
  (shorten `WARM_MAX_AGE`); `sent on warm connection` with the TV still on
  means the bytes did not reach the NIC in time. Raise `SUSPEND_DWELL` first —
  but it cannot exceed `SUSPEND_BUDGET`, because Windows may interrupt the
  handler at ~2 s and the deadline cannot be extended. Once the dwell is at the
  budget the local approach really is at its limit: switch the suspend path to
  SmartThings' cloud `switch: off`, which is delivered by Samsung's servers
  *after* the PC has suspended. Note this path can never *confirm* delivery
  (the TV sends no acknowledgement) — for sleeps you trigger yourself, use
  `sleep_pc.py`, which does.
- **TV IP changed and control stopped** — should self-heal via the ARP scan
  (watch for "ARP fallback" lines in the log). If your subnet isn't a /24 or
  differs from `SUBNET_PREFIX`, fix the constant.
- **"Problem with source" dialog appears on the TV when PC sleeps** — the
  off-command lost the suspend race. Verify the log shows "System suspending
  (suspend hook)" lines; if they're absent, the suspend notification failed to
  register (check the startup lines in the log).

## Notes & limitations

- Samsung-specific: uses the Tizen WebSocket remote API. Other brands need a
  different control backend (LG webOS, Android TV ADB/CEC, etc.).
- DDC/CI (the way PC monitors are controlled) does **not** work on most
  Samsung TVs — they only implement the display-identification subset. That's
  why this project controls the TV over the network instead.
- PC GPUs (NVIDIA/AMD/Intel) have no HDMI-CEC hardware, so CEC isn't an option
  without a USB-CEC adapter.
- The WebSocket TLS connection to the TV uses `CERT_NONE` — the TV presents a
  self-signed certificate; this is standard for local Tizen control.
