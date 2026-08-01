# Utils

Personal utilities.

## BIOS-update

Detects the ASUS motherboard model, queries ASUS for the latest BIOS, verifies
the download against ASUS's published SHA-256, and stages the `.CAP` file on a
FAT32 USB drive for EZ Flash.

Two equivalent implementations:

| Script | Platform | Requires |
|--------|----------|----------|
| `BIOS-update/Update-AsusBios.ps1` | Windows | PowerShell, run as Administrator |
| `BIOS-update/update-asus-bios.sh` | Ubuntu/Debian | root (`dmidecode`, `mount`) |

### Windows

1. Open PowerShell as admin
2. `powershell -ExecutionPolicy Bypass -File Update-AsusBios.ps1`

### Ubuntu

```bash
sudo ./BIOS-update/update-asus-bios.sh
```

Installs `curl`, `jq`, `dmidecode`, `unzip` via `apt-get` if missing.

### What both scripts do

1. Read the board model and current BIOS version from SMBIOS
2. Query the ASUS support API for the latest BIOS
3. Exit early if already up to date
4. Find a FAT32 USB drive (mounting it if it has no mount point / drive letter)
5. Download the package and **verify its SHA-256 against the hash ASUS
   publishes** — a mismatch aborts before anything touches the USB drive
6. Extract the `.CAP`, keeping ASUS's original filename
7. Print the EZ Flash steps and offer to reboot

### Tests

Both suites run on any machine — no root/Administrator, no ASUS board, no USB
drive, no network. `lsblk`, `dmidecode`, `curl` and the BIOS archive are stubbed.

```bash
./BIOS-update/test-update-asus-bios.sh          # 25 tests
pwsh -File ./BIOS-update/Test-UpdateAsusBios.ps1 # 18 tests
```

Each case pins down behaviour that was previously wrong — the comments in the
test files say what broke. Both scripts return early when sourced/dot-sourced,
so the tests exercise their functions without running `main`.

What the tests do **not** cover: the actual flash. Nothing here has been run
end to end against a real ASUS board, and EZ Flash itself is untested by
definition.

### Applying the update

Reboot, enter BIOS (F2 or Del), then **Tool → ASUS EZ Flash 3 Utility**, and
select the `.CAP` file from the USB drive.

Do not power off during the flash.

### Notes

- The original `.CAP` filename is preserved deliberately. It already encodes
  board and version (e.g. `PRIME-B760M-K-D4-ASUS-1838.CAP`), and **USB BIOS
  FlashBack** — the rear-panel button method — expects a specific board name.
  Renaming to `<version>.CAP` would break it. If ASUS ships `BIOSRenamer.exe`
  in the archive, it is copied to the USB drive too; that tool produces the
  exact name FlashBack needs.
- Only ASUS boards are supported; the scripts refuse to run on anything else.
- The USB drive must be **FAT32**. EZ Flash cannot read NTFS or exFAT.

## jarvis

Always-on "Hey Jarvis" voice assistant for Claude Code on Windows. Wake word
and speech-to-text run locally (openWakeWord + faster-whisper); simple
commands execute instantly, anything else goes to a persistent Claude Code
session and is spoken back with neural TTS.

Controls apps (Chrome, WhatsApp, Spotify, Steam, Discord, Claude Desktop),
media keys, Steam games by name, and PC sleep. Claude's shell access is
allowlisted to a single action script, so a misheard command cannot run
arbitrary commands.

```powershell
powershell -ExecutionPolicy Bypass -File jarvis/setup.ps1
```

See `jarvis/README.md` for configuration, security model, and troubleshooting.
