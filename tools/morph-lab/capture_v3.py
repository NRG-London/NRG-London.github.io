#!/usr/bin/env python3
"""Headless verification driver for v3 — V1's morph with the boundary warp
moved off the CPU and onto the GPU, as a deck.gl LayerExtension.

TWO JOBS, AND THE FIRST IS "NOTHING BROKE"
------------------------------------------
V3 is V1 with one extra path, so the whole of V1's battery is inherited here
and every assertion in it must still pass (A1-A13). Where an assertion measures
the MORPH ITSELF rather than the page around it, and the pair it uses is one V3
now warps, it is pinned to `&warp=0` — which is V1's code path exactly — and
the warp is measured separately by the W arms. That is deliberate rather than
convenient: A4 and A10 exist to catch a transition that cuts or restarts, and
"pixel progress between the two endpoint maps" stops meaning that the moment
the geometry is also moving. Measured on the warp path, A4's own metric reads
320%. W2 is what replaces it.

A0 additionally holds v3 under `?warp=0` against V1 ITSELF, same route, same
frame — the strongest form of "the V1 morph did not regress" available.

THE W ARMS, WHICH ARE THE NEW CLAIM
-----------------------------------
  S   THE SPIKE: that the injection reaches position at all; that the layer is
      NOT blanked (v2's verdict on deck's own getPolygon transition); that the
      shader warp reproduces a CPU warp of the same geometry, side walls
      included; and that the extension AT REST is bit-identical to the page
      built without it.
  W1  Endpoint identity for both warped directions against a direct load.
  W2  CONCURRENCY — the whole point of V3. One mid-flight frame in which the
      geometry is demonstrably displaced AND the value transition is strictly
      interior, measured against STAGED references carrying the same
      displacement.
  W3  Frame rate across the gesture, reported, against v2's CPU path.
  W4  A zoom and an interrupt landing mid-warp still land exactly.

AN INK GATE ON EVERY CAPTURE
----------------------------
v2's lesson, and not optional here. deck.gl blanked the SolidPolygonLayer for a
whole sprint while `errors == 0` and nothing reached window.onerror, because a
WebGL INVALID_OPERATION is not a JavaScript exception. Every committed capture
below also asserts that something was actually DRAWN, and the browser's own log
is read over CDP so a WebGL error is evidence rather than a silent blank.

    python tools/morph-lab/capture_v3.py

Serves `static/` (the page needs /labs/morph/v3/, /labs/morph/v1/,
/labs/morph/d/ and
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
OUT = ROOT / "tools" / "morph-lab" / "captures" / "v3"

WIDTH, HEIGHT = 1400, 950

MAD_LIMIT = 2.0          # mean absolute difference per channel, 0..255
FRAC_LIMIT = 0.005       # share of pixels allowed to differ by more than...
PIXEL_DIFF = 12          # ...this, on any one channel

MID_DUR = 3000           # a deliberately slow morph, for the mid-flight frames

# The page's own warp defaults, mirrored so the driver can stage a reference at
# exactly the displacement a live frame is carrying. Changing them on the page
# without changing them here would make W2's staged references the wrong shape,
# so W2 reads both back off the page and asserts they agree.
WARP_INSET = 0.92
WARP_PEAK = 0.38
# THE NUMBER THAT SEPARATES THE TWO VERDICTS. v2's CPU warp measured 34.5-46.0
# fps at ward grain in this same harness, on this same machine, rebuilding an
# 811 KB position buffer and re-tessellating 689 features every frame. V3's
# per-frame cost is one float. A floor of 55 cannot be met by the CPU path and
# is met with room to spare by the GPU one, so it is a discriminating gate
# rather than a decorative one.
MIN_WARP_FPS = 55.0
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
        self.events = []
        # Pin the viewport rather than trusting the window size: the page sizes
        # its camera off window.innerWidth, so every screenshot has to agree
        # about it or the maps are photographed at different zooms.
        self.call("Emulation.setDeviceMetricsOverride",
                  {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1,
                   "mobile": False})
        # THE BROWSER'S OWN LOG. Ported from v2's driver, where it was the whole
        # story: with a getPolygon transition declared every frame logged
        # "INVALID_OPERATION: beginTransformFeedback: not enough transform
        # feedback buffers bound" and the map went blank in complete silence.
        # V3's entire design is "never touch that attribute", so this is the
        # instrument that says whether that worked.
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

    def gl_errors(self, clear=True):
        return [x for x in self.logs(clear) if "WebGL" in x or "INVALID_" in x]

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
    profile = tempfile.mkdtemp(prefix="v3cdp-")
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
# Reads EITHER page's nodes, because A0 drives v1 through this same class to
# hold v3's ?warp=0 route against it frame for frame.
STATE_JS = """JSON.stringify({
  q: location.search,
  s: (document.getElementById('v3status')||document.getElementById('v1status')
      ||{}).textContent || '',
  m: (document.getElementById('v3meta')||document.getElementById('v1meta')
      ||{}).textContent || '',
  e: (document.getElementById('v3err')||document.getElementById('v1err')
      ||{}).textContent || '',
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


def staged(st, mt):
    """Booted AND any ?stage=/?wt= state is standing. The staged references W2
    compares against are set up after the first view has settled, so `ready`
    alone would photograph the page on its way there."""
    return morph_capable(st, mt) and bool(st.get("staged"))


def morph_capable(st, mt):
    """Booted, drawn, and BOTH bases are warm. Until then every switch takes the
    curtain BY DESIGN, so a driver that switched before this would be testing
    the curtain and calling it a morph.

    `warpReady` is V3's addition and it is not cosmetic. The warp is drawn on
    the ward tier, so a cold split's seed is that layer's FIRST draw — measured
    at 625 ms of tessellation before the crack could open. The page warms it at
    boot and says so here; a driver that did not wait would be timing the
    tessellation and calling it the morph. A page with the warp off reports it
    true immediately."""
    # `warpReady is None` means the page does not have the field — which is
    # true of v1, and A0 drives v1 through this same predicate to hold v3's
    # ?warp=0 route against it. A v3 page always publishes the field, so it
    # reads False until the warp tier is warm and this still waits for it.
    return (bool(st.get("ready")) and bool(st.get("morphReady"))
            and (st.get("warpReady") is None or bool(st.get("warpReady"))))


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


# ---- A13: the per-frame signature -------------------------------------------
# The page's ?flickerprobe=1 reads a fixed 512x384 region of the deck canvas
# back off the GPU inside every committed render and reduces it to a mean, a
# standard deviation and an eight-bucket luminance histogram. `spike_of` asks
# one question of that log: is there a frame that sits further from BOTH its
# neighbours than they sit from each other?
#
# That is the signature of a WRONG frame and of nothing else. A moving picture
# walks: each frame is close to the one before and the one after, and the
# neighbours are far apart. A frame that is wrong and immediately corrected is
# far from both while the neighbours agree, so the excess below is large. A
# frame that is merely SLOW shows in `dt` and not here at all — which is how
# the two hypotheses were told apart in the first place.
#
# Reported as a share of the sampled region, so the limits do not depend on the
# region size. Measured: 23.5% on the unfixed page (the seed) and 8.3% (the
# hand-off); 0.02% on the fixed one. The limits sit in a gap of three orders of
# magnitude.
FLICKER_LIMIT = 0.01        # fixed page: no frame may exceed 1% of the region
FLICKER_FLOOR = 0.05        # ?ghost=0: the probe must SEE at least 5%, or it
                            # is not looking at anything and proves nothing


def spike_of(log):
    """(worst one-frame excess as a share of the region, that sample)."""
    if len(log) < 3:
        return 0.0, None
    npx = sum(log[0]["h"]) or 1

    def hd(a, b):
        return sum(abs(x - y) for x, y in zip(a["h"], b["h"]))

    worst, at = 0, None
    for i in range(1, len(log) - 1):
        a, e, b = log[i - 1], log[i], log[i + 1]
        excess = min(hd(a, e), hd(e, b)) - hd(a, b)
        if excess > worst:
            worst, at = excess, e
    return worst / float(npx), at


# ---- the no-blanking gate ---------------------------------------------------
# v2's lesson. `ink` is the share of the frame carrying something brighter than
# the ground: a blunt instrument that answers the one question a clean error
# count cannot, which is whether any extrusion reached the screen at all.
# Measured on this page: a drawn ward map is 0.2775 and v2's blanked layer was
# 0.0363, so the floor sits in the middle of a gap of nearly an order of
# magnitude. The threshold is above the #1A2332 ground and the Thames and below
# every ramp colour.
INK_FLOOR = 0.15


def ink(src):
    a = img(src)
    return float((a.sum(axis=2) > 190).mean())


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
    base = "http://127.0.0.1:%d/labs/morph/v3/" % port
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
                log("     page errors (#v3err): %s" % (nav.err or "<empty>"))
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
        # PINNED TO ?warp=0, WHICH IS V1'S PATH EXACTLY. borough->ward is a
        # warped pair in V3, and this assertion's instrument — pixel distance
        # between the two endpoint maps — stops measuring the transition the
        # moment the geometry is also moving: on the warp path it reads 320%,
        # because a cracked frame is far from both closed ones. So A4 keeps
        # doing the job it was written for (catching a transition that cuts or
        # restarts) on the code path it was written for, and W2 makes the
        # equivalent claim about the warp with references that carry the crack.
        n4 = Nav(page, base, "?tier=borough&morphdur=%d&warp=0" % slow)
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
        # Logged HERE, before A5b runs, so the elapsed time below is A5's own and
        # the two appear in RESULTS in the order they were captured.
        log("shot %-24s %-44s %5.1fs  %s"
            % ("a5_interrupt_ward.png", "A5 borough->pcon, retargeted to ward",
               time.time() - t0, "ok" if ok_a5 else "FAILED"))
        log("     at +300 ms: %s" % json.dumps(mid_st))
        log("     final:      %s" % json.dumps(st5))
        log("     log:        %s" % json.dumps(mt5.get("log")))
        a5_mid_was_morphing = bool((mid_st or {}).get("morphBasis"))
        a5_clean = (not st5.get("morphBasis")) and (st5.get("switching") is False)

        # A5b. INTERRUPT INSIDE THE SEED WARM WINDOW. A5 above fires at +300 ms,
        #      which is past both warm commits, so it asserts nothing about them.
        #      The window between the seed's warm commit and its reveal is one
        #      committed render wide, so it is not raced from out here — both
        #      clicks go out in ONE task instead, which puts the second morphTier
        #      in front of the first morph's warm commit deterministically.
        #
        #      That is the window where morphSeed is standing and the seed block
        #      is skipped (morphBasis is already BASIS). Getting it wrong strands
        #      morphSeed: buildStack goes on resolving `shown` to a tier the
        #      reader has left, the morph animates invisibly, and the map is
        #      stuck on the wrong layer for the life of the page. Measured on the
        #      build that had it: morphSeed still "borough" after a morph to
        #      wards, four committed renders for the whole 750 ms because nothing
        #      on screen was moving, and the watchdog forcing the animate through
        #      at +693 ms. All three are asserted below.
        #
        #      ONE TASK IS A SUPERSET OF A REAL DOUBLE-CLICK, not a copy of it.
        #      Two setArea calls with no yield between them leave two apply()
        #      chains in flight over the same `tier` global, so for the moment
        #      between them READY[tier] aliases and one buildStack can emit two
        #      layers carrying the same poly-<key> id. A human double-click
        #      always has at least one task boundary in it and cannot reach that
        #      state. It is used anyway because the state it DOES reach — the
        #      seed's warm window, entered with morphSeed standing — is the one
        #      under test and is not reachable from out here any other way, and
        #      because a page that survives the superset survives the subset.
        log("")
        t0b = time.time()
        n5b = Nav(page, base, "?tier=borough")
        got, st, mt = n5b.poll(morph_capable, timeout=180)
        ok_5b = check(n5b, st, got, "a5b boot")
        for area in ("ward", "pcon", "borough"):     # pre-visit, so every tier
            n5b.set_area(area)                       # carries a drawn buffer
            got, st, mt = n5b.poll(done_morphing, timeout=120)
            ok_5b &= check(n5b, st, got, "a5b pre-visit " + area)
            time.sleep(0.35)
        r_before = (n5b.read()[1] or {}).get("renders") or 0
        n5b.js('window.__setArea("pcon").then(function(){},function(){});'
               'window.__setArea("ward").then(function(){},function(){}); 0')
        got, st5b, mt5b = n5b.poll(done_morphing, timeout=120)
        ok_5b &= check(n5b, st5b, got, "a5b retarget")
        time.sleep(SETTLE)
        a5b_end = page.shot_bytes()
        a5b_state = json.loads(n5b.js(
            "JSON.stringify({seed: typeof morphSeed === 'undefined' ? 'UNDEFINED'"
            " : morphSeed, mb: morphBasis, sw: switching, tier: tier,"
            " renders: renderCount})") or "{}")
        a5b_seed_clear = a5b_state.get("seed") is None
        a5b_no_watchdog = not any(str(x).startswith("watchdog")
                                  for x in (mt5b.get("log") or []))
        a5b_renders = (a5b_state.get("renders") or 0) - r_before
        a5b_drew = a5b_renders >= 30      # a 750 ms morph that is actually drawn
        log("shot %-24s %-44s %5.1fs  %s"
            % ("-", "A5b retarget inside the seed warm window", time.time() - t0b,
               "ok" if ok_5b else "FAILED"))
        log("     both pills clicked in one task; log: %s" % json.dumps(mt5b.get("log")))
        log("     after it settles: morphSeed=%r morphBasis=%r switching=%r tier=%r; "
            "%d committed renders across the morph"
            % (a5b_state.get("seed"), a5b_state.get("mb"), a5b_state.get("sw"),
               a5b_state.get("tier"), a5b_renders))

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
        # ?warp=0 for A4's reason: this compares against a4_mid75, which is a
        # V1-path frame. W4 makes the same claim about the warp path.
        n10 = Nav(page, base, "?tier=borough&morphdur=%d&warp=0" % slow)
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
        #      #v3status.morphReady went on saying true.
        #
        #      Racing the real window from out here is fiddly and flaky — the
        #      warm-up's own fetches gate __NG_DONE__, so "ready" already
        #      implies they have landed. Reproducing the STATE is deterministic
        #      and tests the same predicate: clearing READY.oa.painted leaves
        #      exactly what the bail-out leaves — basis resident, crosswalked,
        #      never painted, absent from the layer stack.
        log("")
        t0 = time.time()
        # ?warp=0, AND THIS ONE IS NOT COSMETIC. A12 exists to prove that
        # morphReady() lets a morph start with an UNPAINTED output-area basis
        # rather than falling back to the curtain for the life of the page.
        # borough->ward is a warped pair in V3 and the warp does not use the
        # output-area basis at all — it is drawn on the ward tier — so with the
        # warp on, clearing READY.oa.painted tests nothing whatsoever and the
        # assertion would pass for the wrong reason. Pinned to V1's path.
        n12 = Nav(page, base, "?tier=borough&warp=0")
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

        # A13. THE ONE-FRAME FLASH. Both swaps in a morph reveal a layer on the
        #      same commit that first hands deck.gl that layer's new values,
        #      and on that commit deck.gl still holds the previous ones — so
        #      the revealed layer draws one frame of whatever it was last DRAWN
        #      with. That is invisible whenever it was last drawn with this
        #      same map, and a flash of a different one whenever it was not: a
        #      measure, year or change-view switch repaints only the tier on
        #      screen, so the first arrival at every other area type after one
        #      showed the old measure for a frame. No screenshot can catch it,
        #      so the page is asked instead: ?flickerprobe=1 signs every
        #      committed frame and this reads the log back.
        #
        #      RUN IN BOTH DIRECTIONS, and that is the point. ?ghost=0 puts the
        #      old swap sequence back, so the same probe, the same route and
        #      the same metric must SEE the defect on one leg and not on the
        #      other. A regression probe that has only ever seen the fixed page
        #      cannot tell a fix from a probe that has stopped looking.
        #
        #      ?highlight=off for the same reason A6 uses it: the peak pulse is
        #      a second animation over the hand-off, and this metric is about
        #      what one frame does that its neighbours do not.
        #      EVERY LEG ASSERTS THE PROBE WAS ALIVE. spike_of() returns 0.0 for
        #      a log shorter than three samples, __flicker.log() returns [] when
        #      the probe never initialised, and probeSample() retires itself into
        #      PROBE.dead rather than throwing (so the errors gate would not
        #      catch it either). Without the liveness check below, the leg that
        #      is supposed to prove the page is clean would pass loudest when
        #      the probe had stopped looking altogether.
        def flicker_leg(extra, what, route):
            t0 = time.time()
            n = Nav(page, base, "?shield=0&highlight=off&flickerprobe=1" + extra)
            got, st, mt = n.poll(morph_capable if "morph=0" not in extra else is_ready,
                                 timeout=180)
            ok = check(n, st, got, "a13 boot " + what)
            ok &= route(n, what)
            time.sleep(0.4)
            info = json.loads(n.js("JSON.stringify(window.__flicker.info())") or "{}")
            raw = n.js("JSON.stringify(window.__flicker.log())")
            flog = json.loads(raw) if raw else []
            alive = bool(info.get("on")) and not info.get("dead") and len(flog) >= 30
            ok &= alive
            worst, at = spike_of(flog)
            log("shot %-24s %-44s %5.1fs  %s"
                % ("-", "A13 " + what, time.time() - t0, "ok" if ok else "FAILED"))
            log("     %s probe alive: on=%s dead=%r %d committed frames signed "
                "(need >= 30), region %s of %s"
                % ("pass" if alive else "FAIL", info.get("on"), info.get("dead") or "",
                   len(flog), info.get("rect"), info.get("canvas")))
            log("     worst one-frame excess %.2f%% of the region%s"
                % (100 * worst,
                   ("  at t=%.0f ms, %s" % (at["t"], at["ev"] or "no mark"))
                   if at else ""))
            return ok, worst, at, len(flog), info

        # The route the defect was found on: paint ward and borough under the
        # opening measure so both layers have been DRAWN and carry a buffer;
        # change the measure, which repaints ONLY the tier on screen and leaves
        # ward and the basis a whole measure out of date; then arrive at ward.
        def route_first_arrival(n, what):
            ok = True
            for area in ("ward", "borough"):
                n.set_area(area)
                got, st, mt = n.poll(done_morphing, timeout=120)
                ok &= check(n, st, got, "a13 %s %s" % (what, area))
                time.sleep(0.35)
            n.js('window.__setMeasure("%s").then(function(){},function(){}); 0' % MEAS2)
            got, st, mt = n.poll(settled, timeout=120)
            ok &= check(n, st, got, "a13 %s measure" % what)
            time.sleep(0.35)
            n.js("window.__flicker.clear(); 0")     # the window is this one switch
            n.set_area("ward")
            got, st, mt = n.poll(done_morphing, timeout=120)
            return ok and check(n, st, got, "a13 %s flash switch" % what)

        # A MEASURE CHANGE LANDING MID-MORPH. apply()'s plain-paint branch calls
        # endMorph() and then paints and reveals the hidden destination on one
        # commit — the same shape as the two swaps, so it was worth measuring
        # rather than assuming. It does NOT flash, and the reason is worth
        # keeping: the out-of-date value the reveal frame draws is the tier's
        # own map on the OLD measure, which is exactly where the 750 ms measure
        # ease is supposed to start from. It is a legitimate animation start,
        # not a wrong frame, and "fixing" it would delete the animation.
        def route_mid_morph_measure(n, what):
            ok = True
            for area in ("ward", "borough"):
                n.set_area(area)
                got, st, mt = n.poll(done_morphing, timeout=120)
                ok &= check(n, st, got, "a13 %s %s" % (what, area))
                time.sleep(0.35)
            n.js("window.__flicker.clear(); 0")
            n.js('window.__setArea("ward").then(function(){},function(){});'
                 'setTimeout(function(){window.__setMeasure("%s")'
                 '.then(function(){},function(){});}, 350); 0' % MEAS2)
            got, st, mt = n.poll(settled, timeout=120)
            return ok and check(n, st, got, "a13 %s mid-morph measure" % what)

        # THE CURTAIN, under ?morph=0, on the same route. Its incoming layer is
        # revealed and repainted on one commit too, so the report's original
        # claim that paintFlat gives it a clean frame needed measuring rather
        # than asserting. It is clean — but not for the reason first written
        # down: the out-of-date value its reveal draws IS the flat baseline
        # paintFlat established while it was hidden, which is what the rise
        # wants. Asserted here so a deck.gl change that broke it would show up
        # as a PRODUCTION defect rather than silently.
        def route_curtain(n, what):
            ok = True
            for area in ("ward", "borough"):
                n.set_area(area)
                got, st, mt = n.poll(settled, timeout=120)
                ok &= check(n, st, got, "a13 %s %s" % (what, area))
                time.sleep(0.6)
            n.js('window.__setMeasure("%s").then(function(){},function(){}); 0' % MEAS2)
            got, st, mt = n.poll(settled, timeout=120)
            ok &= check(n, st, got, "a13 %s measure" % what)
            time.sleep(0.6)
            n.js("window.__flicker.clear(); 0")
            n.set_area("ward")
            got, st, mt = n.poll(settled, timeout=120)
            time.sleep(0.4)
            return ok and check(n, st, got, "a13 %s curtain switch" % what)

        log("")
        a13_fix_ok, a13_fix, a13_fix_at, a13_fix_n, a13_info = flicker_leg(
            "", "fixed page: warm commits on", route_first_arrival)
        log("")
        # THE CONTROL LEG IS PINNED TO ?warp=0. Its whole job is to prove this
        # probe can still SEE the defect, and the defect is a property of V1's
        # seed/reveal — which is the path ?warp=0 takes. Measured on the WARP
        # path the same leg comes back 0.00%, i.e. it does not reproduce there;
        # that is reported below as its own leg rather than being allowed to
        # neuter the control.
        a13_old_ok, a13_old, a13_old_at, a13_old_n, _ = flicker_leg(
            "&warp=0&ghost=0", "?warp=0&ghost=0 control: warm commits off",
            route_first_arrival)
        log("")
        # And the same probe on the WARP path with the warm commits off. This
        # is REPORTED, not gated: it is a number about a code path whose
        # behaviour under ?ghost=0 is not established, and asserting a floor on
        # it would be asserting an explanation this run does not have.
        a13_wg_ok, a13_wg, a13_wg_at, a13_wg_n, _ = flicker_leg(
            "&ghost=0", "?ghost=0 on the WARP path (reported, not gated)",
            route_first_arrival)
        log("")
        a13_mid_ok, a13_mid, a13_mid_at, a13_mid_n, _ = flicker_leg(
            "", "measure change landing MID-MORPH", route_mid_morph_measure)
        log("")
        a13_cur_ok, a13_cur, a13_cur_at, a13_cur_n, _ = flicker_leg(
            "&morph=0", "the CURTAIN, ?morph=0, same route", route_curtain)
        ok_all &= a13_fix_ok and a13_old_ok and a13_mid_ok and a13_cur_ok
        ok_all &= a13_wg_ok

        # =====================================================================
        # THE W ARMS — V3's own claim
        # =====================================================================

        # ---- A0. v3 under ?warp=0 IS v1. Same route, same frame, both pages
        #      served from this same origin. Every other "no regression" claim
        #      in this file is an assertion about v3 measured against itself;
        #      this one is measured against the page v3 was forked from.
        log("")
        t0 = time.time()
        v1base = base.replace("/labs/morph/v3/", "/labs/morph/v1/")
        nz = Nav(page, v1base, "?tier=borough&highlight=off")
        got, st, mt = nz.poll(morph_capable, timeout=180)
        ok_a0 = check(nz, st, got, "A0 v1 boot")
        nz.set_area("ward")
        got, st, mt = nz.poll(done_morphing, timeout=120)
        ok_a0 &= check(nz, st, got, "A0 v1 morph")
        time.sleep(SETTLE)
        page.screenshot(OUT / "a0_v1_ward.png")
        nz = Nav(page, base, "?tier=borough&warp=0&highlight=off")
        got, st, mt = nz.poll(morph_capable, timeout=180)
        ok_a0 &= check(nz, st, got, "A0 v3 warp=0 boot")
        nz.set_area("ward")
        got, st, mt = nz.poll(done_morphing, timeout=120)
        ok_a0 &= check(nz, st, got, "A0 v3 warp=0 morph")
        time.sleep(SETTLE)
        page.screenshot(OUT / "a0_v3_warp0_ward.png")
        log("shot %-24s %-44s %5.1fs  %s"
            % ("a0_*.png", "A0 v1 vs v3 ?warp=0, same route", time.time() - t0,
               "ok" if ok_a0 else "FAILED"))

        # ---- S. THE SPIKE. Four questions, in the order they gate each other.
        log("")
        t0 = time.time()
        nS = Nav(page, base, "?tier=ward&highlight=off")
        got, st, mt = nS.poll(morph_capable, timeout=180)
        ok_s = check(nS, st, got, "S boot")
        s_info = json.loads(nS.js("JSON.stringify(window.__v3.warpInfo())") or "{}")
        time.sleep(SETTLE)
        page.screenshot(OUT / "s_ext_at_rest.png")
        s_gl_rest = page.gl_errors()

        nS2 = Nav(page, base, "?tier=ward&warp=0&highlight=off")
        got, st, mt = nS2.poll(morph_capable, timeout=180)
        ok_s &= check(nS2, st, got, "S warp=0")
        time.sleep(SETTLE)
        page.screenshot(OUT / "s_no_extension.png")

        # The CPU ground truth: v2's warp in Float64, applied to the position
        # buffer BEFORE the first draw, so deck.gl tessellates and projects the
        # inset geography itself and nothing about the picture is the shader's.
        nS3 = Nav(page, base, "?tier=ward&cpuwarp=%s&highlight=off" % WARP_INSET)
        got, st, mt = nS3.poll(morph_capable, timeout=180)
        ok_s &= check(nS3, st, got, "S cpu truth")
        time.sleep(SETTLE)
        page.screenshot(OUT / "s_cpu_truth.png")

        nS4 = Nav(page, base, "?tier=ward&wt=1&highlight=off")
        got, st, mt = nS4.poll(staged, timeout=180)
        ok_s &= check(nS4, st, got, "S gpu warp")
        time.sleep(SETTLE)
        page.screenshot(OUT / "s_gpu_warp.png")
        s_amt = nS4.js("WARP.amount")
        s_gl_warp = page.gl_errors()

        # Frame rate of a pure scrub, values frozen: the envelope on its own.
        nS5 = Nav(page, base, "?tier=ward&highlight=off")
        got, st, mt = nS5.poll(morph_capable, timeout=180)
        ok_s &= check(nS5, st, got, "S fps")
        time.sleep(0.8)
        nS5.js("window.__v3.runWarp(2000)")
        time.sleep(2.9)
        s_fps = json.loads(nS5.js("JSON.stringify(window.__v3.warpInfo())") or "{}")
        s_gl_scrub = page.gl_errors()
        log("shot %-24s %-44s %5.1fs  %s"
            % ("s_*.png", "S the spike: injection, truth, fps",
               time.time() - t0, "ok" if ok_s else "FAILED"))
        log("     warpInfo at boot: %s" % json.dumps(s_info))

        # ---- W1. Both warped directions, endpoint identity.
        #
        #      A REFERENCE WITH MATCHING CHROME. The W arms run with
        #      ?highlight=off, because W2 takes a mid-flight frame and the peak
        #      pulse is a second animation over it. That changes one pill's
        #      text — "Peaks: off" against "Peaks: highest" — so comparing a W
        #      frame against a2_ref_ward.png measures a few hundred pixels of
        #      button label as well as the morph. It passed anyway (0.0146/255
        #      against a 2.0 limit), which is exactly why it is worth removing:
        #      an endpoint assertion should be measuring the endpoint.
        ok_all &= direct("w_ref_ward.png", "?tier=ward&morph=0&highlight=off",
                         "W ward reference, ?highlight=off chrome")
        ok_all &= direct("w_ref_borough.png",
                         "?tier=borough&morph=0&highlight=off",
                         "W borough reference, ?highlight=off chrome")
        log("")
        ok_all &= switch("?tier=borough&highlight=off", "ward",
                         "W1 borough -> ward (warped split)", "w1_split_end.png")
        ok_all &= switch("?tier=ward&highlight=off", "borough",
                         "W1 ward -> borough (warped merge)", "w1_merge_end.png")

        # ---- W2. CONCURRENCY.
        #
        #      Sampled at the envelope's PEAK, and that is not a convenience:
        #      the envelope is stationary there (cubic-in-out reaches the top
        #      with zero velocity), so the tens of milliseconds a screenshot
        #      round trip costs barely move the displacement, and the staged
        #      references can be cut to match it. The uniform is read either
        #      side of the shot and averaged, exactly as the clock is.
        log("")
        t0 = time.time()
        n_w2 = Nav(page, base, "?tier=borough&morphdur=%d&highlight=off" % slow)
        got, st, mt = n_w2.poll(morph_capable, timeout=180)
        ok_w2 = check(n_w2, st, got, "W2 boot")
        w2_inset = n_w2.js("WARP_INSET")
        w2_peak = n_w2.js("WARP_PEAK")
        n_w2.set_area("ward")
        got, st, mt = n_w2.poll(logged("gesture"), timeout=60)
        ok_w2 &= check(n_w2, st, got, "W2 gesture")
        g_at = log_at(mt, "gesture") or n_w2.clock()
        n_w2.wait_clock(g_at + slow * w2_peak)
        a_before = n_w2.js("WARP.amount")
        w2_mid = page.shot_bytes()
        a_after = n_w2.js("WARP.amount")
        (OUT / "w2_mid_peak.png").write_bytes(w2_mid)
        w2_amt = (float(a_before) + float(a_after)) / 2.0
        w2_t = w2_amt / (1.0 - w2_inset) if w2_inset < 1 else 0.0
        got, st, mt = n_w2.poll(done_morphing, timeout=120)
        ok_w2 &= check(n_w2, st, got, "W2 finalise")
        w2_beat = (mt.get("warp") or {})
        w2_log = mt.get("log")
        time.sleep(SETTLE)
        page.screenshot(OUT / "w2_end.png")

        # The four staged references. Two carry the SAME crack the live frame
        # was carrying and differ only in their values; two carry the same
        # values with no crack at all, and exist to prove from pixels — rather
        # than from the page's own report of its uniform — that the live frame
        # really was displaced.
        def stage(fname, q, label):
            n = Nav(page, base, q + "&highlight=off")
            got, st, mt = n.poll(staged, timeout=180)
            ok = check(n, st, got, fname)
            time.sleep(SETTLE)
            page.screenshot(OUT / fname)
            log("shot %-24s %-44s        %s"
                % (fname, label, "ok" if ok else "FAILED"))
            return ok

        ok_w2 &= stage("w2_ref_plateau_cracked.png",
                       "?tier=ward&stage=plateau&wt=%.5f" % w2_t,
                       "W2 ref: plateau values, live crack")
        ok_w2 &= stage("w2_ref_ward_cracked.png",
                       "?tier=ward&wt=%.5f" % w2_t,
                       "W2 ref: ward values, live crack")
        ok_w2 &= stage("w2_ref_plateau_flat.png", "?tier=ward&stage=plateau",
                       "W2 ref: plateau values, no crack")
        ok_w2 &= stage("w2_ref_ward_flat.png", "?tier=ward&warp=0",
                       "W2 ref: ward values, no crack")
        log("shot %-24s %-44s %5.1fs  %s"
            % ("w2_*.png", "W2 concurrency, sampled at the peak",
               time.time() - t0, "ok" if ok_w2 else "FAILED"))
        log("     uniform %.5f -> morphT %.4f (inset %s, peak %s); log %s"
            % (w2_amt, w2_t, w2_inset, w2_peak, json.dumps(w2_log)))

        # ---- W4. A zoom and an interrupt landing mid-warp.
        log("")
        t0 = time.time()
        n_w4 = Nav(page, base, "?tier=borough&morphdur=%d&highlight=off" % slow)
        got, st, mt = n_w4.poll(morph_capable, timeout=180)
        ok_w4 = check(n_w4, st, got, "W4 zoom boot")
        n_w4.set_area("ward")
        got, st, mt = n_w4.poll(logged("gesture"), timeout=60)
        g4 = log_at(mt, "gesture") or n_w4.clock()
        n_w4.wait_clock(g4 + slow * 0.30)
        n_w4.js("window.__applyZoom(13);"
                "setTimeout(function(){window.__applyZoom(0);},80); 0")
        n_w4.wait_clock(g4 + slow * 0.55)
        w4_zoom_amt = n_w4.js("WARP.amount")
        got, st, mt = n_w4.poll(done_morphing, timeout=120)
        ok_w4 &= check(n_w4, st, got, "W4 zoom endpoint")
        w4_zoom_fps = (mt.get("warp") or {}).get("fps")
        time.sleep(SETTLE)
        w4_zoom_end = page.shot_bytes()
        (OUT / "w4_zoom_end.png").write_bytes(w4_zoom_end)

        n_w5 = Nav(page, base, "?tier=borough&morphdur=%d&highlight=off" % slow)
        got, st, mt = n_w5.poll(morph_capable, timeout=180)
        ok_w4 &= check(n_w5, st, got, "W4 interrupt boot")
        n_w5.set_area("ward")
        got, st, mt = n_w5.poll(logged("gesture"), timeout=60)
        g5 = log_at(mt, "gesture") or n_w5.clock()
        n_w5.wait_clock(g5 + slow * 0.35)
        w4_int_amt = n_w5.js("WARP.amount")
        n_w5.set_area("borough")
        got, st5, mt5 = n_w5.poll(done_morphing, timeout=120)
        ok_w4 &= check(n_w5, st5, got, "W4 interrupt endpoint")
        time.sleep(SETTLE)
        w4_int_end = page.shot_bytes()
        (OUT / "w4_interrupt_end.png").write_bytes(w4_int_end)
        w4_int_rest = st5.get("warp")
        log("shot %-24s %-44s %5.1fs  %s"
            % ("w4_*.png", "W4 zoom and interrupt inside the gesture",
               time.time() - t0, "ok" if ok_w4 else "FAILED"))
        log("     zoom: uniform %.5f mid-gesture, %s fps; interrupt fired at "
            "uniform %.5f, settled at %s"
            % (float(w4_zoom_amt or 0), w4_zoom_fps, float(w4_int_amt or 0),
               w4_int_rest))

        gl_all = page.gl_errors()
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

        # ---- A5b retarget inside the seed warm window
        a5b_land = compare(OUT / "a2_ref_ward.png", a5b_end,
                           "A5b a retarget landing INSIDE the seed's warm window "
                           "still lands exactly on the ward map", log,
                           name_b="<a5b final frame, in memory>")
        a5b_all = ok_5b and a5b_land and a5b_seed_clear and a5b_no_watchdog and a5b_drew
        ok_all &= a5b_all
        log("     %s morphSeed is cleared afterwards, not stranded on the tier the "
            "reader left" % ("pass" if a5b_seed_clear else "FAIL"))
        log("     %s the morph was actually DRAWN (%d committed renders, need >= 30)"
            % ("pass" if a5b_drew else "FAIL", a5b_renders))
        log("     %s no watchdog: the commit chain never stalled"
            % ("pass" if a5b_no_watchdog else "FAIL"))
        log("     STRANDING SHOWS IN ALL THREE AT ONCE, and did before the fix:")
        log("     morphSeed stayed \"borough\" for the life of the page, the whole")
        log("     750 ms morph took four committed renders because the layer being")
        log("     animated was not the one being drawn, and the watchdog forced the")
        log("     animate through at +693 ms. The endpoint alone would not have")
        log("     caught it — FINALISE reveals the destination either way.")
        log("%s A5b a retarget inside the warm window is an ordinary interrupt"
            % ("PASS" if a5b_all else "FAIL"))
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
        log("     while #v3status.morphReady — the field this driver gates on — said true.")
        log("%s A12 an unpainted basis is a morph that pays its own tessellation, "
            "not a dead one" % ("PASS" if a12_all else "FAIL"))
        log("")

        # ---- A13 the one-frame flash
        a13_clean = a13_fix <= FLICKER_LIMIT
        a13_seen = a13_old >= FLICKER_FLOOR
        a13_mid_clean = a13_mid <= FLICKER_LIMIT
        a13_cur_clean = a13_cur <= FLICKER_LIMIT
        a13_all = (a13_fix_ok and a13_old_ok and a13_mid_ok and a13_cur_ok
                   and a13_wg_ok
                   and a13_clean and a13_seen and a13_mid_clean and a13_cur_clean)
        ok_all &= a13_all
        log("A13 the one-frame flash: a layer revealed on the same commit that first")
        log("    hands deck.gl its new values, signed frame by frame from inside the")
        log("    render loop. The excess below is an L1 histogram distance over the")
        log("    sampled region, so it is about TWICE the share of pixels that changed")
        log("    luminance bucket: 23.5% here is roughly 11.8% of the region's pixels.")
        log("     region %s of %s"
            % (a13_info.get("rect"), a13_info.get("canvas")))
        log("     %s fixed page, first arrival after a measure change  %6.2f%%  "
            "(limit %.2f%%, %d frames)"
            % ("pass" if a13_clean else "FAIL", 100 * a13_fix,
               100 * FLICKER_LIMIT, a13_fix_n))
        log("     %s ?ghost=0 control, the same route                  %6.2f%%  "
            "(floor %.2f%%, %d frames)"
            % ("pass" if a13_seen else "FAIL", 100 * a13_old,
               100 * FLICKER_FLOOR, a13_old_n))
        if a13_old_at:
            log("          the control's spike is at %s"
                % (a13_old_at.get("ev") or "an unmarked frame"))
        log("     %s measure change landing MID-MORPH                  %6.2f%%  "
            "(limit %.2f%%, %d frames)"
            % ("pass" if a13_mid_clean else "FAIL", 100 * a13_mid,
               100 * FLICKER_LIMIT, a13_mid_n))
        log("     %s the CURTAIN under ?morph=0, the same route        %6.2f%%  "
            "(limit %.2f%%, %d frames)"
            % ("pass" if a13_cur_clean else "FAIL", 100 * a13_cur,
               100 * FLICKER_LIMIT, a13_cur_n))
        log("     .... ?ghost=0 on the WARP path                     %6.2f%%  "
            "(REPORTED, %d frames)" % (100 * a13_wg, a13_wg_n))
        log("     THE WARP PATH DOES NOT REPRODUCE THE DEFECT WITH ITS WARM COMMITS")
        log("     TURNED OFF, and this run does not establish why. The honest")
        log("     statement is the measurement: on V1's path ?ghost=0 shows the")
        log("     flash and on the warp path it does not. The warp split still")
        log("     ships the ghost commit — it is cheap, it is V1's invariant, and")
        log("     an unexplained absence is not a reason to remove a guard. What")
        log("     it does mean is that the warp leg above is NOT evidence that the")
        log("     ghost is working there; only the V1 leg carries that.")
        log("     THE CONTROL LEG IS THE ASSERTION THAT THIS PROBE CAN STILL FAIL.")
        log("     Under ?ghost=0 the seed and the hand-off each reveal a layer on the")
        log("     same commit that first gives deck.gl its new values, and deck.gl")
        log("     draws an out-of-date one. The frames either side agree with each")
        log("     other, so the excess is the whole of the difference between two")
        log("     measures - L1 23.5% of the region at the seed and 8.3% at the")
        log("     hand-off when this was first caught, against 0.02% with the warm")
        log("     commits on.")
        log("     The last two legs are paths this fix does NOT touch, measured rather")
        log("     than assumed. Both reveal a layer and repaint it on one commit, and")
        log("     both are clean, because the out-of-date value each one draws is")
        log("     already the value that frame wanted: the start of the measure ease")
        log("     in one case, the flat baseline paintFlat established in the other.")
        log("     CAVEAT: one 512x384 region of a 1400x950 canvas. A defect that only")
        log("     moved pixels outside it would pass. The rect is settable with")
        log("     ?fpx/?fpy/?fpw/?fph; this leg uses the default.")
        log("%s A13 no committed frame shows a picture its neighbours do not"
            % ("PASS" if a13_all else "FAIL"))

        # =====================================================================
        # W ASSERTIONS
        # =====================================================================
        log("")
        ok_all &= compare(OUT / "a0_v1_ward.png", OUT / "a0_v3_warp0_ward.png",
                          "A0 NO REGRESSION, measured against v1 itself: the same "
                          "borough -> ward route through v1 and through v3 under "
                          "?warp=0 land on the same frame", log)
        ok_all &= ok_a0
        log("")

        # ---- S. THE SPIKE
        log("S THE SPIKE: does a LayerExtension move a SolidPolygonLayer's "
            "vertices at all?")
        log("     v2's verdict on deck.gl's own answer stands and is why this "
            "exists: declaring")
        log("     transitions:{getPolygon} does not animate the positions, it "
            "BLANKS the layer —")
        log("     ink 0.0363 against a drawn 0.3166, 12 WebGL "
            "INVALID_OPERATIONs per frame, and a")
        log("     page error count of 0 throughout. V3 never touches that "
            "attribute. It adds one")
        log("     Float32 per-vertex attribute and one float uniform, and "
            "injects at")
        log("     vs:DECKGL_FILTER_GL_POSITION — the only one of deck.gl's four "
            "declared hooks")
        log("     that can reach position (vs:#decl lands above the attribute "
            "declarations and a")
        log("     GLSL `in` is read-only anyway; vs:#main-start lands before "
            "props.positions is")
        log("     assigned and vs:#main-end after the vertex is already "
            "projected and lit).")
        s_attr = (s_info or {}).get("attr") or {}
        s_bound = (bool((s_info or {}).get("on")) and bool((s_info or {}).get("attached"))
                   and s_attr.get("size") == 2
                   and int(s_attr.get("bytes") or 0) == 2 * int((s_info or {}).get("verts") or 0)
                   and int((s_info or {}).get("verts") or 0) > 0)
        log("     %s the extension is attached and its attribute BOUND: "
            "%s x%s %s, %s values for %s vertices"
            % ("pass" if s_bound else "FAIL", s_attr.get("type"),
               s_attr.get("size"), s_attr.get("step"), s_attr.get("bytes"),
               (s_info or {}).get("verts")))

        s_rest = compare(OUT / "s_no_extension.png", OUT / "s_ext_at_rest.png",
                         "S1 AT REST the extension is invisible: the page carrying "
                         "it at morphT 0 against the page built without it at all",
                         log)
        s_rest_mad = mad_of(OUT / "s_no_extension.png", OUT / "s_ext_at_rest.png")
        s_exact = s_rest_mad == 0.0
        log("     %s and it is EXACT, not merely close (%0.4f/255). It has to be: "
            "the displacement"
            % ("pass" if s_exact else "note", s_rest_mad))
        log("     is (centroid - vertex) * amount, so amount = 0 multiplies the "
            "whole of the")
        log("     float32 centroid's error by zero. Every endpoint assertion in "
            "this file rests on it.")
        log("")
        s_truth = compare(OUT / "s_cpu_truth.png", OUT / "s_gpu_warp.png",
                          "S2 the SHADER warp reproduces a CPU warp of the same "
                          "geometry at inset %s — v2's warp in Float64, applied to "
                          "the position buffer before the first draw so deck.gl "
                          "tessellates the inset geography itself" % WARP_INSET,
                          log)
        s_ink_cpu, s_ink_gpu = ink(OUT / "s_cpu_truth.png"), ink(OUT / "s_gpu_warp.png")
        log("     ink %.4f (CPU truth) vs %.4f (GPU warp); uniform at the shot %s"
            % (s_ink_cpu, s_ink_gpu, s_amt))
        log("     THIS IS ALSO THE SIDE-WALL ASSERTION. The top faces are drawn "
            "from a")
        log("     NON-instanced model and the walls from an INSTANCED one, off "
            "the same buffers")
        log("     and through two different vertex shaders; the wall shader "
            "interpolates")
        log("     mix(vertexPositions, nextVertexPositions, ...). A displacement "
            "that reached the")
        log("     tops and not the walls, or sheared between them, could not "
            "come within")
        log("     %.4f/255 of a picture whose walls were tessellated in the "
            "warped position." % mad_of(OUT / "s_cpu_truth.png", OUT / "s_gpu_warp.png"))
        log("     The attribute is the RING CENTROID rather than the "
            "displacement for exactly")
        log("     this reason: it is constant along a ring, so mixing it is a "
            "no-op and no")
        log("     nextMorphDelta view and no RING_WINDING_ORDER swap is needed.")
        log("")

        s_gl_total = len(s_gl_rest) + len(s_gl_warp) + len(s_gl_scrub)
        s_no_gl = s_gl_total == 0
        s_no_blank = min(ink(OUT / "s_ext_at_rest.png"), s_ink_gpu) >= INK_FLOOR
        log("     %s NO BLANKING: ink %.4f at rest and %.4f fully warped "
            "(floor %.2f, v2's blanked layer 0.0363)"
            % ("pass" if s_no_blank else "FAIL", ink(OUT / "s_ext_at_rest.png"),
               s_ink_gpu, INK_FLOOR))
        log("     %s NO WebGL ERRORS from the browser's own log across rest, "
            "full warp and a 2 s scrub (%d)"
            % ("pass" if s_no_gl else "FAIL", s_gl_total))
        if not s_no_gl:
            for x in (s_gl_rest + s_gl_warp + s_gl_scrub)[:8]:
                log("        %s" % x)
        s_fps_v = float((s_fps or {}).get("fps") or 0)
        s_worst = float((s_fps or {}).get("worst") or 0)
        s_fast = s_fps_v >= MIN_WARP_FPS
        log("     %s SCRUB %.1f fps over %s frames, worst frame %.1f ms "
            "(floor %.0f)"
            % ("pass" if s_fast else "FAIL", s_fps_v, (s_fps or {}).get("frames"),
               s_worst, MIN_WARP_FPS))
        log("        v2's CPU warp measured 34.5-46.0 fps on this machine, in this "
            "harness, at this")
        log("        grain, and could not run a value transition at the same time "
            "at any speed.")
        log("        Headless Chrome does not lock rAF to vsync, so the mean is "
            "THROUGHPUT and not a")
        log("        claim about a 60 Hz screen. THE WORST FRAME IS NOT SMALL: "
            "%.1f ms here, against" % s_worst)
        log("        8-11 ms measured in isolated probes of the same code. The "
            "mean hides it, this")
        log("        line does not, and it is carried into the report as an open "
            "concern rather than")
        log("        as a 60 fps claim.")
        s_all = (ok_s and s_bound and s_rest and s_truth and s_no_gl
                 and s_no_blank and s_fast)
        ok_all &= s_all
        log("%s S the injection reaches position, draws, and is exact at rest"
            % ("PASS" if s_all else "FAIL"))
        log("")

        # ---- W1
        ok_all &= compare(OUT / "w_ref_ward.png", OUT / "w1_split_end.png",
                          "W1 SPLIT endpoint: borough -> ward as ONE warped "
                          "gesture lands on exactly the ward map", log)
        log("")
        ok_all &= compare(OUT / "w_ref_borough.png", OUT / "w1_merge_end.png",
                          "W1 MERGE endpoint: ward -> borough as ONE warped "
                          "gesture hands back exactly the borough map", log)
        log("")

        # ---- W2 CONCURRENCY
        log("W2 CONCURRENCY — the claim V3 exists to make")
        log("     v2 could not do this and measured why: rewriting the position "
            "buffer per frame")
        log("     forces deck.gl to re-tessellate, re-tessellation re-reads every "
            "attribute, and the")
        log("     colour transition therefore restarted on EVERY frame. Measured "
            "live in v2's own")
        log("     driver, every run: the values sat 29.25% across at the 84% "
            "mark of the ease,")
        log("     where a working transition is at ~96.6%. That is what forced "
            "its three separate")
        log("     beats. V3 never changes the geometry deck.gl holds, so there "
            "is nothing to")
        log("     restart and the two can share one timeline.")
        log("     Sampled at the envelope's PEAK, where cubic-in-out is "
            "stationary, so the")
        log("     screenshot round trip barely moves the displacement and the "
            "references can be")
        log("     staged to match it: uniform %.5f, i.e. morphT %.4f of a "
            "1-%s crack."
            % (w2_amt, w2_t, w2_inset))
        w2_cfg_ok = (abs(float(w2_inset) - WARP_INSET) < 1e-9
                     and abs(float(w2_peak) - WARP_PEAK) < 1e-9)
        log("     %s the page's own inset/peak match this driver's (%s, %s)"
            % ("pass" if w2_cfg_ok else "FAIL", w2_inset, w2_peak))

        A = OUT / "w2_ref_plateau_cracked.png"
        B = OUT / "w2_ref_ward_cracked.png"
        Af = OUT / "w2_ref_plateau_flat.png"
        Bf = OUT / "w2_ref_ward_flat.png"
        span = mad_of(A, B)
        w2_prog = (mad_of(w2_mid, A) / span) if span else 0.0
        log("     the two same-crack references are %.4f/255 apart" % span)
        log("     the live frame is %.4f/255 from the plateau end and %.4f/255 "
            "from the ward end"
            % (mad_of(w2_mid, A), mad_of(w2_mid, B)))
        w2_val_ok = 0.10 <= w2_prog <= 0.90
        log("     %s VALUE PROGRESS %.2f%% across, strictly interior "
            "(band 10-90%%)"
            % ("pass" if w2_val_ok else "FAIL", 100 * w2_prog))

        d_cracked = mad_of(w2_mid, A) + mad_of(w2_mid, B)
        d_flat = mad_of(w2_mid, Af) + mad_of(w2_mid, Bf)
        w2_pos_ok = d_flat > d_cracked
        log("     %s POSITION DISPLACEMENT, from pixels rather than from the "
            "page's own report of"
            % ("pass" if w2_pos_ok else "FAIL"))
        log("        its uniform: the live frame sits %.4f/255 from the CRACKED "
            "pair and %.4f/255"
            % (d_cracked, d_flat))
        log("        from the same two states with the crack closed, so it "
            "belongs to the cracked")
        log("        family. A frame whose geometry had not moved could not.")
        w2_amt_ok = w2_amt > 0.9 * (1.0 - float(w2_inset))
        log("     %s and the page reports the uniform at %.5f, %.1f%% of a full "
            "crack"
            % ("pass" if w2_amt_ok else "FAIL", w2_amt,
               100 * w2_amt / max(1e-9, 1.0 - float(w2_inset))))
        w2_end_ok = compare(OUT / "w_ref_ward.png", OUT / "w2_end.png",
                            "W2 and the gesture still lands exactly on the ward map",
                            log)
        w2_fps = float((w2_beat or {}).get("fps") or 0)
        w2_fps_ok = w2_fps >= MIN_WARP_FPS
        log("     %s W3 the gesture held %.1f fps over %s frames, worst %.1f ms "
            "(floor %.0f)"
            % ("pass" if w2_fps_ok else "FAIL", w2_fps, (w2_beat or {}).get("frames"),
               float((w2_beat or {}).get("worst") or 0), MIN_WARP_FPS))
        log("     phase log: %s" % json.dumps(w2_log))
        w2_all = (ok_w2 and w2_cfg_ok and w2_val_ok and w2_pos_ok and w2_amt_ok
                  and w2_end_ok and w2_fps_ok)
        ok_all &= w2_all
        log("%s W2/W3 the values and the crack move TOGETHER, at %.0f fps"
            % ("PASS" if w2_all else "FAIL", w2_fps))
        log("")

        # ---- W4
        w4_zoom_ok = compare(OUT / "w_ref_ward.png", w4_zoom_end,
                             "W4a a zoom landing inside the gesture — two "
                             "elevationScale layer-stack rebuilds mid-warp — still "
                             "lands exactly on the ward map", log,
                             name_b="<w4 zoom final frame, in memory>")
        log("     the uniform was %.5f when the zoom landed, so the warp really "
            "was in flight"
            % float(w4_zoom_amt or 0))
        log("")
        w4_int_ok = compare(OUT / "w_ref_borough.png", w4_int_end,
                            "W4b an interrupt landing inside the gesture — the "
                            "opposite pill at 35% — lands exactly on the borough "
                            "map", log,
                            name_b="<w4 interrupt final frame, in memory>")
        w4_rest_ok = (w4_int_rest == 0)
        log("     %s the crack is fully closed afterwards (uniform %s): an "
            "interrupt hands its"
            % ("pass" if w4_rest_ok else "FAIL", w4_int_rest))
        log("        open crack to the next gesture's envelope, or eases it shut "
            "over 180 ms if")
        log("        there is no next gesture — it is never snapped.")
        w4_all = ok_w4 and w4_zoom_ok and w4_int_ok and w4_rest_ok
        ok_all &= w4_all
        log("%s W4 the gesture survives a zoom and an interrupt"
            % ("PASS" if w4_all else "FAIL"))
        log("")

        # ---- THE INK GATE, over every committed frame
        shots = sorted(OUT.glob("*.png"))
        inks = [(f.name, ink(f)) for f in shots]
        dark = [x for x in inks if x[1] < INK_FLOOR]
        ink_ok = not dark and len(inks) > 0
        ok_all &= ink_ok
        log("INK GATE: every committed frame shows a drawn map")
        log("     %d PNGs, ink from %.4f to %.4f, floor %.2f"
            % (len(inks), min(x[1] for x in inks) if inks else 0,
               max(x[1] for x in inks) if inks else 0, INK_FLOOR))
        for nm, v in dark:
            log("     FAIL %s ink %.4f" % (nm, v))
        log("     v2 spent a sprint with a BLANK map, a clean page error count "
            "and nothing in")
        log("     window.onerror, because a WebGL INVALID_OPERATION is not a "
            "JavaScript")
        log("     exception. errors==0 is not a drawing assertion; this is.")
        log("%s INK GATE" % ("PASS" if ink_ok else "FAIL"))
        gl_final = len(gl_all)
        ok_all &= (gl_final == 0)
        log("%s NO WebGL ERRORS anywhere in the run (%d), read from the "
            "browser's own log over CDP"
            % ("PASS" if gl_final == 0 else "FAIL", gl_final))
        for x in gl_all[:8]:
            log("     %s" % x)

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
        log("  * WHETHER THE ONE-GESTURE WARP READS AS ONE GESTURE. This driver")
        log("    proves the crack and the values move together and that the")
        log("    endpoints are exact; whether a 0.38 peak is the right place for")
        log("    the seams to be widest, and whether 750 ms is enough room for")
        log("    the whole shape, are eye questions. ?bench=1 gives a slider")
        log("    straight onto the uniform for judging the inset by hand.")
        log("  * seam shimmer WHILE the crack is open, under rotation. The warp")
        log("    is a per-ring similarity transform so no normal changes, but")
        log("    whether the newly exposed side walls read as walls or as gaps")
        log("    is not a still-frame question.")
        log("  * the warp at OA grain. Nothing here says it looks right at")
        log("    26,369 features — only that the cost of trying would be the")
        log("    same one float, which is what v2's CPU path could not say.")
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
