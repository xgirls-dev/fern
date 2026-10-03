"""Check the actual backend payload before it goes into a Fern installer."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

ALLOWED_BACKEND = {
    'api_server.py', 'media_http.py', 'model_catalog.py', 'model_catalog.json',
    'model_manager.py', 'model_capabilities.py', 'device_adapters.py',
    'flux2_klein_pipeline.py', 'qwen3_tts_worker.py', 'tts_generation_worker.py',
    'tts_model_download.py', 'tts_model_catalog.json', 'requirements-qwen3-tts-runtime.txt',
    'install-qwen3-tts.ps1', 'gallery_store.py', 'generation_worker.py',
    'storage_manager.py', 'bootstrap_install.py',
}
LICENSES = {'LICENSE-QWEN', 'LICENSE-OPENVINO-NOTEBOOKS', 'NOTICE'}
TOKEN = re.compile(rb'hf_[A-Za-z0-9]{20,}')


def audit_backend(root: Path) -> int:
    files = [path for path in root.rglob('*') if path.is_file()]
    missing = ALLOWED_BACKEND - {path.name for path in root.iterdir() if path.is_file()}
    if missing:
        raise ValueError(f'Missing backend resources: {sorted(missing)}')
    for path in files:
        relative = path.relative_to(root)
        vendored = relative.parts[0] == 'tts_runtime'
        allowed = (vendored and '__pycache__' not in relative.parts
                   and (path.suffix in {'.py', '.npz'} or path.name in LICENSES))
        if not allowed and relative.as_posix() not in ALLOWED_BACKEND:
            raise ValueError(f'Unexpected backend resource: {relative}')
        if TOKEN.search(path.read_bytes()):
            raise ValueError(f'Credential-like content in backend resource: {relative}')
    for required in [*LICENSES, 'qwen_3_tts_helper.py', 'qwen_tts/__init__.py']:
        if not (root / 'tts_runtime' / required).is_file():
            raise ValueError(f'Missing bundled inference source/license: {required}')
    return len(files)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('backend', type=Path)
    args = parser.parse_args()
    print(f'Release backend payload verified: {audit_backend(args.backend)} files; no local artifacts or credentials.')
