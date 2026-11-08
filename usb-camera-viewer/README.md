# USB Camera Viewer

Android app that shows a UVC (USB video class) camera plugged into the phone's USB port.

Built and tested on a POCO X6 Pro 5G (HyperOS 3.0, Android 16, MediaTek MT6897) with an
"HD Camera" (USB ID `13d3:784b`).

## Why the app carries its own USB camera driver

- **Android's camera API does not see the camera.** On this phone the camera service lists only
  its 6 built-in cameras (provider `internal/0`). There is no external camera provider, so
  Camera2 never reports a USB camera.
- **The kernel driver leads nowhere.** The kernel's `uvcvideo` driver binds to the camera, but
  without an external camera provider nothing passes it on to apps.
- **Android's Java USB API cannot stream it.** It does control, bulk and interrupt transfers.
  UVC cameras stream over isochronous endpoints.

So the app runs [libuvc](https://github.com/libuvc/libuvc) on top of
[libusb](https://github.com/libusb/libusb), on the file descriptor that `UsbManager` gives the
app (`libusb_wrap_sys_device`, through libuvc's `uvc_wrap`). Before libuvc starts, the app takes
the video interfaces from `uvcvideo` with `claimInterface(intf, true)`. When the app closes the
camera, libuvc gives them back to `uvcvideo`.

## The app

- **Permissions**: on start it asks for the Camera permission (for apps that target Android 9+,
  USB access to a video-class device fails without it), then for USB access to the camera. The
  manifest also offers the app when a camera is plugged in; choosing it grants USB access.
- **Mode**: the first match of: 25 fps or more, then MJPEG before YUYV, then at most 1080p, then
  the larger picture, then the higher frame rate. The HD Camera starts in MJPEG 1280×720 30 fps.
- **Picture**: MJPEG frames are decoded with `AImageDecoder` (Android 11+), YUYV is converted in
  C. Frames go to a `SurfaceView` that keeps the camera's aspect ratio. The system bars stay
  visible.
- **Status line**: camera, mode and frames shown per second. It hides after 4 s of frames and
  comes back when frames stop. A tap on it retries after an error; nothing else takes taps.
- **Watchdog**: with no frame for 3 s, the app closes and opens the camera again.
- **Forced mode** (kind 0 = MJPEG, 1 = YUYV, then width, height, fps):

  ```bash
  adb shell am start -n com.tomerg.usbcamera/.MainActivity --es mode 1,640,480,20
  ```

`app/jni/usbcamera.c` is the native side, `UvcCamera.java` its JNI bridge, `Modes.java` the
mode choice, `MainActivity.java` the rest.

### Build

Needs JDK 17+, git and the Android SDK with `platforms;android-36`, `build-tools;36.0.0` and an
NDK:

```bash
sdkmanager "platforms;android-36" "build-tools;36.0.0" "ndk;28.2.13676358"
./build.sh
```

On the first build, `build.sh` fetches libusb 1.0.30 and libuvc 0.0.9 at pinned commits into
`third_party/` (git-ignored). It compiles them and the JNI bridge with the NDK's clang into
`lib/arm64-v8a/libusbcamera.so`, then builds `build/usb-camera.apk` the same way as
`ir-volume-remote` (aapt2, javac, d8, apksigner, no Gradle).

### Packets per USB transfer

libuvc keeps 100 isochronous transfers queued. With its default of 32 packets per transfer
(51 KB at the 1600 bytes per microframe that MJPEG 1280×720 uses here), this phone refused
transfers with ENOMEM: `libusb: error [submit_iso_transfer] submiturb failed, errno=12`. When a
submit fails, libuvc drops that transfer for good (in `stream.c`, at start it also drops all
transfers not yet submitted). Seen on this phone:

- ENOMEM once at start, then 13 truncated frames, then a second ENOMEM at 18 s, the moment
  the picture froze. From libuvc's code, only 1 transfer was left after the first ENOMEM, and
  the second one dropped it.
- ENOMEM once at start, and the stream did not start (`uvc_start_streaming: I/O error (-1)`).
- Runs with no ENOMEM at all: the failure comes and goes.

With 8 packets (12.8 KB) there was no ENOMEM in 4 opens over about 4 minutes (MJPEG 1280×720
and YUYV 640×480). `build.sh` uses 8. To try another value:

```bash
PACKETS=4 ./build.sh
```

### Install

Wireless debugging (Android 11+) keeps the USB port free for the camera: Developer options →
**Wireless debugging** → **Pair device with pairing code**, then:

```bash
adb pair <phone-ip>:<pairing-port>
adb connect <phone-ip>:<port-shown-on-the-wireless-debugging-screen>
```

On HyperOS, Wireless debugging turned itself off twice during testing. Turning it on again was
enough: the pairing stays.

HyperOS refuses `adb install` (`INSTALL_FAILED_USER_RESTRICTED`) unless **Install via USB** is
on, which needs a Mi account. Open the phone's installer instead (as in `ir-volume-remote`):

```bash
adb push build/usb-camera.apk /sdcard/Download/usb-camera.apk
adb shell content call --uri content://media --method scan_file \
    --arg /storage/emulated/0/Download/usb-camera.apk
adb shell "content query --uri content://media/external/file --projection _id \
    --where \"_display_name='usb-camera.apk'\""          # prints _id=N
adb shell am start -f 0x10008000 -a android.intent.action.VIEW --grant-read-uri-permission \
    -t application/vnd.android.package-archive -d content://media/external/file/N
```

`-f 0x10008000` (new task, clear task) matters on a second install: without it the phone brings
back the previous installer screen and installs nothing. On this phone the installer then
installed without a tap.

### Log

```bash
adb logcat -s usbcamera libusb
```

Once a second while streaming: `HD Camera · MJPEG 1280×720 30 fps · showing 30 fps (… received,
… shown)`. A close with the camera plugged in usually logs one error line:
`submit_bulk_transfer submiturb failed, errno=16` (EBUSY). Measured: it comes at the close, and
right after the close `uvcvideo` holds the camera's interfaces again. Likely, from libuvc's code:
the camera's status transfer completes during the close, and libuvc's attempt to submit it
again fails because `uvcvideo` now owns the interface.

Of 11 such closes in the saved logs of 2026-11-08, 9 logged that line, 1 logged nothing, and 1
logged two other lines: `[do_close] Device handle closed while transfer was still being
processed` and `[do_close] A cancellation hasn't even been scheduled`. From the code:
`uvc_close` does not cancel the status transfer before `libusb_close`, and libusb prints these
two lines when a transfer is still in flight at that point. The camera opened normally after
all 11. A close after an unplug logs no libusb error.

### Tests

```bash
./tests/run.sh
```

Plain JDK, no SDK. Checks which mode `Modes.pick` starts a camera in for webcam-like mode
lists, in both list orders. Checks that the ranking is a strict order (so the list order cannot
change the pick), and the parsing of the forced mode (327 checks). Mutation-checked: removing
the 25 fps rule, the MJPEG preference or the 1080p cap, preferring larger frames above 1080p or
lower frame rates, ignoring the forced mode, a 26 fps threshold, or a looser parse each make it
fail.

### Tested on the phone (2026-11-08)

- **Unplug and plug in while the app runs** (by hand, twice). On unplug, the status line showed
  "Plug in a USB camera." 8 to 33 ms after the system removed the camera. On plug-in, the phone
  opened the app for the camera with no dialog: on this phone the app is the camera's default
  (`adb shell dumpsys usb`, under `device_preferences`). The stream started 0.19 and 0.26 s after
  the system saw the camera, at 30 fps. The app opens the camera twice on plug-in: once from its
  attach receiver, and again because the system's new intent pauses and resumes the activity.
  The first stream lives under 0.1 s.
- **Rotation**, through `adb shell cmd window user-rotation lock 1`, then `3`, then `0`
  (auto-rotate is off on this phone). The activity was not recreated and the camera was not
  reopened. Frames stayed at 30 fps. In both landscape rotations the picture stayed upright,
  16:9 and clear of the system bars.
- **Watchdog**, with a test build that is not in this repo. It adds an adb broadcast that calls
  `libusb_cancel_transfer` on every transfer in libuvc's stream handle. libuvc frees a cancelled
  transfer and does not submit it again, so the stream ends in the same state as the ENOMEM
  freeze: running, with no transfer left. 5 stalls: 4 in MJPEG 1280×720 and 1 in a forced YUYV
  640×480. Each time, the status line came back with "showing 0 fps", and the app logged
  `No frame for 3001 ms, reopening (N)` (3001 to 3003 ms). The check runs once a second, so
  this is 3 to 4 s after the last frame. Frames were back within 1 s, at the full rate the
  second after. The reopen kept the forced mode.

### Not tested

- A real stall (ENOMEM) reaching the watchdog. The watchdog test cancelled transfers instead.
- Plugging the camera in when the app is not its default (the USB access dialog and the offer
  to open the app), or while the app is not running.
- Other cameras and other phones.
