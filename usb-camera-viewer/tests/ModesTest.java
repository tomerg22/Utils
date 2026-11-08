import com.tomerg.usbcamera.Modes;
import java.util.Arrays;

/**
 * Checks which mode Modes.pick starts a camera in, and the parsing of a wanted mode.
 * Plain Java, no Android: run with tests/run.sh.
 */
public class ModesTest {
    static int failures = 0, checks = 0;

    static final int M = Modes.MJPEG, Y = Modes.YUYV;

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) {
            failures++;
            System.out.println("FAIL " + what);
        }
    }

    static int[] flat(int[]... modes) {
        int[] out = new int[4 * modes.length];
        for (int i = 0; i < modes.length; i++) System.arraycopy(modes[i], 0, out, 4 * i, 4);
        return out;
    }

    static int[] mode(int kind, int w, int h, int fps) {
        return new int[] {kind, w, h, fps};
    }

    static void expectPick(String what, int[] flat, int[] wanted, int[] want) {
        int[] got = Modes.pick(flat, wanted);
        check(Arrays.equals(got, want), what + ": got " + Arrays.toString(got) + ", want " + Arrays.toString(want));
        // The order of the list must not matter.
        int n = Modes.count(flat);
        int[] reversed = new int[flat.length];
        for (int i = 0; i < n; i++) System.arraycopy(flat, 4 * i, reversed, 4 * (n - 1 - i), 4);
        got = Modes.pick(reversed, wanted);
        check(Arrays.equals(got, want), what + " (reversed list): got " + Arrays.toString(got));
    }

    public static void main(String[] args) {
        // A common 5 MP webcam: MJPEG up to 2592x1944, YUYV only small at 30 fps.
        int[] webcam = flat(mode(M, 640, 480, 30), mode(M, 1280, 720, 30), mode(M, 1920, 1080, 30),
                mode(M, 2592, 1944, 15), mode(Y, 640, 480, 30), mode(Y, 1280, 720, 10),
                mode(Y, 1920, 1080, 5));
        expectPick("webcam: MJPEG 1080p 30", webcam, null, mode(M, 1920, 1080, 30));
        expectPick("wanted mode wins", webcam, mode(Y, 1280, 720, 10), mode(Y, 1280, 720, 10));
        expectPick("wanted mode the camera lacks is ignored", webcam, mode(M, 800, 600, 30),
                mode(M, 1920, 1080, 30));

        expectPick("YUYV only: the largest smooth size",
                flat(mode(Y, 1280, 720, 10), mode(Y, 640, 480, 30), mode(Y, 320, 240, 30), mode(Y, 1920, 1080, 5)),
                null, mode(Y, 640, 480, 30));
        expectPick("smooth YUYV beats choppy MJPEG",
                flat(mode(M, 1920, 1080, 15), mode(M, 1280, 720, 15), mode(Y, 640, 480, 30)),
                null, mode(Y, 640, 480, 30));
        expectPick("MJPEG beats YUYV at the same size and rate",
                flat(mode(Y, 640, 480, 30), mode(M, 640, 480, 30)), null, mode(M, 640, 480, 30));
        expectPick("all choppy: still the largest up to 1080p",
                flat(mode(M, 1280, 720, 15), mode(M, 1920, 1080, 10), mode(M, 3840, 2160, 5)),
                null, mode(M, 1920, 1080, 10));
        expectPick("only above 1080p: the smallest of them",
                flat(mode(M, 3840, 2160, 30), mode(M, 2560, 1440, 30)), null, mode(M, 2560, 1440, 30));
        expectPick("1080p beats a larger frame",
                flat(mode(M, 2560, 1440, 30), mode(M, 1920, 1080, 30)), null, mode(M, 1920, 1080, 30));
        expectPick("same size: the higher rate",
                flat(mode(M, 1280, 720, 25), mode(M, 1280, 720, 60), mode(M, 1280, 720, 30)),
                null, mode(M, 1280, 720, 60));
        expectPick("25 fps counts as smooth",
                flat(mode(M, 1920, 1080, 25), mode(M, 640, 480, 30)), null, mode(M, 1920, 1080, 25));
        check(Modes.pick(new int[0], null) == null, "no modes: null");

        // better() must be a strict order, or pick() would depend on the list order.
        int[][] all = new int[Modes.count(webcam) + 4][];
        for (int i = 0; i < Modes.count(webcam); i++) all[i] = Modes.get(webcam, i);
        all[all.length - 4] = mode(M, 3840, 2160, 30);
        all[all.length - 3] = mode(M, 2560, 1440, 30);
        all[all.length - 2] = mode(M, 1280, 720, 60);
        all[all.length - 1] = mode(Y, 320, 240, 30);
        for (int[] a : all) {
            check(!Modes.better(a, a), "better is irreflexive for " + Arrays.toString(a));
            for (int[] b : all) {
                if (!Arrays.equals(a, b)) {
                    check(Modes.better(a, b) != Modes.better(b, a),
                            "better is total and antisymmetric for " + Arrays.toString(a) + " " + Arrays.toString(b));
                }
                for (int[] c : all) {
                    if (Modes.better(a, b) && Modes.better(b, c)) {
                        check(Modes.better(a, c), "better is transitive for " + Arrays.toString(a)
                                + " " + Arrays.toString(b) + " " + Arrays.toString(c));
                    }
                }
            }
        }

        // The mode extra: "kind,width,height,fps", and what parse refuses.
        for (int[] m : all) {
            String s = m[0] + "," + m[1] + "," + m[2] + "," + m[3];
            check(Arrays.equals(Modes.parse(s), m), "parse " + s);
        }
        check(Modes.parse(null) == null, "parse(null)");
        check(Modes.parse("") == null, "parse(\"\")");
        check(Modes.parse("0,640,480") == null, "parse with 3 fields");
        check(Modes.parse("0,640,480,30,1") == null, "parse with 5 fields");
        check(Modes.parse("0,640,x,30") == null, "parse with a non-number");

        check(Modes.label(mode(M, 1280, 720, 30)).equals("MJPEG 1280×720 30 fps"), "MJPEG label");
        check(Modes.label(mode(Y, 640, 480, 30)).equals("YUYV 640×480 30 fps"), "YUYV label");

        System.out.println(checks + " checks, " + failures + " failures");
        if (failures > 0) System.exit(1);
    }
}
