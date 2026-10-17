package com.tomerg.irvolume;

import java.util.ArrayList;
import java.util.List;

/**
 * IR encoders for ConsumerIrManager.transmit().
 *
 * Each code yields a carrier, a first frame and a repeat frame (microseconds,
 * alternating mark/space, starting with a mark). Every frame ends with a space
 * that pads it to the protocol's repeat period, so frames can be concatenated.
 * Timings and bit layouts follow the Flipper Zero firmware encoders, because the
 * brand codes come from Flipper-IRDB.
 */
public final class IrCodes {

    public enum Protocol { NEC, NECEXT, PIONEER, SIRC12, SIRC15, RC5, KASEIKYO }

    public static final class Code {
        public final String label;
        public final Protocol protocol;
        public final long address;
        public final int command;

        public Code(String label, Protocol protocol, long address, int command) {
            this.label = label;
            this.protocol = protocol;
            this.address = address;
            this.command = command;
        }
    }

    public static final class Signal {
        public final int carrierHz;
        public final int[] frame;
        public final int[] repeat;

        Signal(int carrierHz, int[] frame, int[] repeat) {
            this.carrierHz = carrierHz;
            this.frame = frame;
            this.repeat = repeat;
        }
    }

    private IrCodes() {}

    private static int sum(List<Integer> p) {
        int s = 0;
        for (int v : p) s += v;
        return s;
    }

    private static int[] toArray(List<Integer> p) {
        int[] a = new int[p.size()];
        for (int i = 0; i < a.length; i++) a[i] = p.get(i);
        return a;
    }

    /** Pulse-distance frame: header, bytes LSB first, stop mark, space padded to period. */
    private static int[] pulseDistance(int hdrMark, int hdrSpace, int mark, int space0, int space1,
                                       int[] bytes, int bits, int period) {
        List<Integer> p = new ArrayList<>();
        p.add(hdrMark);
        p.add(hdrSpace);
        for (int i = 0; i < bits; i++) {
            int b = (bytes[i / 8] >> (i % 8)) & 1;
            p.add(mark);
            p.add(b == 1 ? space1 : space0);
        }
        p.add(mark);
        p.add(period - sum(p));
        return toArray(p);
    }

    private static int[] necRepeat() {
        return new int[] {9000, 2250, 560, 108000 - 9000 - 2250 - 560};
    }

    public static Signal encode(Code c, boolean rc5Toggle) {
        switch (c.protocol) {
            case NEC: {
                int a = (int) (c.address & 0xFF), cmd = c.command & 0xFF;
                int[] bytes = {a, a ^ 0xFF, cmd, cmd ^ 0xFF};
                return new Signal(38000,
                        pulseDistance(9000, 4500, 560, 560, 1690, bytes, 32, 108000), necRepeat());
            }
            case NECEXT: {
                int a = (int) (c.address & 0xFFFF), cmd = c.command & 0xFFFF;
                int[] bytes = {a & 0xFF, a >> 8, cmd & 0xFF, cmd >> 8};
                return new Signal(38000,
                        pulseDistance(9000, 4500, 560, 560, 1690, bytes, 32, 108000), necRepeat());
            }
            case PIONEER: {
                // Flipper sends 33 bits: address, ~address, command, ~command, one 0 bit.
                int a = (int) (c.address & 0xFF), cmd = c.command & 0xFF;
                int[] bytes = {a, a ^ 0xFF, cmd, cmd ^ 0xFF, 0};
                int[] f = pulseDistance(8500, 4225, 500, 500, 1500, bytes, 33, 0);
                f[f.length - 1] = 26000;
                return new Signal(40000, f, f);
            }
            case SIRC12:
            case SIRC15: {
                int bits = c.protocol == Protocol.SIRC12 ? 12 : 15;
                long data = (c.command & 0x7F) | ((c.address & (bits == 12 ? 0x1F : 0xFF)) << 7);
                List<Integer> p = new ArrayList<>();
                p.add(2400);
                p.add(600);
                for (int i = 0; i < bits; i++) {
                    p.add(((data >> i) & 1) == 1 ? 1200 : 600);
                    p.add(600);
                }
                p.set(p.size() - 1, 600 + 45000 - sum(p));
                int[] f = toArray(p);
                return new Signal(40000, f, f);
            }
            case RC5: {
                int[] f = rc5((int) (c.address & 0x1F), c.command & 0x3F, rc5Toggle ? 1 : 0);
                return new Signal(36000, f, f);
            }
            case KASEIKYO: {
                long addr = c.address;
                int id = (int) ((addr >> 24) & 3);
                int vendor = (int) ((addr >> 8) & 0xFFFF);
                int genre1 = (int) ((addr >> 4) & 0xF), genre2 = (int) (addr & 0xF);
                int cmd = c.command & 0x3FF;
                int[] d = new int[6];
                d[0] = vendor & 0xFF;
                d[1] = vendor >> 8;
                int vp = d[0] ^ d[1];
                vp = (vp & 0xF) ^ (vp >> 4);
                d[2] = (vp & 0xF) | (genre1 << 4);
                d[3] = (genre2 & 0xF) | ((cmd & 0xF) << 4);
                d[4] = (id << 6) | (cmd >> 4);
                d[5] = d[2] ^ d[3] ^ d[4];
                int[] f = pulseDistance(3456, 1728, 432, 432, 1296, d, 48, 130000);
                return new Signal(38000, f, f);
            }
            default:
                throw new IllegalArgumentException("protocol " + c.protocol);
        }
    }

    /** RC5: start 1, start 1, toggle, 5 address bits, 6 command bits, MSB first, Manchester. */
    static int[] rc5(int addr, int cmd, int toggle) {
        int[] bits = new int[14];
        bits[0] = 1;
        bits[1] = 1;
        bits[2] = toggle;
        for (int i = 0; i < 5; i++) bits[3 + i] = (addr >> (4 - i)) & 1;
        for (int i = 0; i < 6; i++) bits[8 + i] = (cmd >> (5 - i)) & 1;
        List<Integer> halves = new ArrayList<>();
        for (int b : bits) {  // 1 = space then mark, 0 = mark then space
            halves.add(b == 1 ? 0 : 1);
            halves.add(b == 1 ? 1 : 0);
        }
        while (halves.get(0) == 0) halves.remove(0);
        List<Integer> p = new ArrayList<>();
        int level = halves.get(0), run = 0;
        for (int h : halves) {
            if (h == level) {
                run += 889;
            } else {
                p.add(run);
                level = h;
                run = 889;
            }
        }
        p.add(run);
        if (level == 1) {
            p.add(113778 - sum(p));
        } else {
            p.set(p.size() - 1, run + 113778 - sum(p));
        }
        return toArray(p);
    }

    /**
     * One transmit chunk of a held button: the first frame (when first is true) followed by
     * repeat frames, up to maxUs. A chunk always holds at least one frame.
     */
    public static int[] chunk(Signal s, boolean first, int maxUs) {
        List<Integer> p = new ArrayList<>();
        int total = 0;
        if (first) {
            for (int v : s.frame) p.add(v);
            total = sumArr(s.frame);
        }
        int r = sumArr(s.repeat);
        while (p.isEmpty() || total + r <= maxUs) {
            for (int v : s.repeat) p.add(v);
            total += r;
        }
        return toArray(p);
    }

    static int sumArr(int[] a) {
        int s = 0;
        for (int v : a) s += v;
        return s;
    }

    /** VOL+ / VOL- pairs from Flipper-IRDB Audio_and_Video_Receivers, most common entry per brand. */
    public static final Code[][] BRANDS = {
        {new Code("Pioneer", Protocol.PIONEER, 0xA5, 0x0A), new Code("Pioneer", Protocol.PIONEER, 0xA5, 0x0B)},
        {new Code("Sony (SIRC15)", Protocol.SIRC15, 0x30, 0x12), new Code("Sony (SIRC15)", Protocol.SIRC15, 0x30, 0x13)},
        {new Code("Sony (SIRC12)", Protocol.SIRC12, 0x10, 0x12), new Code("Sony (SIRC12)", Protocol.SIRC12, 0x10, 0x13)},
        {new Code("Onkyo / Integra", Protocol.NECEXT, 0x6DD2, 0xFD02), new Code("Onkyo / Integra", Protocol.NECEXT, 0x6DD2, 0xFC03)},
        {new Code("Yamaha", Protocol.NEC, 0x7A, 0x1A), new Code("Yamaha", Protocol.NEC, 0x7A, 0x1B)},
        {new Code("Denon", Protocol.KASEIKYO, 0x00325441L, 0x0170), new Code("Denon", Protocol.KASEIKYO, 0x00325441L, 0x0171)},
        {new Code("Marantz / Philips / Cambridge", Protocol.RC5, 0x10, 0x10), new Code("Marantz / Philips / Cambridge", Protocol.RC5, 0x10, 0x11)},
        {new Code("Harman Kardon", Protocol.NECEXT, 0x7080, 0x38C7), new Code("Harman Kardon", Protocol.NECEXT, 0x7080, 0x37C8)},
        {new Code("NAD", Protocol.NECEXT, 0x7C87, 0x7788), new Code("NAD", Protocol.NECEXT, 0x7C87, 0x738C)},
        {new Code("Panasonic / Technics", Protocol.KASEIKYO, 0x002002A0L, 0x0200), new Code("Panasonic / Technics", Protocol.KASEIKYO, 0x002002A0L, 0x0210)},
        // Not in Flipper-IRDB receivers; from IRDB and LIRC via the cross-check
        {new Code("Pioneer SX-Q180", Protocol.PIONEER, 0xA6, 0x0A), new Code("Pioneer SX-Q180", Protocol.PIONEER, 0xA6, 0x0B)},
        {new Code("Yamaha (older DSP-A)", Protocol.NEC, 0x7D, 0x8D), new Code("Yamaha (older DSP-A)", Protocol.NEC, 0x7D, 0x8E)},
        {new Code("Kenwood", Protocol.NEC, 0xB8, 0x9B), new Code("Kenwood", Protocol.NEC, 0xB8, 0x9A)},
        {new Code("NEC (brand)", Protocol.NECEXT, 0xC51A, 0xFD02), new Code("NEC (brand)", Protocol.NECEXT, 0xC51A, 0xFC03)},
        {new Code("Cambridge Azur 540R", Protocol.NECEXT, 0xC0C0, 0xFC03), new Code("Cambridge Azur 540R", Protocol.NECEXT, 0xC0C0, 0xE01F)},
    };
}
