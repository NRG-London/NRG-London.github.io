#!/usr/bin/env python3
"""Headless verification driver for v2 — the boundary-warp experiment.

v0 and v1 animate VALUES on fixed geometry. v2 animates the geometry: wards are
inset towards their own centres so a thin gap of ground opens along every ward
boundary, and the split/merge choreography cracks a borough block apart into its
wards and heals it back.

    python tools/morph-lab/capture_v2.py

Serves `static/` (the page needs /labs/morph/v2/, /labs/morph/d/ and
/js/deck.min.js under ONE origin), drives Chrome (or Edge, via --browser) over
the DevTools protocol in real time, writes tools/morph-lab/captures/v2/ and
exits non-zero if any assertion fails.

THE SPIKE GATES EVERYTHING, AND IT CAME BACK NEGATIVE
-----------------------------------------------------
The whole experiment rested on one unproven claim: that deck.gl will INTERPOLATE
`getPolygon` on this page's setup — binary attributes, `_normalize: false`,
`positionFormat: "XY"`, and Float64 positions that deck splits into an fp64
high/low Float32 pair before the GPU ever sees them. Nothing in v0 or v1 needed
that, so nothing in v0 or v1 proved it.

It does not, and the failure is worse than "it does not animate": putting
`getPolygon` into the transitions block stops the SolidPolygonLayer drawing at
all. The map goes blank, in both precisions, with the page's own error count
still at zero — because the failure is a WebGL INVALID_OPERATION from the
transform-feedback pass deck.gl runs transitions on, not a JavaScript exception.
Section S below measures that ladder end to end and writes SPIKE-VERDICT:
NEGATIVE with the numbers and the browser's own log line behind it. THE RUN
THEREFORE EXITS NON-ZERO BY DESIGN: the verdict is this task's answer, not a
broken run, and the RESULT line says which of the two it is.

What still works is captured too, because it is what the user has to look at:
position swaps land pixel-exactly where a first draw of the same geometry lands,
so the warp itself is sound and the choreography CUTS its outlines while its
colours and heights still slide.

Why Chrome by default, and why everything goes over CDP: the installed Edge
no-ops one-shot CLI automation flags (--dump-dom, --screenshot) outside the
DevTools protocol on this machine, while the same flags on Chrome work; and
virtual time is not used at all, because it stops issuing animation frames the
moment the page is briefly idle and deck.gl's entire render loop is
requestAnimationFrame. Both were diagnosed in the v0/v1 reports.
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
OUT = ROOT / "tools" / "morph-lab" / "captures" / "v2"

WIDTH, HEIGHT = 1400, 950

# The lab panel lives in the top-left corner and carries a live frame-time
# readout, so it is never the same twice. Everything outside this box is map.
# The panel is 404 px wide and its content box ends well above 260; the margin
# is asserted against the page's own layout at boot rather than assumed.
CROP_W, CROP_H = 420, 260

MAD_LIMIT = 2.0          # mean absolute difference per channel, 0..255
FRAC_LIMIT = 0.005       # share of pixels allowed to differ by more than...
PIXEL_DIFF = 12          # ...this, on any one channel

MID_DUR = 3000           # a deliberately slow warp, for the mid-flight frames
SPIKE_S = 0.9            # the spike's inset: wards at 90% of their true size
SETTLE = 0.8             # after a state is reached, before capturing

# Chrome first: see the module docstring.
BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

# Tried in order until one both BOOTS the map and runs a split to finalise. Real
# GPU first: it is an order of magnitude faster than SwiftShader.
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
        self.events = []
        # Pin the viewport rather than trusting the window size: the page sizes
        # its camera off window.innerWidth, so every screenshot has to agree
        # about it or the maps are photographed at different zooms.
        self.call("Emulation.setDeviceMetricsOverride",
                  {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1,
                   "mobile": False})
        # THE BROWSER'S OWN LOG, and on this page it is the whole story. A WebGL
        # INVALID_OPERATION is not a JavaScript exception: nothing reaches
        # window.onerror, the page's own error list stays at zero, and the map
        # goes silently blank. Without this the spike below could only report
        # that nothing was drawn, not why.
        self.call("Log.enable")
        self.call("Runtime.enable")

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
            # KEPT, not discarded. Everything arrives down one socket, so the
            # obvious "ignore anything that is not my reply" loop throws the
            # browser's log away as a side effect of asking it a question.
            if "method" in msg:
                self.events.append(msg)
                continue
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s: %s" % (method, msg["error"]))
                return msg.get("result", {})

    def logs(self, clear=True):
        """Console, log and exception text collected since the last call."""
        out = []
        for m in self.events:
            p = m.get("params", {})
            if m["method"] == "Log.entryAdded":
                out.append(p.get("entry", {}).get("text", ""))
            elif m["method"] == "Runtime.consoleAPICalled":
                out.append(" ".join(str(a.get("value"))
                                    for a in p.get("args", [])))
            elif m["method"] == "Runtime.exceptionThrown":
                d = p.get("exceptionDetails", {})
                out.append(d.get("text", "") + " " +
                           str((d.get("exception") or {}).get("description", "")))
        if clear:
            self.events = []
        return [x.strip() for x in out if x and x.strip()]

    def evaluate(self, expr, await_promise=False):
        r = self.call("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True,
                       "awaitPromise": bool(await_promise)})
        if r.get("exceptionDetails"):
            return None
        return r.get("result", {}).get("value")

    def navigate(self, url):
        self.call("Page.navigate", {"url": url})

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
    profile = tempfile.mkdtemp(prefix="v2cdp-")
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
# satisfied by the PREVIOUS shot's finished warp still sitting on screen.
STATE_JS = """JSON.stringify({
  q: location.search,
  s: (document.getElementById('v2status')||{}).textContent || '',
  m: (document.getElementById('v2meta')||{}).textContent || '',
  e: (document.getElementById('v2err')||{}).textContent || ''
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


def is_ready(st, mt):
    return bool(st.get("ready"))


def logged(prefix):
    return lambda st, mt: any(x.startswith(prefix) for x in (mt.get("log") or []))


def done(st, mt):
    return is_ready(st, mt) and logged("finalise")(st, mt)


def log_at(mt, prefix):
    """Page-clock time of a logged phase, from `t0` plus its own offset."""
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
    """Per-pixel absolute difference OUTSIDE the control-panel corner. v2 keeps
    v0's visible panel — the HUD in it carries a live clock and a frame-time
    readout, so it is never the same twice — hence the crop v1 did not need."""
    a, b = img(a), img(b)
    if a.shape != b.shape:
        return None
    keep = np.ones(a.shape[:2], dtype=bool)
    keep[:CROP_H, :CROP_W] = False
    return np.abs(a - b)[keep]


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
    over = d.max(axis=1) > PIXEL_DIFF
    frac = float(over.mean())
    ok = mad <= MAD_LIMIT and frac <= FRAC_LIMIT
    log("%s %s vs %s" % ("PASS" if ok else "FAIL", na, nb))
    log("     %s" % label)
    log("     MAD %.4f/255 (limit %.1f)   pixels >%d/255: %d of %d = %.4f%% "
        "(limit %.1f%%)   max channel diff %d"
        % (mad, MAD_LIMIT, PIXEL_DIFF, int(over.sum()), over.size,
           100 * frac, 100 * FRAC_LIMIT, worst))
    return ok


def ink(src):
    """Share of the map area carrying something brighter than the ground.

    A blunt instrument on purpose. Two pictures can be far apart in MAD for many
    reasons; this answers the one question the spike turned out to hinge on —
    are there any extrusions on screen AT ALL — and it answers it the same way
    for every frame. The panel corner is excluded, and the threshold sits well
    above the #1A2332 ground and the Thames but below every ramp colour."""
    a = img(src)[:, CROP_W:]
    return float((a.sum(axis=2) > 190).mean())


def progress_of(frame, start, end, span=None):
    """How far `frame` has travelled from `start` towards `end`, in pixel space.
    Not linear in the value space the easing acts on, hence the wide bands
    wherever this is asserted against."""
    if span is None:
        span = mad_of(start, end)
    return (mad_of(frame, start) / span) if span else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", help="path to chrome.exe / msedge.exe")
    ap.add_argument("--mid-dur", type=int, default=MID_DUR,
                    help="ms for the slow runs the mid-flight frames come from")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    lines = []

    def log(s=""):
        print(s, flush=True)
        lines.append(s)

    browser = find_browser(args.browser)
    srv, port = serve(STATIC)
    base = "http://127.0.0.1:%d/labs/morph/v2/" % port
    slow = args.mid_dur
    log("driver     %s" % Path(__file__).name)
    log("browser    %s" % browser)
    log("serving    %s  ->  %s" % (STATIC, base))
    log("viewport   %dx%d, comparing everything OUTSIDE the %dx%d control-panel "
        "corner" % (WIDTH, HEIGHT, CROP_W, CROP_H))
    log("slow runs  %d ms, so a mid-flight frame is a photograph and not a guess"
        % slow)
    log("")

    ok_all = True
    proc = profile = None
    try:
        # ---- flag-set probe -------------------------------------------------
        # Boots AND runs a split to finalise. The split finalises on a timer, so
        # this says nothing about whether the outlines moved — that is the
        # spike's job — but it does rule out a flag set whose render loop never
        # runs at all.
        chosen_flags = None
        for name, flags in FLAG_SETS:
            dport = free_port()
            try:
                p, prof = launch(browser, flags, dport)
            except Exception as e:
                log("probe [%-38s] launch failed: %s" % (name, e))
                continue
            try:
                pg = Page(dport)
                n = Nav(pg, base, "?warp=split")
                got, st, mt = n.poll(is_ready, timeout=90)
                log("probe [%-38s] boot  %s" % (name, json.dumps(st)))
                if got:
                    got2, st2, mt2 = n.poll(done, timeout=60)
                    log("       %-37s split %s" % ("", json.dumps(mt2.get("log"))))
                    if got2 and st2.get("errors") == 0:
                        chosen_flags = (name, flags)
                pg.close()
            finally:
                kill(p, prof)
            if chosen_flags:
                break

        if not chosen_flags:
            log("")
            log("FAIL: no flag set both booted the page and ran a split to finalise")
            return 1
        fname_, flags = chosen_flags
        log("")
        log("PASS probe  boots and completes a split under [%s]" % fname_)
        log("")

        # ---- everything else, through one browser, one page, in real time ----
        dport = free_port()
        proc, profile = launch(browser, flags, dport)
        page = Page(dport)

        def check(nav, st, got, what):
            """EVERY capture asserts the page reported no errors, as v0's and
            v1's drivers do."""
            ok = bool(got) and st.get("errors") == 0
            if not ok:
                log("     %s: %s" % (what, "STATE NOT REACHED" if not got
                                     else "PAGE ERRORS"))
                log("     status %s" % json.dumps(st))
                log("     page errors (#v2err): %s" % (nav.err or "<empty>"))
            return ok

        def q(query, pos):
            """Every URL carries the precision mode under test."""
            if pos != "f32":
                return query
            return query + ("&" if "?" in query else "?") + "pos=f32"

        def at_tier(t):
            return lambda st, mt: is_ready(st, mt) and st.get("tier") == t

        def direct(fname, query, label, pos, want=is_ready, settle=SETTLE):
            """A reference frame: the page loaded straight into a state."""
            t0 = time.time()
            n = Nav(page, base, q(query, pos))
            got, st, mt = n.poll(want, timeout=180)
            time.sleep(settle)
            page.screenshot(OUT / fname)
            ok = check(n, st, got, fname)
            log("shot %-26s %-42s %5.1fs  %s"
                % (fname, label, time.time() - t0, "ok" if ok else "FAILED"))
            return ok, st, mt

        # ================= S. THE SPIKE, and everything is gated on it =======
        #
        # The question was "does getPolygon interpolate". The answer turned out
        # to be one layer down, so this measures the whole ladder, each step
        # against a baseline taken the same way:
        #
        #   S1  the spike's own configuration — getPolygon in `transitions` —
        #       against the identical page with that ONE key removed. `ink` is a
        #       blunt "are there any extrusions on screen at all" measure, and it
        #       is here because the failure turned out not to be a wrong picture
        #       but no picture.
        #   S2  the same with the ward positions downcast to Float32, which is
        #       the fallback the brief asks for if fp64 breaks interpolation.
        #   S3  GROUND TRUTH: the inset applied BEFORE the first draw, so there
        #       is a picture of what a warp of s really looks like that no update
        #       path had a hand in.
        #   S4  the same inset applied IN PLACE afterwards, measured against S3.
        #   S5  and finally asking for it as an ANIMATION.
        spike = {}
        log("---- S. the spike: can the outlines warp, and can the warp be tweened? ----")
        log("")

        # S0. The control: the true ward map with NO getPolygon transition. It
        #     doubles as the ward reference the split's end-state is judged on.
        ok_ref_ward, st_rw, mt_rw = direct(
            "ref_ward.png", "?show=ward&postrans=0",
            "S0 control: ward map, no getPolygon transition", "f64",
            want=at_tier("ward"))
        ok_all &= ok_ref_ward
        ink_ctl = ink(OUT / "ref_ward.png")
        page.logs()
        log("     ink %.4f of the map area — the control, and what the ward "
            "extrusions look like" % ink_ctl)
        log("")

        # S1/S2. getPolygon IN the transitions block, both precisions.
        for pos_ in ("f64", "f32"):
            fname = "spike_trans_%s.png" % pos_
            okT, stT, mtT = direct(
                fname, q("?show=ward&postrans=1", pos_),
                "S%d getPolygon transition declared, %s"
                % (1 if pos_ == "f64" else 2, pos_),
                "f64", want=at_tier("ward"))
            gl = [x for x in page.logs() if "WebGL" in x or "INVALID" in x]
            inkT = ink(OUT / fname)
            d = mad_of(OUT / "ref_ward.png", OUT / fname)
            blank = inkT < ink_ctl / 4.0
            spike[pos_] = {"ink": inkT, "mad": d, "blank": blank, "gl": gl,
                           "errors": stT.get("errors")}
            log("     ink %.4f (control %.4f)   MAD vs the control %.4f/255"
                % (inkT, ink_ctl, d))
            log("     the page's own error count: %s — nothing was thrown"
                % stT.get("errors"))
            for x in gl[:4]:
                log("     browser log: %s" % x)
            log("     %s the layer is BLANK with getPolygon in transitions (%s)"
                % ("MEASURED:" if blank else "not blank —", pos_))
            log("")
            ok_all &= okT

        # S3. Ground truth: the inset applied before the first paint.
        okG, stG, mtG = direct(
            "spike_ground.png", "?s0=%s&postrans=0" % SPIKE_S,
            "S3 ground truth: inset %.2f before the first draw" % SPIKE_S, "f64",
            want=lambda st, mt: is_ready(st, mt) and st.get("s") == SPIKE_S)
        ok_all &= okG
        span3 = mad_of(OUT / "ref_ward.png", OUT / "spike_ground.png")
        log("     ink %.4f   MAD vs the control %.4f/255 — THIS is how big a "
            "%.2f inset is" % (ink(OUT / "spike_ground.png"), span3, SPIKE_S))
        log("")

        # S4. The same inset applied in place, no transition declared.
        t0 = time.time()
        n = Nav(page, base, "?show=ward&postrans=0")
        got, st, mt = n.poll(at_tier("ward"), timeout=180)
        ok_all &= check(n, st, got, "S4 boot")
        time.sleep(SETTLE)
        n.js("window.__v2.warpSnap(%s); 0" % SPIKE_S)
        got, st, mt = n.poll(lambda a_, b_: a_.get("s") == SPIKE_S, timeout=30)
        time.sleep(SETTLE)
        page.screenshot(OUT / "spike_inplace.png")
        ok_s4 = check(n, st, got, "spike_inplace.png")
        ok_all &= ok_s4
        gl4 = [x for x in page.logs() if "WebGL" in x or "INVALID" in x]
        d_ground = mad_of(OUT / "spike_ground.png", OUT / "spike_inplace.png")
        log("shot %-26s %-42s %5.1fs  %s"
            % ("spike_inplace.png", "S4 the same inset, applied in place",
               time.time() - t0, "ok" if ok_s4 else "FAILED"))
        log("     ink %.4f   MAD vs the GROUND TRUTH %.4f/255   browser WebGL "
            "errors: %d" % (ink(OUT / "spike_inplace.png"), d_ground, len(gl4)))
        inplace_ok = d_ground <= MAD_LIMIT
        log("     %s an in-place position swap lands exactly where a first draw "
            "of the same geometry does" % ("pass" if inplace_ok else "FAIL"))
        ok_all &= inplace_ok
        log("")

        # S5. And now ask for it as an animation, over a deliberately slow ease.
        t0 = time.time()
        n = Nav(page, base, "?show=ward&postrans=0")
        got, st, mt = n.poll(at_tier("ward"), timeout=180)
        ok_all &= check(n, st, got, "S5 boot")
        time.sleep(SETTLE)
        start_shot = page.shot_bytes()
        n.js("window.__v2.warpTo(%s, %d); 0" % (SPIKE_S, slow))
        got, st, mt = n.poll(logged("animate"), timeout=60)
        ok_all &= check(n, st, got, "S5 animate")
        at = log_at(mt, "animate") or n.clock()
        s5 = {}
        for frac in (25, 50, 75):
            n.wait_clock(at + slow * frac / 100.0)
            before = n.clock()
            shot = page.shot_bytes()
            after = n.clock()
            if frac == 50:
                (OUT / "spike_anim_mid.png").write_bytes(shot)
            s5[frac] = (100.0 * ((before + after) / 2.0 - at) / slow, shot)
        got, st, mt = n.poll(done, timeout=90)
        time.sleep(SETTLE)
        end_shot = page.shot_bytes()
        ok_s5 = check(n, st, got, "S5 end")
        ok_all &= ok_s5
        span5 = mad_of(start_shot, end_shot)
        log("shot %-26s %-42s %5.1fs  %s"
            % ("spike_anim_mid.png", "S5 the warp asked for as an animation",
               time.time() - t0, "ok" if ok_s5 else "FAILED"))
        log("     the start and the end of the %d ms warp are %.4f/255 apart"
            % (slow, span5))
        p5 = {}
        for frac in (25, 50, 75):
            landed, shot = s5[frac]
            p5[frac] = progress_of(shot, start_shot, end_shot, span5)
            log("     frame at %5.1f%% of the ease  ->  %6.2f%% across"
                % (landed, 100 * p5[frac]))
        slides = (all(0.01 < p5[f] < 0.99 for f in (25, 50, 75))
                  and p5[25] < p5[50] < p5[75])
        cuts = all(p5[f] > 0.99 for f in (25, 50, 75))
        log("     %s it slides (every frame strictly between the ends, and rising)"
            % ("pass" if slides else "FAIL"))
        log("     %s it CUTS — the first sampled frame is already at the "
            "destination" % ("confirmed" if cuts else "no"))
        log("")

        # ---- THE VERDICT ----------------------------------------------------
        log("=" * 74)
        spike_ok = bool(slides)
        if spike_ok:
            log("SPIKE-VERDICT: POSITIVE — getPolygon interpolates")
        else:
            log("SPIKE-VERDICT: NEGATIVE")
            log("")
            log("  getPolygon position transitions are not available on this "
                "page's setup, and")
            log("  the failure is not that they interpolate badly — it is that "
                "declaring one")
            log("  stops the layer drawing at all.")
            log("")
            log("  1. With getPolygon in the transitions block the "
                "SolidPolygonLayer renders")
            log("     NOTHING: ink %.4f against the control's %.4f, and %.2f/255 "
                "away from it."
                % (spike["f64"]["ink"], ink_ctl, spike["f64"]["mad"]))
            log("  2. Float32 positions change nothing: ink %.4f, MAD %.4f. The "
                "layer declares its"
                % (spike["f32"]["ink"], spike["f32"]["mad"]))
            log("     own attribute type as float64 whatever array is handed in, "
                "so the fallback")
            log("     the brief asks for never reaches the mechanism that fails.")
            log("  3. That mechanism, from the browser rather than from "
                "inference:")
            for x in (spike["f64"]["gl"] or ["<none captured>"])[:3]:
                log("       %s" % x)
            log("     deck.gl runs an attribute transition as a transform "
                "feedback pass, and it")
            log("     cannot bind the buffers for SolidPolygonLayer's "
                "double-precision")
            log("     vertexPositions. The pass fails, the destination buffer is "
                "never written,")
            log("     and the layer draws from it anyway.")
            log("  4. IT IS SILENT. The page's own error count stayed at %s "
                "throughout: a WebGL"
                % spike["f64"]["errors"])
            log("     INVALID_OPERATION is not a JavaScript exception, so nothing "
                "reaches")
            log("     window.onerror and no assertion watching the page would "
                "ever see it.")
            log("  5. What DOES work: positions swapped in place land "
                "pixel-exactly where a")
            log("     first draw of the same geometry lands (%.4f/255 apart, S3 "
                "vs S4) — so the" % d_ground)
            log("     warp itself is sound. Asked for as an animation it CUTS: "
                "%.1f%% across at" % (100 * p5[25]))
            log("     the quarter mark of a %d ms ease." % slow)
            log("")
            log("  No shader extension was attempted: the brief puts that "
                "decision with the")
            log("  controller and out of this task's scope.")
        log("=" * 74)
        log("")

        # The rest of the run uses the configuration that DRAWS, and reports the
        # choreography for what it now is — correct in its end states, and a cut
        # rather than a slide wherever it moves an outline.
        pos = "f64"
        log("---- captures (pos=%s) ----" % pos)

        # ---- 1. boot ---------------------------------------------------------
        ok1, st1, mt1 = direct("ref_borough.png", "?show=borough",
                               "1 borough map, loaded directly", pos,
                               want=at_tier("borough"))
        ok_all &= ok1
        w2b = mt1.get("w2b") or {}
        boot_ok = bool(ok1 and st1.get("w2b") and w2b.get("ok")
                       and w2b.get("conflicts") == 0
                       and w2b.get("mapped") == w2b.get("wards"))
        ok_all &= boot_ok

        # (the ward reference was taken as the spike's control, S0 above)

        # ---- 2. the split ----------------------------------------------------
        # Mid frames are timed off the page's own clock: it logs the phase and
        # the offset it happened at, so a frame is taken against an absolute
        # deadline and the fraction it ACTUALLY landed on is measured, not
        # assumed.
        log("")
        t0 = time.time()
        n = Nav(page, base, q("?warp=split&dur=%d&when=250" % slow, pos))
        got, st, mt = n.poll(logged("crack"), timeout=180)
        ok_all &= check(n, st, got, "split crack")
        page.screenshot(OUT / "split_crack.png")
        log("shot %-26s %-42s %5.1fs  %s"
            % ("split_crack.png", "2 the crack, just after the swap",
               time.time() - t0, "ok"))
        got, st, mt = n.poll(logged("animate"), timeout=60)
        ok_all &= check(n, st, got, "split animate")
        at = log_at(mt, "animate") or n.clock()
        split_at = {}
        for frac in (25, 50, 75):
            n.wait_clock(at + slow * frac / 100.0)
            before = n.clock()
            page.screenshot(OUT / ("split_%d.png" % frac))
            after = n.clock()
            split_at[frac] = 100.0 * ((before + after) / 2.0 - at) / slow
            log("shot %-26s %-42s        landed at %.1f%% of a %d ms split"
                % ("split_%d.png" % frac, "2 split mid-flight", split_at[frac], slow))
        got, st, mt = n.poll(done, timeout=120)
        time.sleep(SETTLE)
        page.screenshot(OUT / "split_end.png")
        ok_split = check(n, st, got, "split_end.png")
        ok_all &= ok_split
        log("shot %-26s %-42s %5.1fs  %s"
            % ("split_end.png", "2 split end-state", time.time() - t0,
               "ok" if ok_split else "FAILED"))
        log("     %s" % json.dumps({"status": st, "log": mt.get("log")}))

        # ---- 3. the merge ----------------------------------------------------
        # Both phases photographed: phase 1 converges the values while the seams
        # open, phase 2 moves the outlines alone. Phase 2 is the one that needs
        # polyData()'s posPhase key — nothing is repainted in it at all.
        log("")
        t0 = time.time()
        d1, d2 = slow, int(slow * 0.875)      # the 400/350 default, scaled up
        n = Nav(page, base, q("?warp=merge&d1=%d&d2=%d&when=250" % (d1, d2), pos))
        got, st, mt = n.poll(logged("phase1"), timeout=180)
        ok_all &= check(n, st, got, "merge phase1")
        at1 = log_at(mt, "phase1") or n.clock()
        n.wait_clock(at1 + d1 * 0.5)
        before = n.clock()
        page.screenshot(OUT / "merge_p1_50.png")
        after = n.clock()
        m1_at = 100.0 * ((before + after) / 2.0 - at1) / d1
        log("shot %-26s %-42s        landed at %.1f%% of phase 1 (%d ms)"
            % ("merge_p1_50.png", "3 merge phase 1: values + seams", m1_at, d1))
        got, st, mt = n.poll(logged("phase2"), timeout=60)
        ok_all &= check(n, st, got, "merge phase2")
        at2 = log_at(mt, "phase2") or n.clock()
        n.wait_clock(at2 + d2 * 0.5)
        before = n.clock()
        merge_p2 = page.shot_bytes()
        after = n.clock()
        (OUT / "merge_p2_50.png").write_bytes(merge_p2)
        m2_at = 100.0 * ((before + after) / 2.0 - at2) / d2
        log("shot %-26s %-42s        landed at %.1f%% of phase 2 (%d ms)"
            % ("merge_p2_50.png", "3 merge phase 2: outlines alone", m2_at, d2))
        got, st, mt = n.poll(done, timeout=120)
        time.sleep(SETTLE)
        page.screenshot(OUT / "merge_end.png")
        ok_merge = check(n, st, got, "merge_end.png")
        ok_all &= ok_merge
        log("shot %-26s %-42s %5.1fs  %s"
            % ("merge_end.png", "3 merge end-state", time.time() - t0,
               "ok" if ok_merge else "FAILED"))
        log("     %s" % json.dumps({"status": st, "log": mt.get("log")}))

        page.close()

        # ---- assertions ------------------------------------------------------
        log("")
        log("---- assertions ----")
        log("%s 1 BOOT: ready, errors 0, and the ward->borough mapping was "
            "CHECKED, not assumed" % ("PASS" if boot_ok else "FAIL"))
        log("     %d of %d wards mapped from %d output areas, %d conflicts "
            "(a conflict throws at boot)"
            % (w2b.get("mapped", -1), w2b.get("wards", -1), w2b.get("oas", -1),
               w2b.get("conflicts", -1)))
        log("     ward tier: %s features, %s vertices; positions %s"
            % (mt1.get("nWards"), mt1.get("nVerts"), mt1.get("pos")))
        log("")

        log("%s S SPIKE: getPolygon position transitions animate"
            % ("PASS" if spike_ok else "FAIL"))
        log("     f64 with the transition declared: ink %.4f vs control %.4f, "
            "MAD %.4f, WebGL errors %d"
            % (spike["f64"]["ink"], ink_ctl, spike["f64"]["mad"],
               len(spike["f64"]["gl"])))
        log("     f32 with the transition declared: ink %.4f vs control %.4f, "
            "MAD %.4f, WebGL errors %d"
            % (spike["f32"]["ink"], ink_ctl, spike["f32"]["mad"],
               len(spike["f32"]["gl"])))
        log("     %s S4 in-place position swap == a first draw of the same "
            "geometry (%.4f/255)"
            % ("pass" if inplace_ok else "FAIL", d_ground))
        log("     S5 asked for as an animation: %.2f%% -> %.2f%% -> %.2f%% "
            "across (a cut lands on 100/100/100)"
            % (100 * p5[25], 100 * p5[50], 100 * p5[75]))
        log("     THE VERDICT IS THE FINDING, and the non-zero exit code below "
            "records it.")
        log("")

        ok_all &= compare(OUT / "ref_ward.png", OUT / "split_end.png",
                          "2 SPLIT END-STATE: the cracked-open wards heal into "
                          "exactly the ward map", log)
        log("")
        ok_all &= compare(OUT / "ref_borough.png", OUT / "merge_end.png",
                          "3 MERGE END-STATE: the wards converge and hand back to "
                          "exactly the borough map", log)
        log("")

        log("4 MID FRAMES FOR THE EYE — saved, error-gated, deliberately NOT "
            "pixel-asserted:")
        log("     the crack is SUPPOSED to differ from both ends, so a "
            "progression band on the")
        log("     split would be measuring the gaps rather than the "
            "choreography. Read them")
        log("     knowing what the spike found: the VALUES still tween (colour "
            "and height keep")
        log("     their transitions and v0 proved those), and the OUTLINES cut.")
        log("       split_crack.png   the swap, at s=%s: every ward boundary is "
            "a gap of ground" % (mt1.get("inset")))
        log("       split_%%d.png      %.1f / %.1f / %.1f%% of the %d ms split — "
            "values sliding,"
            % (split_at[25], split_at[50], split_at[75], slow))
        log("                         outlines already home")
        log("       merge_p1_50.png   %.1f%% of phase 1 — values converging, "
            "seams already open" % m1_at)
        log("       merge_p2_50.png   %.1f%% of phase 2 — the seams' one "
            "instant close" % m2_at)
        log("")

        log("---- UNTESTED-BY-DRIVER (left to the human eye) ----")
        log("  * whether style B reads better than style A. That is the whole")
        log("    point of the experiment, no assertion here touches it, and the")
        log("    spike means it can only be judged as a cut, not as a warp.")
        log("  * the inset rate: s is a fixed FRACTION of each ward's size, so a")
        log("    small ward opens a small gap and a large one opens a large gap.")
        log("    A constant-metre inset would look different and is not built.")
        log("  * per-ring insetting shrinks HOLES towards their own centres too,")
        log("    so an enclave inside a ward grows rather than shrinking. There")
        log("    are few of these at ward grain and none were seen to matter.")
        log("  * a mid-flight opposite click restarts the choreography from")
        log("    wherever the VALUE interpolation had got to; it lands correctly,")
        log("    but whether the restart reads as a correction is an eye question.")
        log("  * seam shimmer under rotation and tilt, which is not a")
        log("    still-frame question.")
        log("")
        # Split out so the RESULT line can tell the two apart: a negative spike
        # is this task's ANSWER, and a broken run is not.
        supporting_ok = bool(ok_all)
        ok_all &= spike_ok
        log("RESULT %s" % ("ALL ASSERTIONS PASS" if ok_all else
                           ("SPIKE NEGATIVE — recorded above with its evidence; "
                            "every other assertion in this run passed"
                            if supporting_ok else
                            "FAILED — and not only at the spike")))
    finally:
        if proc:
            kill(proc, profile)
        srv.shutdown()
        (OUT / "RESULTS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
