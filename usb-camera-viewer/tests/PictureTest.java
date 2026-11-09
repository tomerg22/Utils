package com.tomerg.usbcamera;

import java.util.Random;

/**
 * Checks Picture: where the frame lands for each turn and mirror, that the TextureView matrix
 * matches it, that zoom keeps the pinch point still, and that the zoomed picture stays over the
 * view. In Picture's package for its package-private fields. Plain Java: run with tests/run.sh.
 */
public class PictureTest {
    static int failures = 0, checks = 0;

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) {
            failures++;
            System.out.println("FAIL " + what);
        }
    }

    static boolean near(float a, float b) {
        return Math.abs(a - b) < 0.01f;
    }

    static void expectAt(Picture p, float u, float v, float x, float y, String what) {
        float[] got = p.map(u, v, VW, VH, BW, BH);
        check(near(got[0], x) && near(got[1], y), what + ": got (" + got[0] + ", " + got[1] + "), want (" + x + ", " + y + ")");
    }

    /** A view point through a Matrix.setValues-order matrix. */
    static float[] apply(float[] m, float x, float y) {
        return new float[] {m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]};
    }

    static Picture picture(int rotation, boolean mirror) {
        Picture p = new Picture();
        p.rotation = rotation;
        p.mirror = mirror;
        return p;
    }

    // A landscape view and a 16:9 camera frame.
    static final float VW = 1000, VH = 500, BW = 1280, BH = 720;

    public static void main(String[] args) {
        // Turn 0: fits the height (500 / 720), centered: x from 55.56 to 944.44.
        Picture p = picture(0, false);
        expectAt(p, 0, 0, 55.556f, 0, "turn 0: top left");
        expectAt(p, BW, BH, 944.444f, 500, "turn 0: bottom right");
        expectAt(p, BW / 2, BH / 2, 500, 250, "turn 0: center");
        // A quarter turn clockwise: 720 wide, 1280 high, fits the height (500 / 1280), x from
        // 359.375 to 640.625. The frame's top edge becomes the right edge.
        p = picture(1, false);
        expectAt(p, 0, 0, 640.625f, 0, "turn 1: frame top left at top right");
        expectAt(p, BW, 0, 640.625f, 500, "turn 1: frame top right at bottom right");
        expectAt(p, 0, BH, 359.375f, 0, "turn 1: frame bottom left at top left");
        p = picture(2, false);
        expectAt(p, 0, 0, 944.444f, 500, "turn 2: frame top left at bottom right");
        p = picture(3, false);
        expectAt(p, 0, 0, 359.375f, 500, "turn 3: frame top left at bottom left");
        expectAt(p, BW, 0, 359.375f, 0, "turn 3: frame top right at top left");
        // Mirror swaps left and right of what is on screen, after the turn.
        p = picture(0, true);
        expectAt(p, 0, 0, 944.444f, 0, "mirror: frame top left at top right");
        p = picture(1, true);
        expectAt(p, 0, 0, 359.375f, 0, "turn 1 + mirror: frame top left at top left");

        Random random = new Random(1);
        for (int rotation = 0; rotation < 4; rotation++) {
            for (boolean mirror : new boolean[] {false, true}) {
                for (float zoom : new float[] {1, 2.5f}) {
                    p = picture(rotation, mirror);
                    p.zoom = zoom;
                    p.panX = zoom > 1 ? 40 : 0;
                    p.panY = zoom > 1 ? -30 : 0;
                    String what = "turn " + rotation + (mirror ? " mirrored" : "") + " zoom " + zoom;
                    // Same scale both ways: the aspect ratio holds.
                    float[] o = p.map(0, 0, VW, VH, BW, BH), x = p.map(BW, 0, VW, VH, BW, BH), y = p.map(0, BH, VW, VH, BW, BH);
                    float sx = (float) Math.hypot(x[0] - o[0], x[1] - o[1]) / BW;
                    float sy = (float) Math.hypot(y[0] - o[0], y[1] - o[1]) / BH;
                    check(Math.abs(sx - sy) < 1e-4f, what + ": scale " + sx + " vs " + sy);
                    // At zoom 1 the turned frame fits the view exactly in one direction.
                    if (zoom == 1) {
                        float[] t = Picture.turned(rotation, BW, BH);
                        float w = t[0] * sx, h = t[1] * sx;
                        check((near(w, VW) && h <= VH + 0.01f) || (near(h, VH) && w <= VW + 0.01f),
                                what + ": fits, " + w + "×" + h);
                    }
                    // The TextureView first stretches the frame over the view; the matrix
                    // after that stretch must land each frame point where map says.
                    float[] m = p.textureMatrix(VW, VH, BW, BH);
                    for (int i = 0; i < 20; i++) {
                        float u = random.nextFloat() * BW, v = random.nextFloat() * BH;
                        float[] want = p.map(u, v, VW, VH, BW, BH);
                        float[] got = apply(m, u * VW / BW, v * VH / BH);
                        check(near(got[0], want[0]) && near(got[1], want[1]), what + ": matrix at (" + u + ", " + v + ")");
                    }
                }
            }
        }
        float[] identity = new Picture().textureMatrix(VW, VH, 0, 0);
        check(identity[0] == 1 && identity[4] == 1 && identity[2] == 0 && identity[5] == 0,
                "no frame size yet: identity");
        // Before the first frame (size 0) or the first layout, gestures and layouts must not
        // leave NaN behind for when the sizes arrive.
        p = new Picture();
        p.clamp(VW, VH, 0, 0);
        p.zoomAt(2, 100, 100, VW, VH, 0, 0);
        p.panBy(50, 50, VW, VH, 0, 0);
        p.clamp(0, 0, BW, BH);
        p.zoomAt(Float.NaN, 100, 100, VW, VH, BW, BH);
        p.zoomAt(0, 100, 100, VW, VH, BW, BH);
        check(p.zoom == 1 && p.panX == 0 && p.panY == 0, "no sizes: zoom 1, centered: " + p.zoom + " " + p.panX + " " + p.panY);
        float[] m = p.textureMatrix(VW, VH, BW, BH);
        boolean finite = true;
        for (float v : m) finite &= !Float.isNaN(v) && !Float.isInfinite(v);
        check(finite, "no sizes, then sizes: a finite matrix");

        // Pinch: the spot under the fingers stays there.
        p = picture(0, false);
        float[] before = p.map(740, 410, VW, VH, BW, BH);
        p.zoomAt(2, before[0], before[1], VW, VH, BW, BH);
        float[] after = p.map(740, 410, VW, VH, BW, BH);
        check(near(p.zoom, 2), "zoom 2: " + p.zoom);
        check(near(after[0], before[0]) && near(after[1], before[1]), "pinch point stays");
        p.zoomAt(1000, 0, 0, VW, VH, BW, BH);
        check(near(p.zoom, Picture.MAX_ZOOM), "zoom stops at MAX_ZOOM: " + p.zoom);
        p.zoomAt(0.0001f, 0, 0, VW, VH, BW, BH);
        check(near(p.zoom, 1) && p.panX == 0 && p.panY == 0, "zoom out stops at 1, centered");

        // Drag: the picture follows the finger until an edge reaches the view's edge.
        p = picture(0, false);
        p.zoomAt(3, VW / 2, VH / 2, VW, VH, BW, BH);
        p.panBy(1e6f, 1e6f, VW, VH, BW, BH);
        expectAt(p, 0, 0, 0, 0, "zoom 3, dragged right and down: top left corner at the view's");
        p.panBy(-1e6f, -1e6f, VW, VH, BW, BH);
        expectAt(p, BW, BH, VW, VH, "zoom 3, dragged left and up: bottom right at the view's");
        p.panBy(-10, 0, VW, VH, BW, BH);
        expectAt(p, BW, BH, VW, VH, "dragging past the edge does nothing");
        p.panBy(25, 0, VW, VH, BW, BH);
        float[] moved = p.map(BW, BH, VW, VH, BW, BH);
        check(near(moved[0], VW + 25), "a drag back moves it: " + moved[0]);
        // Zoom 1.1: wider than the view vertically only, so it stays centered across.
        p = picture(0, false);
        p.zoomAt(1.1f, VW / 2, VH / 2, VW, VH, BW, BH);
        p.panBy(300, 300, VW, VH, BW, BH);
        check(p.panX == 0 && near(p.panY, 25), "zoom 1.1: x centered, y up to 25: " + p.panX + ", " + p.panY);
        p = picture(0, false);
        p.panBy(300, 300, VW, VH, BW, BH);
        check(p.panX == 0 && p.panY == 0, "zoom 1: no drag");

        // Turn and mirror state.
        p = picture(0, false);
        p.zoomAt(2, 100, 100, VW, VH, BW, BH);
        p.rotate();
        check(p.rotation == 1 && p.zoom == 1 && p.panX == 0 && p.panY == 0, "a turn resets the zoom");
        p.rotate();
        p.rotate();
        p.rotate();
        check(p.rotation == 0, "four turns: back to 0");
        p = picture(0, false);
        p.zoomAt(3, 200, 100, VW, VH, BW, BH);
        float[] spot = p.map(BW / 2, BH / 2, VW, VH, BW, BH);
        p.toggleMirror();
        float[] mirrored = p.map(BW / 2, BH / 2, VW, VH, BW, BH);
        check(near(mirrored[0], VW - spot[0]) && near(mirrored[1], spot[1]), "mirror flips the zoomed view around its center");
        p.toggleMirror();
        check(!p.mirror, "mirror twice: off");

        System.out.println("PictureTest: " + checks + " checks, " + failures + " failures");
        if (failures > 0) System.exit(1);
    }
}
