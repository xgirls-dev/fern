import sys, threading, time, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from generation_worker import GenerationWorker
from PIL import Image

if __name__ == "__main__":
    worker = GenerationWorker()
    cancel = threading.Event()
    timer = threading.Timer(600, cancel.set)
    timer.start()
    try:
        output = Path("artifacts/model-verification/outputs").resolve()
        start = time.monotonic()
        path, seconds = worker.generate(
            cancel_event=cancel,
            log=lambda msg: print(msg, flush=True),
            model="4b",
            device="INTEL_GPU",
            prompt="A red ceramic bowl on a wooden table in daylight",
            output_dir=output,
            width=512,
            height=512,
            steps=4,
            seed=42,
        )
        print(
            json.dumps(
                {"textToImage": str(path), "coldSeconds": time.monotonic() - start}
            ),
            flush=True,
        )
        ref = Image.open(path).convert("RGB")
        edited, seconds = worker.generate(
            cancel_event=cancel,
            log=lambda msg: print(msg, flush=True),
            model="4b",
            device="INTEL_GPU",
            prompt="Make the bowl blue",
            reference_image=ref,
            output_dir=output,
            width=512,
            height=512,
            steps=4,
            seed=43,
        )
        print(
            json.dumps({"imageEdit": str(edited), "seconds": seconds, "passed": True}),
            flush=True,
        )
    finally:
        timer.cancel()
        worker.close()
