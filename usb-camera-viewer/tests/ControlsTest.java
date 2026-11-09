import com.tomerg.usbcamera.Controls;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Checks Controls: that its ids match control_table in app/jni/usbcamera.c, the auto switch
 * links, value texts, and the slider arithmetic. Plain Java: run with tests/run.sh.
 */
public class ControlsTest {
    static int failures = 0, checks = 0;

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) {
            failures++;
            System.out.println("FAIL " + what);
        }
    }

    public static void main(String[] args) throws Exception {
        // The C table, in order: {camera_terminal, selector, bit, size, kind}.
        String c = new String(Files.readAllBytes(Paths.get("app/jni/usbcamera.c")), "UTF-8");
        Matcher table = Pattern.compile("control_table\\[\\] = \\{(.*?)\\n\\};", Pattern.DOTALL).matcher(c);
        check(table.find(), "control_table found in usbcamera.c");
        List<String[]> rows = new ArrayList<>();
        Matcher row = Pattern.compile("\\{(\\d), (UVC_\\w+), (\\d+), (\\d), (CTRL_\\w+)\\}").matcher(table.group(1));
        while (row.find()) rows.add(new String[] {row.group(1), row.group(2), row.group(3), row.group(4), row.group(5)});
        String[] selectors = {
            "UVC_CT_AE_MODE_CONTROL", "UVC_CT_EXPOSURE_TIME_ABSOLUTE_CONTROL", "UVC_PU_GAIN_CONTROL",
            "UVC_PU_BRIGHTNESS_CONTROL", "UVC_PU_CONTRAST_CONTROL", "UVC_PU_SATURATION_CONTROL",
            "UVC_PU_HUE_CONTROL", "UVC_PU_SHARPNESS_CONTROL", "UVC_PU_GAMMA_CONTROL",
            "UVC_PU_BACKLIGHT_COMPENSATION_CONTROL", "UVC_PU_WHITE_BALANCE_TEMPERATURE_AUTO_CONTROL",
            "UVC_PU_WHITE_BALANCE_TEMPERATURE_CONTROL", "UVC_PU_POWER_LINE_FREQUENCY_CONTROL",
            "UVC_CT_FOCUS_AUTO_CONTROL", "UVC_CT_FOCUS_ABSOLUTE_CONTROL", "UVC_CT_ZOOM_ABSOLUTE_CONTROL",
        };
        // bmControls bits, from the Linux uvcvideo driver's uvc_ctrls[] .index values.
        int[] bits = {1, 3, 9, 0, 1, 3, 2, 4, 5, 8, 12, 6, 10, 17, 5, 9};
        int[] sizes = {1, 4, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 1, 2, 2};
        check(rows.size() == selectors.length, "C table has " + rows.size() + " rows, want " + selectors.length);
        check(Controls.count(new int[6 * selectors.length]) == selectors.length, "count");
        for (int id = 0; id < Math.min(rows.size(), selectors.length); id++) {
            String[] r = rows.get(id);
            String name = Controls.name(id);
            check(r[1].equals(selectors[id]), name + ": C row " + id + " is " + r[1]);
            check(r[0].equals(selectors[id].startsWith("UVC_CT_") ? "1" : "0"), name + ": unit");
            check(Integer.parseInt(r[2]) == bits[id], name + ": bit " + r[2]);
            check(Integer.parseInt(r[3]) == sizes[id], name + ": size " + r[3]);
            boolean cSwitch = r[4].equals("CTRL_SWITCH") || r[4].equals("CTRL_AE_MODE");
            check(cSwitch == Controls.isSwitch(id), name + ": switch in C and Java");
            check(r[4].equals("CTRL_RANGE_SIGNED") == (id == Controls.BRIGHTNESS || id == Controls.HUE),
                    name + ": signed only for brightness and hue");
        }

        // Auto switches and what they drive.
        for (int id = 0; id < selectors.length; id++) {
            int m = Controls.master(id);
            if (m >= 0) {
                check(Controls.isSwitch(m), Controls.name(id) + ": master is a switch");
                check(Controls.slave(m) == id, Controls.name(id) + ": slave of master");
            }
        }
        check(Controls.master(Controls.EXPOSURE) == Controls.AUTO_EXPOSURE, "exposure under auto exposure");
        check(Controls.master(Controls.WHITE_BALANCE) == Controls.AUTO_WHITE_BALANCE, "white balance under auto");
        check(Controls.master(Controls.FOCUS) == Controls.AUTOFOCUS, "focus under autofocus");
        check(Controls.slave(Controls.BRIGHTNESS) == -1, "brightness drives nothing");

        check(Controls.valueText(Controls.EXPOSURE, 156).equals("15.6 ms"), "exposure 156: " + Controls.valueText(Controls.EXPOSURE, 156));
        check(Controls.valueText(Controls.EXPOSURE, 100).equals("10 ms"), "exposure 100");
        check(Controls.valueText(Controls.EXPOSURE, 3).equals("0.3 ms"), "exposure 3");
        check(Controls.valueText(Controls.WHITE_BALANCE, 4600).equals("4600 K"), "white balance");
        check(Controls.valueText(Controls.POWER_LINE, 0).equals("Off"), "power line 0");
        check(Controls.valueText(Controls.POWER_LINE, 1).equals("50 Hz"), "power line 1");
        check(Controls.valueText(Controls.POWER_LINE, 3).equals("Auto"), "power line 3");
        check(Controls.valueText(Controls.POWER_LINE, 7).equals("7"), "power line 7");
        check(Controls.valueText(Controls.AUTOFOCUS, 1).equals("On"), "switch on");
        check(Controls.valueText(Controls.BRIGHTNESS, -12).equals("-12"), "brightness");

        // Slider arithmetic: every position maps to a value in range and back.
        int[][] ranges = {{-64, 64, 1}, {0, 255, 1}, {2800, 6500, 10}, {3, 2047, 1}, {0, 100, 3}, {0, 1, 1}, {5, 5, 0}};
        for (int[] r : ranges) {
            int steps = Controls.steps(r[0], r[1], r[2]);
            String what = r[0] + ".." + r[1] + " step " + r[2];
            for (int p = 0; p <= steps; p++) {
                int v = Controls.valueAt(r[0], r[1], r[2], p);
                check(v >= r[0] && v <= r[1], what + ": position " + p + " gives " + v);
                check(Controls.progressOf(r[0], r[1], r[2], v) == p, what + ": position " + p + " back");
            }
            check(Controls.valueAt(r[0], r[1], r[2], steps + 5) == Controls.valueAt(r[0], r[1], r[2], steps), what + ": past the end");
            check(Controls.progressOf(r[0], r[1], r[2], r[1] + 1000) == steps, what + ": above max");
            check(Controls.progressOf(r[0], r[1], r[2], r[0] - 1000) == 0, what + ": below min");
        }
        check(Controls.progressOf(2800, 6500, 10, 4604) == 180, "nearest position, down");
        check(Controls.progressOf(2800, 6500, 10, 4606) == 181, "nearest position, up");

        int[] flat = {Controls.BRIGHTNESS, -64, 64, 1, 0, -10, Controls.AUTOFOCUS, 0, 1, 1, 1, 1};
        check(Controls.find(flat, Controls.BRIGHTNESS) == 0, "find first");
        check(Controls.find(flat, Controls.AUTOFOCUS) == 6, "find second");
        check(Controls.find(flat, Controls.FOCUS) == -1, "find missing");
        check(Controls.find(flat, -1) == -1, "find -1");
        check(Controls.describe(flat).equals("Brightness -64..64 = -10, Autofocus On"), "describe: " + Controls.describe(flat));
        check(Controls.describe(new int[0]).equals("none"), "describe none");

        System.out.println("ControlsTest: " + checks + " checks, " + failures + " failures");
        if (failures > 0) System.exit(1);
    }
}
