"""Loopback-only synchronous Lesson Builder API, default port 8766."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

from .cli import build_from_request
from .importer import MAX_BYTES, MediaError, SetupError
from .schema import annotation_document, validate_lesson

ROOT = Path(__file__).resolve().parent.parent / ".cache" / "lessons"
PREFIX = "/api/lesson-builder"
# UI route contract (same-origin proxy -> http://127.0.0.1:8766):
# GET /api/lesson-builder/health -> {status, schemaVersion}
# GET /api/lesson-builder/lessons -> {lessons: [{folder, lesson}]}
# POST /api/lesson-builder/import-local : raw media; X-Owner-Confirmed-Permission: true
# POST /api/lesson-builder/import-url : {url, ownerConfirmedPermission, ...build options}
# POST /api/lesson-builder/build : {path OR url, ownerConfirmedPermission, startSeconds?,
#   endSeconds?, title?, sourcePaths?: {source_A:path,source_B:path}, humanAnnotations?,
#   observedControllerActions?: [{timestamp,type:"mixer_rates",values:[x,y],source}]}
# Import/build replies: {folder, lesson}. Calls finish analysis/export synchronously.
# GET /api/lesson-builder/lessons/<folder> -> {folder, lesson} (current human annotations)
# GET /api/lesson-builder/lessons/<folder>/<reference.wav|source_A.wav|source_B.wav|
#   lesson.json|annotations.json|features.npz|actions.json|summary.md> -> file bytes.
#   Supports a single "Range: bytes=start-end" request (206 + Content-Range + Accept-Ranges),
#   required for <audio>/<video> elements; an unsatisfiable start returns 416.
# POST /api/lesson-builder/lessons/<folder>/annotations : {humanAnnotations:{...}}
#   -> separately versioned annotations document; source review is validated before save.
# Error replies: {error}; 403 permission/origin, 413 size, 422 invalid media/schema, 503 setup.
# Actions: timestamp is segment-relative seconds; all feature/region times are original-file seconds.
# Manual URL checklist: with permission, try public YouTube/TikTok/Instagram clips;
# verify creator/date/platform/group identity, audition reference timing, test unavailable/private/
# age-gated URLs yield the local-file fallback, and inspect logs for absence of tokens.


class LessonHandler(BaseHTTPRequestHandler):
    root = ROOT

    def log_message(self, format, *args):
        pass
    # Summary: This suppresses HTTP request logging so request URLs cannot expose tokens.
    # Structured error responses remain available; this is not an operational audit log.

    def reply(self, status, body):
        payload = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass
    # Summary: This frames finite JSON replies and tolerates a disconnected local client.
    # A cancelled request does not stop already-running analysis.

    def local_request(self):
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "").split(":")[0]
        if host not in ("localhost", "127.0.0.1") or (origin and urlsplit(origin).hostname not in ("localhost", "127.0.0.1")):
            self.reply(403, {"error": "Only local application requests are supported."})
            return False
        return True
    # Summary: This checks loopback host and browser origin before exposing local files/builds.
    # It is a local development boundary, not authentication for public deployment.

    def range_bounds(self, header, size):
        # A single 'bytes=start-end' spec; anything else (absent, multi-range, malformed)
        # falls back to a full response, which RFC 7233 explicitly permits.
        if not header or not header.startswith("bytes=") or "," in header:
            return None
        spec = header[len("bytes="):].strip()
        if "-" not in spec:
            return None
        start_text, _, end_text = spec.partition("-")
        try:
            if start_text == "":
                suffix = int(end_text)
                if suffix <= 0:
                    return None
                start, end = max(0, size - suffix), size - 1
            else:
                start = int(start_text)
                end = int(end_text) if end_text else size - 1
        except ValueError:
            return None
        if start < 0:
            return None
        if start >= size:
            raise ValueError("unsatisfiable")
        if end < start:
            return None
        return start, min(end, size - 1)
    # Summary: This parses one byte-range request against the file's real size.
    # An out-of-bounds start is reported to the caller as unsatisfiable (416); everything else prefers a full reply.

    def folder_for(self, name):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+-v1", name):
            raise ValueError("Invalid lesson folder identifier.")
        path = self.root / name
        if not path.is_dir() or path.is_symlink():
            raise ValueError("Lesson folder not found.")
        return path
    # Summary: This resolves a fixed-format exported folder without accepting arbitrary path traversal.
    # Locally modified artifact contents still require validation when loaded.

    def result(self, folder):
        lesson = json.loads((folder / "lesson.json").read_text())
        lesson["humanAnnotations"] = json.loads((folder / "annotations.json").read_text())["humanAnnotations"]
        return {"folder": folder.name, "lesson": lesson}
    # Summary: This presents current human edits alongside immutable analysis metadata.
    # Editing annotations does not rerun analysis or authenticate reviewer claims.

    def do_GET(self):
        if not self.local_request():
            return
        route = urlsplit(self.path).path
        try:
            if route == PREFIX + "/health":
                self.reply(200, {"status": "ok", "schemaVersion": 1})
            elif route == PREFIX + "/lessons":
                lessons = [self.result(path) for path in sorted(self.root.glob("*-v1")) if (path / "lesson.json").is_file()]
                self.reply(200, {"lessons": lessons})
            elif route.startswith(PREFIX + "/lessons/"):
                parts = route[len(PREFIX + "/lessons/"):].split("/")
                folder = self.folder_for(parts[0])
                if len(parts) == 1:
                    self.reply(200, self.result(folder))
                    return
                allowed = {"reference.wav", "source_A.wav", "source_B.wav", "lesson.json", "annotations.json", "features.npz", "actions.json", "summary.md"}
                if len(parts) != 2 or parts[1] not in allowed:
                    raise ValueError("Unknown lesson file.")
                path = folder / parts[1]
                if path.is_symlink():
                    raise ValueError("Symlink artifacts are unsupported.")
                size = path.stat().st_size
                try:
                    bounds = self.range_bounds(self.headers.get("Range"), size)
                except ValueError:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                start, end = bounds if bounds else (0, max(0, size - 1))
                self.send_response(206 if bounds else 200)
                self.send_header("Content-Type", "audio/wav" if path.suffix == ".wav" else "application/octet-stream")
                self.send_header("Accept-Ranges", "bytes")
                if bounds:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    self.send_header("Content-Length", str(end - start + 1))
                else:
                    self.send_header("Content-Length", str(size))
                self.end_headers()
                try:
                    with path.open("rb") as handle:
                        handle.seek(start)
                        remaining = size if not bounds else end - start + 1
                        while remaining > 0:
                            block = handle.read(min(1024 * 1024, remaining))
                            if not block:
                                break
                            self.wfile.write(block)
                            remaining -= len(block)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self.reply(404, {"error": "Unknown endpoint."})
        except (ValueError, OSError):
            self.reply(404, {"error": "Lesson artifact is unavailable or invalid; re-export it locally."})
    # Summary: This exposes exported metadata and single-range, bounded-chunk file reads on loopback.
    # Browsers send Range on <audio>/<video> elements; without 206 support Chrome aborts the media load
    # even though the same URL fetches fine as a plain request. Multi-range requests fall back to a full reply.
    # Streaming analysis progress is not implemented.

    def do_POST(self):
        if not self.local_request():
            return
        route = urlsplit(self.path).path
        try:
            length = int(self.headers.get("Content-Length", "0"))
            limit = MAX_BYTES if route == PREFIX + "/import-local" else 2 * 1024 * 1024
            if not 0 < length <= limit:
                self.reply(413, {"error": "Request is empty or exceeds the endpoint's upload limit."})
                return
            self.connection.settimeout(60)
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("Incomplete upload; retry the local file.")
            if route == PREFIX + "/import-local":
                if self.headers.get("X-Owner-Confirmed-Permission") != "true":
                    self.reply(403, {"error": "Confirm that you own or have permission to use this material."})
                    return
                with tempfile.TemporaryDirectory(prefix="lesson-upload-") as temporary:
                    path = Path(temporary) / "upload.media"
                    path.write_bytes(body)
                    folder = build_from_request({"path": str(path), "ownerConfirmedPermission": True}, self.root)
                self.reply(201, self.result(folder))
                return
            request = json.loads(body)
            if not isinstance(request, dict):
                raise ValueError("Request must be a JSON object.")
            if route in (PREFIX + "/import-url", PREFIX + "/build"):
                if route.endswith("/import-url") and not request.get("url"):
                    raise ValueError("url is required.")
                if request.get("ownerConfirmedPermission") is not True:
                    self.reply(403, {"error": "Confirm that you own or have permission to use this material."})
                    return
                folder = build_from_request(request, self.root)
                self.reply(201, self.result(folder))
            elif route.startswith(PREFIX + "/lessons/") and route.endswith("/annotations"):
                name = route[len(PREFIX + "/lessons/"):-len("/annotations")]
                folder = self.folder_for(name)
                lesson = deepcopy(self.result(folder)["lesson"])
                lesson["humanAnnotations"] = request.get("humanAnnotations")
                errors = validate_lesson(lesson)
                if errors:
                    raise ValueError("; ".join(errors))
                previous = json.loads((folder / "annotations.json").read_text())
                document = annotation_document(lesson["humanAnnotations"], previous["revision"] + 1)
                with tempfile.TemporaryDirectory(dir=folder) as temporary:
                    staged = Path(temporary) / "annotations.json"
                    staged.write_text(json.dumps(document, indent=2, allow_nan=False) + "\n")
                    os.replace(staged, folder / "annotations.json")
                self.reply(200, document)
            else:
                self.reply(404, {"error": "Unknown endpoint."})
        except SetupError as error:
            self.reply(503, {"error": str(error)})
        except (MediaError, ValueError) as error:
            self.reply(422, {"error": str(error)})
        except FileExistsError:
            self.reply(409, {"error": "This lesson already exists. Open the existing lesson or revise its inputs."})
        except (OSError, KeyError, TypeError):
            self.reply(422, {"error": "Could not build or edit the lesson. Check the input fields and local files."})
    # Summary: This builds permission-gated artifacts and atomically saves only explicit human annotation edits.
    # Synchronous processing limits concurrency; no URL bypass, external AI service, or inferred actions are used.


def main():
    server = HTTPServer(("127.0.0.1", 8766), LessonHandler)
    print("DJ Lesson Builder: http://127.0.0.1:8766 (Ctrl+C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
# Summary: This starts a single local worker for bounded, serial decoding and analysis.
# Public deployment, authentication, and job scheduling require a separate design.


if __name__ == "__main__":
    main()

# Module summary: The documented routes connect a local editor to validated lesson artifacts.
# Detector suggestions remain separate from human edits and genuine/authored controller targets.
