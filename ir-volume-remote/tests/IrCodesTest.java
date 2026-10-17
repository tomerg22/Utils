import com.tomerg.irvolume.IrCodes;
import com.tomerg.irvolume.IrCodes.Code;
import com.tomerg.irvolume.IrCodes.Protocol;
import com.tomerg.irvolume.IrCodes.Signal;

/**
 * Encodes codes with IrCodes, then decodes the timings with independent decoders
 * (the interpret logic of the Flipper Zero decoders) and checks the round trip.
 * Plain Java, no Android: run with tests/run.sh.
 */
public class IrCodesTest {
    static int failures = 0, checks = 0;

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) {
            failures++;
            System.out.println("FAIL " + what);
        }
    }

    static boolean near(int v, int want) { return Math.abs(v - want) <= 120; }

    /** Pulse-distance bits after a header, LSB first per byte. Returns bytes or null. */
    static int[] pdBytes(int[] p, int hdrMark, int hdrSpace, int bits, int space1) {
        if (!near(p[0], hdrMark) || !near(p[1], hdrSpace)) return null;
        int[] out = new int[(bits + 7) / 8];
        for (int i = 0; i < bits; i++) {
            int space = p[3 + 2 * i];
            boolean one = near(space, space1);
            if (!one && !near(space, p[2 + 2 * i])) return null;
            if (one) out[i / 8] |= 1 << (i % 8);
        }
        return out;
    }

    static int sum(int[] a) {
        int s = 0;
        for (int v : a) s += v;
        return s;
    }

    static boolean alternatesFromMark(int[] p) {
        return p.length % 2 == 0;  // mark,space pairs; last entry is the padding space
    }

    static void roundTrip(Code c) {
        Signal s = IrCodes.encode(c, false);
        int[] f = s.frame;
        String name = c.label + " " + c.protocol + " a=" + Long.toHexString(c.address) + " c=" + Integer.toHexString(c.command);
        check(alternatesFromMark(f), name + ": even length");
        for (int v : f) check(v > 0, name + ": positive timings");
        switch (c.protocol) {
            case NEC:
            case NECEXT: {
                check(s.carrierHz == 38000, name + ": carrier");
                check(sum(f) == 108000, name + ": period");
                int[] d = pdBytes(f, 9000, 4500, 32, 1690);
                check(d != null, name + ": decodes");
                if (d == null) return;
                boolean nec = d[1] == (~d[0] & 0xFF) && d[3] == (~d[2] & 0xFF);
                if (c.protocol == Protocol.NEC) {
                    check(nec && d[0] == c.address && d[2] == c.command, name + ": NEC fields");
                } else {
                    check(!nec || c.address == ((d[1] << 8) | d[0]), name + ": NECext classified");
                    check(((d[1] << 8) | d[0]) == c.address && ((d[3] << 8) | d[2]) == c.command, name + ": NECext fields");
                }
                check(sum(s.repeat) == 108000 && s.repeat[0] == 9000 && s.repeat[1] == 2250, name + ": repeat frame");
                break;
            }
            case PIONEER: {
                check(s.carrierHz == 40000, name + ": carrier");
                int[] d = pdBytes(f, 8500, 4225, 33, 1500);
                check(d != null, name + ": decodes");
                if (d == null) return;
                check(d[0] == c.address && d[1] == (~c.address & 0xFF) && d[2] == c.command
                        && d[3] == (~c.command & 0xFF) && d[4] == 0, name + ": Pioneer fields");
                check(f[f.length - 1] == 26000 && f.length == 2 + 33 * 2 + 2, name + ": stop and silence");
                break;
            }
            case SIRC12:
            case SIRC15: {
                int bits = c.protocol == Protocol.SIRC12 ? 12 : 15;
                check(s.carrierHz == 40000 && sum(f) == 45000, name + ": carrier/period");
                check(f[0] == 2400 && f[1] == 600, name + ": header");
                long data = 0;
                for (int i = 0; i < bits; i++) if (f[2 + 2 * i] == 1200) data |= 1L << i;
                check((data & 0x7F) == c.command && (data >> 7) == c.address, name + ": SIRC fields");
                check(f.length == 2 + 2 * bits, name + ": length");
                break;
            }
            case RC5: {
                check(s.carrierHz == 36000 && sum(f) == 113778, name + ": carrier/period");
                int[] h = new int[40];
                int n = 0, level = 1;
                h[n++] = 0;  // S1 starts with a space that is not transmitted
                for (int v : f) {
                    int k = Math.round(v / 889f);
                    for (int j = 0; j < k && n < 28; j++) h[n++] = level;
                    level ^= 1;
                }
                int[] b = new int[14];
                boolean ok = true;
                for (int i = 0; i < 14; i++) {
                    if (h[2 * i] == 0 && h[2 * i + 1] == 1) b[i] = 1;
                    else if (h[2 * i] == 1 && h[2 * i + 1] == 0) b[i] = 0;
                    else ok = false;
                }
                int a = 0, cmd = 0;
                for (int i = 3; i < 8; i++) a = (a << 1) | b[i];
                for (int i = 8; i < 14; i++) cmd = (cmd << 1) | b[i];
                check(ok && b[0] == 1 && b[1] == 1 && a == c.address && cmd == c.command, name + ": RC5 fields");
                Signal t = IrCodes.encode(c, true);
                check(t.frame != f && !java.util.Arrays.equals(t.frame, f), name + ": toggle changes frame");
                break;
            }
            case KASEIKYO: {
                check(s.carrierHz == 38000 && sum(f) == 130000, name + ": carrier/period");
                int[] d = pdBytes(f, 3456, 1728, 48, 1296);
                check(d != null, name + ": decodes");
                if (d == null) return;
                // Flipper infrared_decoder_kaseikyo_interpret
                int vendor = (d[1] << 8) | d[0];
                int vp = d[2] & 0xF, g1 = d[2] >> 4, g2 = d[3] & 0xF;
                int data = (d[3] >> 4) | ((d[4] & 0x3F) << 4);
                int id = d[4] >> 6;
                int vpc = d[0] ^ d[1];
                vpc = (vpc & 0xF) ^ (vpc >> 4);
                check(vp == vpc, name + ": vendor parity");
                check(d[5] == (d[2] ^ d[3] ^ d[4]), name + ": parity");
                long addr = ((long) id << 24) | ((long) vendor << 8) | (g1 << 4) | g2;
                check(addr == c.address && data == c.command, name + ": Kaseikyo fields");
                break;
            }
        }
        // chunks: never over the Android 2 s limit, at least one frame, padded frames only
        for (boolean first : new boolean[] {true, false}) {
            int[] ch = IrCodes.chunk(s, first, 450_000);
            check(sum(ch) <= 2_000_000 && sum(ch) > 0 && ch.length % 2 == 0, name + ": chunk first=" + first);
            if (first) check(ch[0] == f[0], name + ": chunk starts with frame");
        }
    }

    public static void main(String[] args) {
        // the kit codes found by the sweep
        roundTrip(new Code("kit up", Protocol.NEC, 0x00, 0x05));
        roundTrip(new Code("kit down", Protocol.NEC, 0x00, 0x04));
        for (Code[] pair : IrCodes.BRANDS) for (Code c : pair) roundTrip(c);
        // whole NEC space, and every RC5 / SIRC12 address+command
        for (int a = 0; a < 256; a++) for (int c = 0; c < 256; c++) roundTrip(new Code("nec", Protocol.NEC, a, c));
        for (int a = 0; a < 32; a++) for (int c = 0; c < 64; c++) roundTrip(new Code("rc5", Protocol.RC5, a, c));
        for (int a = 0; a < 32; a++) for (int c = 0; c < 128; c++) roundTrip(new Code("sirc", Protocol.SIRC12, a, c));
        // kit timings match the patterns the sweep sent (sweep used 562/1687, Flipper 560/1690)
        int[] kit = IrCodes.encode(new Code("k", Protocol.NEC, 0, 5), false).frame;
        check(kit.length == 68, "kit frame length 68");
        System.out.println(checks + " checks, " + failures + " failures");
        System.exit(failures == 0 ? 0 : 1);
    }
}
