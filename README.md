# Utils

Personal utilities.

## BIOS-update

Finds the newest BIOS your machine's vendor publishes, verifies the download,
and stages it on a FAT32 USB drive. The flash itself is always done by the
machine's own firmware, so no vendor tool and no Windows is involved.

| Script | Platform | Covers | Requires |
|--------|----------|--------|----------|
| `BIOS-update/update-bios.sh` | Ubuntu/Debian | ASUS + Dell | root (`dmidecode`, `mount`) |
| `BIOS-update/Update-AsusBios.ps1` | Windows | ASUS | PowerShell, run as Administrator |

### Ubuntu

```bash
sudo ./BIOS-update/update-bios.sh
```

The vendor is detected from SMBIOS and decides the code path. Missing
dependencies are installed via `apt-get`: `curl`, `dmidecode` and `jq` plus
`unzip` on ASUS, `cabextract`, `iconv` and `python3` on Dell.

### Windows

1. Open PowerShell as admin
2. `powershell -ExecutionPolicy Bypass -File Update-AsusBios.ps1`

### What the script does

1. Read the vendor, model and current BIOS version from SMBIOS
2. Look up the newest published BIOS (see below, it differs per vendor)
3. Exit early if already up to date
4. Find a FAT32 USB drive, mounting it if it has no mount point
5. Download and verify before anything touches the USB drive
6. Stage the file and print that vendor's flash steps, then offer to reboot

### Where the version comes from

**ASUS** queries the support API, which returns the version, a download URL and
a published SHA-256 in one JSON response. The `.zip` is hash-verified, then the
`.CAP` inside it is extracted. When ASUS publishes no hash, the archive is
integrity-tested with `unzip -t` instead. A mismatch aborts before anything is
written.

**Dell** reads `downloads.dell.com/catalog`, the feed Dell Command Update
consumes. Not `dell.com/support`: that page renders its driver table only after
you enter a service tag or pick the "All \<model\>" tab, it ships the payload
Caesar-shifted, and each `driverid` is a permalink to one historical release
rather than to the latest. An XPS 15 9500 has 31 BIOS releases listed, so
picking a link off that page picks a version at random.

The catalog keys models on Dell's four-hex **System ID** (the SMBIOS SKU
number, `097D` for an XPS 15 9500), because the model name is not a stable key:
SMBIOS says `XPS 15 9500` while the catalog says `XPS Notebook 9500`. The
per-model catalog is SHA-256 verified against the index before it is parsed.
The catalog carries no per-file hash for BIOS components, so the downloaded
`.exe` is checked against the size the catalog declares.

`fwupd` is not an option on Dell consumer laptops. They are not published to
LVFS, so `fwupdmgr get-releases` for System Firmware returns nothing whatever
version of fwupd is installed.

### Applying the update

**ASUS** — reboot, enter BIOS (F2 or Del), **Tool → ASUS EZ Flash 3 Utility**,
select the `.CAP` file from the USB drive.

**Dell** — reboot, tap **F12**, **BIOS Update → Flash from file**, select the
`.exe` from the USB drive. The file is a Windows executable but the F12 flasher
runs it from firmware, so no Windows is needed.

Keep the charger connected. Do not power off during the flash.

### Tests

```bash
./BIOS-update/test-update-bios.sh          # 25 tests, ASUS code path
pwsh -File ./BIOS-update/Test-UpdateAsusBios.ps1 # 18 tests
```

Both suites run on any machine — no root/Administrator, no ASUS board, no USB
drive, no network. `lsblk`, `dmidecode`, `curl` and the BIOS archive are
stubbed, and the shell suite sets `VENDOR=asus` to pin the code path it covers.
The scripts return early when sourced, so the tests exercise their functions
without running `main`.

What the tests do **not** cover: the actual flash, and the Dell code path.
The Dell half was run end to end against a real XPS 15 9500 (correctly reports
1.40.0 as both current and latest, and downloads `XPS_9500_1.40.0.exe` at the
size the catalog declares), but EZ Flash and the Dell F12 flasher are untested
by definition.

### Notes

- The staged ASUS file is renamed to `<version>.CAP` (e.g. `1838.CAP`), which
  EZ Flash 3 accepts and which is easy to pick in the utility. **USB BIOS
  FlashBack**, the rear-panel button method, is different: it needs a
  board-specific name that ASUS's `BIOSRenamer.exe` derives from the *original*
  download filename. For FlashBack, run BIOSRenamer on the unzipped download
  rather than using the staged file.
- Only ASUS and Dell are supported; the script refuses to run on anything else.
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

## tv-control

Turns a Samsung Smart TV used as a second monitor **off** when Windows puts
the displays to sleep and back **on** when the PC wakes — over the network, no
extra hardware. Without it, a TV used as a monitor just sits on a "no signal"
dialog when the PC sleeps and never comes back by itself.

A hidden background listener hooks the Windows display-state and
suspend/resume notifications. Power-off goes over Samsung's local WebSocket
remote-control API; power-on is a Wake-on-LAN burst. The TV is identified by
MAC address, so a DHCP reassignment self-heals via an ARP rediscovery scan.

```powershell
py -3 -m pip install websocket-client wakeonlan pywin32
```

See `tv-control/README.md` for pairing, configuration, and the Windows timing
constraints that shape the design — the suspend window is only a few hundred
milliseconds wide, which is why a connection is held open and rotated rather
than opened on demand.
