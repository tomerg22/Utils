"""
Turn the TV off, confirm it actually went off, then suspend the PC.

Why this exists
---------------
When Windows suspends, the network stack goes down within milliseconds. The
listener's suspend hook does fire, but a command sent at that moment usually
never reaches the TV - and there is no confirmation signal to detect it with
(this TV answers nothing and does not close the socket when it powers off).

Observed on this machine:

    display-off, then suspend 23.5s later  -> off command succeeds
    straight to suspend, no display-off    -> off command lost

That race cannot be won reliably from inside the suspend handler. So instead
of racing it, this script inverts the order: the TV is switched off *first*,
while the network is fully up, verified, and only then is the PC suspended.

Use this instead of the Start menu's Sleep (bind it to a shortcut, or call it
from a voice assistant's "sleep" command). The listener still handles the
idle-timeout case and the wake-up on its own.
"""
import ctypes
import sys
import time

import tv_control

CONFIRM_TIMEOUT = 12.0


def main() -> int:
    state = tv_control.get_state()
    print(f"TV state: {state}")

    if state == "on":
        # Not the fast path: the PC is fully awake here, so there is time to
        # do this properly with pre-flight checks and a fresh connection.
        tv_control.power_off(fast=False)

        deadline = time.time() + CONFIRM_TIMEOUT
        while time.time() < deadline:
            time.sleep(0.7)
            state = tv_control.get_state()
            if state != "on":
                print(f"TV confirmed off (state={state}) after "
                      f"{CONFIRM_TIMEOUT - (deadline - time.time()):.1f}s")
                break
        else:
            print("WARNING: TV did not report off within "
                  f"{CONFIRM_TIMEOUT:.0f}s - suspending anyway", file=sys.stderr)
    else:
        print("TV already off - nothing to do")

    print("Suspending PC...")
    # SetSuspendState(bHibernate=False, bForce=False, bWakeupEventsDisabled=False)
    ctypes.windll.powrprof.SetSuspendState(False, False, False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
