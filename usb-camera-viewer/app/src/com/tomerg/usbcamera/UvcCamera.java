package com.tomerg.usbcamera;

import android.graphics.Bitmap;
import android.view.Surface;
import java.io.IOException;

/**
 * JNI bridge to libuvc (app/jni/usbcamera.c). Call everything that takes a handle on one thread,
 * between open and close.
 */
final class UvcCamera {
    static {
        System.loadLibrary("usbcamera");
    }

    private UvcCamera() {}

    /** Opens the UVC camera behind a UsbDeviceConnection's file descriptor. Returns a handle. */
    static native long open(int fd) throws IOException;

    /** The camera's MJPEG and YUYV modes, flattened {kind, width, height, fps}; see Modes. */
    static native int[] modes(long handle);

    /** Starts streaming one mode into the surface. Call once per open. */
    static native void start(long handle, int kind, int width, int height, int fps) throws IOException;

    /** Stops streaming and frees the handle. The caller then closes the connection. */
    static native void close(long handle);

    /** Where frames are drawn; null detaches. Safe from any thread. */
    static native void setSurface(Surface surface);

    /** {received, shown, bad} frame counts since the last start. */
    static native int[] stats();

    /**
     * Copies the last decoded frame into an ARGB_8888 bitmap of the mode's size. False when there
     * is no whole frame yet (or the last one failed to decode) or the bitmap does not fit.
     */
    static native boolean snapshot(long handle, Bitmap bitmap);

    /** The controls the camera has, flattened {id, min, max, step, def, cur}; see Controls. */
    static native int[] controls(long handle);

    /** A control's current value. */
    static native int getControl(long handle, int id) throws IOException;

    /** Sets a control, then returns its value as the camera reads it back. */
    static native int setControl(long handle, int id, int value) throws IOException;
}
