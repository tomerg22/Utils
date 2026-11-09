package com.tomerg.usbcamera;

import java.util.Arrays;

/**
 * Camera modes as {kind, width, height, fps}, flattened the way UvcCamera.modes returns them,
 * and which one to start with. Plain Java, so tests/run.sh tests it without Android.
 */
public final class Modes {
    public static final int MJPEG = 0, YUYV = 1;
    /** Below this, motion looks choppy. */
    static final int SMOOTH_FPS = 25;
    /** Larger frames cost decode time that a phone screen does not show. */
    static final long MAX_AREA = 1920L * 1080;

    private Modes() {}

    public static int count(int[] flat) {
        return flat.length / 4;
    }

    public static int[] get(int[] flat, int i) {
        return Arrays.copyOfRange(flat, 4 * i, 4 * i + 4);
    }

    /** The wanted mode if the camera offers it, else the best one. Null when there are none. */
    public static int[] pick(int[] flat, int[] wanted) {
        int[] best = null;
        for (int i = 0; i < count(flat); i++) {
            int[] m = get(flat, i);
            if (Arrays.equals(m, wanted)) return m;
            if (best == null || better(m, best)) best = m;
        }
        return best;
    }

    /**
     * Smooth frame rate first, then MJPEG (YUYV needs far more USB bandwidth per frame), then at
     * most 1080p, then the size nearest 1080p, then the higher frame rate.
     */
    public static boolean better(int[] a, int[] b) {
        int c = Boolean.compare(a[3] >= SMOOTH_FPS, b[3] >= SMOOTH_FPS);
        if (c == 0) c = Boolean.compare(a[0] == MJPEG, b[0] == MJPEG);
        if (c == 0) c = Boolean.compare(area(a) <= MAX_AREA, area(b) <= MAX_AREA);
        // Both at most 1080p: larger is better. Both above: smaller is better.
        if (c == 0) c = area(a) <= MAX_AREA ? Long.compare(area(a), area(b)) : Long.compare(area(b), area(a));
        if (c == 0) c = Integer.compare(a[3], b[3]);
        return c > 0;
    }

    static long area(int[] m) {
        return (long) m[1] * m[2];
    }

    public static String label(int[] m) {
        return (m[0] == MJPEG ? "MJPEG " : "YUYV ") + m[1] + "×" + m[2] + " " + m[3] + " fps";
    }

    /** The list for a mode picker: MJPEG first, then larger frames, then higher frame rates. */
    public static int[][] sorted(int[] flat) {
        int[][] out = new int[count(flat)][];
        for (int i = 0; i < out.length; i++) out[i] = get(flat, i);
        Arrays.sort(out, (a, b) -> {
            int c = Boolean.compare(b[0] == MJPEG, a[0] == MJPEG);
            if (c == 0) c = Long.compare(area(b), area(a));
            if (c == 0) c = Integer.compare(b[1], a[1]);
            if (c == 0) c = Integer.compare(b[3], a[3]);
            return c;
        });
        return out;
    }

    /** The form parse reads. */
    public static String format(int[] m) {
        return m[0] + "," + m[1] + "," + m[2] + "," + m[3];
    }

    /** Parses "kind,width,height,fps" (the launch intent's mode extra). Null when s is null or not four integers. */
    public static int[] parse(String s) {
        if (s == null) return null;
        String[] p = s.split(",");
        if (p.length != 4) return null;
        int[] m = new int[4];
        try {
            for (int i = 0; i < 4; i++) m[i] = Integer.parseInt(p[i]);
        } catch (NumberFormatException e) {
            return null;
        }
        return m;
    }
}
