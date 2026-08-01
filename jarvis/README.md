# Jarvis — always-on voice assistant for Claude Code (Windows)

Say **"Hey Jarvis"** and speak. Commands are recognized fully offline
(wake word + speech-to-text run locally), simple ones execute instantly,
and everything else is answered by Claude Code — spoken back in a
JARVIS-style British voice.

```
Mic ─▶ openWakeWord ─▶ record until silence ─▶ faster-whisper ─▶ ┬─ fast path: app/media/game/sleep actions (~4s)
       "hey jarvis"     adaptive threshold      local STT        └─ Claude Code persistent session ─▶ streamed TTS
```

## Features

- **Always listening** — starts at logon, survives crashes (5-minute watchdog
  task + single-instance guard), ~1% CPU while idle
- **Fully local recognition** — openWakeWord + faster-whisper, no cloud STT
- **Instant local actions**, no LLM round-trip:
  - launch/close Chrome, WhatsApp, Spotify, Steam, Discord, Claude Desktop
  - play/pause, next/previous track, volume, mute (system media keys)
  - launch/close any installed **Steam game** by name (fuzzy-matched from
    local appmanifests: "open balatro", "play silksong", "close rainbow six")
  - **sleep the PC** ("hey jarvis, goodnight")
- **Everything else goes to Claude Code** — a persistent headless session
  with conversation memory; replies stream sentence-by-sentence into neural
  TTS (Edge `en-GB-RyanNeural`, offline SAPI fallback)
- **Conversation flow** — "Right away, sir" acknowledgment on first command,
  silent quick-fire follow-ups within 30 seconds, silent "OK" for actions
- **Security-scoped** — Claude's shell access is allowlisted to exactly one
  action script (`jarvis_apps.ps1`); a misheard command cannot run arbitrary
  shell commands

## Requirements

- Windows 10/11, a microphone
- [Python 3.11+](https://python.org) (3.12 tested)
- [Claude Code](https://claude.com/claude-code) installed and signed in
  (desktop app or CLI)

## Install on a new machine

```powershell
git clone <your-repo-url> $env:USERPROFILE\Jarvis
cd $env:USERPROFILE\Jarvis
powershell -ExecutionPolicy Bypass -File setup.ps1
```

`setup.ps1` does all of this (idempotent, re-run any time):
1. Creates a `venv` and installs Python dependencies
2. Downloads the wake-word model (~5 MB; Whisper `base.en` ~75 MB downloads
   on first check)
3. Copies `jarvis_config.example.json` → `jarvis_config.json`
4. Writes `.claude/settings.json` permission rules pointing at *this*
   folder's `jarvis_apps.ps1`
5. Marks the folder as trusted in `~/.claude.json` (headless sessions
   ignore project permissions in untrusted folders)
6. Registers autostart (Startup shortcut) and the 5-minute watchdog task
7. Runs a self-check (mic, models, Claude CLI) and starts the daemon

Manual smoke test afterwards: **"Hey Jarvis, what time is it?"**

## Usage

| You say (after "Hey Jarvis") | What happens |
|---|---|
| "open spotify" / "close discord" | instant app launch/close |
| "pause the music" / "next song" / "turn it up" | media keys |
| "open hollow knight" / "close balatro" | Steam game via appid |
| "open youtube.com" | Chrome at that URL |
| "goodnight" / "go to sleep" | PC sleeps (wake it manually) |
| anything else | Claude Code answers/acts, spoken reply |
| "never mind" / "cancel" | abort current command |

**Beeps:** high = speak now · mid = working · single high = done ·
low = nothing heard / cancelled. Actions confirm with the done-beep only;
Claude speaks only for questions or failures.

## Configuration — `jarvis_config.json`

| Key | Meaning |
|---|---|
| `wake_threshold` | wake-word sensitivity (lower = more sensitive, default 0.4) |
| `silence_rms`, `silence_seconds` | end-of-speech detection (threshold auto-adapts to ambient noise) |
| `whisper_model` | STT model (`base.en` default; `small.en` = more accurate, slower) |
| `permission_mode` | Claude Code permission mode for voice commands (`acceptEdits` default) |
| `tts_voice`, `tts_rate`, `tts_pitch` | Edge TTS voice tuning |
| `ack_text` | first-command acknowledgment phrase |
| `followup_window_seconds` | quick-fire window with no spoken ack (30) |
| `voice_system_prompt` | instructions given to Claude (`{APPS}` expands to the action script path) |

Edit, then restart: `Get-Process pythonw | Stop-Process` (the watchdog
relaunches it, or run the Startup shortcut).

## Security model

- The daemon itself only ever runs `jarvis_apps.ps1` with a **closed set of
  actions**; URLs are restricted to http/https.
- The Claude session runs with `permission_mode: acceptEdits` and a
  project-scoped allowlist covering **only** that same script. Arbitrary
  shell commands from voice input are refused by Claude Code's permission
  system.
- Closing a Steam game is a hard kill (unsaved progress is lost) — the kill
  is scoped to processes inside that game's install folder.
- `close-steam` closes the whole Steam client; Claude is instructed to use
  per-game `close-game` instead unless you explicitly ask.

## Files

| File | Purpose |
|---|---|
| `jarvis_listener.py` | the daemon: wake word → STT → dispatch → TTS |
| `jarvis_apps.ps1` | allowlisted app/media/game/sleep action script |
| `jarvis_config.json` | your settings (gitignored; example provided) |
| `.claude/settings.json` | machine-generated permission rules (gitignored) |
| `setup.ps1` | one-shot installer for a new machine |
| `jarvis.log` | rotating log — every transcript, action, and reply |

## Troubleshooting

- **No response to "Hey Jarvis"** — check `jarvis.log` for `Wake near-miss`
  lines; lower `wake_threshold`. Verify the right mic is the Windows default
  input device, or set `input_device` (see `python -m sounddevice` for IDs).
- **Commands misheard** — log shows every transcript. Try `whisper_model:
  "small.en"` for better accuracy at ~2x the STT latency.
- **Claude says it needs approval** — the folder isn't trusted or the
  allowlist paths don't match this folder; re-run `setup.ps1`.
- **Daemon not running** — the watchdog task (`JarvisVoiceWatchdog` in Task
  Scheduler) relaunches it within 5 minutes; check `jarvis.log` for crashes.
- **Voice replies silent offline** — Edge TTS needs internet; the fallback
  voice is Windows SAPI (robotic but functional).
