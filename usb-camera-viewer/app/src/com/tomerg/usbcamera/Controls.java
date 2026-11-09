package com.tomerg.usbcamera;

/**
 * The camera's UVC controls, as UvcCamera.controls returns them: flattened
 * {id, min, max, step, def, cur}. Ids index control_table in app/jni/usbcamera.c, so keep both in
 * the same order. Plain Java, so tests/run.sh tests it without Android.
 */
public final class Controls {
    public static final int AUTO_EXPOSURE = 0, EXPOSURE = 1, GAIN = 2, BRIGHTNESS = 3,
            CONTRAST = 4, SATURATION = 5, HUE = 6, SHARPNESS = 7, GAMMA = 8, BACKLIGHT = 9,
            AUTO_WHITE_BALANCE = 10, WHITE_BALANCE = 11, POWER_LINE = 12, AUTOFOCUS = 13,
            FOCUS = 14, ZOOM = 15;

    static final String[] NAMES = {
        "Auto exposure", "Exposure", "Gain", "Brightness", "Contrast", "Saturation", "Hue",
        "Sharpness", "Gamma", "Backlight compensation", "Auto white balance", "White balance",
        "Power line frequency", "Autofocus", "Focus", "Zoom",
    };

    static final int FIELDS = 6;
    public static final int ID = 0, MIN = 1, MAX = 2, STEP = 3, DEF = 4, CUR = 5;

    private Controls() {}

    public static int count(int[] flat) {
        return flat.length / FIELDS;
    }

    /** The offset of control id's fields in flat, or -1 when the camera does not have it. */
    public static int find(int[] flat, int id) {
        for (int i = 0; i < count(flat); i++) if (flat[i * FIELDS + ID] == id) return i * FIELDS;
        return -1;
    }

    public static String name(int id) {
        return id >= 0 && id < NAMES.length ? NAMES[id] : "Control " + id;
    }

    /** On / off controls, shown as a switch. */
    public static boolean isSwitch(int id) {
        return id == AUTO_EXPOSURE || id == AUTO_WHITE_BALANCE || id == AUTOFOCUS;
    }

    /** The auto switch that takes over this control when on, or -1. */
    public static int master(int id) {
        switch (id) {
            case EXPOSURE: return AUTO_EXPOSURE;
            case WHITE_BALANCE: return AUTO_WHITE_BALANCE;
            case FOCUS: return AUTOFOCUS;
            default: return -1;
        }
    }

    /** The control this auto switch takes over, or -1. */
    public static int slave(int id) {
        for (int i = 0; i < NAMES.length; i++) if (master(i) == id) return i;
        return -1;
    }

    /** A value as the user reads it. */
    public static String valueText(int id, int value) {
        switch (id) {
            case EXPOSURE: // units of 100 µs
                return value % 10 == 0 ? value / 10 + " ms" : value / 10 + "." + value % 10 + " ms";
            case WHITE_BALANCE:
                return value + " K";
            case POWER_LINE: {
                String[] names = {"Off", "50 Hz", "60 Hz", "Auto"};
                return value >= 0 && value < names.length ? names[value] : String.valueOf(value);
            }
            default:
                return isSwitch(id) ? (value != 0 ? "On" : "Off") : String.valueOf(value);
        }
    }

    /** Slider steps for a control's range. */
    public static int steps(int min, int max, int step) {
        return (int) (((long) max - min) / Math.max(1, step));
    }

    /** The value at a slider position: min plus whole steps, never past max. */
    public static int valueAt(int min, int max, int step, int progress) {
        int p = Math.max(0, Math.min(steps(min, max, step), progress));
        return (int) (min + (long) p * Math.max(1, step));
    }

    /** The slider position nearest to a value. */
    public static int progressOf(int min, int max, int step, int value) {
        long v = Math.max(min, Math.min(max, value));
        long s = Math.max(1, step);
        return (int) ((v - min + s / 2) / s);
    }

    /** One line per control, for the log. */
    public static String describe(int[] flat) {
        if (count(flat) == 0) return "none";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < count(flat); i++) {
            int o = i * FIELDS, id = flat[o + ID];
            if (i > 0) b.append(", ");
            b.append(name(id)).append(' ');
            if (isSwitch(id)) b.append(valueText(id, flat[o + CUR]));
            else b.append(flat[o + MIN]).append("..").append(flat[o + MAX]).append(" = ").append(flat[o + CUR]);
        }
        return b.toString();
    }
}
