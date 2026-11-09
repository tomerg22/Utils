package com.tomerg.usbcamera;

/**
 * Where the camera's picture goes in the view: turned in quarter turns, mirrored, fitted to the
 * view with its aspect ratio kept, then zoomed and moved. Plain Java (no android.graphics), so
 * tests/run.sh tests it without Android; MainActivity hands textureMatrix to a TextureView.
 */
public final class Picture {
    public static final float MAX_ZOOM = 8;

    /** Quarter turns clockwise, 0 to 3. */
    int rotation;
    /** Left and right swapped, after the turn. */
    boolean mirror;
    /** 1 = the whole picture fits the view. */
    float zoom = 1;
    /** Where the picture's center is, relative to the view's center, in view pixels. */
    float panX, panY;

    /** Both the view and the frame have a size: before that there is nothing to place. */
    static boolean sized(float vw, float vh, float bw, float bh) {
        return vw > 0 && vh > 0 && bw > 0 && bh > 0;
    }

    /** {width, height} of the camera frame once turned. */
    static float[] turned(int rotation, float bw, float bh) {
        return rotation % 2 == 0 ? new float[] {bw, bh} : new float[] {bh, bw};
    }

    /** Scale of the picture on screen: fitted, times the zoom. */
    float scale(float vw, float vh, float bw, float bh) {
        float[] t = turned(rotation, bw, bh);
        return Math.min(vw / t[0], vh / t[1]) * zoom;
    }

    /**
     * The 2×2 part of the camera-frame-to-view map: {a, b, c, d} for x' = a·x + b·y,
     * y' = c·x + d·y, with x and y relative to the frame's center.
     */
    private float[] linear(float k) {
        // A clockwise quarter turn on screen (y points down) maps (x, y) to (-y, x).
        int[][] turns = {{1, 0, 0, 1}, {0, -1, 1, 0}, {-1, 0, 0, -1}, {0, 1, -1, 0}};
        int[] r = turns[rotation];
        float m = mirror ? -1 : 1;
        return new float[] {k * m * r[0], k * m * r[1], k * r[2], k * r[3]};
    }

    /** Where a camera-frame pixel (u, v) lands in the view. */
    float[] map(float u, float v, float vw, float vh, float bw, float bh) {
        float[] a = linear(scale(vw, vh, bw, bh));
        float x = u - bw / 2, y = v - bh / 2;
        return new float[] {a[0] * x + a[1] * y + vw / 2 + panX, a[2] * x + a[3] * y + vh / 2 + panY};
    }

    /**
     * The TextureView transform, in android.graphics.Matrix.setValues order. A TextureView first
     * stretches the frame over the whole view; this undoes that stretch and applies map instead.
     * Identity until both sizes are known.
     */
    float[] textureMatrix(float vw, float vh, float bw, float bh) {
        if (!sized(vw, vh, bw, bh)) return new float[] {1, 0, 0, 0, 1, 0, 0, 0, 1};
        float[] a = linear(scale(vw, vh, bw, bh));
        float sx = bw / vw, sy = bh / vh; // view pixel to frame pixel, under the stretch
        return new float[] {
            a[0] * sx, a[1] * sy, vw / 2 + panX - a[0] * bw / 2 - a[1] * bh / 2,
            a[2] * sx, a[3] * sy, vh / 2 + panY - a[2] * bw / 2 - a[3] * bh / 2,
            0, 0, 1,
        };
    }

    /**
     * Keeps the zoomed picture over the view: an edge may not come inside the view while the
     * picture is larger than it in that direction, and a picture smaller than the view stays
     * centered.
     */
    void clamp(float vw, float vh, float bw, float bh) {
        if (!sized(vw, vh, bw, bh)) { // before the first frame: nothing to keep in view
            panX = panY = 0;
            return;
        }
        float[] t = turned(rotation, bw, bh);
        float k = scale(vw, vh, bw, bh);
        float maxX = Math.max(0, (t[0] * k - vw) / 2), maxY = Math.max(0, (t[1] * k - vh) / 2);
        panX = Math.max(-maxX, Math.min(maxX, panX));
        panY = Math.max(-maxY, Math.min(maxY, panY));
    }

    /** Zooms by factor around the view point (fx, fy), which keeps showing the same spot. */
    void zoomAt(float factor, float fx, float fy, float vw, float vh, float bw, float bh) {
        if (!sized(vw, vh, bw, bh) || !(factor > 0)) return;
        float next = Math.max(1, Math.min(MAX_ZOOM, zoom * factor));
        float f = next / zoom;
        panX = fx - vw / 2 - (fx - vw / 2 - panX) * f;
        panY = fy - vh / 2 - (fy - vh / 2 - panY) * f;
        zoom = next;
        clamp(vw, vh, bw, bh);
    }

    void panBy(float dx, float dy, float vw, float vh, float bw, float bh) {
        panX += dx;
        panY += dy;
        clamp(vw, vh, bw, bh);
    }

    void resetZoom() {
        zoom = 1;
        panX = panY = 0;
    }

    /** A quarter turn clockwise. Resets the zoom: the old pan has no meaning after a turn. */
    void rotate() {
        rotation = (rotation + 1) % 4;
        resetZoom();
    }

    /** Mirrors around the view's center, so a zoomed view keeps showing the same spot. */
    void toggleMirror() {
        mirror = !mirror;
        panX = -panX;
    }
}
