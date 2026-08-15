#!/usr/bin/env python3
"""Headless verification driver for v1 — the full census map with the curtain
replaced by the geography morph.

v0 proved the morph in isolation. v1 is the production page with one path
swapped, so what has to be proved here is different: that the morph LANDS
exactly where the production page lands, through the real controls, under every
mode the page has — and that nothing else about the page changed.

    python tools/morph-lab/capture_v1.py

Serves `static/` (the page needs /labs/morph/v1/, /labs/morph/d/ and
/js/deck.min.js under ONE origin), drives Chrome (or Edge, via --browser) over
the DevTools protocol in real time, writes tools/morph-lab/captures/v1/ and
exits non-zero if any assertion fails.

WHY CHROME BY DEFAULT, AND WHY EVERYTHING GOES OVER CDP
------------------------------------------------------
v0's driver kept a `--dump-dom` boot probe because the brief suggested it and
it worked. On this machine it no longer does: the installed Edge no-ops
one-shot CLI automation flags (`--dump-dom`, `--screenshot`) outside the
DevTools protocol, returning empty stdout in ~0.05 s, while the same flags on
Chrome work. That was diagnosed in the v0 report and is environmental. So this
driver has one mechanism instead of two — navigate, poll the page's own state
until it says what we are waiting for has happened, then capture — and
BROWSERS lists Chrome first.

Virtual time is not used at all, for the reason v0 documented: it stops issuing
animation frames the moment the page is briefly idle and never restarts, and
deck.gl's entire render loop is requestAnimationFrame.

WHAT IS COMPARED
----------------
Full frames, uncropped. The lab's three status nodes are display:none and its
HUD is off unless ?hud=1, so unlike v0 there is no panel to crop around: every
endpoint assertion below compares the whole 1400x950 picture, production chrome
included. Two assertions need a reference that is NOT simply "the same page
loaded directly", and both say why where they are made (A4 and A6).

Nothing is timed by guesswork. The page publishes its own clock and the morph's
zero on it, so a mid-flight frame is taken against an absolute deadline and the
fraction it actually landed on is measured and printed rather than assumed.
"""

import argparse
import base64
import functools
import http.server
import io
import json
import os
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
OUT = ROOT / "tools" / "morph-lab" / "captures" / "v1"

WIDTH, HEIGHT = 1400, 950

MAD_LIMIT = 2.0          # mean absolute difference per channel, 0..255
FRAC_LIMIT = 0.005       # share of pixels allowed to differ by more than...
PIXEL_DIFF = 12          # ...this, on any one channel

MID_DUR = 3000           # a deliberately slow morph, for the mid-flight frames
# Seconds after a state is reached before capturing. The peak-marker pulse runs
# for PULSE_LEAD + PULSE_TOTAL + 60 = 1.01 s after any paint and then draws one
# clean frame without it; every committed capture waits that out, so the pulse
# is never in a picture and never has to be suppressed to make two frames agree.
SETTLE = 1.6

# Chrome first: see the module docstring.
BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

# Tried in order until one both BOOTS the map and MORPHS it. Real GPU first: it
# is an order of magnitude faster than SwiftShader on 26,369 extruded polygons.
FLAG_SETS = [
    ("real GPU", []),
    ("disable-gpu", ["--disable-gpu"]),
    ("disable-gpu + unsafe-swiftshader", ["--disable-gpu", "--enable-unsafe-swiftshader"]),
    ("angle=swiftshader + unsafe-swiftshader",
     ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
]

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

# THE SUPPRESSION MEASURE, chosen by inspecting the data rather than guessing.
# `resident_under5y` is a share of `nonukborn`, whose minBase of 30 suppresses
# 294 of the 26,369 output areas in 2021 (1.11%) and 1,729 in 2011 — and
# NOTHING at ward, borough, constituency or Assembly-seat grain, where the
# denominator runs to tens of thousands. That is why the suppression run below
# is lsoa->oa and not the brief's borough->ward: at borough and ward there is
# no suppressed area at either end, on any measure the page ships, so that pair
# would have tested nothing. See the report for the full per-tier counts.
SUPP_M = "resident_under5y"
# Same GROUP as the default measure, so a measure change does not also rebuild
# the switcher row and move chrome pixels underneath the assertion.
MEAS2 = "hh_density"


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


def find_browser(override=None):
    if override:
        return override
    for b in BROWSERS:
        if Path(b).exists():
            return b
    sys.exit("no chrome.exe or msedge.exe found in the standard install paths")


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
        parts = []
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

    def evaluate(self, expr, await_promise=False):
        r = self.call("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True,
                       "awaitPromise": bool(await_promise)})
        if r.get("exceptionDetails"):
            return None
        return r.get("result", {}).get("value")

    def navigate(self, url):
        self.call("Page.navigate", {"url": url})

    def reduced_motion(self, on):
        """CDP media emulation, so the reduced-motion path can be asserted
        rather than left to the reader's eye. Set before navigation: the page
        reads matchMedia once, at parse time."""
        feats = [{"name": "prefers-reduced-motion", "value": "reduce"}] if on else []
        self.call("Emulation.setEmulatedMedia", {"features": feats})

    def shot_bytes(self):
        r = self.call("Page.captureScreenshot",
                      {"format": "png", "captureBeyondViewport": False})
        return base64.b64decode(r["data"])

    def screenshot(self, path):
        Path(path).write_bytes(self.shot_bytes())

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
    profile = tempfile.mkdtemp(prefix="v1cdp-")
    args = ([browser] + BASE_FLAGS + ["--user-data-dir=" + profile,
            "--remote-debugging-port=%d" % port] + list(flags) + ["about:blank"])
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_devtools(port):
        kill(p, profile)
        raise RuntimeError("devtools endpoint never came up on port %d" % port)
    return p, profile


def kill(p, profile):
    # Chrome fans out into child processes and killing the one we launched
    # leaves the rest running. Only THIS tree, by pid — never every chrome on
    # the machine, which would take the user's own browser with it.
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
#
# __NG_ERROR__ is read alongside the lab's own error list because the two catch
# different things: the lab counts what reaches window.onerror and
# unhandledrejection, while a data-load failure inside apply() is CAUGHT by
# production and only leaves its message there. A driver that watched one and
# not the other could photograph an error page and call it a pass.
STATE_JS = """JSON.stringify({
  q: location.search,
  s: (document.getElementById('v1status')||{}).textContent || '',
  m: (document.getElementById('v1meta')||{}).textContent || '',
  e: (document.getElementById('v1err')||{}).textContent || '',
  x: String(window.__NG_ERROR__ || '')
})"""

_nav_seq = [0]


class Nav:
    """A navigated document, and the polling that goes with it."""

    def __init__(self, page, base, query):
        _nav_seq[0] += 1
        self.page = page
        self.token = "_n=%d" % _nav_seq[0]
        sep = "&" if "?" in query else "?"
        self.url = base + query + sep + self.token
        self.err = ""
        self.ng_err = ""
        page.navigate(self.url)

    def read(self):
        """(status, meta) for THIS document, or (None, None) if another one is
        still answering."""
        try:
            raw = json.loads(self.page.evaluate(STATE_JS) or "{}")
        except Exception:
            return None, None
        if self.token not in (raw.get("q") or ""):
            return None, None
        self.err = raw.get("e") or ""
        self.ng_err = raw.get("x") or ""
        try:
            return json.loads(raw.get("s") or "{}"), json.loads(raw.get("m") or "{}")
        except Exception:
            return None, None

    def poll(self, want, timeout=180, every=0.04):
        end = time.time() + timeout
        st = mt = {}
        while time.time() < end:
            s, m = self.read()
            if s is not None:
                st, mt = s, m
                if want(st, mt):
                    return True, st, mt
            time.sleep(every)
        return False, st, mt

    def js(self, expr, await_promise=False):
        return self.page.evaluate(expr, await_promise)

    def clock(self):
        """The page's own performance.now(), to the millisecond. Polling the
        meta node instead would quantise to its 100 ms refresh."""
        v = self.page.evaluate("Math.round(performance.now())")
        return v if isinstance(v, (int, float)) else 0

    def wait_clock(self, deadline, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            if self.clock() >= deadline:
                return True
            time.sleep(0.005)
        return False

    # The area pills call setArea(t).then(ok, fail) — handlers on both arms.
    # Mirroring that exactly matters: an unhandled rejection here would be
    # counted as a page error that a real click would never have produced.
    def set_area(self, t):
        self.js('window.__setArea("%s").then(function(){},function(){}); 0' % t)


def is_ready(st, mt):
    return bool(st.get("ready"))


def morph_capable(st, mt):
    """Booted, drawn, and the basis is warm. Until then every switch takes the
    curtain BY DESIGN, so a driver that switched before this would be testing
    the curtain and calling it a morph."""
    return bool(st.get("ready")) and bool(st.get("morphReady"))


def settled(st, mt):
    """A morph has handed back: basis retired, no hand-off in flight, drawn."""
    return (bool(st.get("ready")) and not st.get("morphBasis")
            and not st.get("switching"))


def logged(prefix):
    return lambda st, mt: any(x.startswith(prefix) for x in (mt.get("log") or []))


def done_morphing(st, mt):
    return settled(st, mt) and logged("finalise")(st, mt)


def log_at(mt, prefix):
    """Page-clock time of a logged morph phase, from `t0` plus its own offset."""
    for x in (mt.get("log") or []):
        if x.startswith(prefix):
            return (mt.get("t0") or 0) + int(x.split("+")[1])
    return None


# ---- pixels -----------------------------------------------------------------
def img(src):
    if isinstance(src, (bytes, bytearray)):
        return np.asarray(Image.open(io.BytesIO(src)).convert("RGB"), dtype=np.int16)
    return np.asarray(Image.open(src).convert("RGB"), dtype=np.int16)


def diff(a, b):
    a, b = img(a), img(b)
    if a.shape != b.shape:
        return None
    return np.abs(a - b)


def mad_of(a, b):
    d = diff(a, b)
    return float(d.mean()) if d is not None else float("nan")


def name_of(x, given):
    if given:
        return given
    return "<memory>" if isinstance(x, (bytes, bytearray)) else Path(x).name


def compare(a, b, label, log, name_a=None, name_b=None):
    d = diff(a, b)
    na, nb = name_of(a, name_a), name_of(b, name_b)
    if d is None:
        log("FAIL %s vs %s: image sizes differ" % (na, nb))
        return False
    mad = float(d.mean())
    worst = int(d.max())
    over = d.max(axis=2) > PIXEL_DIFF
    frac = float(over.mean())
    ok = mad <= MAD_LIMIT and frac <= FRAC_LIMIT
    log("%s %s vs %s" % ("PASS" if ok else "FAIL", na, nb))
    log("     %s" % label)
    log("     MAD %.4f/255 (limit %.1f)   pixels >%d/255: %d of %d = %.4f%% "
        "(limit %.1f%%)   max channel diff %d"
        % (mad, MAD_LIMIT, PIXEL_DIFF, int(over.sum()), over.size,
           100 * frac, 100 * FRAC_LIMIT, worst))
    return ok


def progress_of(frame, start, end):
    """How far `frame` has travelled from `start` towards `end`, in pixel
    space. Not linear in the value space the easing acts on, hence the generous
    bands wherever this is asserted against."""
    span = mad_of(start, end)
    return (mad_of(frame, start) / span) if span else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", help="path to chrome.exe / msedge.exe")
    ap.add_argument("--mid-dur", type=int, default=MID_DUR)
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    lines = []

    def log(s=""):
        print(s, flush=True)
        lines.append(s)

    browser = find_browser(args.browser)
    srv, port = serve(STATIC)
    base = "http://127.0.0.1:%d/labs/morph/v1/" % port
    slow = args.mid_dur
    log("driver     %s" % Path(__file__).name)
    log("browser    %s" % browser)
    log("serving    %s  ->  %s" % (STATIC, base))
    log("viewport   %dx%d, FULL-FRAME comparison — no crop, because the lab's "
        "status nodes are" % (WIDTH, HEIGHT))
    log("           display:none and the HUD is off unless ?hud=1")
    log("settle     %.1fs before every committed capture, which outlasts the "
        "1.01s peak pulse" % SETTLE)
    log("")

    ok_all = True
    proc = profile = None
    try:
        # ---- flag-set probe -------------------------------------------------
        chosen = None
        for name, flags in FLAG_SETS:
            dport = free_port()
            try:
                p, prof = launch(browser, flags, dport)
            except Exception as e:
                log("probe [%-38s] launch failed: %s" % (name, e))
                continue
            try:
                pg = Page(dport)
                n = Nav(pg, base, "?tier=borough")
                got, st, mt = n.poll(morph_capable, timeout=90)
                log("probe [%-38s] boot  %s" % (name, json.dumps(st)))
                if got:
                    n.set_area("ward")
                    got2, st2, mt2 = n.poll(done_morphing, timeout=60)
                    log("       %-37s morph %s"
                        % ("", json.dumps(mt2.get("log"))))
                    if got2 and st2.get("errors") == 0:
                        chosen = (name, flags)
                pg.close()
            finally:
                kill(p, prof)
            if chosen:
                break

        if not chosen:
            log("")
            log("FAIL: no flag set both booted the page and ran a morph to finalise")
            return 1
        name, flags = chosen
        log("")
        log("PASS probe  boots and morphs to finalise under [%s]" % name)
        log("")

        # ---- captures, all through one browser, one page, in real time ------
        dport = free_port()
        proc, profile = launch(browser, flags, dport)
        page = Page(dport)

        def check(nav, st, got, what):
            """Every capture asserts the page reported no errors, as v0's does,
            and additionally that apply() did not catch one."""
            ok = bool(got) and st.get("errors") == 0 and not nav.ng_err
            if not ok:
                log("     %s: %s" % (what, "STATE NOT REACHED" if not got
                                     else "PAGE ERRORS"))
                log("     status %s" % json.dumps(st))
                log("     page errors (#v1err): %s" % (nav.err or "<empty>"))
                log("     __NG_ERROR__:         %s" % (nav.ng_err or "<empty>"))
            return ok

        def direct(fname, query, label):
            """A reference: the page loaded straight into a state, no switch."""
            t0 = time.time()
            n = Nav(page, base, query)
            got, st, mt = n.poll(is_ready, timeout=180)
            time.sleep(SETTLE)
            page.screenshot(OUT / fname)
            ok = check(n, st, got, fname)
            log("shot %-24s %-44s %5.1fs  %s"
                % (fname, label, time.time() - t0, "ok" if ok else "FAILED"))
            return ok

        def switch(query, area, label, fname=None, before=None):
            """Boot, wait until the morph is genuinely available, then take the
            REAL pill path and wait for the hand-off to finish."""
            t0 = time.time()
            n = Nav(page, base, query)
            got, st, mt = n.poll(morph_capable, timeout=180)
            if not got:
                check(n, st, got, fname or label)
                log("shot %-24s %-44s %5.1fs  BOOT FAILED"
                    % (fname or "-", label, time.time() - t0))
                return False
            if before:
                before(n)
            n.set_area(area)
            got, st, mt = n.poll(done_morphing, timeout=120)
            time.sleep(SETTLE)
            if fname:
                page.screenshot(OUT / fname)
            ok = check(n, st, got, fname or label)
            log("shot %-24s %-44s %5.1fs  %s"
                % (fname or "-", label, time.time() - t0, "ok" if ok else "FAILED"))
            log("     %s" % json.dumps({"status": st, "log": mt.get("log")}))
            return ok

        log("---- captures ----")

        # A1. Boot the curtain build. Doubles as the borough reference, which
        #     is the destination of the merge-direction morph below.
        ok_a1 = direct("a1_ref_borough.png", "?tier=borough&morph=0",
                       "A1 boot ?morph=0, curtain build sanity")
        ok_all &= ok_a1

        # A2. The default boot (zoom-driven pair, so lsoa) morphed to ward
        #     through __setArea, against a ward loaded directly.
        ok_all &= direct("a2_ref_ward.png", "?tier=ward&morph=0",
                         "A2 ward, loaded directly")
        ok_all &= switch("", "ward", "A2 default boot -> ward, morphed",
                         "a2_morph_ward.png")

        # A3. Non-nested pair, and the merge direction.
        ok_all &= direct("a3_ref_gla.png", "?tier=gla&morph=0",
                         "A3 gla, loaded directly")
        ok_all &= switch("?tier=pcon", "gla", "A3 pcon -> gla (non-nested)",
                         "a3_morph_gla.png")
        ok_all &= switch("?tier=ward", "borough", "A3 ward -> borough (merge)",
                         "a3_morph_borough.png")

        # A4. Mid-flight progression, on a deliberately slow morph.
        #
        #     THE "FROM" REFERENCE IS TAKEN FROM THE RUN ITSELF, at the seed,
        #     and that is the whole answer to the ~24% floor v0's report
        #     documented. Two things change the instant the pill is clicked and
        #     before one pixel of the morph has moved: the borough outlines come
        #     ON (`tier` is already ward, and buildStack's outline rule keys on
        #     it), and the card, legend and pill row switch to ward. A
        #     separately loaded ?tier=borough frame has neither, so every mid
        #     frame differs from it by a constant that has nothing to do with
        #     the morph — which is exactly the floor v0 measured. The seed frame
        #     has both and is otherwise the borough map exactly: that is what
        #     the seed IS, and it is the honest zero.
        #
        #     It is caught by polling for the "seed" log entry, which the page
        #     writes after the seed redraw and two committed frames before the
        #     animation starts. Even a late catch costs almost nothing: the
        #     easing is cubic-in-out, so 100 ms into a 3,000 ms morph is 0.015%
        #     of the distance.
        log("")
        t0 = time.time()
        n4 = Nav(page, base, "?tier=borough&morphdur=%d" % slow)
        got, st, mt = n4.poll(morph_capable, timeout=180)
        ok_all &= check(n4, st, got, "a4 boot")
        n4.set_area("ward")
        got, st, mt = n4.poll(logged("seed"), timeout=60)
        page.screenshot(OUT / "a4_from.png")
        ok_a4boot = check(n4, st, got, "a4_from.png")
        ok_all &= ok_a4boot
        log("shot %-24s %-44s %5.1fs  %s"
            % ("a4_from.png", "A4 seed frame — the honest zero",
               time.time() - t0, "ok" if ok_a4boot else "FAILED"))

        got, st, mt = n4.poll(logged("animate"), timeout=60)
        ok_all &= check(n4, st, got, "a4 animate")
        anim_at = log_at(mt, "animate") or n4.clock()
        sampled = {}
        for frac in (25, 50, 75):
            n4.wait_clock(anim_at + slow * frac / 100.0)
            before = n4.clock()
            page.screenshot(OUT / ("a4_mid%d.png" % frac))
            after = n4.clock()
            sampled[frac] = 100.0 * ((before + after) / 2.0 - anim_at) / slow
            log("shot %-24s %-44s        landed at %.1f%% of a %d ms morph"
                % ("a4_mid%d.png" % frac, "A4 mid-flight", sampled[frac], slow))
        got, st, mt = n4.poll(done_morphing, timeout=120)
        ok_all &= check(n4, st, got, "a4 finalise")

        # A5. Interrupt. A second switch 300 ms into the first, landing on ward
        #     so the reference is one already captured rather than a new file.
        log("")
        t0 = time.time()
        n5 = Nav(page, base, "?tier=borough")
        got, st, mt = n5.poll(morph_capable, timeout=180)
        ok_all &= check(n5, st, got, "a5 boot")
        n5.set_area("pcon")
        time.sleep(0.30)
        mid_st, _ = n5.read()
        n5.set_area("ward")
        got, st5, mt5 = n5.poll(done_morphing, timeout=120)
        time.sleep(SETTLE)
        page.screenshot(OUT / "a5_interrupt_ward.png")
        ok_a5 = check(n5, st5, got, "a5_interrupt_ward.png")
        ok_all &= ok_a5
        log("shot %-24s %-44s %5.1fs  %s"
            % ("a5_interrupt_ward.png", "A5 borough->pcon, retargeted to ward",
               time.time() - t0, "ok" if ok_a5 else "FAILED"))
        log("     at +300 ms: %s" % json.dumps(mid_st))
        log("     final:      %s" % json.dumps(st5))
        log("     log:        %s" % json.dumps(mt5.get("log")))
        a5_mid_was_morphing = bool((mid_st or {}).get("morphBasis"))
        a5_clean = (not st5.get("morphBasis")) and (st5.get("switching") is False)

        # A6. A measure change AFTER a morph still animates — the regression
        #     test for snap poisoning, which would leave the just-morphed tier
        #     with its transition state thrown away and make the next change
        #     cut instead of slide.
        #
        #     RUN WITH ?highlight=off. The peak-marker pulse is a SECOND
        #     production animation that overlaps this one — it starts 200 ms
        #     after any paint and runs for 810 ms, so it covers almost the whole
        #     750 ms measure ease — and its rings sit in the mid frame and in
        #     neither endpoint. Measured: they put 9,902 pixels more than 40/255
        #     from BOTH ends and drove pixel-progress to 116%, which is not a
        #     statement about the transition at all. With the pulse off, six.
        #     highlight=off is the page's own switch, not a test-only one.
        #
        #     Three frames rather than one, because ">2% and <98%" alone is
        #     weak: a cut would put every frame at 100% and a dead transition
        #     would put every frame on the same chrome-only floor. Requiring
        #     them to INCREASE rules out both.
        log("")
        t0 = time.time()
        n6 = Nav(page, base, "?tier=borough&highlight=off")
        got, st, mt = n6.poll(morph_capable, timeout=180)
        ok_all &= check(n6, st, got, "a6 boot")
        n6.set_area("ward")
        got, st, mt = n6.poll(done_morphing, timeout=120)
        ok_all &= check(n6, st, got, "a6 morph")
        time.sleep(SETTLE)
        a6_pre = page.shot_bytes()          # settled ward map, OLD measure
        n6.js('window.__setMeasure("%s").then(function(){},function(){}); 0' % MEAS2)
        t_chg = n6.clock()
        a6_samples = []
        for ms, keep in ((60, "a6_meas_mid.png"), (200, None), (420, None)):
            while n6.clock() < t_chg + ms:
                time.sleep(0.005)
            a = n6.clock()
            shot = page.shot_bytes()
            b = n6.clock()
            if keep:
                (OUT / keep).write_bytes(shot)
            a6_samples.append(((a + b) / 2.0 - t_chg, shot))
        got, st, mt = n6.poll(is_ready, timeout=60)
        time.sleep(SETTLE)
        page.screenshot(OUT / "a6_meas_end.png")
        ok_a6cap = check(n6, st, got, "a6_meas_end.png")
        ok_all &= ok_a6cap
        log("shot %-24s %-44s %5.1fs  %s"
            % ("a6_meas_mid/end.png", "A6 measure change after a morph",
               time.time() - t0, "ok" if ok_a6cap else "FAILED"))
        log("     three frames sampled at %s ms into the 750 ms ease"
            % ", ".join("%.0f" % s[0] for s in a6_samples))

        # A7. Suppression. See SUPP_M above for why this is lsoa->oa.
        log("")
        ok_all &= direct("a7_ref_oa.png", "?tier=oa&m=%s&morph=0" % SUPP_M,
                         "A7 oa / %s, loaded directly" % SUPP_M)
        ok_all &= switch("?tier=lsoa&m=%s" % SUPP_M, "oa",
                         "A7 lsoa -> oa under suppression", "a7_morph_oa.png")

        # A8. The change view, entered the way production enters it. The
        #     __setYear call is AWAITED: it returns apply()'s own promise, and
        #     firing the area switch before it resolved would seed the morph
        #     with the level values while the measure had already become the
        #     change view — a race in the test, not in the page.
        log("")
        ok_all &= direct("a8_ref_change.png", "?tier=ward&y=change&morph=0",
                         "A8 ward change view, loaded directly")
        ok_all &= switch(
            "?tier=borough", "ward", "A8 change view, borough -> ward",
            "a8_morph_change.png",
            before=lambda n: n.js('window.__setYear("change")', await_promise=True))

        # A9. Street mode keeps the curtain. Polled THROUGHOUT the switch
        #     rather than after it: "it ended up right" is not the claim.
        log("")
        t0 = time.time()
        n9 = Nav(page, base, "?mode=street&tier=borough")
        got, st, mt = n9.poll(morph_capable, timeout=180)
        ok_all &= check(n9, st, got, "a9 boot")
        n9.set_area("ward")
        a9_seen = []
        end = time.time() + 3.0
        while time.time() < end:
            s, m = n9.read()
            if s is not None:
                a9_seen.append(bool(s.get("morphBasis")))
            time.sleep(0.02)
        got, st9, mt9 = n9.poll(lambda s, m: is_ready(s, m) and s.get("tier") == "ward",
                                timeout=60)
        a9_ok = check(n9, st9, got, "a9 street") and not any(a9_seen) and len(a9_seen) > 20
        log("shot %-24s %-44s %5.1fs  %s"
            % ("-", "A9 street mode keeps the curtain", time.time() - t0,
               "ok" if a9_ok else "FAILED"))
        log("     %d state samples across the switch, morphActive true in %d"
            % (len(a9_seen), sum(1 for x in a9_seen if x)))

        # A10. A zoom mid-morph. Driven through the page's own __applyZoom hook
        #      rather than a synthetic gesture: a real pointer event would also
        #      reveal the "Reset view" button, which is a chrome difference the
        #      reference frames do not have, and a controlled viewState would
        #      mean taking the camera off the page's own uncontrolled one.
        #      __applyZoom(13) drops elevationScale to ~0.113 and __applyZoom(0)
        #      restores it to exactly 1 (elevScale clamps at 1 anywhere below
        #      the camera's own zoom), so the picture is bit-for-bit comparable
        #      again well before the frame is sampled — while both calls cross
        #      applyZoom's 4% rule and rebuild the layer stack mid-flight, which
        #      is the thing under test.
        #
        #      Both calls go out in ONE evaluate, the second on a page-side
        #      timer, so the disturbance is a known ~80 ms rather than however
        #      long two CDP round trips happen to take. curElevScale is read
        #      straight off the page rather than out of the meta node, which
        #      only refreshes every 100 ms and reported the two values a step
        #      behind on the first run of this driver.
        log("")
        t0 = time.time()
        n10 = Nav(page, base, "?tier=borough&morphdur=%d" % slow)
        got, st, mt = n10.poll(morph_capable, timeout=180)
        ok_all &= check(n10, st, got, "a10 boot")
        n10.set_area("ward")
        got, st, mt = n10.poll(logged("animate"), timeout=60)
        ok_all &= check(n10, st, got, "a10 animate")
        anim10 = log_at(mt, "animate") or n10.clock()
        n10.wait_clock(anim10 + slow * 0.30)
        z_before = n10.js("curElevScale")
        n10.js("window.__applyZoom(13);"
               "setTimeout(function(){window.__applyZoom(0);},80); 0")
        z_hi = n10.js("curElevScale")
        n10.wait_clock(anim10 + slow * 0.40)
        z_back = n10.js("curElevScale")
        n10.wait_clock(anim10 + slow * 0.75)
        before = n10.clock()
        page.screenshot(OUT / "a10_zoom_mid75.png")
        after = n10.clock()
        a10_frac = 100.0 * ((before + after) / 2.0 - anim10) / slow
        got, st10, mt10 = n10.poll(done_morphing, timeout=120)
        time.sleep(SETTLE)
        a10_end = page.shot_bytes()
        ok_a10cap = check(n10, st10, got, "a10 endpoint")
        ok_all &= ok_a10cap
        a10_scale_ok = (z_before == 1 and z_hi is not None and z_hi < 0.2
                        and z_back == 1)
        log("shot %-24s %-44s %5.1fs  %s"
            % ("a10_zoom_mid75.png", "A10 zoom during morph", time.time() - t0,
               "ok" if ok_a10cap else "FAILED"))
        log("     curElevScale %s -> %s -> %s across the nudge; frame landed at "
            "%.1f%% of the morph" % (z_before, z_hi, z_back, a10_frac))
        log("     log: %s" % json.dumps(mt10.get("log")))

        # A11. Reduced motion. Cheap over CDP, so it is asserted rather than
        #      left to the reader: TRANSITION goes to 0, crossFade is false,
        #      and the switch must be instant with no morph at any point.
        log("")
        t0 = time.time()
        page.reduced_motion(True)
        n11 = Nav(page, base, "?tier=borough")
        got, st, mt = n11.poll(is_ready, timeout=180)
        rm_boot = check(n11, st, got, "a11 boot")
        n11.set_area("ward")
        rm_seen = []
        end = time.time() + 2.0
        while time.time() < end:
            s, m = n11.read()
            if s is not None:
                rm_seen.append(bool(s.get("morphBasis")))
            time.sleep(0.02)
        got, st11, mt11 = n11.poll(lambda s, m: is_ready(s, m) and s.get("tier") == "ward",
                                   timeout=60)
        rm_ok = (rm_boot and check(n11, st11, got, "a11 switch")
                 and not any(rm_seen) and len(rm_seen) > 20
                 and mt11.get("transition") == 0)
        log("shot %-24s %-44s %5.1fs  %s"
            % ("-", "A11 reduced motion switches instantly", time.time() - t0,
               "ok" if rm_ok else "FAILED"))
        log("     TRANSITION=%s  MORPH_DUR=%s  %d samples, morphActive true in %d"
            % (mt11.get("transition"), mt11.get("dur"), len(rm_seen),
               sum(1 for x in rm_seen if x)))
        page.reduced_motion(False)

        # A12. THE UNPAINTED BASIS. warmMorph bails out without painting the
        #      basis whenever it resolves while a tier switch is in flight —
        #      reachable by any click landing in the ~1 s warm-up window — and
        #      hands the tessellation to the morph's own seed. That is only
        #      true if morphReady() lets a morph start with an unpainted basis;
        #      when it required B.painted, the bail-out was permanent and the
        #      page fell back to the curtain for the whole session while
        #      #v1status.morphReady went on saying true.
        #
        #      Racing the real window from out here is fiddly and flaky — the
        #      warm-up's own fetches gate __NG_DONE__, so "ready" already
        #      implies they have landed. Reproducing the STATE is deterministic
        #      and tests the same predicate: clearing READY.oa.painted leaves
        #      exactly what the bail-out leaves — basis resident, crosswalked,
        #      never painted, absent from the layer stack.
        log("")
        t0 = time.time()
        n12 = Nav(page, base, "?tier=borough")
        got, st, mt = n12.poll(morph_capable, timeout=180)
        ok_all &= check(n12, st, got, "a12 boot")
        cleared = n12.js("READY.oa.painted = null; String(READY.oa.painted)")
        n12.set_area("ward")
        a12_seen = []
        end = time.time() + 2.0
        while time.time() < end:
            s, m = n12.read()
            if s is not None:
                a12_seen.append(bool(s.get("morphBasis")))
            time.sleep(0.02)
        got, st12, mt12 = n12.poll(done_morphing, timeout=120)
        time.sleep(SETTLE)
        a12_end = page.shot_bytes()
        a12_morphed = any(a12_seen)
        a12_ok = check(n12, st12, got, "a12 switch") and a12_morphed
        log("shot %-24s %-44s %5.1fs  %s"
            % ("-", "A12 morph with an unpainted basis", time.time() - t0,
               "ok" if a12_ok else "FAILED"))
        log("     READY.oa.painted cleared to %s; %d samples across the switch, "
            "morphActive true in %d" % (cleared, len(a12_seen),
                                        sum(1 for x in a12_seen if x)))
        log("     log: %s" % json.dumps(mt12.get("log")))

        page.close()

        # ---- assertions -----------------------------------------------------
        log("")
        log("---- assertions ----")
        log("%s A1 boot with ?morph=0: page ready, errors 0 (curtain build sanity)"
            % ("PASS" if ok_a1 else "FAIL"))
        log("")

        ok_all &= compare(OUT / "a2_ref_ward.png", OUT / "a2_morph_ward.png",
                          "A2 endpoint: the default view morphed to ward through the "
                          "real pill path lands on the ward map", log)
        log("")
        ok_all &= compare(OUT / "a3_ref_gla.png", OUT / "a3_morph_gla.png",
                          "A3 endpoint, non-nested: pcon -> gla lands on the "
                          "Assembly-seat map", log)
        log("")
        ok_all &= compare(OUT / "a1_ref_borough.png", OUT / "a3_morph_borough.png",
                          "A3 endpoint, merge direction: ward -> borough lands on the "
                          "borough map, borough outlines stepping back out", log)
        log("")

        # ---- A4 progression
        start, end_ = OUT / "a4_from.png", OUT / "a2_ref_ward.png"
        span = mad_of(start, end_)
        log("A4 mid-flight progression: does the morph SLIDE?")
        log("     the seed frame and the ward map are %.4f/255 apart" % span)
        p = {}
        for frac in (25, 50, 75):
            f = OUT / ("a4_mid%d.png" % frac)
            da, db = mad_of(f, start), mad_of(f, end_)
            p[frac] = da / span if span else 0.0
            log("     a4_mid%-3d %7.4f from the seed, %7.4f from the ward end  "
                "-> %6.2f%% across   (frame landed at %.1f%%)"
                % (frac, da, db, 100 * p[frac], sampled[frac]))
        checks = [
            ("strictly increasing", p[25] < p[50] < p[75]),
            ("p25 >= 1.0%", p[25] >= 0.01),
            ("p50 within 10-90%", 0.10 <= p[50] <= 0.90),
            ("p75 <= 99.9%", p[75] <= 0.999),
        ]
        a4_ok = all(c[1] for c in checks)
        ok_all &= a4_ok
        for cname, good in checks:
            log("     %s %s" % ("pass" if good else "FAIL", cname))
        log("%s A4 the morph interpolates: %.2f%% -> %.2f%% -> %.2f%%"
            % ("PASS" if a4_ok else "FAIL", 100 * p[25], 100 * p[50], 100 * p[75]))
        log("")

        # ---- A5 interrupt
        ok_all &= compare(OUT / "a2_ref_ward.png", OUT / "a5_interrupt_ward.png",
                          "A5 interrupt: borough->pcon retargeted to ward 300 ms in, "
                          "landing exactly on the ward map", log)
        a5_ok = a5_mid_was_morphing and a5_clean
        ok_all &= a5_ok
        log("     %s a morph really was in flight when the second pill was clicked"
            % ("pass" if a5_mid_was_morphing else "FAIL"))
        log("     %s no stuck morphBasis and no stuck switching afterwards"
            % ("pass" if a5_clean else "FAIL"))
        log("")

        # ---- A6 measure change after a morph
        log("A6 a measure change AFTER a morph still animates (the snap-poisoning "
            "regression)")
        log("     zero is the settled ward map on the OLD measure, so the chrome "
            "the change rewrites")
        log("     (title, legend, active pill) is a fixed part of every number "
            "below — which is why")
        log("     the claim is that they INCREASE, not that any one of them "
            "equals the easing.")
        a6_p = []
        for at, shot in a6_samples:
            v = progress_of(shot, a6_pre, OUT / "a6_meas_end.png")
            a6_p.append(v)
            log("     %6.0f ms after the change  ->  %6.2f%% across" % (at, 100 * v))
        a6_ok = (0.02 < a6_p[0] < 0.98 and a6_p[0] < a6_p[1] < a6_p[2])
        ok_all &= a6_ok
        log("     %s the first frame is strictly between the two ends "
            "(>2%% and <98%%)" % ("pass" if 0.02 < a6_p[0] < 0.98 else "FAIL"))
        log("     %s the three frames strictly increase — so it slides rather "
            "than cutting or stalling"
            % ("pass" if a6_p[0] < a6_p[1] < a6_p[2] else "FAIL"))
        log("%s A6 the measure change after a morph still animates"
            % ("PASS" if a6_ok else "FAIL"))
        log("")

        # ---- A7 suppression
        ok_all &= compare(OUT / "a7_ref_oa.png", OUT / "a7_morph_oa.png",
                          "A7 suppression: lsoa -> oa on %s, whose denominator "
                          "suppresses 294 output areas and none at any coarser grain"
                          % SUPP_M, log)
        log("")

        # ---- A8 change view
        ok_all &= compare(OUT / "a8_ref_change.png", OUT / "a8_morph_change.png",
                          "A8 change view: 2011->2021 at borough, morphed to ward, "
                          "landing on the directly loaded change view", log)
        log("")

        # ---- A9 street
        ok_all &= a9_ok
        log("%s A9 street mode never morphed: morphActive false in all %d samples "
            "across the switch, errors 0" % ("PASS" if a9_ok else "FAIL", len(a9_seen)))
        log("")

        # ---- A10 zoom during morph
        z_p = progress_of(OUT / "a10_zoom_mid75.png", start, end_)
        drift = abs(z_p - p[75])
        a10_end_ok = compare(OUT / "a2_ref_ward.png", a10_end,
                             "A10 endpoint after a mid-flight zoom still lands on the "
                             "ward map", log, name_b="<a10 final frame, in memory>")
        a10_ok = a10_end_ok and a10_scale_ok and drift <= 0.15 and z_p > 0.5
        ok_all &= a10_ok
        log("     %s elevationScale really did move and come back (1 -> %s -> 1)"
            % ("pass" if a10_scale_ok else "FAIL", z_hi))
        log("     a10_zoom_mid75 is %.2f%% across, against a4_mid75's %.2f%% "
            "(drift %.2f pts, limit 15)" % (100 * z_p, 100 * p[75], 100 * drift))
        log("     A RESTART WOULD SHOW HERE, and did before the fix: this frame "
            "came in at 36.39%")
        log("     against a4_mid75's 94.99%, a drift of 58.6 points. The cause "
            "was NOT the scale — a")
        log("     bare redraw() with no scale change at all did the same damage "
            "(91% -> 37% at the")
        log("     70% mark) — it was polyLayer handing deck.gl a fresh "
            "data.attributes object on every")
        log("     redraw, which it reads as the attributes having changed. "
            "polyData() now caches that")
        log("     object per tier, keyed on the paint counter.")
        log("%s A10 the in-flight transition survived the elevationScale redraws"
            % ("PASS" if a10_ok else "FAIL"))
        log("")

        # ---- A11 reduced motion
        ok_all &= rm_ok
        log("%s A11 reduced motion: TRANSITION 0, no morph in %d samples, the "
            "switch lands instantly" % ("PASS" if rm_ok else "FAIL", len(rm_seen)))
        log("")

        # ---- A12 unpainted basis
        a12_land_ok = compare(OUT / "a2_ref_ward.png", a12_end,
                              "A12 a morph started with an UNPAINTED basis still lands "
                              "on the ward map", log,
                              name_b="<a12 final frame, in memory>")
        a12_all = a12_ok and a12_land_ok
        ok_all &= a12_all
        log("     %s it really morphed rather than falling back to the curtain "
            "(morphActive true in %d of %d samples)"
            % ("pass" if a12_morphed else "FAIL",
               sum(1 for x in a12_seen if x), len(a12_seen)))
        log("     WITH morphReady() REQUIRING B.painted THIS CURTAINED: morphActive")
        log("     stayed false for the whole switch and for every switch after it,")
        log("     while #v1status.morphReady — the field this driver gates on — said true.")
        log("%s A12 an unpainted basis is a morph that pays its own tessellation, "
            "not a dead one" % ("PASS" if a12_all else "FAIL"))

        log("")
        log("---- UNTESTED-BY-DRIVER (left to the human eye) ----")
        log("  * the real zoom-gesture lsoa<->oa auto-switch, AS A GESTURE. This")
        log("    driver forces the tier through __setArea and elevationScale")
        log("    through __applyZoom, so how crossing the threshold mid-drag feels")
        log("    is unjudged. (A7 does morph lsoa->oa, just not by dragging.)")
        log("  * plateau seam shimmer under rotation and tilt. The plateau is")
        log("    26,369 coplanar solids; whether their shared edges sparkle as the")
        log("    camera moves is not a still-frame question.")
        log("  * overall aesthetics: whether a split reads as one map refining")
        log("    rather than as a wipe, and whether 750 ms is the right length.")
        log("  * the ~210 ms seed frame v0 measured, AS FELT on a click. It is")
        log("    still there — ?hud=1 shows it — and whether it reads as lag on")
        log("    the click is a judgement no assertion here makes.")
        log("  * street mode keeps the curtain deliberately; whether that is the")
        log("    right call over a pale basemap is a design question, not a bug.")
        log("  * the borough outlines coming on at t=0 of a borough->ward switch.")
        log("    That is inherited production behaviour (the curtain does it too),")
        log("    and A4 measures against it rather than around it — but whether it")
        log("    reads as a pop is an eye question.")
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
