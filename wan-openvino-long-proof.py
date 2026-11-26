import json
import pathlib
import sys
import time

import imageio.v3 as iio
import numpy as np
import openvino as ov
from PIL import Image, ImageDraw
import torch
from huggingface_hub import snapshot_download

FRAMES = 65
SIZE = 128

def run():
    torch.set_num_threads(4)
    assets = pathlib.Path(snapshot_download(
        "xgirls/wan2.2-ti2v-5b-openvino-int4-awq",
        revision="2d93079f0881f5f83ff8954fd906e7a9f4fd07a3",
        allow_patterns=["*.xml", "*.bin", "scheduler/*", "tokenizer/*", "ov_wan_i2v_helper.py"],
        max_workers=3,
    ))
    sys.path.insert(0, str(assets))
    from ov_wan_i2v_helper import OVWanImageToVideoPipeline

    proof = pathlib.Path("proof")
    proof.mkdir(exist_ok=True)
    reference = Image.new("RGB", (SIZE, SIZE), "lightblue")
    ImageDraw.Draw(reference).ellipse((40, 40, 76, 76), fill="firebrick")
    reference.save(proof / "reference.png")
    started = time.monotonic()
    pipeline = OVWanImageToVideoPipeline(assets, device_map="CPU", ov_config={"INFERENCE_NUM_THREADS": 4})
    latents = pipeline(
        image=reference, prompt="A red ball rolls across a pale blue floor. Static camera.",
        height=SIZE, width=SIZE, num_frames=FRAMES, num_inference_steps=4, guidance_scale=5.0,
        generator=torch.Generator(device="cpu").manual_seed(42), output_type="latent",
    ).frames
    expected = (FRAMES - 1) // 4 + 1
    if latents.shape[2] != expected:
        raise RuntimeError(f"Expected {expected} latent frames, received {latents.shape[2]}")
    pipeline_seconds = time.monotonic() - started
    print(f"Generated one sequence of {expected} latent frames in {pipeline_seconds:.1f}s", flush=True)
    means = torch.tensor(pipeline.latents_mean).view(1, pipeline.z_dim, 1, 1, 1)
    std = torch.tensor(pipeline.latents_std).view(1, pipeline.z_dim, 1, 1, 1)
    latents = (latents / std + means).numpy().astype(np.float32, copy=False)
    core = ov.Core()
    model = core.read_model(assets / "vae_decoder.xml")
    model.reshape({0: [1, latents.shape[1], 6, latents.shape[3], latents.shape[4]]})
    decoder = core.compile_model(model, "CPU", {"INFERENCE_NUM_THREADS": 4})
    pictures = []
    seams = []
    consumed = 0
    while consumed < expected:
        end = 6 if consumed == 0 else min(consumed + 4, expected)
        window = np.ascontiguousarray(latents[:, :, end - 6:end])
        decoded = decoder([window])[0]
        if decoded.shape[2] != 21 or not np.isfinite(decoded).all():
            raise RuntimeError(f"Unexpected decoder data: {decoded.shape}")
        new_count = 21 if consumed == 0 else 4 * (end - consumed)
        if consumed:
            seams.append(4 * (consumed - 1) + 1)
        pictures.append(decoded[:, :, -new_count:].copy())
        consumed = end
        print(f"Decoded through latent frame {consumed}/{expected}", flush=True)
    final = np.concatenate(pictures, axis=2)
    post = pipeline.video_processor.postprocess_video(torch.from_numpy(final), output_type="np")[0]
    images = np.clip(post * 255.0, 0, 255).astype(np.uint8)
    if len(images) != FRAMES:
        raise RuntimeError(f"Expected {FRAMES} output frames, received {len(images)}")
    iio.imwrite(proof / "wan-openvino-65.mp4", images, fps=16)
    motion = np.abs(np.diff(images.astype(np.float32), axis=0)).mean(axis=(1, 2, 3))
    distinct = len({frame.tobytes() for frame in images})
    details = {"frames": len(images), "uniqueFrames": distinct, "resolution": [SIZE, SIZE],
               "latentFrames": expected, "framesPerSecond": 16, "seconds": time.monotonic() - started,
               "meanAdjacentPixelDifference": float(motion.mean()),
               "meanSeamPixelDifference": float(motion[np.asarray(seams) - 1].mean())}
    (proof / "result.json").write_text(json.dumps(details, indent=2))
    print(json.dumps(details), flush=True)

if __name__ == "__main__":
    run()
