"""Vercel WSGI entrypoint for the V5 digitizer.

Serves index.html at / and the digitizing API at POST /api/digitize.
Same JSON contract as the local server (v5/webui.py); all pipeline logic
lives in v5/service.py.
"""

import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from v5.service import run_job  # noqa: E402

HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")


def _json(start_response, code, body):
    data = json.dumps(body).encode()
    start_response(f"{code} {'OK' if code == 200 else 'ERROR'}",
                   [("Content-Type", "application/json"),
                    ("Content-Length", str(len(data)))])
    return [data]


def app(environ, start_response):
    path = environ.get("PATH_INFO", "/")
    method = environ.get("REQUEST_METHOD", "GET")

    if method == "GET" and path in ("/", "/index.html"):
        with open(HTML, "rb") as f:
            data = f.read()
        start_response("200 OK", [("Content-Type", "text/html; charset=utf-8"),
                                  ("Content-Length", str(len(data)))])
        return [data]

    if method == "POST" and path in ("/api/digitize", "/api/direct"):
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
            payload = json.loads(environ["wsgi.input"].read(length))
            if path == "/api/digitize":
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
            else:
                from v5.director import direct
                result = direct(base64.b64decode(payload["data"]),
                                size_mm=float(payload.get("size_mm", 50.8)))
            return _json(start_response, 200 if "error" not in result else 422,
                         result)
        except Exception as e:
            return _json(start_response, 500, {"error": str(e)[:300]})

    return _json(start_response, 404, {"error": "not found"})
