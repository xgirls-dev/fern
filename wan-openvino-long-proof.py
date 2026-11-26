import gc
import json
import pathlib
import sys
import time

from diffusers import AutoencoderKLWan
from huggingface_hub import snapshot_download
import imageio.v3 as iio
import numpy as np
from PIL import Image, ImageDraw
import torch

FRAMES = 161
SIZE = 128

def run():
    torch.set_num_threads(4)
    assets = pathlib.Path(snapshot_download(
        "xgirls/wan2.2-ti2v-5b-openvino-int4-awq",
        revision="2d93079f0881f5f83ff8954fd906e7a9f4fd07a3",
        allow_patterns=["transformer.*", "text_encoder.*", "vae_encoder.*", "scheduler/*", "tokenizer/*", "ov_wan_i2v_helper.py"],
        max_workers=3,
    ))
    sys.path.insert(0, str(assets))
    from ov_wan_i2v_helper import OVWanImageToVideoPipeline

    vae_assets = pathlib.Path(snapshot_download(
        "Wan-AI/Wan2.2-TI2V-5B-Diffusers",
        revision="b8fff7315c768468a5333511427288870b2e9635",
        allow_patterns=["vae/config.json", "vae/diffusion_pytorch_model.safetensors"],
    ))
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
    denoise_seconds = time.monotonic() - started
    print(f"Generated one sequence of {expected} latent frames in {denoise_seconds:.1f}s", flush=True)
    means = torch.tensor(pipeline.latents_mean).view(1, pipeline.z_dim, 1, 1, 1)
    std = torch.tensor(pipeline.latents_std).view(1, pipeline.z_dim, 1, 1, 1)
    latents = latents / std + means
    processor = pipeline.video_processor
    del pipeline
    gc.collect()

    decode_started = time.monotonic()
    decoder = AutoencoderKLWan.from_pretrained(
        str(vae_assets / "vae"), torch_dtype=torch.float32, local_files_only=True,
    ).eval()
    with torch.inference_mode():
        decoded = decoder.decode(latents, return_dict=False)[0]
    images = np.clip(processor.postprocess_video(decoded, output_type="np")[0] * 255, 0, 255).astype(np.uint8)
    if len(images) != FRAMES:
        raise RuntimeError(f"Expected {FRAMES} decoded frames, received {len(images)}")
    iio.imwrite(proof / "wan-openvino-161.mp4", images, fps=16)
    distinct = len({frame.tobytes() for frame in images})
    details = {"frames": len(images), "uniqueFrames": distinct, "resolution": [SIZE, SIZE],
               "latentFrames": expected, "framesPerSecond": 16, "denoiseSeconds": denoise_seconds,
               "decodeAndEncodeSeconds": time.monotonic() - decode_started}
    (proof / "result.json").write_text(json.dumps(details, indent=2))
    print(json.dumps(details), flush=True)

if __name__ == "__main__":
    run()
