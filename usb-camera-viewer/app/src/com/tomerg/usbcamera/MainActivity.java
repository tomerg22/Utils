package com.tomerg.usbcamera;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Log;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import java.io.IOException;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * View of a UVC (USB video class) camera on the phone's USB port, through libuvc. The system bars
 * stay visible. A tap on the picture shows or hides the buttons; pinch zooms, a drag moves the
 * zoomed picture, a double tap zooms out. A tap on the status line retries after an error.
 * To force a mode for one launch:
 * adb shell am start -n com.tomerg.usbcamera/.MainActivity --es mode 0,640,480,30
 * (kind 0 = MJPEG or 1 = YUYV, then width, height, fps).
 */
public class MainActivity extends Activity implements TextureView.SurfaceTextureListener {

    private static final String TAG = "usbcamera";
    private static final String ACTION_USB_PERMISSION = "com.tomerg.usbcamera.USB_PERMISSION";
    /** The status line hides once frames have shown for this long. */
    private static final long STATUS_MS = 4000;
    /** With no frame for this long, the camera is closed and opened again. */
    private static final long STALL_MS = 3000;
    /** Where snapshots go, under the phone's shared storage. */
    private static final String PHOTO_DIR = Environment.DIRECTORY_PICTURES + "/USB Camera";

    /**
     * Opens and closes the camera, and sends it control requests: libuvc's control transfers
     * block, so not on the UI thread. Static, so one thread serves every instance: when the
     * activity is recreated (a config change it does not handle, or Back then a relaunch), the
     * new instance's open waits for the old instance's close instead of racing it for the USB
     * interfaces and the native globals.
     */
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();
    /** Compresses and stores snapshots, so a save does not hold up the camera. */
    private static final ExecutorService SAVER = Executors.newSingleThreadExecutor();
    /** The surface frames go to. Instances share the native side, so only its owner detaches it. */
    private static Surface shownSurface;

    private UsbManager usb;
    private SharedPreferences prefs;
    private TextureView video;
    private TextView status;
    private LinearLayout toolbar, panelRows;
    private ScrollView panel;
    private TextView photoButton, modeButton, adjustButton;
    private final Picture picture = new Picture();

    // UI thread
    private Surface surface;
    private boolean resumed, askedCamera, askedUsb;
    private UsbDevice device; // open, or being opened on the worker
    private String deviceName;
    private String deviceKey; // vendor:product, for the saved choices
    private int[] mode; // set once the stream starts
    private int frameWidth, frameHeight; // of the last mode, kept after a stop for the transform
    private int[] modes; // the open camera's modes
    private int[] controls; // the open camera's controls, see Controls
    private final Map<Integer, Row> rows = new HashMap<>(); // control id to its row in the panel
    private long streamStart, lastFrameTime;
    private int lastShown, lastReceived, reopens;

    // Worker thread
    private UsbDeviceConnection connection;
    private long handle;

    /** Control values the worker has yet to send: the newest one per control id. */
    private final Map<Integer, Integer> pendingSets = new ConcurrentHashMap<>();

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
        prefs = getSharedPreferences("usbcamera", MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        video = new TextureView(this);
        video.setSurfaceTextureListener(this);
        video.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            picture.clamp(video.getWidth(), video.getHeight(), frameWidth, frameHeight);
            applyTransform();
        });
        listenToGestures();
        root.addView(video, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

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

        panelRows = new LinearLayout(this);
        panelRows.setOrientation(LinearLayout.VERTICAL);
        panelRows.setPadding(dp(14), dp(10), dp(14), dp(10));
        panel = new ScrollView(this);
        panel.setBackgroundColor(0xCC000000);
        panel.addView(panelRows);
        panel.setVisibility(View.GONE);
        FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(dp(320),
                ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END);
        panelParams.setMargins(0, 0, 0, dp(60)); // clear of the buttons
        root.addView(panel, panelParams);

        toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        photoButton = addButton("Photo", v -> takeSnapshot());
        modeButton = addButton("Mode", v -> pickMode());
        adjustButton = addButton("Adjust", v -> togglePanel());
        addButton("Rotate", v -> rotate());
        addButton("Mirror", v -> mirror());
        FrameLayout.LayoutParams toolbarParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        toolbarParams.setMargins(0, 0, 0, dp(8));
        root.addView(toolbar, toolbarParams);

        // Android 15+ draws apps edge to edge: keep the picture clear of the system bars.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(root);
        buildPanel();
        updateButtons();

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
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        startCamera();
    }

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
        surface = new Surface(texture);
        shownSurface = surface;
        UvcCamera.setSurface(surface);
    }

    @Override
    public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {}

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) {
        // After setSurface(null) returns, the frame thread no longer draws on it.
        if (shownSurface == surface) {
            UvcCamera.setSurface(null);
            shownSurface = null;
        }
        if (surface != null) surface.release();
        surface = null;
        return true;
    }

    @Override
    public void onSurfaceTextureUpdated(SurfaceTexture texture) {}

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
        String key = String.format(Locale.US, "%04x:%04x", found.getVendorId(), found.getProductId());
        if (!key.equals(deviceKey)) {
            // Turn and mirror are saved per camera model: they follow how it is mounted.
            deviceKey = key;
            picture.rotation = prefs.getInt("rotation." + key, 0) & 3;
            picture.mirror = prefs.getBoolean("mirror." + key, false);
            picture.resetZoom();
            applyTransform();
        }
        device = found;
        deviceName = name;
        show("Opening " + name + "…");
        int[] want = wantedMode();
        WORKER.execute(() -> open(found, name, want));
    }

    /** The launch intent's mode (adb), else the one picked for this camera model, else null. */
    private int[] wantedMode() {
        int[] want = Modes.parse(getIntent().getStringExtra("mode"));
        if (want == null && deviceKey != null) want = Modes.parse(prefs.getString("mode." + deviceKey, null));
        return want;
    }

    private void stopCamera() {
        if (device == null) return;
        device = null;
        mode = null;
        modes = null;
        controls = null;
        pendingSets.clear();
        buildPanel();
        updateButtons();
        WORKER.execute(this::close);
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
            runOnUiThread(() -> started(d, m, all));
        } catch (IOException e) {
            if (h != 0) UvcCamera.close(h);
            c.close();
            failed(d, e.getMessage());
            return;
        }
        // After the stream starts, so reading them does not delay the picture.
        int[] read = UvcCamera.controls(h);
        int[] ctl = read != null ? read : new int[0]; // null only when Java is out of memory
        Log.i(TAG, name + " controls: " + Controls.describe(ctl));
        runOnUiThread(() -> {
            if (device != d) return;
            controls = ctl;
            buildPanel();
            updateButtons();
        });
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

    private void started(UsbDevice d, int[] m, int[] all) {
        if (device != d) return; // stopped meanwhile; the worker closes it next
        mode = m;
        modes = all;
        lastShown = 0;
        lastReceived = 0;
        streamStart = lastFrameTime = SystemClock.uptimeMillis();
        if (frameWidth != m[1] || frameHeight != m[2]) {
            frameWidth = m[1];
            frameHeight = m[2];
            picture.resetZoom();
        }
        applyTransform();
        updateButtons();
        show(deviceName + " · " + Modes.label(m));
    }

    private void failed(UsbDevice d, String message) {
        runOnUiThread(() -> {
            if (device != d) return;
            device = null;
            updateButtons();
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

    // ---- Picture: turn, mirror, zoom ----------------------------------------------------------

    private void applyTransform() {
        Matrix m = new Matrix();
        m.setValues(picture.textureMatrix(video.getWidth(), video.getHeight(), frameWidth, frameHeight));
        video.setTransform(m);
        video.invalidate();
    }

    private void listenToGestures() {
        ScaleGestureDetector scaler = new ScaleGestureDetector(this,
                new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                    @Override
                    public boolean onScale(ScaleGestureDetector d) {
                        picture.zoomAt(d.getScaleFactor(), d.getFocusX(), d.getFocusY(),
                                video.getWidth(), video.getHeight(), frameWidth, frameHeight);
                        applyTransform();
                        return true;
                    }
                });
        GestureDetector gestures = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) {
                return true;
            }

            @Override
            public boolean onScroll(MotionEvent e1, MotionEvent e2, float dx, float dy) {
                // dx and dy are how far the finger moved back; the picture follows the finger.
                picture.panBy(-dx, -dy, video.getWidth(), video.getHeight(), frameWidth, frameHeight);
                applyTransform();
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent e) {
                picture.resetZoom();
                applyTransform();
                return true;
            }

            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                boolean show = toolbar.getVisibility() != View.VISIBLE;
                toolbar.setVisibility(show ? View.VISIBLE : View.GONE);
                if (!show) panel.setVisibility(View.GONE);
                return true;
            }
        });
        video.setOnTouchListener((v, e) -> {
            scaler.onTouchEvent(e);
            gestures.onTouchEvent(e);
            return true;
        });
    }

    private void rotate() {
        picture.rotate();
        if (deviceKey != null) prefs.edit().putInt("rotation." + deviceKey, picture.rotation).apply();
        applyTransform();
    }

    private void mirror() {
        picture.toggleMirror();
        if (deviceKey != null) prefs.edit().putBoolean("mirror." + deviceKey, picture.mirror).apply();
        applyTransform();
    }

    // ---- Mode picker --------------------------------------------------------------------------

    private void pickMode() {
        if (modes == null || mode == null) return;
        int[][] list = Modes.sorted(modes);
        int[] want = wantedMode();
        String[] labels = new String[list.length + 1];
        labels[0] = "Auto (" + Modes.label(Modes.pick(modes, null)) + ")";
        // A chosen mode the camera lacks falls back to Auto, so it is ticked only when running.
        int checked = 0;
        for (int i = 0; i < list.length; i++) {
            labels[i + 1] = Modes.label(list[i]);
            if (Arrays.equals(list[i], want) && Arrays.equals(want, mode)) checked = i + 1;
        }
        String key = "mode." + deviceKey;
        new AlertDialog.Builder(this)
                .setTitle("Mode")
                .setSingleChoiceItems(labels, checked, (dialog, which) -> {
                    dialog.dismiss();
                    if (which == 0) prefs.edit().remove(key).apply();
                    else prefs.edit().putString(key, Modes.format(list[which - 1])).apply();
                    getIntent().removeExtra("mode"); // the pick replaces a mode forced by adb
                    stopCamera();
                    startCamera();
                })
                .show();
    }

    // ---- Snapshot -----------------------------------------------------------------------------

    private void takeSnapshot() {
        int[] m = mode;
        if (m == null) return;
        int rotation = picture.rotation;
        boolean mirrored = picture.mirror;
        WORKER.execute(() -> {
            // On the worker: the handle is valid only between its open and close.
            Bitmap frame = Bitmap.createBitmap(m[1], m[2], Bitmap.Config.ARGB_8888);
            if (handle == 0 || !UvcCamera.snapshot(handle, frame)) {
                frame.recycle();
                toast("No picture to save yet.");
                return;
            }
            SAVER.execute(() -> save(frame, rotation, mirrored));
        });
    }

    /** Saver thread. Stores the frame turned and mirrored as on screen, without the zoom. */
    private void save(Bitmap frame, int rotation, boolean mirrored) {
        Bitmap out = frame;
        if (rotation != 0 || mirrored) {
            Matrix m = new Matrix();
            m.setRotate(90 * rotation); // clockwise on screen, as in Picture
            if (mirrored) m.postScale(-1, 1);
            out = Bitmap.createBitmap(frame, 0, 0, frame.getWidth(), frame.getHeight(), m, false);
            frame.recycle();
        }
        String name = "USB_Camera_" + new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date()) + ".jpg";
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, PHOTO_DIR);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        ContentResolver resolver = getApplicationContext().getContentResolver();
        Uri uri = null;
        try {
            uri = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
            if (uri == null) throw new IOException("the media store refused the file");
            try (OutputStream os = resolver.openOutputStream(uri)) {
                if (os == null || !out.compress(Bitmap.CompressFormat.JPEG, 95, os)) {
                    throw new IOException("JPEG compression failed");
                }
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
            Log.i(TAG, "Saved " + uri + ", " + out.getWidth() + "×" + out.getHeight());
            toast("Saved " + PHOTO_DIR + "/" + name);
        } catch (IOException | RuntimeException e) {
            if (uri != null) resolver.delete(uri, null, null);
            Log.w(TAG, "Snapshot not saved", e);
            toast("Could not save the picture: " + e.getMessage());
        } finally {
            out.recycle();
        }
    }

    // ---- Camera controls ----------------------------------------------------------------------

    private void togglePanel() {
        panel.setVisibility(panel.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
    }

    /** One control in the panel: a slider, or a switch for an auto mode. */
    private final class Row {
        final int id, min, max, step;
        final LinearLayout view;
        final TextView label;
        final SeekBar seek; // null for a switch
        final Switch toggle; // null for a slider
        int value;
        boolean dragging, updating;

        Row(int id, int min, int max, int step) {
            this.id = id;
            this.min = min;
            this.max = max;
            this.step = step;
            view = new LinearLayout(MainActivity.this);
            view.setOrientation(LinearLayout.VERTICAL);
            view.setPadding(0, dp(6), 0, dp(6));
            if (Controls.isSwitch(id)) {
                label = null;
                seek = null;
                toggle = new Switch(MainActivity.this);
                toggle.setText(Controls.name(id));
                toggle.setTextColor(Color.WHITE);
                toggle.setTextSize(15);
                toggle.setEnabled(min < max); // a camera may have only one of manual and auto
                toggle.setOnCheckedChangeListener((b, on) -> {
                    if (!updating) changed(on ? 1 : 0);
                });
                view.addView(toggle);
            } else {
                toggle = null;
                label = new TextView(MainActivity.this);
                label.setTextColor(Color.WHITE);
                label.setTextSize(15);
                seek = new SeekBar(MainActivity.this);
                seek.setMax(Controls.steps(min, max, step));
                seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
                    @Override
                    public void onProgressChanged(SeekBar s, int progress, boolean fromUser) {
                        if (fromUser) changed(Controls.valueAt(Row.this.min, Row.this.max, Row.this.step, progress));
                    }

                    @Override
                    public void onStartTrackingTouch(SeekBar s) {
                        dragging = true;
                    }

                    @Override
                    public void onStopTrackingTouch(SeekBar s) {
                        dragging = false;
                    }
                });
                view.addView(label);
                view.addView(seek);
            }
        }

        /** The user moved it: show the value now, send it to the camera on the worker. */
        void changed(int v) {
            value = v;
            if (label != null) label.setText(Controls.name(id) + ": " + Controls.valueText(id, v));
            setControl(id, v);
            int slave = Controls.slave(id);
            if (slave >= 0 && rows.containsKey(slave)) rows.get(slave).setEnabled(v == 0);
        }

        /** The camera's value, without sending anything back. */
        void show(int v) {
            value = v;
            updating = true;
            if (toggle != null) {
                toggle.setChecked(v != 0);
            } else {
                label.setText(Controls.name(id) + ": " + Controls.valueText(id, v));
                if (!dragging) seek.setProgress(Controls.progressOf(min, max, step, v));
            }
            updating = false;
            int slave = Controls.slave(id);
            if (slave >= 0 && rows.containsKey(slave)) rows.get(slave).setEnabled(v == 0);
        }

        void setEnabled(boolean on) {
            if (seek != null) seek.setEnabled(on);
            view.setAlpha(on ? 1f : 0.45f);
        }
    }

    private void buildPanel() {
        panelRows.removeAllViews();
        rows.clear();
        int[] ctl = controls;
        if (ctl == null || Controls.count(ctl) == 0) {
            TextView note = new TextView(this);
            note.setTextColor(Color.WHITE);
            note.setTextSize(15);
            note.setText(ctl == null ? "Waiting for the camera."
                    : "This camera has no settings the app can change.");
            panelRows.addView(note);
            return;
        }
        for (int i = 0; i < Controls.count(ctl); i++) {
            int o = i * Controls.FIELDS;
            Row row = new Row(ctl[o + Controls.ID], ctl[o + Controls.MIN], ctl[o + Controls.MAX], ctl[o + Controls.STEP]);
            rows.put(row.id, row);
            panelRows.addView(row.view);
        }
        // Values after all rows exist, so an auto switch can grey out the control it drives.
        for (int i = 0; i < Controls.count(ctl); i++) {
            int o = i * Controls.FIELDS;
            rows.get(ctl[o + Controls.ID]).show(ctl[o + Controls.CUR]);
        }
        TextView reset = button("Reset to defaults", v -> resetControls());
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.setMargins(0, dp(10), 0, 0);
        panelRows.addView(reset, p);
    }

    private void showValue(int id, int v) {
        Row row = rows.get(id);
        if (row != null) row.show(v);
    }

    /** UI thread. Sends the newest value per control: a slider drag does not queue every step. */
    private void setControl(int id, int value) {
        if (pendingSets.put(id, value) == null) WORKER.execute(() -> sendControl(id));
    }

    /** Worker thread. */
    private void sendControl(int id) {
        Integer value = pendingSets.remove(id);
        long h = handle;
        if (value == null || h == 0) return;
        String name = Controls.name(id);
        try {
            int now = UvcCamera.setControl(h, id, value);
            runOnUiThread(() -> showValue(id, now));
        } catch (IOException e) {
            Log.w(TAG, name + " = " + value + ": " + e.getMessage());
            toast(name + ": the camera refused " + Controls.valueText(id, value) + ".");
            readControl(h, id);
        }
        // An auto switch: the control it drives may have moved while it was on.
        int slave = Controls.slave(id);
        if (slave >= 0) readControl(h, slave);
    }

    /** Worker thread. Shows a control's current value, if the camera has it. */
    private void readControl(long h, int id) {
        try {
            int now = UvcCamera.getControl(h, id);
            runOnUiThread(() -> showValue(id, now));
        } catch (IOException e) {
            // The camera does not have it, or it does not answer: the row keeps its value.
        }
    }

    /** Sets every control to the camera's default, auto switches first. */
    private void resetControls() {
        int[] ctl = controls;
        UsbDevice d = device;
        if (ctl == null || d == null) return;
        pendingSets.clear();
        WORKER.execute(() -> {
            long h = handle;
            if (h == 0) return;
            // A manual control refuses values while its auto switch is on, so the switches go
            // first, and a control whose switch defaults to on is left to the camera.
            for (int pass = 0; pass < 2; pass++) {
                for (int i = 0; i < Controls.count(ctl); i++) {
                    int o = i * Controls.FIELDS, id = ctl[o + Controls.ID];
                    if (Controls.isSwitch(id) != (pass == 0)) continue;
                    int master = Controls.find(ctl, Controls.master(id));
                    if (master >= 0 && ctl[master + Controls.DEF] != 0) continue;
                    try {
                        UvcCamera.setControl(h, id, ctl[o + Controls.DEF]);
                    } catch (IOException e) {
                        Log.w(TAG, "reset " + Controls.name(id) + ": " + e.getMessage());
                    }
                }
            }
            int[] read = UvcCamera.controls(h);
            int[] fresh = read != null ? read : new int[0];
            Log.i(TAG, "controls after reset: " + Controls.describe(fresh));
            runOnUiThread(() -> {
                if (device != d) return;
                controls = fresh;
                buildPanel();
            });
        });
    }

    // ---- Small helpers ------------------------------------------------------------------------

    private TextView addButton(String text, View.OnClickListener action) {
        TextView b = button(text, action);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.setMargins(dp(3), 0, dp(3), 0);
        toolbar.addView(b, p);
        return b;
    }

    private TextView button(String text, View.OnClickListener action) {
        TextView b = new TextView(this);
        b.setText(text);
        b.setTextColor(Color.WHITE);
        b.setTextSize(15);
        b.setBackgroundColor(0x99000000);
        b.setPadding(dp(12), dp(10), dp(12), dp(10));
        b.setOnClickListener(action);
        return b;
    }

    private void updateButtons() {
        enable(photoButton, mode != null);
        enable(modeButton, modes != null);
        enable(adjustButton, controls != null);
    }

    private static void enable(View v, boolean on) {
        v.setEnabled(on);
        v.setAlpha(on ? 1f : 0.4f);
    }

    private void toast(String message) {
        runOnUiThread(() -> Toast.makeText(getApplicationContext(), message, Toast.LENGTH_SHORT).show());
    }

    private void show(String message) {
        status.setText(message);
        status.setVisibility(View.VISIBLE);
        Log.i(TAG, message);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
