package com.tomerg.usbcamera;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * View of a UVC (USB video class) camera on the phone's USB port, through libuvc. The system bars
 * stay visible, and only the status line takes taps (to retry after an error). To force a mode:
 * adb shell am start -n com.tomerg.usbcamera/.MainActivity --es mode 0,640,480,30
 * (kind 0 = MJPEG or 1 = YUYV, then width, height, fps).
 */
public class MainActivity extends Activity implements SurfaceHolder.Callback {

    private static final String TAG = "usbcamera";
    private static final String ACTION_USB_PERMISSION = "com.tomerg.usbcamera.USB_PERMISSION";
    /** The status line hides once frames have shown for this long. */
    private static final long STATUS_MS = 4000;
    /** With no frame for this long, the camera is closed and opened again. */
    private static final long STALL_MS = 3000;

    private UsbManager usb;
    private VideoView video;
    private TextView status;
    /** Opens and closes the camera: libuvc's control transfers block, so not on the UI thread. */
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    // UI thread
    private boolean resumed, askedCamera, askedUsb;
    private UsbDevice device; // open, or being opened on the worker
    private String deviceName;
    private int[] mode; // set once the stream starts
    private long streamStart, lastFrameTime;
    private int lastShown, lastReceived, reopens;

    // Worker thread
    private UsbDeviceConnection connection;
    private long handle;

    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            // Exported so the system's attach and detach broadcasts arrive. Nothing in the
            // intent is trusted: the state is read again from UsbManager.
            String action = intent.getAction();
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                askedUsb = false;
                if (device != null && !usb.getDeviceList().containsKey(device.getDeviceName())) {
                    stopCamera();
                }
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                askedUsb = false;
            }
            startCamera();
        }
    };

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            video.postDelayed(this, 1000);
            if (mode == null) return;
            long now = SystemClock.uptimeMillis();
            int[] s = UvcCamera.stats();
            int fps = s[1] - lastShown;
            lastShown = s[1];
            if (s[0] != lastReceived) {
                lastReceived = s[0];
                lastFrameTime = now;
            } else if (now - lastFrameTime >= STALL_MS) {
                // libuvc drops a transfer for good when resubmitting it fails, and the stream
                // stops when none are left. Opening the camera again starts a fresh set.
                reopens++;
                Log.w(TAG, "No frame for " + (now - lastFrameTime) + " ms, reopening (" + reopens + ")");
                stopCamera();
                startCamera();
                return;
            }
            String text = deviceName + " · " + Modes.label(mode) + " · showing " + fps + " fps"
                    + (s[2] > 0 ? " · " + s[2] + " bad frames" : "")
                    + (reopens > 0 ? " · reopened " + reopens + "×" : "");
            status.setText(text);
            Log.i(TAG, text + " (" + s[0] + " received, " + s[1] + " shown)");
            // Keep the status line up until frames flow, and whenever they stop.
            boolean flowing = fps > 0 && now - streamStart > STATUS_MS;
            status.setVisibility(flowing ? View.GONE : View.VISIBLE);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        usb = (UsbManager) getSystemService(USB_SERVICE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        video = new VideoView(this);
        video.getHolder().addCallback(this);
        root.addView(video, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(15);
        status.setBackgroundColor(0x99000000);
        status.setPadding(dp(10), dp(6), dp(10), dp(6));
        status.setOnClickListener(v -> retry());
        FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.START);
        statusParams.setMargins(dp(8), dp(8), dp(8), 0);
        root.addView(status, statusParams);
        // Android 15+ draws apps edge to edge: keep the picture clear of the system bars.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(root);

        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        registerReceiver(usbReceiver, filter, RECEIVER_EXPORTED);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // A camera was plugged in and the user chose this app for it, or adb asked for a mode.
        askedUsb = false;
        if (intent.hasExtra("mode")) stopCamera();
        startCamera();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        startCamera();
        video.postDelayed(tick, 1000);
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        video.removeCallbacks(tick);
        stopCamera();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        unregisterReceiver(usbReceiver);
        worker.shutdown();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        startCamera();
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        UvcCamera.setSurface(holder.getSurface());
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        UvcCamera.setSurface(null);
    }

    /** Opens the first attached camera, asking for the two permissions it needs on the way. */
    private void startCamera() {
        if (!resumed || device != null) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            // Android 9+ gives USB video devices only to apps that hold CAMERA.
            if (!askedCamera) {
                askedCamera = true;
                requestPermissions(new String[] {Manifest.permission.CAMERA}, 1);
            }
            show("USB cameras need the Camera permission. Tap here to ask again.");
            return;
        }
        UsbDevice found = findCamera();
        if (found == null) {
            show("Plug in a USB camera.");
            return;
        }
        String name = found.getProductName() != null ? found.getProductName() : "USB camera";
        if (!usb.hasPermission(found)) {
            if (!askedUsb) {
                askedUsb = true;
                Intent intent = new Intent(ACTION_USB_PERMISSION).setPackage(getPackageName());
                usb.requestPermission(found, PendingIntent.getBroadcast(this, 0, intent, PendingIntent.FLAG_IMMUTABLE));
            }
            show("No USB access to " + name + ". Tap here to ask again.");
            return;
        }
        device = found;
        deviceName = name;
        show("Opening " + name + "…");
        int[] want = Modes.parse(getIntent().getStringExtra("mode"));
        worker.execute(() -> open(found, name, want));
    }

    private void stopCamera() {
        if (device == null) return;
        device = null;
        mode = null;
        worker.execute(this::close);
    }

    /** Worker thread. */
    private void open(UsbDevice d, String name, int[] want) {
        UsbDeviceConnection c = usb.openDevice(d);
        if (c == null) {
            failed(d, "Cannot open " + name + ".");
            return;
        }
        // Take the video interfaces from any kernel driver; libuvc claims them again on this fd.
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface intf = d.getInterface(i);
            if (intf.getInterfaceClass() == UsbConstants.USB_CLASS_VIDEO) c.claimInterface(intf, true);
        }
        long h = 0;
        try {
            h = UvcCamera.open(c.getFileDescriptor());
            int[] all = UvcCamera.modes(h);
            StringBuilder list = new StringBuilder();
            for (int i = 0; i < Modes.count(all); i++) list.append(i > 0 ? ", " : "").append(Modes.label(Modes.get(all, i)));
            Log.i(TAG, name + " modes: " + list);
            int[] m = Modes.pick(all, want);
            if (m == null) throw new IOException(name + " has no MJPEG or YUYV mode.");
            UvcCamera.start(h, m[0], m[1], m[2], m[3]);
            handle = h;
            connection = c;
            runOnUiThread(() -> started(d, m));
        } catch (IOException e) {
            if (h != 0) UvcCamera.close(h);
            c.close();
            failed(d, e.getMessage());
        }
    }

    /** Worker thread. */
    private void close() {
        if (handle != 0) {
            UvcCamera.close(handle);
            handle = 0;
        }
        if (connection != null) {
            connection.close();
            connection = null;
        }
    }

    private void started(UsbDevice d, int[] m) {
        if (device != d) return; // stopped meanwhile; the worker closes it next
        mode = m;
        lastShown = 0;
        lastReceived = 0;
        streamStart = lastFrameTime = SystemClock.uptimeMillis();
        video.setVideoSize(m[1], m[2]);
        show(deviceName + " · " + Modes.label(m));
    }

    private void failed(UsbDevice d, String message) {
        runOnUiThread(() -> {
            if (device != d) return;
            device = null;
            show(message + " Tap here to retry.");
        });
    }

    /** A tap on the status line: ask for refused permissions again and retry. */
    private void retry() {
        if (device != null) return;
        askedCamera = false;
        askedUsb = false;
        startCamera();
    }

    /** The first attached device with a video-class interface. */
    private UsbDevice findCamera() {
        for (UsbDevice d : usb.getDeviceList().values()) {
            for (int i = 0; i < d.getInterfaceCount(); i++) {
                if (d.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_VIDEO) return d;
            }
        }
        return null;
    }

    private void show(String message) {
        status.setText(message);
        status.setVisibility(View.VISIBLE);
        Log.i(TAG, message);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** A SurfaceView that keeps the camera's aspect ratio inside its parent. */
    static class VideoView extends SurfaceView {
        private int videoWidth, videoHeight;

        VideoView(Context context) {
            super(context);
        }

        void setVideoSize(int width, int height) {
            videoWidth = width;
            videoHeight = height;
            requestLayout();
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            int w = MeasureSpec.getSize(widthSpec), h = MeasureSpec.getSize(heightSpec);
            if (videoWidth > 0 && videoHeight > 0) {
                if ((long) w * videoHeight > (long) h * videoWidth) {
                    w = (int) ((long) h * videoWidth / videoHeight);
                } else {
                    h = (int) ((long) w * videoHeight / videoWidth);
                }
            }
            setMeasuredDimension(w, h);
        }
    }
}
