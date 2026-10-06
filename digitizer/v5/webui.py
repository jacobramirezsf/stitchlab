"""Local web frontend for the V5 digitizer.

    cd digitizer && .venv/bin/python -m v5.webui        # → http://localhost:8737

Serves the same index.html and /api/digitize contract as the deployed
Vercel version; all pipeline logic lives in v5/service.py.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from v5.config import FABRIC_PRESETS  # noqa: E402
from v5.service import FORMATS, run_job  # noqa: E402

PORT = 8737
HTML = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "index.html")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(HTML, "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if self.path == "/api/meta":
            return self._send(200, {
                "fabrics": sorted(FABRIC_PRESETS),
                "styles": ["master", "redwork", "satin"],
                "formats": list(FORMATS),
            })
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length))
            if self.path == "/api/digitize":
                result = run_job(
                    payload["filename"],
                    base64.b64decode(payload["data"]),
                    size_mm=float(payload.get("size_mm", 50.8)),
                    fabric=payload.get("fabric") or None,
                    style=payload.get("style", "redwork"),
                    frontend=payload.get("frontend", "auto"),
                    colors=int(payload.get("colors", 6)),
                    plan=payload.get("plan"),
                )
            elif self.path == "/api/direct":
                from v5.director import direct
                result = direct(base64.b64decode(payload["data"]),
                                size_mm=float(payload.get("size_mm", 50.8)))
            else:
                return self._send(404, {"error": "not found"})
            return self._send(200 if "error" not in result else 422, result)
        except Exception as e:  # surface the message to the UI
            return self._send(500, {"error": str(e)[:300]})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"V5 digitizer UI → http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
