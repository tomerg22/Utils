package com.tomerg.usbcamera;

import android.view.Surface;
import java.io.IOException;

/** JNI bridge to libuvc (app/jni/usbcamera.c). Call open, modes, start and close on one thread. */
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
}
