import argparse
import gc
import hashlib
import json
import pathlib
import sys
import time

from diffusers import AutoencoderKLWan
from huggingface_hub import snapshot_download
import imageio.v3 as iio
import numpy as np
import openvino as ov
from PIL import Image, ImageDraw
import torch
from wan_tiled_attention import make_transformer, verify_tiled_attention

FPS = 16
HEIGHT = 704
WIDTH = 544


def run(duration_seconds: int):
    frame_count = duration_seconds * FPS + 1
    torch.set_num_threads(4)
    assets = pathlib.Path(snapshot_download(
        "xgirls/wan2.2-ti2v-5b-openvino-int4-awq",
        revision="2d93079f0881f5f83ff8954fd906e7a9f4fd07a3",
        allow_patterns=["transformer.*", "text_encoder.*", "vae_encoder.*", "scheduler/*", "tokenizer/*", "ov_wan_i2v_helper.py"],
        max_workers=3,
    ))
    sys.path.insert(0, str(assets))
    import ov_wan_i2v_helper as published

    original_compile = published._compile_ir

    def compile_model(path, device, ov_config=None):
        if pathlib.Path(path).stem != "transformer":
            return original_compile(path, device, ov_config)
        core = ov.Core()
        transformer = make_transformer(core, path, frame_count, HEIGHT, WIDTH)
        print("Compiling the pinned transformer with tiled global self-attention.", flush=True)
        runtime = core.compile_model(transformer, device, ov_config or {})
        print("Transformer ready. Starting denoising.", flush=True)
        return runtime

    published._compile_ir = compile_model

    vae_assets = pathlib.Path(snapshot_download(
        "Wan-AI/Wan2.2-TI2V-5B-Diffusers",
        revision="b8fff7315c768468a5333511427288870b2e9635",
        allow_patterns=["vae/config.json", "vae/diffusion_pytorch_model.safetensors"],
    ))
    proof = pathlib.Path("proof")
    proof.mkdir(exist_ok=True)
    reference = Image.new("RGB", (WIDTH, HEIGHT), "lightblue")
    ImageDraw.Draw(reference).ellipse((160, 270, 300, 410), fill="firebrick")
    reference.save(proof / "reference.png")
    started = time.monotonic()
    pipeline = published.OVWanImageToVideoPipeline(assets, device_map="CPU", ov_config={
        "INFERENCE_NUM_THREADS": 4, "NUM_STREAMS": 1,
    })
    latents = pipeline(
        image=reference, prompt="A red ball rolls across a pale blue floor. Static camera.",
        height=HEIGHT, width=WIDTH, num_frames=frame_count, num_inference_steps=4, guidance_scale=5.0,
        generator=torch.Generator(device="cpu").manual_seed(42), output_type="latent",
    ).frames
    expected = (frame_count - 1) // 4 + 1
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
    decoder.enable_tiling()
    with torch.inference_mode():
        decoded = decoder.decode(latents, return_dict=False)[0]
    images = np.clip(processor.postprocess_video(decoded, output_type="np")[0] * 255, 0, 255).astype(np.uint8)
    expected_shape = (frame_count, HEIGHT, WIDTH, 3)
    if images.shape != expected_shape:
        raise RuntimeError(f"Expected decoded video shape {expected_shape}, received {images.shape}")
    distinct = len({hashlib.sha256(frame.tobytes()).digest() for frame in images})
    if distinct != frame_count:
        raise RuntimeError(f"Expected {frame_count} distinct frames, received {distinct}")
    iio.imwrite(proof / "wan-openvino.mp4", images, fps=FPS)
    for label, index in (("first", 0), ("middle", frame_count // 2), ("last", -1)):
        Image.fromarray(images[index]).save(proof / f"{label}.png")
    details = {
        "frames": len(images),
        "uniqueFrames": distinct,
        "resolution": [WIDTH, HEIGHT],
        "latentFrames": expected,
        "framesPerSecond": FPS,
        "attentionQueryTile": HEIGHT // 32 * (WIDTH // 32),
        "denoiseSeconds": denoise_seconds,
        "decodeAndEncodeSeconds": time.monotonic() - decode_started,
    }
    (proof / "result.json").write_text(json.dumps(details, indent=2))
    print(json.dumps(details), flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("seconds", type=int, choices=(4, 10))
    args = parser.parse_args()
    verify_tiled_attention(ov.Core())
    run(args.seconds)
