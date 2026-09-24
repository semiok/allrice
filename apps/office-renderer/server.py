"""Private fixed-purpose service. No file URLs, remote URLs, commands or paths.

The cache is ephemeral and bounded; every request supplies the complete bytes.
Web must authorize before and after calling us, including on cache hits.
"""
import base64
from collections import OrderedDict
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time

from package_reader import Package

gate = threading.BoundedSemaphore(4)
conversion = threading.Lock()
cache = OrderedDict()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Document contents and checksums are not access-log material.

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def reply(self, status, value):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"ready": self.path == "/health"})

    def do_POST(self):
        if self.path != "/render":
            return self.reply(404, {"code": "not_found"})
        if not gate.acquire(blocking=False):
            return self.reply(503, {"code": "renderer_busy"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 10_700_000 or self.headers.get("Transfer-Encoding"):
                return self.reply(413, {"code": "request_too_large"})
            request = json.loads(self.rfile.read(size))
            if set(request) != {"format", "checksum", "base64"}:
                raise ValueError("invalid_request")
            data = base64.b64decode(request["base64"], validate=True)
            digest = "sha256:" + hashlib.sha256(data).hexdigest()
            if digest != request["checksum"]:
                raise ValueError("checksum_mismatch")
            Package(data, request["format"])
            if not conversion.acquire(timeout=2):
                return self.reply(503, {"code": "renderer_busy"})
            try:
                now = time.monotonic()
                for key in list(cache):
                    if now - cache[key][0] > 600:
                        del cache[key]
                key = request["format"] + digest
                if key in cache:
                    cache.move_to_end(key)
                    return self.reply(200, cache[key][1])
                with tempfile.TemporaryDirectory(prefix="office-") as temp:
                    folder = Path(temp)
                    (folder / ("input." + request["format"])).write_bytes(data)
                    process = subprocess.Popen(["python3", "/app/render.py", temp, request["format"]],
                        start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    try:
                        process.wait(timeout=40)
                    except subprocess.TimeoutExpired:
                        return self.reply(422, {"code": "conversion_timeout"})
                    finally:
                        # Kill the whole disposable process group, including a
                        # hung soffice child, before removing its private profile.
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
                    if process.returncode != 0 or not (folder / "result.json").is_file():
                        error = folder / "error.json"
                        return self.reply(422, error.read_bytes() if error.is_file() else {"code": "conversion_failed"})
                    response = (folder / "result.json").read_bytes()
                    cache[key] = (now, response)
                    while len(cache) > 16 or sum(len(value[1]) for value in cache.values()) > 64_000_000:
                        cache.popitem(last=False)
                    return self.reply(200, response)
            finally:
                conversion.release()
        except Exception:
            self.reply(422, {"code": "invalid_office_file"})
        finally:
            gate.release()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 3112), Handler).serve_forever()
