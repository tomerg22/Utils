#!/usr/bin/env python3
"""
keyshot.py - simulate keyboard input and capture screenshots on macOS.

No third-party packages. It shells out to two tools that ship with macOS:
  /usr/sbin/screencapture       screenshots
  /usr/bin/osascript            key events, via System Events

macOS permissions (System Settings > Privacy & Security):
  Accessibility     needed for key events. Without it osascript fails with
                    error -1719 or -25211 and NO key is sent.
  Screen Recording  needed to capture other apps' windows. Without it the
                    picture shows only the desktop wallpaper.
  Grant them to the app that runs this script (Terminal, iTerm, Claude, ...),
  not to python3 itself.

Commands:
  check                          test both permissions, print what is missing
  selftest                       type a token into this terminal and read
                                 it back, then capture two screenshots
  shot [-o FILE] [--window] [--region X,Y,W,H] [--display N] [--format png]
  type TEXT
  key COMBO                      return, cmd+s, ctrl+alt+delete, cmd+shift+4
  app NAME                       bring an application to the front
  wait SECONDS
  run FILE                       run a sequence, one command per line
  loop [--dir D] [--prefix P] [--wait S] [--key K] [--count N]
                                 wait 5 s -> screenshot -> press a key ->
                                 wait -> repeat, until Ctrl-C
  keys                           list the special key names

Batch file format (one command per line, # starts a comment):
  app TextEdit
  wait 1
  type Hello from keyshot
  key return
  shot step1.png
"""

import argparse
import datetime
import os
import re
import shlex
import subprocess
import sys
import time

DRY_RUN = False          # --dry-run: print the AppleScript, send nothing
OSASCRIPT = "/usr/bin/osascript"
SCREENCAPTURE = "/usr/sbin/screencapture"

# macOS virtual key codes for keys that have no printable character.
KEY_CODES = {
    "return": 36, "enter": 76, "tab": 48, "space": 49,
    "delete": 51, "backspace": 51, "forwarddelete": 117,
    "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "capslock": 57, "help": 114,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79,
    "f19": 80, "f20": 90,
}

MODIFIERS = {
    "cmd": "command down", "command": "command down", "meta": "command down",
    "ctrl": "control down", "control": "control down",
    "alt": "option down", "opt": "option down", "option": "option down",
    "shift": "shift down",
}

PERMISSION_HINT = (
    "no Accessibility permission. System Settings > Privacy & Security > "
    "Accessibility: add and enable the app that runs this script."
)

AUTOMATION_HINT = (
    "no Automation consent for System Events. macOS asks once; if it was "
    "dismissed it never asks again. To make it ask again:\n"
    "       tccutil reset AppleEvents BUNDLE_ID\n"
    "     (iTerm2 = com.googlecode.iterm2, Terminal.app = com.apple.Terminal)\n"
    "     then run this again and click OK. Or set it by hand in System "
    "Settings > Privacy & Security > Automation > your terminal > System Events."
)

SCREEN_HINT = (
    "System Settings > Privacy & Security > Screen Recording: add and enable "
    "the app that runs this script, then restart that app."
)


PERMISSIONS_HELP = """\
macOS permissions
-----------------
Grant all three to the app you run this script from (iTerm2, Terminal, ...),
never to python3. Its bundle id:

  osascript -e 'id of app "iTerm"'        # com.googlecode.iterm2
  osascript -e 'id of app "Terminal"'     # com.apple.Terminal

1. Accessibility  (key events; missing = error -1719 "not allowed assistive access")
     open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

2. Automation > System Events  (key events; missing = error -1743)
     open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
   macOS asks for this once, as a dialog, the first time you run 'check'.
   If the dialog was dismissed it never comes back. Make it ask again:
     tccutil reset AppleEvents com.googlecode.iterm2
   then run 'check' again and click OK.

3. Screen Recording  (screenshots; missing = "could not create image from display")
     open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
   Quit and reopen the app after granting it.

A toggle that shows ON but still fails (common after the app updates):
     tccutil reset Accessibility com.googlecode.iterm2
     tccutil reset ScreenCapture com.googlecode.iterm2
   then grant it again in System Settings.

Verify:
     python3 keyshot.py check        # both permissions, real operations
     python3 keyshot.py selftest     # types a token and reads it back

sudo cannot grant any of these. They are System Settings toggles and the
permission database is protected by System Integrity Protection.
"""


class KeyShotError(RuntimeError):
    pass


def osa(*lines, args=()):
    """Run an AppleScript. Text is passed through argv, so nothing is escaped."""
    if DRY_RUN:
        print("--- applescript ---")
        print("\n".join(lines))
        if args:
            print("argv: %r" % (tuple(str(a) for a in args),))
        return ""

    cmd = [OSASCRIPT]
    for line in lines:
        cmd += ["-e", line]
    if args:
        cmd += ["--", *[str(a) for a in args]]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        err = p.stderr.strip() or "osascript exited %d" % p.returncode
        if "-1743" in err or "not authorized to send apple events" in err.lower():
            err += "\n  -> " + AUTOMATION_HINT
        elif "-1719" in err or "-25211" in err or "assistive" in err.lower():
            err += "\n  -> " + PERMISSION_HINT
        raise KeyShotError(err)
    return p.stdout.strip()


def type_text(text):
    osa(
        "on run argv",
        'tell application "System Events" to keystroke (item 1 of argv)',
        "end run",
        args=[text],
    )


def press_key(combo):
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    if not parts:
        raise KeyShotError("empty key combo")
    name, mods = parts[-1], parts[:-1]

    bad = [m for m in mods if m not in MODIFIERS]
    if bad:
        raise KeyShotError("unknown modifier(s): %s" % ", ".join(bad))
    using = ""
    if mods:
        # dict.fromkeys keeps order and drops a repeated modifier
        using = " using {%s}" % ", ".join(
            dict.fromkeys(MODIFIERS[m] for m in mods)
        )

    if name in KEY_CODES:
        body = "key code %d%s" % (KEY_CODES[name], using)
        args = ()
    elif len(name) == 1:
        # the literal character travels in argv, so quotes and \ are safe
        body = "keystroke (item 1 of argv)%s" % using
        args = (combo.split("+")[-1].strip(),)  # keep the original case
    else:
        raise KeyShotError(
            "unknown key %r (single characters, or: %s)"
            % (name, ", ".join(sorted(KEY_CODES)))
        )

    osa(
        "on run argv",
        'tell application "System Events" to %s' % body,
        "end run",
        args=args,
    )


def activate_app(name):
    osa(
        "on run argv",
        "tell application (item 1 of argv) to activate",
        "end run",
        args=[name],
    )


def front_window_bounds():
    out = osa(
        'tell application "System Events"',
        "  set p to first application process whose frontmost is true",
        "  set w to front window of p",
        "  set {x, y} to position of w",
        "  set {ww, hh} to size of w",
        '  return (x as text) & "," & (y as text) & "," & '
        '(ww as text) & "," & (hh as text)',
        "end tell",
    )
    try:
        return [int(float(v)) for v in out.split(",")]
    except ValueError:
        raise KeyShotError("could not read the front window bounds: %r" % out)


def screenshot(path=None, window=False, region=None, display=None, fmt="png"):
    if path is None:
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        path = "shot-%s.%s" % (stamp, fmt)
    path = os.path.abspath(os.path.expanduser(path))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    cmd = [SCREENCAPTURE, "-x", "-t", fmt]
    if display is not None:
        cmd += ["-D", str(display)]
    if window:
        region = front_window_bounds()
    if region:
        if isinstance(region, str):
            region = [int(float(v)) for v in region.split(",")]
        if len(region) != 4:
            raise KeyShotError("--region needs X,Y,W,H")
        cmd += ["-R", ",".join(str(int(v)) for v in region)]
    cmd.append(path)

    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise KeyShotError(
            "screencapture failed: %s" % (p.stderr.strip() or p.returncode)
        )
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        raise KeyShotError("screencapture wrote nothing to %s" % path)
    return path


def image_size(path):
    """(width, height) in pixels, via sips. ('?', '?') if it cannot tell."""
    out = subprocess.run(
        ["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
        capture_output=True, text=True,
    ).stdout
    w = h = "?"
    for line in out.splitlines():
        if "pixelWidth:" in line:
            w = line.split(":")[1].strip()
        elif "pixelHeight:" in line:
            h = line.split(":")[1].strip()
    return w, h


def selftest():
    """Prove a key really lands, with no human eyeball needed.

    Types a random token into the frontmost window, which is the terminal
    running this script, then reads that token back from its own stdin.
    """
    import select
    import termios
    import uuid

    if not sys.stdin.isatty():
        print("selftest needs an interactive terminal (stdin is not a tty).")
        return False

    ok = True
    token = "keyshot-%s" % uuid.uuid4().hex[:8]
    print("Do not touch the keyboard or switch windows for ~6 seconds.")
    print("Sending %s to this window ..." % token)
    time.sleep(1.0)

    try:
        termios.tcflush(sys.stdin, termios.TCIFLUSH)
        type_text(token)
        press_key("return")
    except KeyShotError as exc:
        print("Key events       : FAILED\n  %s" % exc)
        return False

    ready, _, _ = select.select([sys.stdin], [], [], 5.0)
    if not ready:
        ok = False
        print("Key events       : FAILED (nothing arrived within 5s; the keys "
              "went to another window, or focus changed)")
    else:
        got = sys.stdin.readline().strip()
        if got == token:
            print("Key events       : PASS (sent and read back %s)" % token)
        else:
            ok = False
            print("Key events       : FAILED (sent %r, read %r)" % (token, got))

    out = os.path.join(os.path.expanduser("~"), "keyshot-selftest.png")
    try:
        screenshot(out)
        w, h = image_size(out)
        print("Screenshot       : PASS (%sx%s px, %d bytes, %s)"
              % (w, h, os.path.getsize(out), out))
    except KeyShotError as exc:
        ok = False
        print("Screenshot       : FAILED\n  %s" % exc)

    try:
        win = os.path.join(os.path.expanduser("~"), "keyshot-selftest-window.png")
        screenshot(win, window=True)
        w, h = image_size(win)
        print("Window capture   : PASS (%sx%s px, %s)" % (w, h, win))
    except KeyShotError as exc:
        ok = False
        print("Window capture   : FAILED\n  %s" % exc)

    print("RESULT: %s" % ("PASS" if ok else "FAIL"))
    return ok


def check_permissions():
    """Probe each permission with a real operation, not a guess."""
    ok = True

    try:
        front_window_bounds()
        print("Key events       : OK")
    except KeyShotError as exc:
        ok = False
        print("Key events       : FAILED\n  %s" % exc)

    tmp = os.path.join(
        os.environ.get("TMPDIR", "/tmp"), "keyshot-permcheck.png"
    )
    try:
        screenshot(tmp)
        w, h = image_size(tmp)
        print("Screen Recording : OK (captured the display, %sx%s px, %d bytes)"
              % (w, h, os.path.getsize(tmp)))
    except KeyShotError as exc:
        ok = False
        print("Screen Recording : FAILED\n  %s\n  -> %s" % (exc, SCREEN_HINT))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    return ok


def next_index(directory, prefix, fmt):
    """Highest number already used in the folder, plus one. Never overwrites."""
    pat = re.compile(r"^%s(\d+)\.%s$" % (re.escape(prefix), re.escape(fmt)))
    best = 0
    if os.path.isdir(directory):
        for name in os.listdir(directory):
            m = pat.match(name)
            if m:
                best = max(best, int(m.group(1)))
    return best + 1


def loop_capture(directory, prefix="shot-", fmt="png", wait=5.0, key="left",
                 count=None, digits=4, window=False, region=None,
                 display=None, app=None, start_delay=5.0):
    """Startup wait, then: screenshot -> press key -> wait -> repeat.

    The wait comes after the key press so the page has time to turn and
    render before the next screenshot. Runs until Ctrl-C.
    """
    directory = os.path.abspath(os.path.expanduser(directory))
    os.makedirs(directory, exist_ok=True)
    idx = next_index(directory, prefix, fmt)

    if app:
        activate_app(app)
    if start_delay > 0:
        what = ("%s is in front." % app if app
                else "Click the window you want to capture.")
        print("%s Starting in %d s ..." % (what, start_delay))
        for left in range(int(start_delay), 0, -1):
            print("   %d " % left, end="\r", flush=True)
            time.sleep(1)
        print("      ", end="\r")

    print("Folder : %s" % directory)
    print("Names  : %s%0*d.%s and up" % (prefix, digits, idx, fmt))
    print("Each   : shot, press %r, wait %gs" % (key, wait))
    print("Stop   : Ctrl-C")

    saved = 0
    try:
        while True:
            path = os.path.join(
                directory, "%s%0*d.%s" % (prefix, digits, idx, fmt)
            )
            screenshot(path, window=window, region=region,
                       display=display, fmt=fmt)
            saved += 1
            idx += 1
            print("[%d] %s" % (saved, path))
            if count is not None and saved >= count:
                break
            press_key(key)
            time.sleep(wait)
    except KeyboardInterrupt:
        print()
    except KeyShotError as exc:
        print("error: %s" % exc, file=sys.stderr)
        print("stopped after %d file(s) in %s" % (saved, directory))
        return False

    print("stopped. %d file(s) in %s" % (saved, directory))
    return True


def run_batch(path, delay):
    with open(path) as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            verb, _, rest = line.partition(" ")
            verb, rest = verb.lower(), rest.strip()
            try:
                if verb == "type":
                    type_text(rest)
                elif verb == "key":
                    press_key(rest)
                elif verb == "app":
                    activate_app(rest)
                elif verb == "wait":
                    time.sleep(float(rest))
                elif verb == "shot":
                    print(screenshot(rest or None))
                else:
                    raise KeyShotError("unknown command %r" % verb)
            except (KeyShotError, ValueError) as exc:
                raise KeyShotError("%s:%d: %s" % (path, lineno, exc))
            time.sleep(delay)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="keyshot.py",
        description="Simulate key presses and take screenshots (macOS).",
        epilog=PERMISSIONS_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="print the AppleScript for type/key/app, send nothing")
    ap.add_argument("--delay", type=float, default=0.3,
                    help="seconds to wait after each action (default 0.3)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check", help="test permissions")
    sub.add_parser("selftest", help="prove keys land and shots work")
    sub.add_parser("keys", help="list special key names")

    s = sub.add_parser("shot", help="take a screenshot")
    s.add_argument("path", nargs="?", help="output file (default shot-<ts>.png)")
    s.add_argument("-o", "--out", dest="out", help="same as path")
    s.add_argument("--window", action="store_true",
                   help="only the frontmost window")
    s.add_argument("--region", help="X,Y,W,H in points")
    s.add_argument("--display", type=int, help="display number, 1-based")
    s.add_argument("--format", default="png",
                   choices=["png", "jpg", "tiff", "pdf"])

    t = sub.add_parser("type", help="type literal text")
    t.add_argument("text", nargs="+")

    k = sub.add_parser("key", help="press a key or combo")
    k.add_argument("combo", nargs="+")

    a = sub.add_parser("app", help="bring an application to the front")
    a.add_argument("name", nargs="+")

    w = sub.add_parser("wait", help="sleep")
    w.add_argument("seconds", type=float)

    r = sub.add_parser("run", help="run a batch file")
    r.add_argument("file")

    lp = sub.add_parser(
        "loop", help="screenshot, wait, press a key, repeat until Ctrl-C")
    lp.add_argument("--dir", default="~/Downloads/worthy",
                    help="output folder (default ~/Downloads/worthy)")
    lp.add_argument("--prefix", default="shot-",
                    help="filename prefix (default shot-)")
    lp.add_argument("--digits", type=int, default=4,
                    help="zero padding of the counter (default 4)")
    lp.add_argument("--wait", type=float, default=5.0,
                    help="seconds after the key press, before the next "
                         "shot (default 5)")
    lp.add_argument("--key", default="left",
                    help="key pressed each round (default left)")
    lp.add_argument("--count", type=int,
                    help="stop after N shots (default: never)")
    lp.add_argument("--app", help="activate this app first (the startup "
                                  "countdown still runs)")
    lp.add_argument("--start-delay", type=float, default=5.0,
                    help="wait before the first shot, always, also with "
                         "--app (default 5)")
    lp.add_argument("--window", action="store_true",
                    help="capture only the frontmost window")
    lp.add_argument("--region", help="X,Y,W,H in points")
    lp.add_argument("--display", type=int, help="display number, 1-based")
    lp.add_argument("--format", default="png",
                    choices=["png", "jpg", "tiff", "pdf"])

    args = ap.parse_args(argv)

    global DRY_RUN
    DRY_RUN = args.dry_run

    try:
        if args.cmd == "check":
            return 0 if check_permissions() else 1
        if args.cmd == "selftest":
            return 0 if selftest() else 1
        if args.cmd == "keys":
            print(" ".join(sorted(KEY_CODES)))
            print("modifiers: " + " ".join(sorted(MODIFIERS)))
            return 0
        if args.cmd == "shot":
            print(screenshot(args.out or args.path, window=args.window,
                             region=args.region, display=args.display,
                             fmt=args.format))
        elif args.cmd == "type":
            type_text(" ".join(args.text))
        elif args.cmd == "key":
            for combo in args.combo:
                press_key(combo)
                time.sleep(args.delay)
        elif args.cmd == "app":
            activate_app(" ".join(args.name))
        elif args.cmd == "wait":
            time.sleep(args.seconds)
        elif args.cmd == "run":
            run_batch(args.file, args.delay)
        elif args.cmd == "loop":
            return 0 if loop_capture(
                args.dir, prefix=args.prefix, fmt=args.format, wait=args.wait,
                key=args.key, count=args.count,
                digits=args.digits, window=args.window, region=args.region,
                display=args.display, app=args.app,
                start_delay=args.start_delay,
            ) else 1
    except KeyShotError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
