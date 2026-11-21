"""Run one Fern wallpaper job or apply an existing preview from Omarchy."""

import argparse
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid


OPEN_FERN = "Open Fern with wallpaper support and wait for it to finish starting."
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def read_connection():
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR", ""))
    try:
        if not runtime.is_absolute():
            raise ValueError("Missing runtime directory")
        with (runtime / "fern-wallpapers.json").open(encoding="utf-8") as descriptor:
            info = os.fstat(descriptor.fileno())
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError("Invalid connection permissions")
            value = json.load(descriptor)
        port, pid, outputs = value["port"], value["pid"], Path(value["outputs"])
        if type(port) is not int or not 0 < port <= 65535 or type(pid) is not int or pid <= 0:
            raise ValueError("Invalid Fern connection")
        if not outputs.is_absolute():
            raise ValueError("Invalid Fern output directory")
        os.kill(pid, 0)
        return port, outputs
    except (OSError, TypeError, ValueError, KeyError) as error:
        raise RuntimeError(OPEN_FERN) from error


def request(port, path, payload=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        if payload is None:
            connection.request("GET", path)
        else:
            connection.request("POST", path, json.dumps(payload), {"Content-Type": "application/json"})
        response = connection.getresponse()
        result = json.load(response)
        if not 200 <= response.status < 300:
            raise RuntimeError(result.get("error") or f"Fern returned HTTP {response.status}.")
        return result
    except (OSError, ValueError, http.client.HTTPException) as error:
        raise RuntimeError("Fern stopped responding. Check that it is still open.") from error
    finally:
        connection.close()


def generate(prompt):
    prompt = prompt.strip()
    if not prompt or len(prompt) > 2000:
        raise RuntimeError("Enter a wallpaper prompt with 1 to 2,000 characters.")
    port, outputs = read_connection()
    if request(port, "/api/health").get("service") != "fern":
        raise RuntimeError(OPEN_FERN)
    models = request(port, "/api/models")["models"]
    if not any(model.get("id") == "4b" and model.get("installed") for model in models):
        raise RuntimeError("Install FLUX.2 Klein 4B in Fern’s Models library first.")

    thread_id = f"omarchy-wallpaper-{uuid.uuid4().hex}"
    job = request(port, "/api/flux2/generate", {
        "prompt": prompt,
        "model": "4b",
        "device": "AUTO",
        "width": 1280,
        "height": 720,
        "seed": secrets.randbelow(2**31),
        "thread_id": thread_id,
    })["job"]
    job_id = job["id"]
    deadline = time.monotonic() + 30 * 60
    while job.get("id") == job_id and job.get("threadId") == thread_id:
        status = job.get("status")
        if status == "complete":
            name = (job.get("output") or {}).get("name", "")
            if not name or Path(name).name != name or not name.endswith(".png"):
                raise RuntimeError("Fern finished without a wallpaper image.")
            root = outputs.resolve()
            path = (root / name).resolve()
            if path.parent != root or not path.is_file():
                raise RuntimeError("The generated image is no longer in Fern’s output folder.")
            return {"path": str(path), "url": path.as_uri()}
        if status != "running":
            raise RuntimeError(job.get("error") or "Wallpaper generation ended before producing an image.")
        if time.monotonic() >= deadline:
            raise RuntimeError("Waiting for Fern timed out. Check generation in the Fern app.")
        time.sleep(1.5)
        job = request(port, "/api/flux2/status?images=0&model=4b")["job"]
    raise RuntimeError("Fern switched to another image job before the wallpaper could be retrieved.")


def apply_wallpaper(source):
    if not source.is_absolute() or source.suffix != ".png" or not source.is_file():
        raise RuntimeError("The preview is gone. Generate another wallpaper first.")
    data_home = Path(os.environ.get("XDG_DATA_HOME", ""))
    if not data_home.is_absolute():
        data_home = Path.home() / ".local" / "share"
    directory = data_home / "fern-wallpapers"
    with source.open("rb") as image:
        if image.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
            raise RuntimeError("The preview is not a PNG image.")
        image.seek(0)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(dir=directory, suffix=".png", prefix="fern-")
        destination = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as copy:
                shutil.copyfileobj(image, copy)
        except OSError:
            destination.unlink(missing_ok=True)
            raise
    # The desktop may link to this copy even if the transition reports an error.
    try:
        subprocess.run(
            ["omarchy", "theme", "bg", "set", str(destination)],
            check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("Omarchy could not set the wallpaper. Check that its shell is running.") from error
    return {"applied": True}


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("generate", help="Read a single wallpaper prompt from standard input")
    commands.add_parser("apply").add_argument("image", type=Path)
    args = parser.parse_args()
    try:
        result = generate(sys.stdin.readline(2002)) if args.command == "generate" else apply_wallpaper(args.image)
    except (OSError, RuntimeError) as error:
        print(json.dumps({"error": str(error)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
