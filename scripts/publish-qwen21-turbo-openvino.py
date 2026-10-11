"""Publish Fern's validated Qwen Turbo OpenVINO INT8 model to Hugging Face."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models" / "qwen-image-2.1-turbo-openvino-int8"
CATALOG_PATH = ROOT / "scripts" / "qwen21_turbo_model_catalog.json"
UPSTREAM_REPO = "Qwen/Qwen-Image-2.1-Turbo"
UPSTREAM_REVISION = "84d3f71fff32fc6c4740b89f5556657d0c65af27"
MODEL_MARKER = ".fern-qwen21-turbo-openvino.json"
COMPONENTS = (
    "transformer", "text_encoder", "text_encoder_i2i",
    "vision_encoder", "vae_encoder", "vae_decoder",
)
IGNORE_PATTERNS = ("**/model_cache/**", ".openvino_export_complete")


def validate_model() -> dict:
    required = (
        MODEL_MARKER, "model_index.json", ".fern-sample-sigmas.json",
        ".fern-validation.json", ".fern-validation.png", "LICENSE", "NOTICE", "README.md",
        *(f"{part}/openvino_model.{ext}" for part in COMPONENTS for ext in ("xml", "bin")),
    )
    missing = [name for name in required if not (MODEL_DIR / name).is_file()]
    if missing:
        raise RuntimeError("Validated export is missing: " + ", ".join(missing))
    empty = [name for name in required if (MODEL_DIR / name).stat().st_size <= 0]
    if empty:
        raise RuntimeError("Validated export contains empty files: " + ", ".join(empty))
    marker = json.loads((MODEL_DIR / MODEL_MARKER).read_text(encoding="utf-8-sig"))
    if not (
        marker.get("repo") == UPSTREAM_REPO
        and marker.get("revision") == UPSTREAM_REVISION
        and marker.get("format") == "openvino-int8"
        and marker.get("weightBits") == 8
    ):
        raise RuntimeError("Export provenance does not match the expected official INT8 model.")
    evidence = json.loads((MODEL_DIR / ".fern-validation.json").read_text(encoding="utf-8-sig"))
    image_path = MODEL_DIR / ".fern-validation.png"
    model_index = json.loads((MODEL_DIR / "model_index.json").read_text(encoding="utf-8-sig"))
    sigmas = json.loads((MODEL_DIR / ".fern-sample-sigmas.json").read_text(encoding="utf-8-sig"))
    if not (
        evidence.get("device") == "GPU"
        and evidence.get("steps") == 8
        and evidence.get("width") == 512
        and evidence.get("height") == 512
        and evidence.get("useKvCache") is False
        and evidence.get("sampleSigmas") == model_index.get("sample_sigmas")
        and evidence.get("sampleSigmas") == sigmas.get("sample_sigmas")
        and evidence.get("pixelStdDev", 0) >= 0.5
        and evidence.get("sha256") == hashlib.sha256(image_path.read_bytes()).hexdigest()
    ):
        raise RuntimeError("The included OpenVINO validation evidence failed integrity checks.")
    with Image.open(image_path) as image:
        if image.size != (512, 512):
            raise RuntimeError("The included OpenVINO validation image has the wrong dimensions.")
    return evidence


def model_files() -> list[Path]:
    return sorted(
        path for path in MODEL_DIR.rglob("*")
        if path.is_file()
        and "model_cache" not in path.relative_to(MODEL_DIR).parts
        and path.name != ".openvino_export_complete"
    )


def get_hf_token() -> str | None:
    """Read the Hub token from the process environment or the project .env."""
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if token:
        return token.strip().strip("\"'")
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return None
    for line in env_path.read_text(encoding="utf-8-sig").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip().removeprefix("export ").strip().upper() == "HF_TOKEN":
            return value.strip().strip("\"'") or None
    return None


def build_catalog(files: list[Path], repo_id: str, revision: str) -> dict:
    entries = []
    total = 0
    for index, path in enumerate(files, start=1):
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as source:
            while chunk := source.read(4 * 1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
        total += size
        entries.append({
            "path": path.relative_to(MODEL_DIR).as_posix(),
            "size": size,
            "sha256": digest.hexdigest(),
        })
        print(f"Hashed {index}/{len(files)}: {entries[-1]['path']}", flush=True)
    return {"repo": repo_id, "revision": revision, "bytes": total, "files": entries}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="Optional destination model repo; defaults to your account.")
    args = parser.parse_args()

    if not MODEL_DIR.is_dir():
        raise RuntimeError(f"OpenVINO export not found: {MODEL_DIR}")
    evidence = validate_model()
    token = get_hf_token()
    api = HfApi(token=token)
    try:
        identity = api.whoami()
    except Exception as error:
        raise RuntimeError(f"Hugging Face authentication failed ({type(error).__name__}).") from None
    owner = identity["name"]
    repo_id = args.repo or f"{owner}/Qwen-Image-2.1-Turbo-OpenVINO-INT8"

    files = model_files()
    print(
        f"Publishing {len(files)} files ({sum(path.stat().st_size for path in files) / 1e9:.2f} GB) "
        f"to public model repo {repo_id}.",
        flush=True,
    )
    if not importlib.util.find_spec("hf_xet"):
        print("hf_xet is unavailable; upload will use the Hugging Face Hub fallback transport.", flush=True)
    print(
        f"Validation: {evidence['width']}x{evidence['height']} · {evidence['steps']} steps · "
        f"{evidence['device']} · pixel stddev {evidence.get('pixelStdDev', 0):.2f}",
        flush=True,
    )
    exists = False
    try:
        remote = api.model_info(repo_id, files_metadata=False)
        exists = True
    except Exception as error:
        if "404" not in str(error) and "Repository Not Found" not in str(error):
            raise
    if exists:
        remote_files = {item.rfilename for item in remote.siblings or []}
        if remote_files - {".gitattributes"} and MODEL_MARKER not in remote_files:
            raise RuntimeError(
                f"Refusing to upload over existing repo {repo_id}: it does not contain Fern's model marker."
            )
        if MODEL_MARKER in remote_files:
            remote_marker_path = hf_hub_download(
                repo_id=repo_id, filename=MODEL_MARKER, revision=remote.sha, token=token,
            )
            remote_marker = json.loads(Path(remote_marker_path).read_text(encoding="utf-8-sig"))
            local_marker = json.loads((MODEL_DIR / MODEL_MARKER).read_text(encoding="utf-8-sig"))
            if remote_marker != local_marker:
                raise RuntimeError(f"Refusing to overwrite repo {repo_id}: its upstream model provenance differs.")
    else:
        api.create_repo(repo_id=repo_id, repo_type="model", private=False)
    api.upload_folder(
        repo_id=repo_id,
        repo_type="model",
        folder_path=str(MODEL_DIR),
        ignore_patterns=list(IGNORE_PATTERNS),
        commit_message="Publish Fern-validated OpenVINO INT8 conversion",
    )
    revision = api.model_info(repo_id, files_metadata=False).sha
    catalog = build_catalog(files, repo_id, revision)
    CATALOG_PATH.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"Published https://huggingface.co/{repo_id}", flush=True)
    print(f"Pinned model revision: {revision}", flush=True)
    print(f"Wrote install catalog: {CATALOG_PATH}", flush=True)


if __name__ == "__main__":
    main()
