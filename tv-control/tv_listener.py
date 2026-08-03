"""
Background listener: watches Windows' GUID_CONSOLE_DISPLAY_STATE power
notification (fires when the display actually turns off/on/dims - distinct
from full system sleep) and drives the TV to match the main monitor.
Runs hidden, no console window, meant to be launched via Task Scheduler
at logon using pythonw.exe.
"""
import ctypes
import ctypes.wintypes as wintypes
import logging
import time
import traceback
from pathlib import Path

import win32con
import win32gui

import tv_control

LOG_FILE = Path(__file__).resolve().parent / "tv_listener.log"
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s %(message)s",
)


def log(msg: str) -> None:
    logging.info(msg)


GUID_CONSOLE_DISPLAY_STATE = "{6FE69556-704A-47A0-8F24-C28D936FDA47}"
WM_POWERBROADCAST = 0x0218
PBT_POWERSETTINGCHANGE = 0x8013

DISPLAY_OFF = 0
DISPLAY_ON = 1
DISPLAY_DIMMED = 2

# System suspend/resume events (distinct from display-state events) - these
# fire specifically around the sleep transition, and Windows waits briefly
# for the window procedure to return before completing suspend, giving the
# TV-off command a real (if bounded) window instead of racing a teardown.
PBT_APMSUSPEND = 0x0004
PBT_APMRESUMESUSPEND = 0x0007
PBT_APMRESUMEAUTOMATIC = 0x0012


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class POWERBROADCAST_SETTING(ctypes.Structure):
    _fields_ = [
        ("PowerSetting", GUID),
        ("DataLength", ctypes.c_ulong),
        ("Data", ctypes.c_ubyte * 4),
    ]


def _make_guid(guid_str: str) -> GUID:
    guid = GUID()
    ctypes.windll.ole32.CLSIDFromString(ctypes.c_wchar_p(guid_str), ctypes.byref(guid))
    return guid


# Windows delivers the *current* display state immediately upon registration.
# Acting on it would mean any restart (watchdog, logon) re-asserts TV power -
# e.g. turning the TV back on after you deliberately switched it off. Sync
# state silently instead, and only act on genuine transitions after that.
_startup_event_seen = False
_last_resume = 0.0
_last_power_on = 0.0

# A display-off notification queued during suspend is delivered on resume,
# which would switch the TV off moments before switching it back on.
RESUME_IGNORE_WINDOW = 20.0
# Resume produces two events (PBT_APMRESUMEAUTOMATIC then PBT_APMRESUMESUSPEND)
# plus a display-on; without debouncing, each fires its own 12s WoL burst.
POWER_ON_DEBOUNCE = 20.0


def _do_power_off(source: str, suspending: bool = False) -> None:
    """Send the off toggle at most once per on/off cycle.

    This TV ignores KEY_POWEROFF, KEY_POWER_OFF and KEY_STANDBY (all verified
    against the real device), so KEY_POWER - a toggle - is the only command
    that works, and a second send switches the TV back ON. The gap between
    the display-off and suspend events varies hugely (4ms and 23.5s both
    observed), so a time-based debounce cannot cover it: the state is tracked
    explicitly and cleared only by a power-on.
    """
    if tv_control.get_believed_off():
        log(f"{source} -> skipped, TV already believed off "
            "(KEY_POWER is a toggle - sending again would switch it back on)")
        return
    log(f"{source} -> turning TV off")
    try:
        # sets the shared believed-off flag itself
        tv_control.power_off(suspending=suspending)
    except Exception:
        log("power_off failed:\n" + traceback.format_exc())


def _do_power_on(source: str) -> None:
    global _last_power_on
    now = time.time()
    if now - _last_power_on < POWER_ON_DEBOUNCE:
        log(f"{source} -> power_on suppressed "
            f"(already issued {now - _last_power_on:.1f}s ago)")
        return
    _last_power_on = now
    log(f"{source} -> turning TV on")
    try:
        tv_control.power_on()
    except Exception:
        log("power_on failed:\n" + traceback.format_exc())


def _handle_display_state(state: int) -> None:
    global _startup_event_seen
    if not _startup_event_seen:
        _startup_event_seen = True
        log(f"Initial display state {state} at startup -> ignoring (no action)")
        return

    if state == DISPLAY_OFF:
        since_resume = time.time() - _last_resume
        if since_resume < RESUME_IGNORE_WINDOW:
            log(f"Display OFF {since_resume:.1f}s after resume -> ignoring "
                "(stale event queued during suspend)")
            return
        _do_power_off("Display OFF")
    elif state == DISPLAY_ON:
        _do_power_on("Display ON")
    else:
        log(f"Display state {state} (dimmed) -> ignoring")


def wnd_proc(hwnd, msg, wparam, lparam):
    if msg == WM_POWERBROADCAST:
        if wparam == PBT_POWERSETTINGCHANGE:
            try:
                settings = ctypes.cast(lparam, ctypes.POINTER(POWERBROADCAST_SETTING)).contents
                state = settings.Data[0]
                _handle_display_state(state)
            except Exception:
                log("wnd_proc error:\n" + traceback.format_exc())
            return 0

        if wparam == PBT_APMSUSPEND:
            # Windows waits for this handler to return before it suspends, but
            # only for ~2s. That whole budget is now spent inside power_off's
            # warm send (tv_control.SUSPEND_DWELL), so it is accounted for in
            # one place. A second dwell here would land *after* the socket
            # close and push the total past the deadline for no gain.
            _do_power_off("System suspending (suspend hook)", suspending=True)
            return 0

        if wparam in (PBT_APMRESUMESUSPEND, PBT_APMRESUMEAUTOMATIC):
            global _last_resume
            _last_resume = time.time()
            _do_power_on(f"System resumed (wparam={wparam}, suspend hook)")
            return 0

    return win32gui.DefWindowProc(hwnd, msg, wparam, lparam)


def main() -> None:
    log("=== tv_listener starting ===")

    wc = win32gui.WNDCLASS()
    wc.lpfnWndProc = wnd_proc
    wc.lpszClassName = "TVControlListenerWindow"
    wc.hInstance = win32gui.GetModuleHandle(None)
    class_atom = win32gui.RegisterClass(wc)

    # Deliberately NOT a message-only (HWND_MESSAGE) window: those do not
    # receive broadcast WM_POWERBROADCAST messages, so PBT_APMSUSPEND /
    # PBT_APMRESUME* never arrive - only the targeted display-state
    # notifications do. A normal top-level window that is simply never shown
    # receives both and stays invisible.
    hwnd = win32gui.CreateWindow(
        class_atom, "TVControlListener", win32con.WS_OVERLAPPED,
        0, 0, 0, 0, 0, 0, wc.hInstance, None,
    )
    log(f"Hidden window created: hwnd={hwnd}")

    guid = _make_guid(GUID_CONSOLE_DISPLAY_STATE)
    handle = ctypes.windll.user32.RegisterPowerSettingNotification(hwnd, ctypes.byref(guid), 0)
    if not handle:
        log("RegisterPowerSettingNotification FAILED")
        return
    log("Registered for GUID_CONSOLE_DISPLAY_STATE notifications")

    suspend_handle = ctypes.windll.user32.RegisterSuspendResumeNotification(hwnd, 0)
    if not suspend_handle:
        log("RegisterSuspendResumeNotification FAILED (continuing without it)")
    else:
        log("Registered for suspend/resume notifications")

    # Hold a live socket to the TV so the suspend-time command is ~5ms.
    tv_control.start_warm_keepalive()

    win32gui.PumpMessages()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log("FATAL:\n" + traceback.format_exc())
