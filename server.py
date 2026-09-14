import argparse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import urlopen
import uuid
import webbrowser

ROOT = Path(__file__).resolve().parent
ID = r"[0-9a-f]{32}"


def find_blender(value=None):
    for candidate in (value, os.getenv("BLENDER_PATH"), shutil.which("blender")):
        if candidate:
            path = Path(candidate).expanduser()
            if path.is_file():
                return str(path.resolve())
            resolved = shutil.which(candidate)
            if resolved:
                return resolved
    candidates = [Path("/Applications/Blender.app/Contents/MacOS/Blender")]
    for name in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        if base := os.getenv(name):
            candidates.extend(sorted(Path(base).glob("Blender Foundation/Blender*/blender.exe"), reverse=True))
    return next((str(path) for path in candidates if path.is_file()), None)


class ViewerState:
    def __init__(self, root, blender):
        self.root, self.blender = Path(root), blender
        self.data, self.assets = self.root / "data", self.root / "assets"
        self.uploads = self.data / "uploads"
        for path in (self.uploads, self.assets):
            path.mkdir(parents=True, exist_ok=True)
        self.jobs, self.lock = {}, threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1)

    def update(self, job_id, **values):
        with self.lock:
            self.jobs[job_id].update(values)

    def queue(self, operation, asset_id, **options):
        job_id = uuid.uuid4().hex
        with self.lock:
            self.jobs[job_id] = dict(status="queued", progress=0, message="Waiting...", result=None)
        self.executor.submit(self.run, job_id, operation, asset_id, options)
        return job_id

    def run(self, job_id, operation, asset_id, options):
        self.update(job_id, status="running", progress=2, message="Opening Blender file...")
        process = timer = None
        try:
            if not self.blender:
                raise ValueError("Blender was not found. Set BLENDER_PATH or use --blender.")
            with tempfile.TemporaryDirectory(dir=self.data) as temporary:
                work = Path(temporary)
                request = dict(operation=operation, input=str(self.uploads / asset_id / "source.blend"),
                               output=str(work / "result.json"), **options)
                result = dict(assetId=asset_id, sourceName=options["sourceName"])
                if operation == "load":
                    export_id = uuid.uuid4().hex
                    folder = self.assets / export_id
                    folder.mkdir()
                    request["exportPath"] = str(folder / "model.glb")
                    result["modelUrl"] = f"/assets/{export_id}/model.glb"
                request_path = work / "request.json"
                request_path.write_text(json.dumps(request), encoding="utf-8")
                process = subprocess.Popen([self.blender, "--background", "--factory-startup",
                    "--disable-autoexec", "--python", str(self.root / "blender_worker.py"), "--", str(request_path)],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                    errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                expired = threading.Event()
                def timeout():
                    expired.set()
                    if process.poll() is None:
                        process.kill()
                timer = threading.Timer(900, timeout)
                timer.daemon = True
                timer.start()
                for line in process.stdout:
                    if line.startswith("PROGRESS "):
                        self.update(job_id, **json.loads(line[9:]))
                code = process.wait()
                if expired.is_set():
                    raise ValueError("Blender timed out after 15 minutes.")
                output = Path(request["output"])
                report = json.loads(output.read_text(encoding="utf-8")) if output.is_file() else {}
                if code or "error" in report or not report:
                    raise ValueError(report.get("error", "Blender could not process this file."))
                result.update(report)
                if operation == "inspect":
                    (self.uploads / asset_id / "metadata.json").write_text(json.dumps(result), encoding="utf-8")
                self.update(job_id, status="done", progress=100, message="Ready", result=result)
        except Exception as error:
            self.update(job_id, status="error", progress=100, message=str(error))
        finally:
            if timer:
                timer.cancel()
            if process:
                if process.poll() is None:
                    process.kill()
                process.wait()
                process.stdout.close()


class ViewerHandler(BaseHTTPRequestHandler):
    @property
    def state(self):
        return self.server.state

    def local_request(self):
        host = self.headers.get("Host", "")
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if host.lower() not in allowed or self.headers.get("Origin", "http://" + host) != "http://" + host:
            self.respond(403, {"error": "Only same-origin local requests are allowed."})
            return False
        return True

    def headers_for(self, status, kind, length):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

    def respond(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.headers_for(status, "application/json; charset=utf-8", len(data))
        self.wfile.write(data)

    def serve_file(self, root, relative):
        root = root.resolve()
        path = (root / unquote(relative)).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return self.respond(404, {"error": "File not found."})
        kind = "model/gltf-binary" if path.suffix == ".glb" else mimetypes.guess_type(path)[0]
        self.headers_for(200, kind or "application/octet-stream", path.stat().st_size)
        try:
            with path.open("rb") as stream:
                shutil.copyfileobj(stream, self.wfile)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if not self.local_request():
            return
        path = urlsplit(self.path).path
        if path == "/api/health":
            return self.respond(200, dict(ok=True, app="Model distance assist",
                                         blenderAvailable=bool(self.state.blender)))
        if path.startswith("/api/jobs/"):
            with self.state.lock:
                job = self.state.jobs.get(path.removeprefix("/api/jobs/"))
                job = dict(job) if job else None
            return self.respond(200 if job else 404, job or {"error": "Job not found."})
        if path.startswith("/api/"):
            return self.respond(404, {"error": "Endpoint not found."})
        if path.startswith("/assets/"):
            if not re.fullmatch(rf"/assets/{ID}/model\.glb", path):
                return self.respond(404, {"error": "Asset not found."})
            return self.serve_file(self.state.assets, path.removeprefix("/assets/"))
        if path.startswith("/vendor/three/"):
            return self.serve_file(self.state.root / "node_modules" / "three", path.removeprefix("/vendor/three/"))
        return self.serve_file(self.state.root / "web", path.lstrip("/") or "index.html")

    def do_POST(self):
        if not self.local_request():
            return
        try:
            parts = urlsplit(self.path)
            length = int(self.headers.get("Content-Length", "0"))
            if parts.path == "/api/import":
                if not 0 < length <= 2 * 1024**3:
                    return self.respond(413, {"error": "Choose a Blender file smaller than 2 GB."})
                filename = parse_qs(parts.query).get("filename", ["model.blend"])[0]
                filename = filename.replace("\\", "/").rsplit("/", 1)[-1]
                if not filename.lower().endswith(".blend") or len(filename) > 240:
                    raise ValueError("Choose a .blend file.")
                asset_id = uuid.uuid4().hex
                folder = self.state.uploads / asset_id
                folder.mkdir()
                target = folder / "source.blend"
                try:
                    with target.open("xb") as out:
                        while length:
                            chunk = self.rfile.read(min(1024**2, length))
                            if not chunk:
                                raise ValueError("Upload interrupted. Please try again.")
                            out.write(chunk)
                            length -= len(chunk)
                except Exception:
                    target.unlink(missing_ok=True)
                    raise
                job = self.state.queue("inspect", asset_id, sourceName=filename)
            elif parts.path == "/api/load":
                if not 0 < length <= 1024**2:
                    raise ValueError("Invalid model selection.")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("Invalid model selection.")
                asset_id = data.get("assetId")
                if not isinstance(asset_id, str) or not re.fullmatch(ID, asset_id):
                    raise ValueError("Import a Blender file first.")
                metadata_path = self.state.uploads / asset_id / "metadata.json"
                if not metadata_path.is_file():
                    raise ValueError("Wait for the file to finish opening.")
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                names = {obj["id"] for obj in metadata["objects"]}
                box, size, models = data.get("boxObject"), data.get("boxSizeCm"), data.get("modelObjects")
                if not isinstance(box, str) or box not in names:
                    raise ValueError("Choose a box from this file.")
                if not isinstance(size, list) or len(size) != 3 or any(
                    isinstance(n, bool) or not isinstance(n, (int, float)) or not 0.001 <= n <= 10000 for n in size):
                    raise ValueError("Box dimensions must be between 0.001 and 10,000 cm.")
                if models is not None and (not isinstance(models, list) or not models or any(
                    not isinstance(n, str) or n not in names or n == box for n in models)):
                    raise ValueError("Select model objects other than the box.")
                job = self.state.queue("load", asset_id, sourceName=metadata["sourceName"],
                                       boxObject=box, boxSizeCm=size, modelObjects=models)
            else:
                return self.respond(404, {"error": "Endpoint not found."})
            self.respond(202, {"jobId": job})
        except (ValueError, OSError) as error:
            self.respond(400, {"error": str(error)})


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--blender")
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    try:
        server = LocalServer(("127.0.0.1", args.port), ViewerHandler)
    except OSError as error:
        if args.open:
            try:
                with urlopen(url + "/api/health", timeout=1) as response:
                    health = json.load(response)
                if isinstance(health, dict) and health.get("ok") and health.get("app") == "Model distance assist":
                    webbrowser.open(url)
                    return
            except (OSError, ValueError):
                pass
        parser.exit(1, f"Cannot use port {args.port}: {error}\n")
    server.state = ViewerState(ROOT, find_blender(args.blender))
    url = f"http://127.0.0.1:{server.server_port}"
    print(url, flush=True)
    if args.open:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.state.executor.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
