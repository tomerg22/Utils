"""
Core TV control: power off via Samsung Tizen WebSocket remote-key API,
power on via Wake-on-LAN, with MAC-based auto-rediscovery if the TV's
DHCP-assigned IP changes.
"""
from __future__ import annotations

import base64
import json
import logging
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import websocket
from wakeonlan import send_magic_packet

BASE_DIR = Path(__file__).resolve().parent
TOKEN_FILE = BASE_DIR / "tv-token.txt"
IP_CACHE_FILE = BASE_DIR / "tv-ip-cache.txt"

CONFIG_FILE = BASE_DIR / "tv-config.json"


def _load_config() -> dict:
    if not CONFIG_FILE.exists():
        raise SystemExit(
            f"Missing {CONFIG_FILE.name} - copy tv-config.example.json to "
            f"{CONFIG_FILE.name} and fill in your TV's MAC address, current "
            "IP and subnet prefix (README step 4)."
        )
    return json.loads(CONFIG_FILE.read_text())


_config = _load_config()
TV_MAC = _config["tv_mac"]
LAST_KNOWN_IP = _config["last_known_ip"]
SUBNET_PREFIX = _config["subnet_prefix"]  # /24 this PC is on

# Believed TV power state, shared across processes: the listener runs as a
# background service while sleep_pc.py runs in the foreground, and the two
# must agree. KEY_POWER is a toggle, so a redundant send from the listener's
# suspend hook would switch the TV straight back on.
STATE_FILE = BASE_DIR / "tv-state.json"


def get_believed_off() -> bool:
    try:
        return bool(json.loads(STATE_FILE.read_text()).get("believed_off", False))
    except Exception:
        return False


def set_believed_off(value: bool) -> None:
    try:
        STATE_FILE.write_text(json.dumps({"believed_off": value, "at": time.time()}))
    except Exception:
        pass

CLIENT_NAME = base64.b64encode(b"claude-tv-control").decode()
REST_TIMEOUT = 1.5
WS_TIMEOUT = 5


# Log to the listener's file too: under pythonw.exe sys.stdout is None, so
# print() is silently discarded - which previously hid every power_off
# decision (skips, failures, which IP was used) from diagnosis.
_LOG_FILE = BASE_DIR / "tv_listener.log"
_logger = logging.getLogger("tv_control")
if not _logger.handlers:
    _handler = logging.FileHandler(_LOG_FILE, encoding="utf-8")
    _handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    _logger.addHandler(_handler)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False


def _log(msg: str) -> None:
    _logger.info(f"[tv_control] {msg}")
    if sys.stdout is not None:
        print(f"[tv_control] {msg}", flush=True)


def _get_token() -> str:
    return TOKEN_FILE.read_text().strip()


def _rest_device_info(ip: str, timeout: float = REST_TIMEOUT) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://{ip}:8001/api/v2/", timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


def _read_cached_ip() -> str:
    if IP_CACHE_FILE.exists():
        cached = IP_CACHE_FILE.read_text().strip()
        if cached:
            return cached
    return LAST_KNOWN_IP


def _write_cached_ip(ip: str) -> None:
    IP_CACHE_FILE.write_text(ip)


def _arp_scan_for_mac(mac: str) -> str | None:
    """Populate the ARP cache by attempting connections across the subnet,
    then look up which IP owns the target MAC."""
    mac_norm = mac.lower().replace(":", "-")

    _log(f"ARP fallback: probing {SUBNET_PREFIX}0/24 to refresh ARP cache...")
    socks = []
    for i in range(1, 255):
        ip = f"{SUBNET_PREFIX}{i}"
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setblocking(False)
        try:
            s.connect_ex((ip, 80))
        except OSError:
            pass
        socks.append(s)
    time.sleep(1.0)
    for s in socks:
        s.close()

    out = subprocess.run(
        ["arp", "-a"], capture_output=True, text=True, timeout=10
    ).stdout
    for line in out.splitlines():
        m = re.search(r"(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})", line, re.IGNORECASE)
        if m and m.group(2).lower() == mac_norm:
            found_ip = m.group(1)
            _log(f"ARP fallback: found {mac} at {found_ip}")
            return found_ip

    _log("ARP fallback: MAC not found on subnet")
    return None


def resolve_tv_ip() -> str | None:
    """Fast path: check cached/last-known IP still owns the right MAC.
    Slow path: ARP-scan the subnet for the TV's MAC address."""
    cached = _read_cached_ip()
    info = _rest_device_info(cached)
    if info and info.get("device", {}).get("wifiMac", "").upper() == TV_MAC.upper():
        return cached

    found = _arp_scan_for_mac(TV_MAC)
    if found:
        _write_cached_ip(found)
        return found

    _log(f"Could not resolve TV IP; falling back to last-known {cached}")
    return None


def get_state(ip: str | None = None) -> str | None:
    """Returns 'on', 'off', or None if unreachable (device.PowerState)."""
    ip = ip or resolve_tv_ip()
    if not ip:
        return None
    info = _rest_device_info(ip)
    if not info:
        return None
    return info.get("device", {}).get("PowerState")


def _ws_url(ip: str) -> str:
    return (
        f"wss://{ip}:8002/api/v2/channels/samsung.remote.control"
        f"?name={CLIENT_NAME}&token={_get_token()}"
    )


def _key_payload(key: str) -> str:
    return json.dumps({
        "method": "ms.remote.control",
        "params": {
            "Cmd": "Click",
            "DataOfCmd": key,
            "Option": "false",
            "TypeOfRemote": "SendRemoteKey",
        },
    })


def _open_ws(ip: str, timeout: float) -> websocket.WebSocket:
    ws = websocket.WebSocket(sslopt={"cert_reqs": ssl.CERT_NONE})
    ws.settimeout(timeout)
    ws.connect(_ws_url(ip), timeout=timeout)
    try:
        # Nagle would let a small frame sit in the buffer; at suspend time
        # there is no "later" for it to be coalesced into.
        ws.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        pass
    ws.recv()  # ms.channel.connect ack
    return ws


def _send_key(ip: str, key: str, timeout: float = WS_TIMEOUT,
              flush_wait: float = 1.0) -> None:
    ws = _open_ws(ip, timeout)
    ws.send(_key_payload(key))
    time.sleep(flush_wait)
    ws.close()


# --- Warm connection -------------------------------------------------------
# Opening a connection takes ~1.6s (TCP + TLS handshake + WebSocket upgrade).
# At suspend time the network is torn down long before that finishes - proven
# in the log: a connect started at 23:07:12 froze mid-handshake and only
# failed 50 minutes later when the PC resumed. Holding an already-established
# socket open reduces the suspend-time work to sending a few bytes (~5ms),
# which comfortably fits inside the window Windows gives us.

_warm_lock = threading.Lock()
_warm_ws = None
_warm_opened_at = 0.0
_warm_failure_logged = False
_warm_ever_up = False

# The TV closes idle sockets after ~60s, and ping() on a socket the peer has
# already closed does NOT reliably raise - so liveness cannot be probed, only
# assumed for a short window. The connection is therefore rotated on a timer.
# A socket found dead at suspend time is fatal: reconnecting takes ~1.3s and
# the network is gone well before that completes.
WARM_MAX_AGE = 20.0

# Windows allows an application approximately two seconds to handle
# PBT_APMSUSPEND before it may be interrupted, and that deadline is hard-coded
# - it dropped from 20s to 2s in Vista and is not configurable:
#   https://learn.microsoft.com/en-us/windows/win32/power/pbt-apmsuspend
#   https://devblogs.microsoft.com/oldnewthing/20111124-00/?p=9043
# ws.send() only fills the socket buffer, so the one useful thing to do with
# that budget is keep running long enough for the NIC to transmit the segment.
# Spend most of it dwelling, keeping a margin for the send itself, the socket
# close and the rest of the handler. Previously only ~0.55s of the 2s was used
# (0.25s here plus 0.3s in the listener), giving the segment far less time to
# leave than Windows actually permits.
SUSPEND_BUDGET = 2.0
SUSPEND_DWELL = 1.5

# Everywhere else there is no deadline to spend and nothing racing the send,
# so the dwell only needs to cover handing the segment to a healthy NIC.
# Using SUSPEND_DWELL here would make `tv_control.py off` and the idle
# display-off path block for 1.5s to no purpose.
NORMAL_DWELL = 0.3


def warm_connect(force: bool = False) -> bool:
    """Ensure a live WebSocket to the TV is held open. Safe to call often."""
    global _warm_ws, _warm_opened_at, _warm_failure_logged, _warm_ever_up

    with _warm_lock:
        if (_warm_ws is not None and not force
                and time.time() - _warm_opened_at < WARM_MAX_AGE):
            return True

    # Build the replacement *before* discarding the current one, so there is
    # never a window where no usable socket exists - suspend can land at any
    # moment, including in the middle of a reconnect.
    ip = _read_cached_ip()
    try:
        new_ws = _open_ws(ip, timeout=3.0)
    except Exception as e:
        if not _warm_failure_logged:
            _log(f"warm connect to {ip} unavailable ({type(e).__name__}) - "
                 "retrying in background (normal while the TV is off)")
            _warm_failure_logged = True
        return False

    with _warm_lock:
        old_ws = _warm_ws
        _warm_ws = new_ws
        _warm_opened_at = time.time()
        # Routine rotations stay silent; only report first connect and
        # recovery, so the log shows state changes rather than a heartbeat.
        if _warm_failure_logged or not _warm_ever_up:
            _log(f"warm connection established to {ip}")
        _warm_failure_logged = False
        _warm_ever_up = True

    if old_ws is not None:
        try:
            old_ws.close()
        except Exception:
            pass
    return True


def _send_key_warm(key: str, dwell: float = NORMAL_DWELL) -> bool:
    """Send on the already-open socket. Returns True if it went out.

    `dwell` blocks after the write: ws.send() only copies bytes into the
    socket buffer, and when the system is suspending the NIC can go down
    before they are transmitted (observed: the send "succeeded" in 0ms and
    the TV never reacted). Windows waits for the suspend handler to return,
    so this pause buys the segment time to actually leave - and it is sized
    to use most of the ~2s Windows really grants (SUSPEND_BUDGET) instead of
    a fraction of it.
    """
    global _warm_ws
    with _warm_lock:
        ws = _warm_ws
        age = time.time() - _warm_opened_at
        if ws is None:
            _log(f"{key}: no warm connection held")
            return False
        try:
            ws.send(_key_payload(key))
            _log(f"{key} sent on warm connection (socket age {age:.1f}s)")
            time.sleep(dwell)
        except Exception as e:
            _log(f"warm send failed at socket age {age:.1f}s: "
                 f"{type(e).__name__}: {e}")
            _warm_ws = None
            return False
        # The TV drops the socket as it powers off; retire it either way.
        try:
            ws.close()
        except Exception:
            pass
        _warm_ws = None
        return True


def start_warm_keepalive(interval: float = 5.0) -> None:
    """Background thread that keeps the warm connection alive/reconnecting."""
    def loop():
        while True:
            try:
                warm_connect()
            except Exception:
                pass
            time.sleep(interval)

    threading.Thread(target=loop, daemon=True, name="tv-warm-keepalive").start()
    _log("warm keepalive thread started")


def power_off(fast: bool = True, suspending: bool = False) -> None:
    """Send the TV power key.

    fast=True skips the pre-flight REST checks. When the PC is suspending,
    the network is torn down within a second or two, and two 1.5s REST calls
    (resolve + state) reliably lose that race. Sending to an already-off TV
    is harmless: its WebSocket server is unreachable, so the attempt simply
    fails and is logged.

    suspending=True means this is running inside the PBT_APMSUSPEND handler,
    under the hard ~2s budget: dwell for most of it (SUSPEND_DWELL), and skip
    every fallback, since none of them can finish before the deadline.
    """
    set_believed_off(True)

    # Fastest path: reuse the already-open socket (~5ms). This is the only
    # path with any chance of completing while the system is suspending.
    if fast and _send_key_warm(
            "KEY_POWER", dwell=SUSPEND_DWELL if suspending else NORMAL_DWELL):
        return

    if suspending:
        # Nothing below can complete inside the remaining budget: a fresh
        # connect alone costs ~1.3s and an ARP rediscovery ~2s more, so they
        # would be interrupted mid-flight and only obscure the log. Fail fast
        # and record why - the recovery path is sleep_pc.py, which switches
        # the TV off and confirms it *before* suspend is ever requested.
        _log("power_off: no usable warm socket during suspend - skipping "
             f"fallbacks (they cannot finish within {SUSPEND_BUDGET:.0f}s)")
        return

    ip = _read_cached_ip() if fast else resolve_tv_ip()
    if not ip:
        _log("power_off: no known TV IP, skipping")
        return

    if not fast:
        state = get_state(ip)
        if state != "on":
            _log(f"power_off: TV state is '{state}', not 'on'. Skipping.")
            return

    _log(f"power_off: sending KEY_POWER to {ip} (fast={fast})")
    try:
        _send_key(ip, "KEY_POWER",
                  timeout=2.0 if fast else WS_TIMEOUT,
                  flush_wait=0.4 if fast else 1.0)
        _log("power_off: command sent OK")
        return
    except Exception as e:
        _log(f"power_off: send to {ip} failed: {type(e).__name__}: {e}")

    if fast:
        # Cached IP may be stale - resolve properly and retry once.
        resolved = resolve_tv_ip()
        if resolved and resolved != ip:
            _log(f"power_off: retrying with resolved IP {resolved}")
            try:
                _send_key(resolved, "KEY_POWER")
                _log("power_off: command sent OK on retry")
            except Exception as e:
                _log(f"power_off: retry failed: {type(e).__name__}: {e}")


def power_on() -> None:
    # Cleared unconditionally and first: whether the TV is already on or is
    # about to be woken, it is no longer "believed off", and a later power_off
    # must not be suppressed. Returning early without clearing this would
    # wedge the TV on permanently.
    set_believed_off(False)
    ip = resolve_tv_ip()
    state = get_state(ip) if ip else None
    if state == "on":
        _log("power_on: TV already on. Skipping.")
        return
    _log(f"power_on: sending Wake-on-LAN to {TV_MAC}")
    targets = [
        ("255.255.255.255", 9),
        (f"{SUBNET_PREFIX}255", 9),
        (f"{SUBNET_PREFIX}255", 7),
    ]
    if ip:
        # WiFi WoL (WoWLAN) often only wakes on a unicast packet addressed
        # to the device's own IP - APs handle broadcast frames differently
        # for sleeping stations.
        targets.append((ip, 9))

    # WiFi WoL only lands reliably if it hits the radio's periodic listen
    # window (power-save polling) - a single quick burst is often missed,
    # so we spread repeats across ~12s (empirically confirmed necessary).
    for attempt in range(6):
        for target_ip, port in targets:
            try:
                send_magic_packet(TV_MAC, ip_address=target_ip, port=port)
            except Exception as e:
                _log(f"power_on: WoL to {target_ip}:{port} failed: {e}")
        if attempt < 5:
            time.sleep(2.0)


if __name__ == "__main__":
    import sys
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    if action == "off":
        power_off()
    elif action == "on":
        power_on()
    else:
        print(f"IP: {resolve_tv_ip()}")
        print(f"State: {get_state()}")
