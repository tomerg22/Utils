package com.tomerg.irvolume;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.hardware.ConsumerIrManager;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * IR volume remote for a DIY volume kit, plus a brand-code test.
 * Hold a button to keep sending (frame, then repeat frames), like a real remote.
 */
public class MainActivity extends Activity {

    /** One transmit call per chunk; short so a release stops the motor quickly. */
    private static final int CHUNK_US = 450_000;
    private static final int BRAND_TEST_MS = 3000;
    /** MUTE holds VOL- this long, enough to run the motor pot to its end stop. */
    private static final int MUTE_MS = 10_000;

    private ConsumerIrManager ir;
    private TextView status;
    private EditText addrField, upField, downField;
    private Button brandTestButton;

    private volatile Thread sender;
    private volatile boolean brandTestRunning;
    private boolean rc5Toggle;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        ir = (ConsumerIrManager) getSystemService(CONSUMER_IR_SERVICE);
        SharedPreferences prefs = getPreferences(MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        root.setPadding(pad, pad, pad, pad);

        status = new TextView(this);
        status.setTextSize(16);
        status.setPadding(0, 0, 0, dp(12));
        root.addView(status);
        if (ir == null || !ir.hasIrEmitter()) {
            status.setText("This phone has no IR emitter.");
        } else {
            status.setText("Ready. Hold a button to keep sending.");
        }

        root.addView(header("Volume kit (NEC)"));
        LinearLayout big = new LinearLayout(this);
        big.setOrientation(LinearLayout.HORIZONTAL);
        big.addView(holdButton(new SquareButton(this), "VOL +", () -> kitCode(true), 40), weight());
        big.addView(holdButton(new SquareButton(this), "VOL −", () -> kitCode(false), 40), weight());
        root.addView(big);

        // MUTE: same square size as VOL+ / VOL-, centred on its own row
        LinearLayout muteRow = new LinearLayout(this);
        muteRow.setOrientation(LinearLayout.HORIZONTAL);
        muteRow.setGravity(Gravity.CENTER_HORIZONTAL);
        muteRow.setWeightSum(2f);
        Button mute = new SquareButton(this);
        mute.setText("MUTE");
        mute.setTextSize(32);
        mute.setOnClickListener(v -> toggleMute());
        muteRow.addView(mute, weight());
        root.addView(muteRow);

        LinearLayout codes = new LinearLayout(this);
        codes.setOrientation(LinearLayout.HORIZONTAL);
        addrField = hexField(prefs.getString("addr", "00"), "address");
        upField = hexField(prefs.getString("up", "05"), "VOL+ cmd");
        downField = hexField(prefs.getString("down", "04"), "VOL− cmd");
        codes.addView(labelled("Address", addrField), weight());
        codes.addView(labelled("VOL+ cmd", upField), weight());
        codes.addView(labelled("VOL− cmd", downField), weight());
        root.addView(codes);

        root.addView(header("Brand test"));
        brandTestButton = new Button(this);
        brandTestButton.setText("Send every brand's VOL+ for 3 s");
        brandTestButton.setOnClickListener(v -> toggleBrandTest());
        root.addView(brandTestButton);
        for (IrCodes.Code[] pair : IrCodes.BRANDS) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            TextView name = new TextView(this);
            name.setText(pair[0].label);
            name.setTextSize(15);
            row.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 2f));
            row.addView(holdButton("+", () -> pair[0], 18), weight());
            row.addView(holdButton("−", () -> pair[1], 18), weight());
            root.addView(row);
        }

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        // Android 15+ draws apps edge to edge: keep the content clear of the system bars.
        if (Build.VERSION.SDK_INT >= 30) {
            scroll.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            scroll.setFitsSystemWindows(true);
        }
        setContentView(scroll);
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopSending();
        brandTestRunning = false;
        getPreferences(MODE_PRIVATE).edit()
                .putString("addr", addrField.getText().toString())
                .putString("up", upField.getText().toString())
                .putString("down", downField.getText().toString())
                .apply();
    }

    private interface CodeSource { IrCodes.Code get(); }

    private IrCodes.Code kitCode(boolean up) {
        int addr = parseHex(addrField, 0x00);
        int cmd = parseHex(up ? upField : downField, up ? 0x05 : 0x04);
        return new IrCodes.Code(up ? "Kit VOL+" : "Kit VOL−", IrCodes.Protocol.NEC, addr, cmd);
    }

    private static int parseHex(EditText f, int fallback) {
        try {
            return Integer.parseInt(f.getText().toString().trim(), 16) & 0xFF;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private Button holdButton(String text, CodeSource src, int textSp) {
        return holdButton(new Button(this), text, src, textSp);
    }

    private Button holdButton(Button b, String text, CodeSource src, int textSp) {
        b.setText(text);
        b.setTextSize(textSp);
        b.setOnTouchListener((v, ev) -> {
            switch (ev.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    v.setPressed(true);
                    startSending(src.get());
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    v.setPressed(false);
                    stopSending();
                    return true;
                default:
                    return true;
            }
        });
        return b;
    }

    /** Sends the code until stopSending() is called. */
    private synchronized void startSending(IrCodes.Code code) {
        startSending(code, 0);
    }

    /** MUTE: VOL- for MUTE_MS. A second tap, or any other button, stops it. */
    private synchronized void toggleMute() {
        if (sender != null && muting) {
            stopSending();
            return;
        }
        startSending(kitCode(false), MUTE_MS);
    }

    private volatile boolean muting;

    /** Sends the code until stopSending() is called, or for durationMs when it is above 0. */
    private synchronized void startSending(IrCodes.Code code, int durationMs) {
        stopSending();
        brandTestRunning = false;
        if (ir == null || !ir.hasIrEmitter()) return;
        rc5Toggle = !rc5Toggle;
        final IrCodes.Signal sig = IrCodes.encode(code, rc5Toggle);
        final long end = durationMs > 0 ? System.currentTimeMillis() + durationMs : Long.MAX_VALUE;
        muting = durationMs > 0;
        Thread t = new Thread(() -> {
            boolean first = true;
            while (sender == Thread.currentThread() && System.currentTimeMillis() < end) {
                if (!transmit(sig, first)) break;
                first = false;
                if (durationMs > 0) {
                    long left = (end - System.currentTimeMillis() + 999) / 1000;
                    setStatus("MUTE: VOL− for " + Math.max(left, 0) + " s more (tap MUTE to stop)");
                }
            }
            synchronized (MainActivity.this) {
                if (sender == Thread.currentThread()) {
                    sender = null;
                    muting = false;
                    setStatus("Ready. Hold a button to keep sending.");
                }
            }
        }, "ir-send");
        sender = t;
        setStatus(durationMs > 0 ? "MUTE: VOL− for " + durationMs / 1000 + " s" : "Sending " + describe(code));
        t.start();
    }

    private synchronized void stopSending() {
        muting = false;
        if (sender != null) {
            sender = null;
            setStatus("Ready. Hold a button to keep sending.");
        }
    }

    private boolean transmit(IrCodes.Signal sig, boolean first) {
        try {
            ir.transmit(sig.carrierHz, IrCodes.chunk(sig, first, CHUNK_US));
            return true;
        } catch (RuntimeException e) {
            setStatus("Transmit failed: " + e.getMessage());
            return false;
        }
    }

    private void toggleBrandTest() {
        if (brandTestRunning) {
            brandTestRunning = false;
            return;
        }
        stopSending();
        if (ir == null || !ir.hasIrEmitter()) return;
        brandTestRunning = true;
        brandTestButton.setText("Stop brand test");
        new Thread(() -> {
            for (IrCodes.Code[] pair : IrCodes.BRANDS) {
                if (!brandTestRunning) break;
                IrCodes.Code c = pair[0];
                setStatus("Brand test: " + describe(c));
                rc5Toggle = !rc5Toggle;
                IrCodes.Signal sig = IrCodes.encode(c, rc5Toggle);
                long end = System.currentTimeMillis() + BRAND_TEST_MS;
                boolean first = true;
                while (brandTestRunning && System.currentTimeMillis() < end) {
                    if (!transmit(sig, first)) break;
                    first = false;
                }
                sleep(700);
            }
            brandTestRunning = false;
            runOnUiThread(() -> brandTestButton.setText("Send every brand's VOL+ for 3 s"));
            setStatus("Brand test done.");
        }, "brand-test").start();
    }

    private static String describe(IrCodes.Code c) {
        return String.format("%s  (%s addr 0x%X cmd 0x%X)", c.label, c.protocol, c.address, c.command);
    }

    private void setStatus(String s) {
        runOnUiThread(() -> status.setText(s));
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private TextView header(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(20);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(16), 0, dp(8));
        return t;
    }

    private EditText hexField(String value, String hint) {
        EditText e = new EditText(this);
        e.setText(value);
        e.setHint(hint);
        e.setSingleLine(true);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
        return e;
    }

    private View labelled(String label, EditText field) {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView l = new TextView(this);
        l.setText(label + " (hex)");
        l.setTextColor(Color.GRAY);
        col.addView(l);
        col.addView(field);
        return col;
    }

    /** A button whose height equals its width. */
    private static final class SquareButton extends Button {
        SquareButton(android.content.Context c) {
            super(c);
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            super.onMeasure(widthSpec, widthSpec);
        }
    }

    private static LinearLayout.LayoutParams weight() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
