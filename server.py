#!/usr/bin/env python3
"""
WiiSportsPhone - local game server.

Serves the game screen (for your PC) and the controller page (for your phone)
over HTTPS on your LAN, and relays phone motion data to the screen over a
WebSocket. Pure standard library: no pip install required.

    python server.py

Then open the printed https:// address on your phone.
"""

import base64
import hashlib
import json
import os
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CERTS = os.path.join(HERE, "certs")
CERT = os.path.join(CERTS, "cert.pem")
KEY = os.path.join(CERTS, "key.pem")

HTTPS_PORT = int(os.environ.get("WSP_PORT", "8443"))
REDIRECT_PORT = int(os.environ.get("WSP_HTTP_PORT", "8080"))

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


# --------------------------------------------------------------------------
# network helpers
# --------------------------------------------------------------------------

def primary_ip():
    """Best guess at the LAN address other devices should dial."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def all_ips():
    ips = {primary_ip()}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except socket.gaierror:
        pass
    ips.discard("0.0.0.0")
    return sorted(ips)


# --------------------------------------------------------------------------
# certificate
# --------------------------------------------------------------------------

def find_openssl():
    found = shutil.which("openssl")
    if found:
        return found
    candidates = [
        "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
        "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
        "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return None


def cert_covers(ips):
    """True if an existing cert already lists every address we care about."""
    if not (os.path.exists(CERT) and os.path.exists(KEY)):
        return False
    openssl = find_openssl()
    if not openssl:
        return True  # cannot check, assume the existing one is fine
    try:
        out = subprocess.run(
            [openssl, "x509", "-in", CERT, "-noout", "-text"],
            capture_output=True, text=True, timeout=20,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return True
    return all(("IP Address:" + ip) in out for ip in ips)


def ensure_cert(ips):
    if cert_covers(ips):
        return True
    openssl = find_openssl()
    if not openssl:
        print("!! Could not find openssl, so no HTTPS certificate can be made.")
        print("   Install Git for Windows (it ships OpenSSL) and run this again.")
        return False

    os.makedirs(CERTS, exist_ok=True)
    san = ",".join(["DNS:localhost"] + ["IP:" + ip for ip in ips] + ["IP:127.0.0.1"])
    print("-> Creating a self-signed certificate for " + ", ".join(ips))
    cmd = [
        openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", KEY, "-out", CERT,
        "-days", "820", "-subj", "/CN=WiiSportsPhone",
        "-addext", "subjectAltName=" + san,
        "-addext", "basicConstraints=CA:FALSE",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print("!! openssl failed:\n" + res.stderr)
        return False
    return True


# --------------------------------------------------------------------------
# websocket framing
# --------------------------------------------------------------------------

class WSClosed(Exception):
    pass


def ws_frame(payload, opcode=0x1):
    """Build an unmasked server->client frame."""
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    head = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head.append(n)
    elif n < 65536:
        head.append(126)
        head += struct.pack(">H", n)
    else:
        head.append(127)
        head += struct.pack(">Q", n)
    return bytes(head) + payload


def _read_exact(rfile, n):
    buf = b""
    while len(buf) < n:
        chunk = rfile.read(n - len(buf))
        if not chunk:
            raise WSClosed()
        buf += chunk
    return buf


def ws_read(rfile):
    """Read one client frame. Returns (opcode, payload_bytes)."""
    b1, b2 = _read_exact(rfile, 2)
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _read_exact(rfile, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _read_exact(rfile, 8))[0]
    if length > (1 << 20):
        raise WSClosed()
    mask = _read_exact(rfile, 4) if masked else None
    data = _read_exact(rfile, length) if length else b""
    if mask:
        data = bytes(byte ^ mask[i & 3] for i, byte in enumerate(data))
    return opcode, data


# --------------------------------------------------------------------------
# the hub: who is connected, and who hears whom
# --------------------------------------------------------------------------

class Client:
    def __init__(self, wfile, role):
        self.wfile = wfile
        self.role = role          # "screen" or "phone"
        self.pid = None           # player slot, phones only
        self.name = ""
        self.lock = threading.Lock()
        self.alive = True

    def send(self, obj):
        if not self.alive:
            return
        data = ws_frame(json.dumps(obj, separators=(",", ":")))
        try:
            with self.lock:
                self.wfile.write(data)
                self.wfile.flush()
        except OSError:
            self.alive = False


class Hub:
    def __init__(self):
        self.lock = threading.RLock()
        self.clients = []

    def add(self, client):
        with self.lock:
            if client.role == "phone":
                taken = set(c.pid for c in self.clients if c.role == "phone")
                client.pid = next(i for i in range(1, 9) if i not in taken)
            self.clients.append(client)
        if client.role == "phone":
            client.send({"t": "assigned", "pid": client.pid})
            print("   phone connected  -> player " + str(client.pid))
        else:
            print("   game screen connected")
        self.announce()

    def remove(self, client):
        with self.lock:
            if client in self.clients:
                self.clients.remove(client)
        client.alive = False
        if client.role == "phone":
            print("   phone disconnected (player " + str(client.pid) + ")")
            self.to_screens({"t": "leave", "pid": client.pid})
        else:
            print("   game screen disconnected")
        self.announce()

    def snapshot(self):
        with self.lock:
            return list(self.clients)

    def announce(self):
        """Tell everyone the current roster."""
        clients = self.snapshot()
        phones = [{"pid": c.pid, "name": c.name}
                  for c in clients if c.role == "phone"]
        screens = sum(1 for c in clients if c.role == "screen")
        msg = {"t": "roster", "players": phones, "screens": screens}
        for c in clients:
            c.send(msg)

    def to_screens(self, msg):
        for c in self.snapshot():
            if c.role == "screen":
                c.send(msg)

    def to_phone(self, pid, msg):
        for c in self.snapshot():
            if c.role == "phone" and c.pid == pid:
                c.send(msg)

    def to_phones(self, msg):
        for c in self.snapshot():
            if c.role == "phone":
                c.send(msg)


HUB = Hub()


# --------------------------------------------------------------------------
# http + websocket handler
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "WiiSportsPhone"

    def setup(self):
        BaseHTTPRequestHandler.setup(self)
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    def log_message(self, fmt, *args):
        pass  # the interesting events are logged by the hub instead

    # -- routing ----------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/ws":
            self.do_websocket()
            return
        if path == "/info":
            self.serve_info()
            return
        if path == "/":
            path = "/index.html"
        elif path == "/phone":
            path = "/phone.html"
        self.serve_file(path)

    def serve_info(self):
        """Lets the game screen show the exact address to type on the phone."""
        body = json.dumps({
            "ip": primary_ip(),
            "ips": all_ips(),
            "httpsPort": HTTPS_PORT,
            "httpPort": REDIRECT_PORT,
            "phoneUrl": "https://" + primary_ip() + ":" + str(HTTPS_PORT) + "/phone",
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    # -- static files -----------------------------------------------------

    def serve_file(self, path):
        rel = path.lstrip("/").replace("\\", "/")
        target = os.path.normpath(os.path.join(WEB, rel))
        if not target.startswith(WEB) or not os.path.isfile(target):
            body = b"404 - not found"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        fh = open(target, "rb")
        try:
            body = fh.read()
        finally:
            fh.close()
        ext = os.path.splitext(target)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # -- websocket --------------------------------------------------------

    def do_websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if not key or "websocket" not in upgrade:
            self.send_error(400, "expected a websocket upgrade")
            return

        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode()).digest()
        ).decode()
        self.wfile.write(
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\n"
            b"Connection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: " + accept.encode() + b"\r\n\r\n"
        )
        self.wfile.flush()
        self.close_connection = True

        role = "screen" if "role=screen" in self.path else "phone"
        client = Client(self.wfile, role)
        HUB.add(client)
        try:
            self.ws_loop(client)
        except (WSClosed, OSError, ValueError):
            pass
        finally:
            HUB.remove(client)

    def ws_loop(self, client):
        while client.alive:
            opcode, data = ws_read(self.rfile)
            if opcode == 0x8:                       # close
                return
            if opcode == 0x9:                       # ping -> pong
                with client.lock:
                    self.wfile.write(ws_frame(data, 0xA))
                    self.wfile.flush()
                continue
            if opcode != 0x1:
                continue
            try:
                msg = json.loads(data.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue
            self.route(client, msg)

    def route(self, client, msg):
        kind = msg.get("t")

        if kind == "p":                              # keepalive
            client.send({"t": "p"})
            return

        if kind == "hello":
            client.name = str(msg.get("name", ""))[:24]
            HUB.announce()
            return

        if client.role == "phone":
            # motion, buttons, calibration - the screen is the only listener
            msg["pid"] = client.pid
            HUB.to_screens(msg)
            return

        # from the screen: haptics and controller-mode changes go to phones
        if kind in ("buzz", "mode", "hud"):
            pid = msg.get("pid")
            if pid:
                HUB.to_phone(pid, msg)
            else:
                HUB.to_phones(msg)


class PlainHandler(Handler):
    """
    The plain-HTTP twin of the main handler.

    The game screen runs on the PC, needs no sensors, and is happier without a
    certificate warning - so it is served here in full. The controller page is
    the one that genuinely needs HTTPS (browsers hide the motion sensors on an
    insecure origin), so any request for it is bounced to the TLS port.
    """

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/phone", "/phone.html"):
            host = (self.headers.get("Host") or primary_ip()).split(":")[0]
            target = "https://" + host + ":" + str(HTTPS_PORT) + "/phone"
            body = ('<!doctype html><meta http-equiv="refresh" content="0;url='
                    + target + '"><p>Redirecting to <a href="' + target + '">'
                    + target + "</a></p>").encode()
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        Handler.do_GET(self)


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def banner(ip):
    line = "=" * 64
    print("")
    print(line)
    print("  WII-STYLE SPORTS  -  your phone is the controller")
    print(line)
    print("")
    print("  1. On THIS PC, open the game screen:")
    print("       http://localhost:" + str(REDIRECT_PORT) + "/")
    print("")
    print("  2. On your PHONE (same WiFi), open the controller:")
    print("       https://" + ip + ":" + str(HTTPS_PORT) + "/phone")
    print("")
    print("  The phone WILL warn about the certificate. That is expected - the")
    print("  server runs on your own machine, so no public authority can vouch")
    print("  for it. Tap 'Advanced', then 'Proceed' / 'Visit this website'.")
    print("  The https is only there because phone browsers refuse to hand out")
    print("  motion-sensor data over a plain connection.")
    print("")
    print("  (http://" + ip + ":" + str(REDIRECT_PORT) + "/phone forwards there too.)")
    print("")
    print("  Press Ctrl+C to stop.")
    print(line)
    print("")


def main():
    ips = all_ips()
    ip = primary_ip()
    if not ensure_cert(ips):
        sys.exit(1)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)

    httpsd = ThreadingHTTPServer(("0.0.0.0", HTTPS_PORT), Handler)
    httpsd.daemon_threads = True
    httpsd.socket = ctx.wrap_socket(httpsd.socket, server_side=True)

    try:
        plaind = ThreadingHTTPServer(("0.0.0.0", REDIRECT_PORT), PlainHandler)
        plaind.daemon_threads = True
        threading.Thread(target=plaind.serve_forever, daemon=True).start()
    except OSError:
        pass  # port busy, not important

    banner(ip)
    try:
        httpsd.serve_forever()
    except KeyboardInterrupt:
        print("\n   shutting down")
        httpsd.shutdown()


if __name__ == "__main__":
    main()
