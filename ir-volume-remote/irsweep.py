#!/usr/bin/env python3
"""Sweep IR codes from a Poco phone over adb (ConsumerIrService via `service call`).

Each code is sent as a "held button" for --hold seconds (frame + repeats).
One transmit call is capped at 2 s by Android, so longer holds use several calls.

Order (codes list index is stable, so --start resumes):
  1. NEC, address 0x00, all 256 commands
  2. RC5, 32 addresses x 64 commands
  3. Sony SIRC 12-bit, 32 addresses x 128 commands
  4. NEC, addresses 0x01-0xFF, all commands

Log: one CSV line per code (local time, index, protocol, address, command, result).
"""
import argparse
import datetime
import os
import re
import subprocess
import sys
import time

MAX_CALL_US = 1_950_000  # Android rejects patterns over 2 s ("IR pattern too long")


# ---------- encoders: return (carrier_hz, frame_pattern_us, repeat_pattern_us) ----------
# Every pattern starts with a mark (on) and ends with a space (off) that pads to the period.

def nec(addr, cmd):
    bits = []
    for byte in (addr, addr ^ 0xFF, cmd, cmd ^ 0xFF):
        bits += [(byte >> i) & 1 for i in range(8)]  # LSB first
    p = [9000, 4500]
    for b in bits:
        p += [562, 1687 if b else 562]
    p += [562]
    p += [108000 - sum(p)]
    rep = [9000, 2250, 562]
    rep += [108000 - sum(rep)]
    return 38000, p, rep


def rc5(addr, cmd, toggle):
    bits = [1, 1, toggle] + [(addr >> i) & 1 for i in range(4, -1, -1)] \
        + [(cmd >> i) & 1 for i in range(5, -1, -1)]
    halves = []
    for b in bits:  # Manchester: 1 = space,mark ; 0 = mark,space
        halves += [0, 1] if b else [1, 0]
    while halves[0] == 0:
        halves.pop(0)
    p = []
    level, run = halves[0], 0
    for h in halves:
        if h == level:
            run += 889
        else:
            p.append(run)
            level, run = h, 889
    p.append(run)
    if level == 1:
        p.append(113778 - sum(p))
    else:
        p[-1] += 113778 - sum(p)
    return 36000, p, p


def sirc12(addr, cmd):
    bits = [(cmd >> i) & 1 for i in range(7)] + [(addr >> i) & 1 for i in range(5)]
    p = [2400, 600]
    for b in bits:
        p += [1200 if b else 600, 600]
    p[-1] += 45000 - sum(p)
    return 40000, p, p


# ---------- code list ----------

def build_codes():
    codes = []
    for c in range(256):
        codes.append(("NEC", 0, c))
    for a in range(32):
        for c in range(64):
            codes.append(("RC5", a, c))
    for a in range(32):
        for c in range(128):
            codes.append(("SIRC12", a, c))
    for a in range(1, 256):
        for c in range(256):
            codes.append(("NEC", a, c))
    return codes


def hold_calls(proto, addr, cmd, idx, hold_s):
    """Split a held press into transmit calls, each under MAX_CALL_US."""
    if proto == "NEC":
        freq, frame, rep = nec(addr, cmd)
    elif proto == "RC5":
        freq, frame, rep = rc5(addr, cmd, idx & 1)
    else:
        freq, frame, rep = sirc12(addr, cmd)
    total_us = int(hold_s * 1_000_000)
    calls, cur, sent = [], list(frame), sum(frame)
    while sent + sum(rep) <= total_us:
        if sum(cur) + sum(rep) > MAX_CALL_US:
            calls.append(cur)
            cur = []
        cur += rep
        sent += sum(rep)
    if cur:
        calls.append(cur)
    return freq, calls


def shell_cmd(freq, pattern):
    return ("service call consumer_ir 2 s16 com.android.shell i32 %d i32 %d %s"
            % (freq, len(pattern), " ".join("i32 %d" % v for v in pattern)))


class Phone:
    def __init__(self, serial):
        self.serial = serial
        self.proc = None
        self.seq = 0

    def open(self):
        args = ["adb"] + (["-s", self.serial] if self.serial else []) + ["shell"]
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, bufsize=1)

    def run(self, line):
        """Run one command in the persistent shell; return its output."""
        self.seq += 1
        mark = "__END_%d__" % self.seq
        self.proc.stdin.write("%s 2>&1; echo %s\n" % (line, mark))
        self.proc.stdin.flush()
        out = []
        while True:
            l = self.proc.stdout.readline()
            if not l:
                raise ConnectionError("adb shell closed")
            if l.strip() == mark:
                return "".join(out)
            out.append(l)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hold", type=float, default=1.0, help="seconds per code")
    ap.add_argument("--start", type=int, default=0, help="first code index")
    ap.add_argument("--end", type=int, default=None, help="last code index (inclusive)")
    ap.add_argument("--gap", type=float, default=0.3, help="pause between codes, s")
    ap.add_argument("--log", required=True)
    ap.add_argument("--serial", default=None)
    ap.add_argument("--only", default=None, help="comma list of code indices, in send order")
    ap.add_argument("--dry-run", action="store_true", help="print patterns, send nothing")
    a = ap.parse_args()

    codes = build_codes()
    end = len(codes) - 1 if a.end is None else min(a.end, len(codes) - 1)

    order = [int(x, 0) for x in a.only.split(",")] if a.only else list(range(a.start, end + 1))

    if a.dry_run:
        for i in order:
            proto, addr, cmd = codes[i]
            freq, calls = hold_calls(proto, addr, cmd, i, a.hold)
            print(i, proto, hex(addr), hex(cmd), freq, [sum(c) for c in calls], calls[0][:12])
        return

    phone = Phone(a.serial)
    phone.open()
    state_path = a.log + ".state"
    with open(a.log, "a") as log:
        log.write("# start %s hold=%.2fs range=%d-%d of %d\n"
                  % (datetime.datetime.now().isoformat(timespec="seconds"), a.hold, a.start, end, len(codes)))
        log.flush()
        k = 0
        fails = 0
        while k < len(order):
            i = order[k]
            proto, addr, cmd = codes[i]
            freq, calls = hold_calls(proto, addr, cmd, i, a.hold)
            ts = datetime.datetime.now().strftime("%H:%M:%S")
            try:
                ok = True
                for c in calls:
                    out = phone.run(shell_cmd(freq, c))
                    if not re.search(r"Parcel\(\s*00000000\s+'", out):
                        ok = False
                        err = " ".join(out.split())[:200]
                        break
            except ConnectionError as e:
                log.write("# %s adb lost at index %d: %s; retrying in 10 s\n" % (ts, i, e))
                log.flush()
                time.sleep(10)
                phone.open()
                continue
            if not ok:
                fails += 1
                log.write("%s,%d,%s,0x%02X,0x%02X,FAIL %s\n" % (ts, i, proto, addr, cmd, err))
                log.flush()
                if fails >= 5:
                    log.write("# stopping: 5 failed transmits in a row\n")
                    sys.exit(2)
                continue
            fails = 0
            log.write("%s,%d,%s,0x%02X,0x%02X,ok\n" % (ts, i, proto, addr, cmd))
            log.flush()
            with open(state_path, "w") as s:
                s.write("%d\n" % i)
            k += 1
            time.sleep(a.gap)
        log.write("# done %s\n" % datetime.datetime.now().isoformat(timespec="seconds"))


if __name__ == "__main__":
    main()
