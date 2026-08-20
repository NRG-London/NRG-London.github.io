#!/usr/bin/env python3
"""Full verification battery for the merged wards<->hexes crime chart at
static/labs/crime/v1/ (V1-V15). Independent of, and more adversarial than,
the page's own 10-leg smoke (investigations/crime_map_v2/capture_v1_smoke.py).

Serves the Hugo static tree (the page fetches d/*.json; V14 also needs
/interactive/crime-skyline/ under the same origin), drives headless Chrome
over a raw CDP websocket (plumbing lifted from tools/morph-lab/capture_v1.py /
viz3d/capture_phasea_checks.py — headless Edge one-shot CLI no-ops on this
machine), writes evidence PNGs + RESULTS.txt into captures/v1/ and exits
non-zero if any hard leg fails. V14 (parity vs the production skyline) is
PASS-with-notes: the two pages ship different default cameras (lat 51.47/51.445,
zoom 9.8/9.75, pitch 50/55), so it measures ink-distribution agreement and
states plainly what was measured.

    python tools/crime-lab/capture_v1.py
"""
import base64
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "static"
OUT = ROOT / "tools" / "crime-lab" / "captures" / "v1"
LAB_PATH = "/labs/crime/v1/"
SKY_PATH = "/interactive/crime-skyline/"

WIDTH, HEIGHT = 1400, 950
BG = np.array([26, 35, 50], dtype=np.int16)   # both pages: body #1A2332
INK_PX = 40           # a pixel is "ink" when any channel sits this far off BG
INK_FLOOR_HEX = 0.02  # central-crop ink floor, hex tier
INK_FLOOR_WARD = 0.05 # ward towers cover more of the frame
MAD_CHANGE = 2.0      # central MAD above which two frames "differ"
MAD_MID = 1.0         # central MAD floor for a mid-flight frame vs an endpoint
MAD_STABLE = 0.5      # central MAD under which two settled frames "agree"
SAG_FLOOR = 0.85      # V12: ~250ms frame keeps >= this share of final ink

# V13 ground truth, from the build spec (the leg recomputes the page's own
# loaded data over CDP and compares EXACTLY):
EXPECTED_TOTALS = {"tfp": 349693, "robbery": 145404, "shoplifting": 300795,
                   "burglary": 260490, "vehicle": 487896, "bike": 84151,
                   "damage": 271400, "publicorder": 284873}

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]
FLAG_SETS = [
    ("real GPU", []),
    ("disable-gpu", ["--disable-gpu"]),
    ("disable-gpu + unsafe-swiftshader", ["--disable-gpu", "--enable-unsafe-swiftshader"]),
]
BASE_FLAGS = [
    "--headless=new",
    "--window-size=%d,%d" % (WIDTH, HEIGHT),
    "--force-device-scale-factor=1",
    "--force-color-profile=srgb",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
]


def asc(s):
    """Console-safe: the page's notes carry a U+2019 apostrophe."""
    return str(s).encode("ascii", "backslashreplace").decode()


# ---- CDP plumbing (verbatim pattern from capture_phasea_checks.py) ----------
class WS:
    def __init__(self, host, port, path, timeout=180):
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
        head = bytearray([0x81])
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
            if opcode == 0x9:
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
    def __init__(self, port, timeout=180):
        import urllib.request
        self._url = urllib.request
        self.port = port
        info = self._http("PUT", "/json/new?about:blank")
        self.target = info["id"]
        url = info["webSocketDebuggerUrl"]
        path = "/" + url.split("/", 3)[3]
        self.ws = WS("127.0.0.1", port, path, timeout=timeout)
        self.next_id = 0
        self.events = []
        self.call("Emulation.setDeviceMetricsOverride",
                  {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1,
                   "mobile": False})
        # silent WebGL failures land in the browser log, not window.onerror
        self.call("Log.enable")
        self.call("Runtime.enable")

    def _http(self, method, path):
        req = self._url.Request("http://127.0.0.1:%d%s" % (self.port, path),
                                method=method)
        with self._url.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())

    def call(self, method, params=None):
        self.next_id += 1
        mid = self.next_id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if "method" in msg:
                self.events.append(msg)
                continue
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s: %s" % (method, msg["error"]))
                return msg.get("result", {})

    def logs(self, clear=True):
        out = []
        for m in self.events:
            p = m.get("params", {})
            if m["method"] == "Log.entryAdded":
                out.append(p.get("entry", {}).get("text", ""))
            elif m["method"] == "Runtime.consoleAPICalled":
                if p.get("type") in ("error", "warning"):
                    out.append(" ".join(str(a.get("value")) for a in p.get("args", [])))
            elif m["method"] == "Runtime.exceptionThrown":
                d = p.get("exceptionDetails", {})
                out.append(d.get("text", "") + " " +
                           str((d.get("exception") or {}).get("description", "")))
        if clear:
            self.events = []
        return [x.strip() for x in out if x and x.strip()]

    def hard_errors(self, clear=True):
        """Log lines that are defects rather than chatter (a cancelled tile
        fetch 4xx is chatter; GL errors and JS exceptions are not)."""
        bad = []
        for x in self.logs(clear):
            if ("INVALID_" in x or "WebGL" in x or "Uncaught" in x
                    or "TypeError" in x or "ReferenceError" in x):
                bad.append(x)
        return bad

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
        feats = [{"name": "prefers-reduced-motion", "value": "reduce"}] if on else []
        self.call("Emulation.setEmulatedMedia", {"features": feats})

    def throttle(self, kbps=400, latency_ms=120):
        """Cache off + slow wire, so V15's hex band fetch is GENUINELY pending
        for seconds after __NG_DONE__ (hex.220.json is 2.6 MB: ~6.5 s at
        400 KB/s)."""
        self.call("Network.enable")
        self.call("Network.setCacheDisabled", {"cacheDisabled": True})
        self.call("Network.emulateNetworkConditions",
                  {"offline": False, "latency": latency_ms,
                   "downloadThroughput": kbps * 1024,
                   "uploadThroughput": kbps * 1024})

    def shot_bytes(self):
        r = self.call("Page.captureScreenshot",
                      {"format": "png", "captureBeyondViewport": False})
        return base64.b64decode(r["data"])

    def screenshot(self, path):
        b = self.shot_bytes()
        Path(path).write_bytes(b)
        return b

    def clock(self):
        v = self.evaluate("Math.round(performance.now())")
        return v if isinstance(v, (int, float)) else 0

    def wait_clock(self, deadline, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            if self.clock() >= deadline:
                return True
            time.sleep(0.004)
        return False

    def close(self):
        self.ws.close()
        try:
            self._http("GET", "/json/close/" + self.target)
        except Exception:
            pass


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def serve_port():
    """A port in 8720-8760, per the brief (other tasks may hold other ports)."""
    for p in range(8720, 8761):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", p))
            s.close()
            return p
        except OSError:
            s.close()
    sys.exit("no free port in 8720-8760")


def find_browser():
    for b in BROWSERS:
        if Path(b).exists():
            return b
    sys.exit("no chrome.exe found in the standard install paths")


def wait_devtools(port, timeout=40):
    import urllib.request
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(
                    "http://127.0.0.1:%d/json/version" % port, timeout=2) as r:
                json.loads(r.read().decode())
                return True
        except Exception:
            time.sleep(0.25)
    return False


def launch(browser, flags, port):
    profile = tempfile.mkdtemp(prefix="crimev1-")
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


# ---- pixels -----------------------------------------------------------------
def img(src):
    if isinstance(src, (bytes, bytearray)):
        return np.asarray(Image.open(io.BytesIO(src)).convert("RGB"), dtype=np.int16)
    return np.asarray(Image.open(src).convert("RGB"), dtype=np.int16)


def central(a):
    """The map's belly: clear of the title card, switcher rows and foot."""
    h, w = a.shape[:2]
    return a[int(0.18 * h):int(0.85 * h), int(0.22 * w):int(0.78 * w)]


def ink_frac(src, thresh=INK_PX):
    a = central(img(src))
    return float((np.abs(a - BG).max(axis=2) > thresh).mean())


def ink_mask(src, thresh=INK_PX):
    a = central(img(src))
    return np.abs(a - BG).max(axis=2) > thresh


def mad_central(a, b):
    x, y = central(img(a)), central(img(b))
    return float(np.abs(x - y).mean())


def mad_full(a, b):
    return float(np.abs(img(a) - img(b)).mean())


def lum(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


# ---- driver helpers ---------------------------------------------------------
class Leg:
    def __init__(self, name, desc):
        self.name, self.desc = name, desc
        self.ok = True
        self.soft = False       # PASS-with-notes leg (V14)
        self.notes = []

    def note(self, s):
        self.notes.append(s)
        print("     " + asc(s))

    def check(self, cond, s):
        tag = "pass" if cond else "FAIL"
        self.notes.append("%s %s" % (tag, s))
        print("     %s %s" % (tag, asc(s)))
        if not cond:
            self.ok = False
        return cond


def wait_done(page, leg, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate("window.__NG_DONE__ === true"):
            err = page.evaluate("String(window.__NG_ERROR__ || '')")
            leg.check(not err, "__NG_DONE__ true, __NG_ERROR__ falsy%s"
                      % ("" if not err else " (got: %s)" % err))
            return True
        time.sleep(0.05)
    leg.check(False, "__NG_DONE__ never became true within %ds" % timeout)
    return False


def wait_eased(page, timeout=6.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate("window.__easing === false"):
            return True, time.time() - t0
        time.sleep(0.02)
    return False, time.time() - t0


def wait_js(page, expr, timeout=60.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate(expr):
            return True
        time.sleep(0.1)
    return False


def state(page):
    return json.loads(page.evaluate("JSON.stringify(window.__state())") or "{}")


def no_hard_errors(page, leg, when):
    errs = page.hard_errors()
    leg.check(not errs, "no console/GL errors %s%s"
              % (when, "" if not errs else " (got: %s)" % "; ".join(errs[:3])[:300]))
    err = page.evaluate("String(window.__NG_ERROR__ || '')")
    leg.check(not err, "__NG_ERROR__ still falsy %s%s"
              % (when, "" if not err else " (got: %s)" % err))


def trigger_now(page, js):
    """Run js and return the page clock at which it ran."""
    return page.evaluate("(function(){%s; return performance.now();})()" % js)


def shot_at(page, t0, offset_ms, path):
    """Screenshot aimed at page-clock t0+offset; the landing is bracketed by
    clock samples either side and the midpoint reported."""
    page.wait_clock(t0 + offset_ms - 70)
    c0 = page.clock()
    png = page.screenshot(path)
    c1 = page.clock()
    return png, (c0 + c1) / 2.0 - t0


def observe_easing(page, t0, window_ms):
    """Poll __easing hard until it is seen true or the window closes."""
    while page.clock() < t0 + window_ms:
        if page.evaluate("window.__easing === true"):
            return True
    return False


def wait_tiles(page, timeout=30.0):
    """Generous CARTO tile wait: shots until two frames 2.0s apart agree."""
    t0 = time.time()
    time.sleep(5.0)
    prev = page.shot_bytes()
    while time.time() - t0 < timeout:
        time.sleep(2.0)
        cur = page.shot_bytes()
        if mad_full(cur, prev) < 0.5:
            return cur, time.time() - t0
        prev = cur
    return prev, time.time() - t0


# ---- the battery ------------------------------------------------------------
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    browser = find_browser()
    http_port = serve_port()
    httpd = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(http_port), "--bind", "127.0.0.1"],
        cwd=str(STATIC), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    lab_url = "http://127.0.0.1:%d%s" % (http_port, LAB_PATH)
    sky_url = "http://127.0.0.1:%d%s" % (http_port, SKY_PATH)
    legs = []
    proc = profile = None
    try:
        time.sleep(0.8)   # http.server boot

        # boot probe: first flag set whose Chrome draws the lab page
        cdp_port = free_port()
        booted = None
        for label, flags in FLAG_SETS:
            proc, profile = launch(browser, flags, cdp_port)
            probe = Page(cdp_port)
            try:
                probe.navigate(lab_url)
                end = time.time() + 60
                ok = False
                while time.time() < end:
                    if probe.evaluate("window.__NG_DONE__ === true"):
                        ok = True
                        break
                    time.sleep(0.1)
                if ok and ink_frac(probe.shot_bytes()) > INK_FLOOR_HEX:
                    booted = label
            finally:
                probe.close()
            if booted:
                break
            kill(proc, profile)
            proc = profile = None
            cdp_port = free_port()
        if not booted:
            sys.exit("no flag set both booted and drew the lab page")
        print("browser: %s (%s)" % (browser, booted))
        print("serving: %s -> %s" % (STATIC, lab_url))

        page = Page(cdp_port)
        try:
            # ---------------- V1: load, ward tier default ----------------
            L = Leg("V1", "load: done gate, ward tier default, state sane, ink")
            legs.append(L)
            print("== V1 " + L.desc)
            page.navigate(lab_url)
            wait_done(page, L)
            time.sleep(0.8)
            v1_png = page.screenshot(OUT / "v1_load_wards.png")
            f = ink_frac(v1_png)
            L.check(f > INK_FLOOR_WARD,
                    "ward towers inked: central ink %.4f > %.3f" % (f, INK_FLOOR_WARD))
            st = state(page)
            L.note("__state() = %s" % json.dumps(st))
            L.check(st.get("tier") == "wards", "tier wards")
            L.check(st.get("metric") == "phone_theft" and st.get("period") == "all"
                    and st.get("band") == 220 and st.get("mode") == "boroughs",
                    "metric/period/band/mode = phone_theft/all/220/boroughs")
            no_hard_errors(page, L, "after load")

            # ---------------- V2: ward metric transition eases ----------------
            L = Leg("V2", "ward metric phone_theft->burglary: mid-frame between "
                          "endpoints, final stable")
            legs.append(L)
            print("== V2 " + L.desc)
            base = v1_png
            t0 = trigger_now(page, "window.__setMetric('burglary')")
            mid, t_mid = shot_at(page, t0, 350, OUT / "v2_mid350.png")
            page.wait_clock(t0 + 1400)
            time.sleep(0.3)
            fin = page.screenshot(OUT / "v2_final.png")
            time.sleep(0.5)
            fin2 = page.shot_bytes()
            d_mb, d_mf, d_bf = (mad_central(mid, base), mad_central(mid, fin),
                                mad_central(fin, base))
            d_stable = mad_central(fin2, fin)
            L.note("mid frame at ~%.0fms of the 750ms ease; central MAD mid-base "
                   "%.2f, mid-final %.2f, final-base %.2f" % (t_mid, d_mb, d_mf, d_bf))
            L.check(d_bf > MAD_CHANGE, "endpoints differ (MAD %.2f > %.1f)" % (d_bf, MAD_CHANGE))
            L.check(d_mb > MAD_MID, "mid differs from base (MAD %.2f > %.1f)" % (d_mb, MAD_MID))
            L.check(d_mf > MAD_MID, "mid differs from final (MAD %.2f > %.1f)" % (d_mf, MAD_MID))
            L.check(d_stable < MAD_STABLE,
                    "final stable: two settled frames 0.5s apart agree (MAD %.3f < %.1f)"
                    % (d_stable, MAD_STABLE))
            L.check(state(page).get("metric") == "burglary", "state metric burglary")
            no_hard_errors(page, L, "after the metric ease")
            ward_burglary = fin

            # ---------------- V3: tier switch wards -> hexes ----------------
            L = Leg("V3", "tier wards->hexes: __easing true->false, trough sinks "
                          "extrusions, lands inked on hexes")
            legs.append(L)
            print("== V3 " + L.desc)
            # TWO PHASES, per a measured capture artifact (probe-validated):
            # on the FIRST hex entry the renderer stalls for hundreds of ms
            # building the 26k-column layer (shader compile + buffer upload),
            # and any CDP screenshot issued near the trough lands ~400-2000ms
            # late AND carries a stale pre-swap frame — the first battery
            # run's "250ms" shot landed at 641ms and photographed a frame
            # visually identical to the wards ENDPOINT (MAD 0.08 vs base), so
            # no single-shot design can photograph the cold trough. The COLD
            # entry (shipped timing) is therefore asserted page-side — elevT
            # sampled to its floor, __easing true->false — and the trough
            # PHOTO is taken on a warm re-entry of the same code path, where
            # capture latency is normal, with a burst + min-ink selection.
            # Min-ink matters: a fall-side trough frame keeps the ward
            # carpet's colored footprint (measured: ink 0.48 of the wards
            # endpoint's 0.51, ext_base only 0.03), so only a hex-side trough
            # frame separates extrusions from carpet decisively (measured:
            # trough ink 0.0878, ext_base 0.4387, ext_fin 0.1357).
            #
            # phase A: cold first entry, sampled page-side
            t0 = trigger_now(page, "window.__setTier('hexes')")
            min_e, seen, n = 10.0, False, 0
            while page.clock() < t0 + 1200:
                v = page.evaluate("JSON.stringify([elevT, window.__easing])")
                if v:
                    e, ea = json.loads(v)
                    n += 1
                    if isinstance(e, (int, float)) and e < min_e:
                        min_e = e
                    seen = seen or (ea is True)
            settled, waited = wait_eased(page)
            L.note("cold entry: %d page-side [elevT, __easing] samples across "
                   "the swap" % n)
            L.check(seen, "__easing observed true during the cold swap")
            L.check(settled, "__easing false again (%.2fs after the sample window)"
                    % waited)
            L.check(min_e < 0.10,
                    "the field sank to the floor: min elevT sampled %.4f < 0.10"
                    % min_e)
            time.sleep(0.6)
            fin = page.screenshot(OUT / "v3_final_hexes.png")
            st = state(page)
            L.check(st.get("tier") == "hexes" and st.get("band") == 220,
                    "state tier hexes, band 220: %s" % json.dumps(st))
            f = ink_frac(fin)
            L.check(f > INK_FLOOR_HEX, "hex tier inked %.4f > %.3f" % (f, INK_FLOOR_HEX))
            # phase B: warm re-entry of the same path, for the trough photo
            trigger_now(page, "window.__setTier('wards')")
            wait_eased(page)
            time.sleep(1.2)
            pre = page.screenshot(OUT / "v3_warm_wards.png")
            t0 = trigger_now(page, "window.__setTier('hexes')")
            shots = []
            while True:
                c0 = page.clock()
                png = page.shot_bytes()
                c1 = page.clock()
                elev = page.evaluate("elevT")
                shots.append(((c0 + c1) / 2.0 - t0, png, elev))
                if c1 - t0 > 900:
                    break
            settled, waited = wait_eased(page)
            L.check(settled, "warm re-entry settled (%.2fs)" % waited)
            time.sleep(0.8)
            fin2 = page.screenshot(OUT / "v3_warm_hexes.png")
            bi, fi = ink_mask(pre), ink_mask(fin2)
            trough = min(shots, key=lambda s: float(ink_mask(s[1]).mean()))
            (OUT / "v3_trough.png").write_bytes(trough[1])
            ti = ink_mask(trough[1])
            ext_base, ext_fin = float((bi & ~ti).mean()), float((fi & ~ti).mean())
            t_only = float((ti & ~(bi | fi)).mean())
            L.note("burst of %d frames across the warm swap; min-ink frame "
                   "bracketed at ~%.0fms (elevT sampled just after it: %s)"
                   % (len(shots), trough[0], trough[2]))
            L.note("ink shares: wards-endpoint %.4f, trough %.4f, hexes-endpoint %.4f"
                   % (float(bi.mean()), float(ti.mean()), float(fi.mean())))
            L.check(float(ti.mean()) < 0.5 * min(float(bi.mean()), float(fi.mean())),
                    "trough frame carries under half of either endpoint's ink "
                    "(%.4f vs %.4f / %.4f)"
                    % (float(ti.mean()), float(bi.mean()), float(fi.mean())))
            L.check(ext_base > max(0.004, 0.15 * float(bi.mean())),
                    "wards endpoint carries material extrusion ink above the trough "
                    "(%.4f)" % ext_base)
            L.check(ext_fin > max(0.004, 0.15 * float(fi.mean())),
                    "hexes endpoint carries material extrusion ink above the trough "
                    "(%.4f)" % ext_fin)
            L.check(t_only < 0.15 * max(float(ti.mean()), 1e-9),
                    "nothing rises AT the trough (trough-only ink %.4f)" % t_only)
            no_hard_errors(page, L, "after the tier switch")
            hex_burglary = fin2

            # ---------------- V4: per-hex metric transition ----------------
            L = Leg("V4", "hex metric burglary->shoplifting: per-hex attribute "
                          "transition, mid-frame strictly between endpoints")
            legs.append(L)
            print("== V4 " + L.desc)
            base = hex_burglary
            t0 = trigger_now(page, "window.__setMetric('shoplifting')")
            mid, t_mid = shot_at(page, t0, 350, OUT / "v4_mid350.png")
            page.wait_clock(t0 + 1400)
            time.sleep(0.3)
            fin = page.screenshot(OUT / "v4_final_shoplifting.png")
            d_mb, d_mf, d_bf = (mad_central(mid, base), mad_central(mid, fin),
                                mad_central(fin, base))
            L.note("mid frame at ~%.0fms; central MAD mid-base %.2f, mid-final %.2f, "
                   "final-base %.2f" % (t_mid, d_mb, d_mf, d_bf))
            L.check(d_bf > MAD_CHANGE, "endpoints differ (MAD %.2f > %.1f)" % (d_bf, MAD_CHANGE))
            L.check(d_mb > MAD_MID and d_mf > MAD_MID,
                    "mid-frame strictly between endpoints (%.2f / %.2f both > %.1f)"
                    % (d_mb, d_mf, MAD_MID))
            L.check(state(page).get("metric") == "shoplifting", "state metric shoplifting")
            no_hard_errors(page, L, "after the hex metric transition")
            hex_shoplifting = fin

            # ---------------- V5: hex year switch ----------------
            L = Leg("V5", "hex year all->2022: mid-frame between endpoints, "
                          "caption names 2022")
            legs.append(L)
            print("== V5 " + L.desc)
            base = hex_shoplifting
            before = page.evaluate("current.year")
            t0 = trigger_now(page, "window.__setYear('2022')")
            after = page.evaluate("current.year")
            L.note("accepted form probe: current.year %r -> %r after "
                   "__setYear('2022') (string form accepted)" % (before, after))
            if after != "2022":
                t0 = trigger_now(page, "window.__setYear(2022)")
                after = page.evaluate("current.year")
                L.note("string form rejected; number form -> %r" % after)
            L.check(after == "2022", "committed year is 2022")
            mid, t_mid = shot_at(page, t0, 350, OUT / "v5_mid350.png")
            page.wait_clock(t0 + 1400)
            time.sleep(0.3)
            fin = page.screenshot(OUT / "v5_final_2022.png")
            d_mb, d_mf, d_bf = (mad_central(mid, base), mad_central(mid, fin),
                                mad_central(fin, base))
            L.note("mid frame at ~%.0fms; central MAD mid-base %.2f, mid-final %.2f, "
                   "final-base %.2f" % (t_mid, d_mb, d_mf, d_bf))
            L.check(d_bf > MAD_MID, "endpoints differ (MAD %.2f > %.1f)" % (d_bf, MAD_MID))
            L.check(d_mb > 0.5 and d_mf > 0.5,
                    "mid-frame between endpoints (%.2f / %.2f both > 0.5)" % (d_mb, d_mf))
            st = state(page)
            L.check(st.get("period") == "2022", "state period 2022: %s" % json.dumps(st))
            sub = page.evaluate("document.getElementById('subtitle').textContent") or ""
            L.check("2022" in sub, "caption DOM contains 2022: %r" % asc(sub[:110]))
            no_hard_errors(page, L, "after the year switch")
            hex_2022 = fin

            # ---------------- V6: band switch ease ----------------
            L = Leg("V6", "band 220->120 via __applyZoom at the CFG midpoint: "
                          "__easing fires, lands on band 120")
            legs.append(L)
            print("== V6 " + L.desc)
            th = json.loads(page.evaluate("JSON.stringify(THRESHOLDS)") or "[]")
            z = (th[0] + th[1]) / 2.0
            L.note("runtime CFG.zoomThresholds %s -> __applyZoom(%.2f) targets the "
                   "middle (120 m) band" % (th, z))
            L.note("HEX[120] prefetched already: %s"
                   % page.evaluate("!!(window.HEX && HEX[120])"))
            t0 = trigger_now(page, "window.__applyZoom(%s)" % z)
            seen = observe_easing(page, t0, 2500)
            ok_band = wait_js(page, "window.__state().band === 120", 30)
            settled, waited = wait_eased(page)
            L.check(seen, "__easing observed true during the band swap")
            L.check(ok_band, "band swap landed")
            L.check(settled, "__easing false again in %.2fs" % waited)
            time.sleep(0.5)
            fin = page.screenshot(OUT / "v6_band120.png")
            st = state(page)
            L.check(st.get("band") == 120 and st.get("tier") == "hexes",
                    "final state band 120: %s" % json.dumps(st))
            d = mad_central(fin, hex_2022)
            L.check(d > MAD_MID, "band flip changed pixels (MAD %.2f > %.1f)" % (d, MAD_MID))
            no_hard_errors(page, L, "after the band flip")

            # ---------------- V7: tier round trip hexes -> wards ----------------
            L = Leg("V7", "tier round trip hexes->wards: state, ink and ward "
                          "caption restored")
            legs.append(L)
            print("== V7 " + L.desc)
            t0 = trigger_now(page, "window.__setTier('wards')")
            seen = observe_easing(page, t0, 600)
            settled, waited = wait_eased(page)
            L.check(seen, "__easing observed true during the swap")
            L.check(settled, "__easing false again in %.2fs" % waited)
            page.wait_clock(t0 + 1200)   # let the fadeText caption land too
            time.sleep(0.4)
            fin = page.screenshot(OUT / "v7_back_wards.png")
            st = state(page)
            L.check(st.get("tier") == "wards" and st.get("metric") == "shoplifting"
                    and st.get("period") == "2022",
                    "state restored: shared metric + year survive: %s" % json.dumps(st))
            f = ink_frac(fin)
            L.check(f > INK_FLOOR_WARD, "ward towers inked %.4f > %.3f" % (f, INK_FLOOR_WARD))
            title = page.evaluate("document.getElementById('title').textContent") or ""
            want = page.evaluate(
                "CFG.wardMetrics['shoplifting'].captions['2022'].title") or ""
            L.check(bool(title) and title == want,
                    "ward caption restored: title == CFG.wardMetrics.shoplifting"
                    ".captions['2022'].title (%r)" % asc(title[:80]))
            no_hard_errors(page, L, "after the round trip")

            # ---------------- V8: availability logic ----------------
            L = Leg("V8", "availability: ward-only pill no-ops greyed in hex tier; "
                          "hex-only tfp falls back to robbery entering wards")
            legs.append(L)
            print("== V8 " + L.desc)
            trigger_now(page, "window.__setTier('hexes')")
            settled, _ = wait_eased(page)
            L.check(settled, "entered hex tier (shoplifting is shared, no fallback)")
            st = state(page)
            L.check(st.get("tier") == "hexes" and st.get("metric") == "shoplifting",
                    "hex tier, metric shoplifting: %s" % json.dumps(st))
            page.evaluate("window.__setMetric('phone_theft'); 0")
            time.sleep(0.4)
            st = state(page)
            L.check(st.get("metric") == "shoplifting",
                    "__setMetric('phone_theft') in hex tier left the metric "
                    "unchanged: %s" % json.dumps(st))
            grey = page.evaluate(
                "document.querySelector('#switcher button[data-key=\"phone_theft\"]')"
                ".classList.contains('unavail')")
            L.check(grey is True, "phone_theft pill carries the greyed class "
                    "('unavail'): %s" % grey)
            sub = page.evaluate("document.getElementById('subtitle').textContent") or ""
            L.check("only available in the Wards view" in sub,
                    "subtitle hints at the no-op: %r" % asc(sub[-120:]))
            page.screenshot(OUT / "v8_greyed_pill.png")
            # hex-only metric, then leave for wards -> fallback robbery
            t0 = trigger_now(page, "window.__setMetric('tfp')")
            page.wait_clock(t0 + 1300)
            L.check(state(page).get("metric") == "tfp", "hex-only tfp set in hex tier")
            t0 = trigger_now(page, "window.__setTier('wards')")
            settled, _ = wait_eased(page)
            L.check(settled, "tier swap back to wards settled")
            page.wait_clock(t0 + 1200)
            time.sleep(0.3)
            st = state(page)
            L.check(st.get("tier") == "wards" and st.get("metric") == "robbery",
                    "tfp fell back to the ward fallback metric robbery: %s"
                    % json.dumps(st))
            sub = page.evaluate("document.getElementById('subtitle').textContent") or ""
            L.check(("showing Robbery" in sub),
                    "subtitle mentions the swap: %r" % asc(sub[-140:]))
            page.screenshot(OUT / "v8_fallback_robbery.png")
            no_hard_errors(page, L, "after the availability checks")

            # ---------------- V9: street mode in hex tier ----------------
            L = Leg("V9", "street mode in hex tier: light-base, attribution, tile "
                          "ink in a margin crop; back to boroughs clean")
            legs.append(L)
            print("== V9 " + L.desc)
            trigger_now(page, "window.__setTier('hexes')")
            settled, _ = wait_eased(page)
            L.check(settled, "entered hex tier for the street leg")
            time.sleep(0.6)
            boro = page.screenshot(OUT / "v9_boroughs_ref.png")
            page.evaluate("window.__setMode('street'); 0")
            street, waited = wait_tiles(page)
            (OUT / "v9_street.png").write_bytes(street)
            L.note("tile settle wait %.1fs" % waited)
            L.check(page.evaluate(
                "document.body.classList.contains('light-base')") is True,
                "body has light-base class in street mode")
            attrib = page.evaluate("document.getElementById('attrib').textContent") or ""
            L.check(bool(attrib) and "CARTO" in attrib,
                    "attribution non-empty and names CARTO: %r" % asc(attrib))
            # tile ink in margin crops that are flat in boroughs mode
            bi_img, si_img = img(boro), img(street)
            h, w = bi_img.shape[:2]
            cs = 130
            regions = {"TL": (15, 15), "TR": (15, w - cs - 15),
                       "BL": (h - cs - 15, 15), "BR": (h - cs - 15, w - cs - 15),
                       "midL": (int(0.5 * h), 15), "midR": (int(0.5 * h), w - cs - 15)}
            found = None
            for nm, (y, x) in regions.items():
                cb, cst = bi_img[y:y + cs, x:x + cs], si_img[y:y + cs, x:x + cs]
                flat = float(lum(cb).std())
                changed = float(np.abs(cst - cb).mean())
                detail = float(lum(cst).std())
                L.note("margin %s: boroughs lum-std %.2f, street-vs-boroughs MAD "
                       "%.2f, street lum-std %.2f" % (nm, flat, changed, detail))
                if flat < 9.0 and changed > 20.0 and detail > 6.0 and found is None:
                    found = nm
            L.check(found is not None,
                    "a boroughs-flat margin crop carries tile ink in street mode "
                    "(region %s)" % found)
            page.evaluate("window.__setMode('boroughs'); 0")
            time.sleep(1.0)
            L.check(page.evaluate(
                "document.body.classList.contains('light-base')") is False,
                "light-base class off back in boroughs mode")
            a2 = page.evaluate("document.getElementById('attrib').textContent")
            L.check(a2 == "", "attribution emptied back in boroughs mode: %r" % a2)
            page.screenshot(OUT / "v9_back_boroughs.png")
            no_hard_errors(page, L, "after the street round trip")

            # ---------------- V10: interrupt storm ----------------
            L = Leg("V10", "interrupt storm: burglary, +120ms vehicle, +240ms "
                           "year 2023 -> lands vehicle/2023, no errors")
            legs.append(L)
            print("== V10 " + L.desc)
            pre = page.shot_bytes()
            t0 = trigger_now(
                page,
                "window.__setMetric('burglary');"
                "setTimeout(function(){window.__setMetric('vehicle');},120);"
                "setTimeout(function(){window.__setYear('2023');},240)")
            page.wait_clock(t0 + 240 + 750 + 400)
            settled, waited = wait_eased(page, 8)
            L.check(settled, "__easing false after the storm (%.1fs)" % waited)
            ok = wait_js(page, "window.__state().metric === 'vehicle' && "
                               "window.__state().period === '2023'", 10)
            st = state(page)
            L.check(ok and st.get("metric") == "vehicle" and st.get("period") == "2023",
                    "state carries the last calls: vehicle/2023: %s" % json.dumps(st))
            time.sleep(0.5)
            fin = page.screenshot(OUT / "v10_storm_final.png")
            f = ink_frac(fin)
            L.check(f > INK_FLOOR_HEX, "hex tier inked after the storm %.4f > %.3f"
                    % (f, INK_FLOOR_HEX))
            d = mad_central(fin, pre)
            L.note("final differs from pre-storm frame by central MAD %.2f" % d)
            no_hard_errors(page, L, "after the interrupt storm")

            # ---------------- V11: rapid tier toggles ----------------
            L = Leg("V11", "rapid tier toggles wards->hexes->wards at 150ms "
                           "spacing: ends wards, settled, inked")
            legs.append(L)
            print("== V11 " + L.desc)
            trigger_now(page, "window.__setTier('wards')")
            settled, _ = wait_eased(page)
            L.check(settled, "staged: back on wards before the toggles")
            t0 = trigger_now(
                page,
                "window.__setTier('hexes');"
                "setTimeout(function(){window.__setTier('wards');},150)")
            page.wait_clock(t0 + 150 + 280 + 420 + 300)
            settled, waited = wait_eased(page, 8)
            L.check(settled, "__easing false after the toggles (%.1fs)" % waited)
            st = state(page)
            L.check(st.get("tier") == "wards", "ends on wards: %s" % json.dumps(st))
            time.sleep(0.5)
            fin = page.screenshot(OUT / "v11_toggles_final.png")
            f = ink_frac(fin)
            L.check(f > INK_FLOOR_WARD, "ward towers inked %.4f > %.3f"
                    % (f, INK_FLOOR_WARD))
            no_hard_errors(page, L, "after the rapid toggles")

            # ---------------- V13: totals (data honesty) ----------------
            # (run on this warm page: all bands prefetched by now; V12 needs a
            # fresh load and V13 does not, so the numbering crosses here)
            L = Leg("V13", "data honesty: the page's own loaded hex data sums to "
                           "the published all-period totals, exactly")
            legs.append(L)
            print("== V13 " + L.desc)
            got = page.evaluate(
                "JSON.stringify((function(){var out={};"
                "var ks=Object.keys(HEX[220].metrics);"
                "for(var i=0;i<ks.length;i++){var sp=HEX[220].metrics[ks[i]]['all'];"
                "var s=0;for(var j=0;j<sp.v.length;j++)s+=sp.v[j];out[ks[i]]=s;}"
                "return out;})())")
            totals = json.loads(got or "{}")
            L.note("measured from HEX[220] in-page: %s" % json.dumps(totals))
            L.check(set(totals.keys()) == set(EXPECTED_TOTALS.keys()),
                    "exactly the 8 hex metrics present: %s" % sorted(totals.keys()))
            for k in sorted(EXPECTED_TOTALS):
                L.check(totals.get(k) == EXPECTED_TOTALS[k],
                        "%s: measured %s == expected %d"
                        % (k, totals.get(k), EXPECTED_TOTALS[k]))
            # cross-band honesty: the 120m band must conserve the same counts
            got120 = page.evaluate(
                "window.HEX && HEX[120] ? JSON.stringify((function(){var out={};"
                "var ks=Object.keys(HEX[120].metrics);"
                "for(var i=0;i<ks.length;i++){var sp=HEX[120].metrics[ks[i]]['all'];"
                "var s=0;for(var j=0;j<sp.v.length;j++)s+=sp.v[j];out[ks[i]]=s;}"
                "return out;})()) : 'ABSENT'")
            if got120 and got120 != "ABSENT":
                t120 = json.loads(got120)
                same = all(t120.get(k) == EXPECTED_TOTALS[k] for k in EXPECTED_TOTALS)
                L.check(same, "band 120 conserves the same totals (binning "
                              "conserves counts): %s" % same)
            else:
                L.note("HEX[120] not resident; cross-band check skipped")
            no_hard_errors(page, L, "after the totals evaluate")
        finally:
            page.close()

        # ---------------- V12: reduced motion (fresh load) ----------------
        L = Leg("V12", "prefers-reduced-motion: metric + tier switches are "
                       "effectively instant (no __easing, no trough sag)")
        legs.append(L)
        print("== V12 " + L.desc)
        page = Page(cdp_port)
        try:
            page.reduced_motion(True)
            page.navigate(lab_url)
            wait_done(page, L)
            L.check(page.evaluate("reducedMotion") is True,
                    "page parsed prefers-reduced-motion: reduce")
            L.check(page.evaluate("TRANSITION") == 0,
                    "attribute-transition duration is 0")
            time.sleep(0.8)
            base = page.screenshot(OUT / "v12_base.png")
            # metric switch: instant
            t0 = trigger_now(page, "window.__setMetric('burglary')")
            seen = observe_easing(page, t0, 150)
            mid, t_mid = shot_at(page, t0, 250, OUT / "v12_metric_mid250.png")
            page.wait_clock(t0 + 900)
            time.sleep(0.3)
            fin = page.screenshot(OUT / "v12_metric_final.png")
            d_change, d_mid = mad_central(fin, base), mad_central(mid, fin)
            L.check(not seen, "__easing never true across the metric switch")
            L.note("metric switch: ~250ms frame vs final MAD %.3f; final vs base "
                   "MAD %.2f" % (d_mid, d_change))
            L.check(d_change > MAD_CHANGE, "the switch did happen (MAD %.2f > %.1f)"
                    % (d_change, MAD_CHANGE))
            L.check(d_mid < MAD_MID,
                    "no easing tail: ~250ms frame already agrees with the final "
                    "(MAD %.3f < %.1f)" % (d_mid, MAD_MID))
            # tier switch: instant, no sag at ~250ms
            t0 = trigger_now(page, "window.__setTier('hexes')")
            seen = observe_easing(page, t0, 300)
            mid, t_mid = shot_at(page, t0, 250, OUT / "v12_tier_mid250.png")
            time.sleep(1.0)
            fin = page.screenshot(OUT / "v12_tier_final.png")
            L.check(not seen, "__easing never true across the tier switch")
            mi, fi2 = ink_frac(mid), ink_frac(fin)
            L.note("tier switch: ink at ~%.0fms %.4f vs final %.4f" % (t_mid, mi, fi2))
            L.check(mi >= SAG_FLOOR * fi2,
                    "no trough sag: ~250ms ink %.4f >= %.0f%% of final %.4f"
                    % (mi, 100 * SAG_FLOOR, fi2))
            st = state(page)
            L.check(st.get("tier") == "hexes", "tier landed: %s" % json.dumps(st))
            no_hard_errors(page, L, "after the reduced-motion switches")
        finally:
            page.close()

        # ---------------- V14: parity vs the production skyline ----------------
        L = Leg("V14", "parity: lab ward tier vs production /interactive/"
                       "crime-skyline/ at robbery/All (PASS-with-notes)")
        L.soft = True
        legs.append(L)
        print("== V14 " + L.desc)
        page = Page(cdp_port)
        try:
            # lab, ward tier, robbery/All, default camera
            page.navigate(lab_url)
            wait_done(page, L)
            t0 = trigger_now(page, "window.__setMetric('robbery')")
            page.wait_clock(t0 + 1500)
            time.sleep(0.5)
            lab_png = page.screenshot(OUT / "v14_lab_wards_robbery.png")
            lab_cam = page.evaluate("JSON.stringify(CFG.camera)")
            lab_st = state(page)
            L.check(lab_st.get("tier") == "wards" and lab_st.get("metric") == "robbery"
                    and lab_st.get("period") == "all",
                    "lab driven to wards/robbery/all: %s" % json.dumps(lab_st))
            # production skyline, robbery/All, default camera
            page.navigate(sky_url)
            wait_done(page, L)
            t0 = trigger_now(page, "window.__setMetric('robbery')")
            page.wait_clock(t0 + 1500)
            time.sleep(0.5)
            sky_png = page.screenshot(OUT / "v14_skyline_robbery.png")
            sky_cam = page.evaluate("JSON.stringify(CFG.camera)")
            sky_cur = page.evaluate("JSON.stringify(current)")
            L.check(json.loads(sky_cur or "{}").get("metric") == "robbery"
                    and json.loads(sky_cur or "{}").get("year") == "all",
                    "skyline driven to robbery/all: %s" % sky_cur)
            L.note("lab camera:     %s" % lab_cam)
            L.note("skyline camera: %s" % sky_cam)
            same_cam = lab_cam == sky_cam
            L.note("cameras identical: %s -> comparison is %s" %
                   (same_cam, "pixel-exact" if same_cam
                    else "ink-DISTRIBUTION (qualitative), as the brief allows"))
            # measured comparison over the central map crop (chrome excluded)
            la, sa = central(img(lab_png)), central(img(sky_png))
            lm = np.abs(la - BG).max(axis=2) > INK_PX
            sm = np.abs(sa - BG).max(axis=2) > INK_PX
            li, si = float(lm.mean()), float(sm.mean())
            d = float(np.abs(la - sa).mean())
            col_l, col_s = lm.mean(axis=0), sm.mean(axis=0)
            row_l, row_s = lm.mean(axis=1), sm.mean(axis=1)

            def corr(a, b):
                a = a - a.mean(); b = b - b.mean()
                den = float(np.sqrt((a * a).sum() * (b * b).sum()))
                return float((a * b).sum() / den) if den else float("nan")
            c_col, c_row = corr(col_l, col_s), corr(row_l, row_s)
            iou = float((lm & sm).sum()) / max(1, (lm | sm).sum())
            L.note("MEASURED on the central crop (18-85%% h x 22-78%% w): central "
                   "MAD %.2f; ink %.4f (lab) vs %.4f (skyline); ink-mask IoU %.3f; "
                   "ink-profile correlation columns %.3f, rows %.3f"
                   % (d, li, si, iou, c_col, c_row))
            L.check(li > INK_FLOOR_WARD and si > INK_FLOOR_WARD,
                    "both frames carry a ward skyline (ink %.4f / %.4f)" % (li, si))
            L.check(c_col > 0.6,
                    "east-west ink distribution agrees (column-profile r %.3f > 0.6; "
                    "the residual difference is the shipped camera offset)" % c_col)
            L.note("row-profile r %.3f is EXPECTED to be lower when cameras differ "
                   "(pitch 50 vs 55 + latitude shift move towers vertically)" % c_row)
            no_hard_errors(page, L, "after the parity captures")
        finally:
            page.close()

        # ---------------- V15: cold-race regression ----------------
        L = Leg("V15", "cold race: cache off + ~400KB/s; tier+metric+year fired "
                       "in one task while hex.220 still fetching")
        legs.append(L)
        print("== V15 " + L.desc)
        page = Page(cdp_port)
        try:
            page.throttle(kbps=400, latency_ms=120)
            page.navigate(lab_url)
            wait_done(page, L, timeout=180)
            res = page.evaluate(
                "(function(){var pending = !(window.HEX && HEX[220]);"
                "window.__setTier('hexes');"
                "window.__setMetric('publicorder');"
                "window.__setYear('2023');"
                "return JSON.stringify({pending: pending, tier: current.tier,"
                " metric: current.metric, year: current.year});})()")
            res = json.loads(res or "{}")
            L.check(res.get("pending") is True,
                    "hex.220 fetch GENUINELY pending at the trigger (measured in "
                    "the same synchronous evaluate): %s" % res.get("pending"))
            L.check(res.get("tier") == "hexes" and res.get("metric") == "publicorder"
                    and res.get("year") == "2023",
                    "committed state carries the full selection immediately: %s"
                    % json.dumps(res))
            ok = wait_js(page, "window.__state().tier === 'hexes'", 90)
            L.check(ok, "tier swap landed once the fetch arrived")
            settled, waited = wait_eased(page, 20)
            L.check(settled, "__easing false (settled %.1fs after landing)" % waited)
            st = state(page)
            L.check(st.get("metric") == "publicorder" and st.get("period") == "2023"
                    and st.get("band") == 220,
                    "rendered state carries the full selection: %s" % json.dumps(st))
            time.sleep(0.5)
            fin = page.screenshot(OUT / "v15_cold_race.png")
            f = ink_frac(fin)
            L.check(f > INK_FLOOR_HEX, "hex tier inked after the race %.4f > %.3f"
                    % (f, INK_FLOOR_HEX))
            no_hard_errors(page, L, "after the cold race")
        finally:
            page.close()
    finally:
        if proc is not None:
            kill(proc, profile)
        httpd.terminate()

    # ---- table + RESULTS.txt ----
    lines = []
    lines.append("crime lab v1 battery - %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    lab_file = STATIC / "labs" / "crime" / "v1" / "index.html"
    sky_file = STATIC / "interactive" / "crime-skyline" / "index.html"
    for p, nm in ((lab_file, "lab page"), (sky_file, "skyline")):
        lines.append("%-9s %s (%d bytes, mtime %s)"
                     % (nm + ":", p, p.stat().st_size,
                        time.strftime("%Y-%m-%d %H:%M", time.localtime(p.stat().st_mtime))))
    lines.append("viewport %dx%d; ink threshold >%d/255 off #1A2332; central crop "
                 "18-85%% h x 22-78%% w" % (WIDTH, HEIGHT, INK_PX))
    lines.append("")
    table = []
    all_ok = True
    for L in legs:
        if L.soft:
            status = "PASS*" if L.ok else "FAIL"
        else:
            status = "PASS" if L.ok else "FAIL"
        all_ok = all_ok and L.ok
        table.append("%-4s %-6s %s" % (L.name, status, L.desc))
    if any(L.soft for L in legs):
        table.append("     (*) V14 is the parity leg: PASS-with-notes; see its "
                     "measured section")
    lines.extend(table)
    lines.append("")
    for L in legs:
        lines.append("---- %s: %s" % (L.name, L.desc))
        lines.extend("  " + n for n in L.notes)
        lines.append("")
    (OUT / "RESULTS.txt").write_text("\n".join(lines), encoding="utf-8")
    print()
    print("\n".join(asc(t) for t in table))
    print("\nRESULTS: %s" % (OUT / "RESULTS.txt"))
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
