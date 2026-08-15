#!/usr/bin/env python3
"""Headless verification driver for the v0 geography-morph harness.

The claim the harness makes is a pixel claim: an output-area layer painted with
a coarser tier's values is not an approximation of that tier's map, it IS that
map — so the morph can swap one for the other mid-flight and nobody sees the
seam. A claim like that is worth exactly as much as the screenshots that test
it, so this drives a real browser over a real server and compares real pixels.

    python tools/morph-lab/capture_v0.py

Serves `static/` (the page needs /labs/morph/v0/, /labs/morph/d/ and
/js/deck.min.js under ONE origin), drives headless Edge or Chrome, writes
tools/morph-lab/captures/v0/ and exits non-zero if any assertion fails.

WHY THERE IS A DEVTOOLS CLIENT IN HERE
--------------------------------------
The obvious driver is `--virtual-time-budget=N --screenshot=out.png`, and for a
STILL map it works. For an animated one it cannot: virtual time stops issuing
animation frames the moment the page is briefly idle, and once stopped it never
restarts, because the only thing that would repaint the page is the frame that
is not coming. deck.gl's entire render loop is requestAnimationFrame, so under
virtual time a transition either does not run at all or is photographed halfway
through a draw — both were observed, run to run, with the same flags. The
harness reports `renders` and `ticks` in #v0meta so this is visible rather than
mysterious; see captures/v0/RESULTS.txt for what each flag set actually did.

So the boot assertion still uses --dump-dom (it is a still page and the brief's
mechanism works fine there), and everything with a moving picture in it is
driven over the DevTools protocol in REAL time instead: navigate, poll the
page's own state until it says the morph has finalised, and only then capture.
Nothing is timed by guesswork. That needs a WebSocket client and Python's
standard library has none, so there is a small one below.
"""

import argparse
import base64
import functools
import http.server
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "static"
OUT = ROOT / "tools" / "morph-lab" / "captures" / "v0"

WIDTH, HEIGHT = 1400, 950

# The lab panel lives in the top-left corner and carries a live frame-time
# readout, so it is never the same twice. Everything outside this box is map.
CROP_W, CROP_H = 420, 260

MAD_LIMIT = 2.0          # mean absolute difference per channel, 0..255
FRAC_LIMIT = 0.005       # share of pixels allowed to differ by more than...
PIXEL_DIFF = 12          # ...this, on any one channel

DURATION = 750           # the harness's default transition, in ms
WHEN = 500               # ms after ready before an auto-morph fires
MID_DUR = 3000           # a deliberately slow morph, for the mid-flight frames

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

# Tried in order until one both BOOTS the map and ANIMATES it. Real GPU first:
# it is an order of magnitude faster than SwiftShader on 26,369 extruded
# polygons, and headless Edge on Windows will use it. --disable-gpu is the
# fallback the brief suggests; recent Chrome will not expose WebGL through the
# software rasteriser without being told the risk is understood, hence the
# swiftshader variants after it.
FLAG_SETS = [
    ("real GPU", []),
    ("disable-gpu", ["--disable-gpu"]),
    ("disable-gpu + unsafe-swiftshader", ["--disable-gpu", "--enable-unsafe-swiftshader"]),
    ("angle=swiftshader + unsafe-swiftshader",
     ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
]


# ---- server -----------------------------------------------------------------
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass    # killing the browser resets its open sockets; that is not news


def serve(directory):
    handler = functools.partial(QuietHandler, directory=str(directory))
    srv = QuietServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ---- browser ----------------------------------------------------------------
def find_browser(override=None):
    if override:
        return override
    for b in BROWSERS:
        if Path(b).exists():
            return b
    sys.exit("no msedge.exe or chrome.exe found in the standard install paths")


BASE_FLAGS = [
    "--headless=new",
    "--window-size=%d,%d" % (WIDTH, HEIGHT),
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
]


def run_once(browser, flags, url, budget_ms, screenshot=None, timeout=420):
    """One throwaway browser run under --virtual-time-budget. Used only for the
    boot/DOM assertion, which is a still page and needs no frames."""
    profile = tempfile.mkdtemp(prefix="v0prof-")
    args = ([browser] + BASE_FLAGS + ["--user-data-dir=" + profile,
            "--virtual-time-budget=%d" % int(budget_ms)] + list(flags))
    args.append("--screenshot=" + str(screenshot) if screenshot else "--dump-dom")
    args.append(url)
    t0 = time.time()
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, errors="replace")
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Chrome fans out into child processes and killing the one we launched
        # leaves the rest running. Only THIS tree, by pid — never every msedge
        # on the machine, which would take the user's own browser with it.
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
        out, err = "", "[TIMEOUT after %ds]" % timeout
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    return {"dom": out, "err": err, "secs": round(time.time() - t0, 1)}


def node_text(dom, node_id):
    m = re.search(r'<div id="%s"[^>]*>(.*?)</div>' % node_id, dom, re.S)
    return m.group(1).strip() if m else ""


# ---- a very small WebSocket client ------------------------------------------
class WS:
    """Client end of RFC 6455, text frames only, enough for DevTools."""

    def __init__(self, host, port, path, timeout=120):
        self.sock = socket.create_connection((host, port), timeout=10)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key))
        self.sock.sendall(req.encode())
        self.buf = b""
        head = self._read_until(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError("websocket upgrade refused: %r" % head[:200])

    def _read_until(self, sep):
        while sep not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("devtools socket closed")
            self.buf += chunk
        i = self.buf.index(sep) + len(sep)
        head, self.buf = self.buf[:i], self.buf[i:]
        return head

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(max(65536, n - len(self.buf)))
            if not chunk:
                raise RuntimeError("devtools socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        payload = text.encode()
        n = len(payload)
        head = bytearray([0x81])                       # FIN + text
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127)
            head += struct.pack(">Q", n)
        mask = os.urandom(4)
        head += mask
        self.sock.sendall(bytes(head) +
                          bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self):
        """Next complete text message, transparently answering pings."""
        parts, op = [], None
        while True:
            b0, b1 = self._read(2)
            fin, opcode, masked, ln = b0 & 0x80, b0 & 0x0F, b1 & 0x80, b1 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if masked else None
            data = self._read(ln) if ln else b""
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:
                raise RuntimeError("devtools closed the connection")
            if opcode == 0x9:                          # ping -> pong
                self.sock.sendall(b"\x8a\x80" + os.urandom(4))
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                op = opcode
            parts.append(data)
            if fin:
                return b"".join(parts).decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


class Page:
    """One DevTools page target."""

    def __init__(self, port, timeout=120):
        self.port = port
        info = self._http("PUT", "/json/new?about:blank")
        self.target = info["id"]
        url = info["webSocketDebuggerUrl"]
        path = "/" + url.split("/", 3)[3]
        self.ws = WS("127.0.0.1", port, path, timeout=timeout)
        self.next_id = 0
        # Pin the viewport rather than trusting the window size: the page sizes
        # its camera off window.innerWidth, so every screenshot has to agree
        # about it or the maps are photographed at different zooms.
        self.call("Emulation.setDeviceMetricsOverride",
                  {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1,
                   "mobile": False})

    def _http(self, method, path):
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path),
                                     method=method)
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())

    def call(self, method, params=None):
        self.next_id += 1
        mid = self.next_id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s: %s" % (method, msg["error"]))
                return msg.get("result", {})

    def evaluate(self, expr):
        r = self.call("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True,
                       "awaitPromise": False})
        if r.get("exceptionDetails"):
            return None
        return r.get("result", {}).get("value")

    def navigate(self, url):
        self.call("Page.navigate", {"url": url})

    def screenshot(self, path):
        r = self.call("Page.captureScreenshot",
                      {"format": "png", "captureBeyondViewport": False})
        Path(path).write_bytes(base64.b64decode(r["data"]))

    def close(self):
        self.ws.close()
        try:
            self._http("GET", "/json/close/" + self.target)
        except Exception:
            pass


def wait_devtools(port, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port,
                                        timeout=2) as r:
                json.loads(r.read().decode())
                return True
        except Exception:
            time.sleep(0.25)
    return False


def launch(browser, flags, port):
    profile = tempfile.mkdtemp(prefix="v0cdp-")
    args = ([browser] + BASE_FLAGS + ["--user-data-dir=" + profile,
            "--remote-debugging-port=%d" % port] + list(flags) + ["about:blank"])
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_devtools(port):
        kill(p, profile)
        raise RuntimeError("devtools endpoint never came up on port %d" % port)
    return p, profile


def kill(p, profile):
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
    try:
        p.wait(timeout=20)
    except Exception:
        pass
    shutil.rmtree(profile, ignore_errors=True)


# ---- page state -------------------------------------------------------------
# One round trip, and it carries the URL as well as the state: a navigation is
# not instant, and without checking which document answered, a poll can be
# satisfied by the PREVIOUS shot's finished morph still sitting on screen.
STATE_JS = """JSON.stringify({
  q: location.search,
  s: (document.getElementById('v0status')||{}).textContent || '',
  m: (document.getElementById('v0meta')||{}).textContent || '',
  e: (document.getElementById('v0err')||{}).textContent || ''
})"""

_nav_seq = [0]


def nav(page, base, query):
    """Navigate, and return the token that identifies THIS document."""
    _nav_seq[0] += 1
    token = "_n=%d" % _nav_seq[0]
    sep = "&" if "?" in query else "?"
    page.navigate(base + query + sep + token)
    return token


def poll(page, token, want, timeout=180, every=0.05):
    """Poll the page's own state until `want(status, meta)` is true on the
    document identified by `token`. Also returns the page's #v0err text as it
    stood at the last read, so callers can report a page error even when
    `want` itself never keyed off it."""
    end = time.time() + timeout
    st = mt = {}
    err = ""
    while time.time() < end:
        try:
            raw = json.loads(page.evaluate(STATE_JS) or "{}")
            if token in (raw.get("q") or ""):
                st = json.loads(raw.get("s") or "{}")
                mt = json.loads(raw.get("m") or "{}")
                err = raw.get("e") or ""
                if want(st, mt):
                    return True, st, mt, err
        except Exception:
            pass
        time.sleep(every)
    return False, st, mt, err


def is_ready(st, mt):
    return bool(st.get("ready"))


def finalised(st, mt):
    return bool(st.get("ready")) and any(
        s.startswith("finalise") for s in (mt.get("log") or []))


# ---- pixels -----------------------------------------------------------------
def diff(path_a, path_b):
    """Per-pixel absolute difference outside the control-panel corner."""
    a = np.asarray(Image.open(path_a).convert("RGB"), dtype=np.int16)
    b = np.asarray(Image.open(path_b).convert("RGB"), dtype=np.int16)
    if a.shape != b.shape:
        return None
    keep = np.ones(a.shape[:2], dtype=bool)
    keep[:CROP_H, :CROP_W] = False          # the control panel / HUD corner
    return np.abs(a - b)[keep]


def mad_of(path_a, path_b):
    d = diff(path_a, path_b)
    return float(d.mean()) if d is not None else float("nan")


def compare(path_a, path_b, label, log):
    d = diff(path_a, path_b)
    if d is None:
        log("FAIL %s: image sizes differ" % label)
        return False
    mad = float(d.mean())
    worst = int(d.max())
    over = d.max(axis=1) > PIXEL_DIFF
    frac = float(over.mean())
    ok = mad <= MAD_LIMIT and frac <= FRAC_LIMIT
    log("%s %s vs %s" % ("PASS" if ok else "FAIL", Path(path_a).name, Path(path_b).name))
    log("     %s" % label)
    log("     MAD %.4f/255 (limit %.1f)   pixels >%d/255: %d of %d = %.4f%% "
        "(limit %.1f%%)   max channel diff %d"
        % (mad, MAD_LIMIT, PIXEL_DIFF, int(over.sum()), over.size,
           100 * frac, 100 * FRAC_LIMIT, worst))
    return ok


# The endpoint assertions prove the morph LANDS in the right place. They would
# pass just as well if it teleported there, which is exactly what an earlier
# build did. This is the assertion that the morph SLIDES: three frames sampled
# across one transition have to sit strictly between the two endpoints and in
# order. Progress is measured in pixel space — how far each frame has travelled
# from the borough map towards the ward map — which is not linear in the value
# space the easing acts on, hence the generous bands.
P25_FLOOR = 0.01        # by a quarter of the way through, something has moved
P50_BAND = (0.15, 0.85)  # half way through, genuinely part way across
P75_CEIL = 0.999        # three quarters through, not already finished


def progression(log):
    start, end = OUT / "s1_show_borough.png", OUT / "s3_show_ward.png"
    span = mad_of(start, end)
    log("---- mid-flight progression: does the morph SLIDE? ----")
    log("     borough and ward are %.4f/255 apart" % span)
    p = {}
    for frac in (25, 50, 75):
        f = OUT / ("mid_%d.png" % frac)
        da, db = mad_of(f, start), mad_of(f, end)
        p[frac] = da / span if span else 0.0
        log("     mid_%d  %7.4f from the borough start, %7.4f from the ward end"
            "   -> %6.2f%% across" % (frac, da, db, 100 * p[frac]))
    checks = [
        ("strictly increasing", p[25] < p[50] < p[75]),
        ("p25 >= %.1f%%" % (100 * P25_FLOOR), p[25] >= P25_FLOOR),
        ("p50 within %.0f-%.0f%%" % (100 * P50_BAND[0], 100 * P50_BAND[1]),
         P50_BAND[0] <= p[50] <= P50_BAND[1]),
        ("p75 <= %.1f%%" % (100 * P75_CEIL), p[75] <= P75_CEIL),
    ]
    ok = all(c[1] for c in checks)
    for name, good in checks:
        log("     %s %s" % ("pass" if good else "FAIL", name))
    log("%s the morph interpolates: %.2f%% -> %.2f%% -> %.2f%%"
        % ("PASS" if ok else "FAIL", 100 * p[25], 100 * p[50], 100 * p[75]))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", help="path to msedge.exe / chrome.exe")
    ap.add_argument("--duration", type=int, default=DURATION)
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    lines = []

    def log(s=""):
        print(s, flush=True)
        lines.append(s)

    browser = find_browser(args.browser)
    srv, port = serve(STATIC)
    base = "http://127.0.0.1:%d/labs/morph/v0/" % port
    dur = args.duration
    log("driver     %s" % Path(__file__).name)
    log("browser    %s" % browser)
    log("serving    %s  ->  %s" % (STATIC, base))
    log("")

    ok_all = True
    proc = profile = None
    try:
        # ---- 1. BOOT, the brief's own mechanism: one --dump-dom run per flag
        # set until the page reports itself up with no errors.
        chosen = None
        for name, flags in FLAG_SETS:
            r = run_once(browser, flags, base + "?show=borough", 20000)
            raw = node_text(r["dom"], "v0status")
            errs = node_text(r["dom"], "v0err")
            log("boot probe  [%-38s] %s  (%ss)" % (name, raw or "<no status node>", r["secs"]))
            if errs:
                log("            page errors: %s" % errs)
            try:
                st = json.loads(raw)
            except Exception:
                continue
            if not (st.get("ready") and st.get("errors") == 0):
                continue

            # ---- 2. FRAMES. Booting is not animating: this flag set has to be
            # able to run a morph to finalise, over the protocol, in real time.
            dport = free_port()
            p, prof = launch(browser, flags, dport)
            try:
                pg = Page(dport)
                tok = nav(pg, base, "?morph=borough:ward&when=%d" % WHEN)
                got, st2, mt2, err2 = poll(pg, tok, finalised, timeout=120)
                log("morph probe [%-38s] %s" % (name, json.dumps(mt2)[:220]))
                if err2:
                    log("            page errors: %s" % err2)
                pg.close()
            finally:
                kill(p, prof)
            if not got:
                log("            no finalise: this flag set boots but does not animate")
                continue
            chosen = (name, flags, raw)
            break

        if not chosen:
            log("")
            log("FAIL: no flag set both booted the page and ran a morph to finalise")
            return 1
        name, flags, boot_raw = chosen
        log("")
        log("PASS boot   --dump-dom of ?show=borough -> %s" % boot_raw)
        log("PASS frames a morph reaches finalise under [%s]" % name)
        log("")

        # ---- 3. captures, all through one browser, one page, in real time.
        dport = free_port()
        proc, profile = launch(browser, flags, dport)
        page = Page(dport)

        def shot(fname, query, wait_for, label, settle=0.35):
            path = OUT / fname
            if path.exists():
                path.unlink()
            t0 = time.time()
            tok = nav(page, base, query)
            got, st, mt, err = poll(page, tok, wait_for, timeout=180)
            time.sleep(settle)
            page.screenshot(path)
            ok = got and st.get("errors") == 0
            status_word = "ok" if ok else ("STATE NOT REACHED" if not got else "PAGE ERROR")
            log("shot %-28s %-34s %5.1fs  %s"
                % (fname, label, time.time() - t0, status_word))
            log("     %s" % json.dumps({"status": st, "log": mt.get("log")}))
            if not ok:
                log("     page errors (#v0err): %s" % (err or "<empty>"))
            return ok

        ok_all &= shot("s1_show_borough.png", "?show=borough", is_ready, "borough tier, true values")
        ok_all &= shot("s2_plateau_oa_borough.png", "?plateau=oa:borough", is_ready,
                       "OA basis, borough values")
        ok_all &= shot("s3_show_ward.png", "?show=ward", is_ready, "ward tier, true values")
        ok_all &= shot("s4_morph_borough_ward.png",
                       "?morph=borough:ward&when=%d" % WHEN, finalised,
                       "borough->ward, after finalise")
        ok_all &= shot("s5_show_gla.png", "?show=gla", is_ready, "gla tier, true values")
        ok_all &= shot("s6_morph_pcon_gla.png",
                       "?morph=pcon:gla&when=%d" % WHEN, finalised,
                       "pcon->gla, after finalise")

        # Mid-flight frames — the evidence for the progression assertion, and
        # the only pictures here a human would enjoy. Run at a deliberately slow
        # MID_DUR so the capture round trip (~0.2 s) is a small share of the
        # transition and the sampled fractions mean something.
        for frac in (0.25, 0.50, 0.75):
            fname = "mid_%d.png" % int(frac * 100)
            path = OUT / fname
            if path.exists():
                path.unlink()
            t0 = time.time()
            tok = nav(page, base, "?morph=borough:ward&when=%d&dur=%d" % (WHEN, MID_DUR))
            got, st, mt, err = poll(page, tok, lambda s, m: any(
                x.startswith("animate") for x in (m.get("log") or [])), timeout=180)
            time.sleep(max(0.0, frac * MID_DUR / 1000.0 - 0.10))
            page.screenshot(path)
            ok = got and st.get("errors") == 0
            ok_all &= ok
            status_word = "ok" if ok else ("ANIMATE NOT REACHED" if not got else "PAGE ERROR")
            log("shot %-28s %-34s %5.1fs  %s"
                % (fname, "%d%% of a %d ms morph" % (frac * 100, MID_DUR),
                   time.time() - t0, status_word))
            if not ok:
                log("     %s" % json.dumps({"status": st, "log": mt.get("log")}))
                log("     page errors (#v0err): %s" % (err or "<empty>"))

        page.close()

        log("")
        log("---- assertions ----")
        ok_all &= compare(OUT / "s1_show_borough.png", OUT / "s2_plateau_oa_borough.png",
                          "the plateau claim: 26,369 output areas painted with their "
                          "borough's value == the 33-borough map", log)
        log("")
        ok_all &= compare(OUT / "s3_show_ward.png", OUT / "s4_morph_borough_ward.png",
                          "nested pair: borough->ward morph lands exactly on the ward map",
                          log)
        log("")
        ok_all &= compare(OUT / "s5_show_gla.png", OUT / "s6_morph_pcon_gla.png",
                          "non-nested pair: pcon->gla morph lands exactly on the "
                          "Assembly-seat map", log)
        log("")
        ok_all &= progression(log)
        log("")
        log("RESULT %s" % ("ALL ASSERTIONS PASS" if ok_all else "FAILED"))
    finally:
        if proc:
            kill(proc, profile)
        srv.shutdown()
        (OUT / "RESULTS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
