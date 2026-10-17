# IR Volume Remote

Android app that turns a phone's IR blaster into a volume remote for a DIY
volume kit (an Alps motorized potentiometer board with an IR receiver), plus
the sweep tool that found the kit's codes.

Built and tested on a POCO X6 Pro 5G (HyperOS 3.0, Android 16).

## The kit's codes

Found by sweeping NEC codes from the phone and watching the knob.

| Key | Protocol | Address | Command | 32-bit (IRremote legacy) |
|-----|----------|---------|---------|--------------------------|
| VOL+ | NEC | 0x00 | 0x05 | `0x00FFA05F` |
| VOL- | NEC | 0x00 | 0x04 | `0x00FF20DF` |

No AV receiver brand uses these. Searched IRDB (3,280 files), Flipper-IRDB
(8,983) and the LIRC remotes (3,358): Pioneer, Sony, Onkyo, Yamaha, Denon,
Marantz, Harman Kardon, NAD, Panasonic, Kenwood, JVC and NEC each use their own
address or protocol, so a brand preset in a universal-remote app cannot drive
the kit. The same two codes are BRIGHTNESS UP / DOWN on the common 24-key RGB
LED remote (the `0xFF`-prefix family; the `0xF7`-prefix family is a different
address and does not work).

## The app

`app/` is plain Java, no Gradle and no AndroidX.

- **VOL+ / VOL-**: square buttons. Hold to keep sending (one frame, then NEC
  repeat frames, in 450 ms transmit calls so a release stops the motor
  quickly). The address and the two commands are editable (hex) and remembered.
- **MUTE**: one tap sends VOL- for 10 s, enough to run the motor pot down to
  its end stop. A second tap, or any other button, stops it.
- **Brand test**: sends every brand's VOL+ for 3 s each and shows which one is
  on air, to check whether the kit also answers a brand code. Each brand row
  also has its own hold-to-send `+` / `−` buttons.

Brand codes come from Flipper-IRDB `Audio_and_Video_Receivers` (most common
entry per brand), plus Pioneer SX-Q180, older Yamaha, Kenwood, NEC and
Cambridge Azur 540R from IRDB / LIRC. Timings and bit layouts follow the
Flipper Zero firmware encoders (NEC, NECext, Pioneer, SIRC, RC5, Kaseikyo).

### Build and install

Needs JDK 17+ and the Android SDK with `platforms;android-36` and
`build-tools;36.0.0`:

```bash
brew install --cask android-commandlinetools
sdkmanager --licenses
sdkmanager "platforms;android-36" "build-tools;36.0.0"
./build.sh
adb install -r build/ir-volume.apk
```

`build.sh` signs with `~/.android/debug.keystore` (created if missing).

On Xiaomi / HyperOS `adb install` fails with `INSTALL_FAILED_USER_RESTRICTED`
unless Developer options → **Install via USB** is on, and that switch needs a
Mi account. Without one, copy the APK over and open the phone's installer:

```bash
adb push build/ir-volume.apk /sdcard/Download/ir-volume.apk
adb shell content call --uri content://media --method scan_file \
    --arg /storage/emulated/0/Download/ir-volume.apk
adb shell "content query --uri content://media/external/file --projection _id \
    --where \"_display_name='ir-volume.apk'\""          # prints _id=N
adb shell am start -a android.intent.action.VIEW --grant-read-uri-permission \
    -t application/vnd.android.package-archive -d content://media/external/file/N
```

Then tap Install on the phone. The scan step matters: a file pushed over adb is
not in the media index, so the Files app does not list it.

### Tests

```bash
./tests/run.sh
```

Plain JDK, no SDK. Encodes every code with `IrCodes`, decodes the timings with
independent decoders (the Flipper decoders' interpret logic) and checks the
round trip: all brand codes, the whole 8-bit NEC space, every RC5 and SIRC12
code, period padding, and that no transmit chunk passes Android's 2 s limit
(5,245,231 checks). Mutation-checked: breaking the Kaseikyo parity, the NEC
inverse byte, the SIRC bit order, the NECext byte order, the Kaseikyo command
split, the Pioneer silence or the RC5 toggle each makes it fail.

## The sweep tool

`irsweep.py` runs on the Mac and sends codes through `adb shell service call
consumer_ir`. No app is needed for this: the adb shell user already holds
`TRANSMIT_IR`. Android caps one transmit at 2 s, so longer holds are split
into several calls.

```bash
python3 irsweep.py --log sweep.csv                    # everything, 1 s per code
python3 irsweep.py --log step.csv --only 9,64,67 --hold 3
python3 irsweep.py --log x --dry-run --start 0 --end 3
```

Order: NEC address 0x00 (256 codes), RC5 (2,048), Sony SIRC12 (4,096), then
NEC addresses 0x01-0xFF (65,280). 71,680 codes, about 27 h at 1 s each. Each
line of the CSV log is written when its code **finishes**, so when the knob
moves, the code on air is the one after the last line.
