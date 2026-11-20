"""Exercise real GPU models through the packaged Mac backend."""

import base64
import io
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

IMAGE_MODEL = "klein-4b-mlx"
TEXT_MODEL = "gemma-4-e4b-gguf"
PROMPT = "A crisp wildlife photograph of a red fox in white snow with dark evergreen trees behind it"


class Fern:
    def __init__(self, base):
        self.base = base

    def request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(
            self.base + path, data=data, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"{request.method} {path}: {error.read().decode()}") from error

    def image_model(self):
        return next(item for item in self.request("/api/models")["models"] if item["id"] == IMAGE_MODEL)

    def text(self, model_id, messages, **options):
        status = self.request("/api/text/generate", {
            "modelId": model_id, "threadId": "text-thread-macos-smoke",
            "device": "GPU", "contextSize": 4096, "mode": "instant",
            "temperature": 0, "maxNewTokens": 128, "seed": 21,
            "messages": messages, **options,
        })["job"]
        job_id = status["job"]["id"]
        job = wait_for("Metal chat", lambda: self.request("/api/text/status")["job"], "complete", 420)
        assert job["id"] == job_id, job
        assert job["result"]["backend"] == "Metal" and job["result"]["device"] == "GPU", job
        return job


def wait_for(label, snapshot, completed, timeout, field="status"):
    end = time.monotonic() + timeout
    previous_phase = None
    while time.monotonic() < end:
        state = snapshot()
        phase = (state[field], state.get("phase"))
        if phase != previous_phase:
            print(f"{label}: {phase[1] or phase[0]}", flush=True)
            previous_phase = phase
        if state[field] == completed:
            return state
        if state[field] in {"failed", "stopped", "error"}:
            raise RuntimeError(f"{label}: {state.get('error')}\n{state.get('logs', [])}")
        time.sleep(2)
    raise TimeoutError(f"{label} did not reach {completed}: {state}")


def verify_png(path):
    with Image.open(path) as image:
        assert image.format == "PNG" and image.size == (512, 512)
        image.load()


def run_checks(fern, root, proof, results):
    def check(label, run):
        try:
            results[label] = {"ok": True, **run()}
        except Exception as error:
            results[label] = {"ok": False, "error": str(error)}
        print(f"{label}: {json.dumps(results[label])}", flush=True)
        return results[label]

    def image_check():
        assert not (model := fern.image_model()).get("setupUnavailableReason"), model
        fern.request("/api/models/install", {"model": IMAGE_MODEL})
        model = wait_for("Klein 4B download", fern.image_model, "installed", 900, field="state")
        assert model["runtimeReady"], model
        fern.request("/api/flux2/generate", {
            "model": IMAGE_MODEL, "device": "APPLE_GPU", "prompt": PROMPT,
            "width": 512, "height": 512, "seed": 314,
        })
        job = wait_for("MLX image", lambda: fern.request(
            f"/api/flux2/status?model={IMAGE_MODEL}&device=APPLE_GPU&images=0"
        )["job"], "complete", 540)
        image = job["output"]
        assert (image["device"], image["steps"]) == ("APPLE_GPU", 4), image
        png = root / "outputs" / image["name"]
        verify_png(png)
        shutil.copyfile(png, proof / "mlx-image.png")
        return {key: image[key] for key in ("model", "device", "steps", "generationTime")}

    def text_check():
        fern.request("/api/text/models/install", {"modelId": TEXT_MODEL})
        install = wait_for("Gemma download", lambda: fern.request("/api/text/status")["modelInstall"], "complete", 900)
        job = fern.text(install["modelId"], [{"role": "user", "content": "What color is fresh snow? Reply in a sentence."}])
        result = job["result"]
        assert "white" in result["text"].lower(), result
        return {key: result[key] for key in ("modelId", "backend", "device", "text", "generationSeconds")}

    def vision_check():
        data = io.BytesIO()
        Image.new("RGB", (384, 384), (235, 18, 23)).save(data, "PNG")
        encoded = base64.b64encode(data.getvalue()).decode("ascii")
        attachment = fern.request("/api/text/images", {"image": f"data:image/png;base64,{encoded}"})["image"]
        job = fern.text(text_model["modelId"], [{
            "role": "user", "content": "What is the dominant color in this image? Reply with one word.",
            "image": attachment,
        }])
        result = job["result"]
        assert "red" in result["text"].lower() and attachment in result["context"]["imageNames"], result
        return {key: result[key] for key in ("backend", "device", "text", "generationSeconds")}

    def chat_image_check():
        turn = {"role": "user", "content": f"Use the generate_image tool to create this image: {PROMPT}."}
        job = fern.text(text_model["modelId"], [turn], imageModel=IMAGE_MODEL)
        image = job["image"]
        result = job["result"]
        assert result["visionChecked"] and image["name"] in result["context"]["imageNames"], result
        png = root / "outputs" / image["name"]
        verify_png(png)
        shutil.copyfile(png, proof / "chat-image.png")
        follow_up = fern.text(text_model["modelId"], [
            turn, {"role": "assistant", "content": result["text"], "generatedImage": image["name"]},
            {"role": "user", "content": "Which animal is shown and what is under its feet?"},
        ])["result"]
        assert image["name"] in follow_up["context"]["imageNames"], follow_up
        assert all(word in follow_up["text"].lower() for word in ("fox", "snow")), follow_up
        return {"model": image["modelLabel"], "backend": result["backend"],
                "inspection": result["text"], "followUp": follow_up["text"]}

    image_result = check("mlx_image", image_check)
    text_model = check("metal_chat", text_check)
    if text_model["ok"]:
        check("metal_vision", vision_check)
    if image_result["ok"] and results.get("metal_vision", {}).get("ok"):
        check("chat_image_and_follow_up", chat_image_check)


def main(app, proof):
    assert platform.system() == "Darwin" and platform.machine() == "arm64"
    resources = app / "Contents" / "Resources"
    python = resources / "runtime" / "python-home"
    env = {key: value for key, value in os.environ.items() if key not in {"PYTHONPATH", "PYTHONHOME"}}
    env.update(
        PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1",
        SSL_CERT_FILE=str(python / "lib/python3.12/site-packages/certifi/cacert.pem"),
    )
    proof.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fern-macos-gpu-") as temporary:
        root = Path(temporary).resolve()
        env["FERN_ROOT"] = str(root)
        subprocess.run(["df", "-h", temporary], check=True)
        subprocess.run(["sysctl", "hw.memsize"], check=True)
        log = root / "server.log"
        results = {}
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with log.open("w", encoding="utf-8") as stream:
            server = subprocess.Popen(
                [sys.executable, "-u", str(resources / "scripts/api_server.py"), "--port", str(port)],
                env=env, cwd=root, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True,
            )
            try:
                for _ in range(90):
                    startup = next((line for line in log.read_text(errors="replace").splitlines()
                                    if line.startswith("Fern API running on ")), None)
                    if startup or server.poll() is not None:
                        break
                    time.sleep(1)
                assert startup, "Packaged backend failed to report a listening address."
                fern = Fern(startup.removeprefix("Fern API running on "))
                assert fern.request("/api/health")["ok"]
                run_checks(fern, root, proof, results)
                assert len(results) == 4 and all(result["ok"] for result in results.values()), results
            except Exception:
                print("\n".join(log.read_text(errors="replace").splitlines()[-40:]), flush=True)
                raise
            finally:
                (proof / "results.json").write_text(json.dumps(results, indent=2) + "\n")
                if server.poll() is None:
                    os.killpg(server.pid, signal.SIGTERM)
                    server.wait(timeout=15)


if __name__ == "__main__":
    main(*(Path(arg).resolve() for arg in sys.argv[1:]))
