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
  **Mode** on the button bar lists the camera's modes (each frame size at its highest frame
  rate) and "Auto". The choice is saved per camera model (USB vendor and product ID).
- **Picture**: MJPEG frames are decoded with `AImageDecoder` (Android 11+), YUYV is converted in
  C. Frames go to a `TextureView`. One matrix places them: turned, mirrored, fitted with the
  camera's aspect ratio, then zoomed and moved. The system bars stay visible.
- **Buttons**: Photo, Mode, Adjust, Rotate, Mirror, at the bottom. A tap on the picture hides or
  shows them.
- **Rotate and Mirror**: a quarter turn clockwise; left and right swapped. Both are saved per
  camera model, since they follow how the camera is mounted.
- **Zoom**: pinch to zoom (up to 8×), drag to move, double tap to zoom out. The picture's edges
  stay at the screen's edges. Done on the phone's GPU, so it works with any camera. Not saved.
- **Photo**: saves the last decoded frame as a JPEG (quality 95) to `Pictures/USB Camera` in
  the phone's shared storage, where the Gallery finds it. At the camera's full frame size,
  turned and mirrored as on screen, without the zoom. No storage permission is needed (the app
  writes its own files through `MediaStore`).
- **Adjust**: the camera's own settings (UVC controls), as sliders and switches: auto exposure,
  exposure, gain, brightness, contrast, saturation, hue, sharpness, gamma, backlight
  compensation, auto white balance, white balance, power line frequency, autofocus, focus and
  the camera's own zoom. **Each camera lists the controls it has** (in its USB descriptor, the
  `bmControls` bits of its camera terminal and processing unit). The app shows only those, and
  only when the camera also answers the range requests for them. A fixed-focus camera has no
  focus slider. A camera with none shows "This camera has no settings the app can change". An
  auto switch greys out the slider it drives (exposure, white balance, focus). "Reset to
  defaults" sets every control to the camera's own default. The values live in the camera, so
  the app does not save them; a camera may reset them when unplugged. The log lists each
  camera's controls when it opens (`HD Camera controls: ...`).
- **Status line**: camera, mode and frames shown per second. It hides after 4 s of frames and
  comes back when frames stop. A tap on it retries after an error.
- **Watchdog**: with no frame for 3 s, the app closes and opens the camera again.
- **Forced mode**, for one launch, ahead of the saved choice (kind 0 = MJPEG, 1 = YUYV, then
  width, height, fps):

  ```bash
  adb shell am start -n com.tomerg.usbcamera/.MainActivity --es mode 1,640,480,20
  ```

`app/jni/usbcamera.c` is the native side, `UvcCamera.java` its JNI bridge, `Modes.java` the
mode choice, `Picture.java` the picture's placement, `Controls.java` the control list,
`MainActivity.java` the rest.

### UVC controls

The native side sends the control requests itself (`libusb_control_transfer` with a 1 s
timeout), not through libuvc's control functions, which wait forever. The control table in
`usbcamera.c` takes its bit numbers, sizes and requests from the Linux `uvcvideo` driver's
control table (`drivers/media/usb/uvc/uvc_ctrl.c`):

- Range controls answer `GET_MIN`, `GET_MAX`, `GET_RES`, `GET_DEF`, `GET_CUR`. Brightness and
  hue are signed.
- Switches (auto white balance, autofocus) and power line frequency answer only `GET_DEF` and
  `GET_CUR`. Power line frequency offers off, 50 Hz and 60 Hz, plus auto when the camera is
  UVC 1.5. A camera may refuse some of these values; the app then says so and shows the value
  the camera kept.
- Auto exposure answers `GET_RES` with the modes the camera has. "On" sets the camera's default
  mode if it is an auto mode, else aperture priority (automatic exposure time), else full auto.
  "Off" sets manual.

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

Plain JDK, no SDK. Three test classes:

- `ModesTest` (340 checks): which mode `Modes.pick` starts a camera in for webcam-like mode
  lists, in both list orders; that the ranking is a strict order (so the list order cannot
  change the pick); the parsing of the forced mode; the saved form of a picked mode; the mode
  picker's order. Mutation-checked: removing the 25 fps rule, the MJPEG preference or the 1080p
  cap, preferring larger frames above 1080p or lower frame rates, ignoring the forced mode, a
  26 fps threshold, or a looser parse each make it fail.
- `PictureTest` (372 checks): where each corner of the frame lands for all 4 turns, with and
  without mirror; that the scale is the same both ways (aspect ratio); that the TextureView
  matrix lands 20 random frame points where `Picture.map` says, for each turn, mirror, zoom and
  pan; that the pinch point stays put; the zoom limits; that a drag stops when an edge reaches
  the screen's edge; that nothing becomes NaN before the first frame.
- `ControlsTest` (5824 checks): reads `control_table` from `usbcamera.c` and checks each row's
  selector, unit, bit, size and kind against the Java ids and the Linux driver's bit numbers;
  the auto switch links; value texts; that every slider position maps to a value on the
  camera's step grid and back.

17 deliberate bugs in `Picture`, `Controls`, `Modes` and the C table (a swapped turn, mirror
before the turn, no stretch undo, no clamp, zoom ignoring the pinch point, two swapped C rows, a
wrong bit, hue unsigned, and others) each make it fail.

```bash
./tests/native.sh
```

Compiles `app/jni/usbcamera.c` on the build machine with stub Android headers
(`tests/native/stubs`) and a fake camera behind `libusb_control_transfer`, and runs
`tests/native/harness.c` twice: with AddressSanitizer and UndefinedBehaviorSanitizer, then with
ThreadSanitizer (107 checks each). Needs clang, a JDK (for `jni.h`) and `third_party/` from a
first `./build.sh`. Checks the control list (declared and answering controls only; a stalling,
a short and an empty-range control are left out; undeclared controls are never asked), signed
and 4-byte values, the auto exposure modes for 7 mode sets, refused values and missing units,
the 1 s timeout on every transfer, the snapshot copy (row stride, size and format checks, no
snapshot after a bad frame) and the drawing on the window. A thread decoding frames while
another takes snapshots runs under ThreadSanitizer. 17 deliberate bugs (no frame lock in the
snapshot or the frame callback, stride ignored, signed read as unsigned, big-endian values,
`bmControls` ignored or off by one bit, no timeout, the wrong auto exposure mode, and others)
each make it fail.

### Tested on the phone (2026-11-09, the features above)

By hand, from 20:15 to 20:21 Israel time. Results from the app's log.

- **HD Camera controls**: 13. Auto exposure, exposure (1 to 250 ms), gain, brightness,
  contrast, saturation, hue, sharpness, gamma, backlight compensation, auto white balance, white
  balance (2800 to 6500 K), power line frequency (off, 50 Hz, 60 Hz). The camera declares no
  focus and no zoom, so the panel has no autofocus, focus or zoom row.
- **Photo**: two photos, 1280×720 JPEG, in `Pictures/USB Camera`. The first one matched the
  screen.
- **Mode**: the picker switched to YUYV 640×480, MJPEG 640×480 and MJPEG 1280×720. Each pick
  reopened the camera in that mode.
- **Adjust**: gain, brightness, sharpness, gamma and backlight compensation were changed. After a
  reopen the camera read back the new values (gain 5, brightness 172, sharpness 6, gamma 137,
  backlight 1). "Reset to defaults" brought back gain 4, brightness 128, sharpness 2, gamma 120
  and backlight 0.
- **Rotate, Mirror, pinch zoom**: reported working by the person testing. They write nothing to
  the log, and no screenshot was taken with them on.
- **Screen rotation** with the `TextureView`, through `adb shell cmd window user-rotation lock
  1`, then `3`, then `0`. Same process, no reopen of the camera, and the frame rate did not
  change. In both landscape rotations the picture was upright, 16:9 (1442×812 of 2000×900 in
  the screenshot) and below the status bar.
- **10 fps**: the camera sent 10 frames a second in every mode tried, including YUYV 640×480 (a
  20 fps mode). Received always equalled shown, so the app dropped nothing. The committed build
  without these features (c0f80c6), run 5 minutes later in the same place, also got 10 fps, so
  the new code did not cause it. On 2026-11-08 the camera sent 30 fps. Cause not found. Guess,
  not tested: auto exposure lowers the frame rate in a dark room.

### Tested on the phone (2026-11-08, build a087ff9, before the features above)

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

- The `TextureView` at 30 fps: the camera sent only 10 fps during the 2026-11-09 test.
- Whether auto exposure off, or more light, brings back 30 fps.
- A photo with Rotate or Mirror on (the turn and mirror in the saved file).
- The replug and watchdog tests of 2026-11-08 with the `TextureView` build.
- A real stall (ENOMEM) reaching the watchdog. The watchdog test cancelled transfers instead.
- Plugging the camera in when the app is not its default (the USB access dialog and the offer
  to open the app), or while the app is not running.
- Other cameras and other phones.
