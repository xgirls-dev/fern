"""Check the actual backend payload before it goes into a Fern installer."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ALLOWED_BACKEND = {
    'api_server.py', 'media_http.py', 'model_catalog.py', 'model_catalog.json',
    'model_manager.py', 'model_capabilities.py', 'device_adapters.py',
    'flux2_klein_pipeline.py', 'qwen3_tts_worker.py', 'tts_generation_worker.py',
    'qwen21_turbo_openvino.py',
    'qwen21_turbo_download.py', 'qwen21_turbo_model_catalog.json',
    'tts_model_download.py', 'tts_model_catalog.json', 'requirements-qwen3-tts-runtime.txt',
    'requirements-qwen21-turbo-export.txt', 'requirements-qwen21-turbo-overlay.txt',
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
    try:
        catalog = json.loads((root / 'qwen21_turbo_model_catalog.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise ValueError('Missing or invalid pinned Qwen Turbo download catalog.') from error
    if not isinstance(catalog, dict) or not (
        isinstance(catalog.get('repo'), str) and '/' in catalog['repo']
        and re.fullmatch(r'[0-9a-f]{40}', catalog.get('revision', ''))
        and isinstance(catalog.get('bytes'), int) and catalog['bytes'] > 0
        and isinstance(catalog.get('files'), list) and catalog['files']
    ):
        raise ValueError('Qwen Turbo is not publishable until its Hub repo and pinned catalog are configured.')
    catalog_paths = set()
    catalog_bytes = 0
    for item in catalog['files']:
        if not isinstance(item, dict):
            raise ValueError('Missing or invalid pinned Qwen Turbo download catalog.')
        path_value = item.get('path')
        size = item.get('size')
        digest = item.get('sha256', '')
        if not isinstance(path_value, str) or not isinstance(digest, str):
            raise ValueError('Missing or invalid pinned Qwen Turbo download catalog.')
        relative = Path(path_value)
        if (
            not path_value or relative.is_absolute() or relative.drive
            or '..' in relative.parts or 'model_cache' in relative.parts
            or not isinstance(size, int) or size <= 0
            or not re.fullmatch(r'[0-9a-f]{64}', digest)
            or relative.as_posix() in catalog_paths
        ):
            raise ValueError('Missing or invalid pinned Qwen Turbo download catalog.')
        catalog_paths.add(relative.as_posix())
        catalog_bytes += size
    if catalog_bytes != catalog['bytes']:
        raise ValueError('Missing or invalid pinned Qwen Turbo download catalog.')
    required_model_files = {
        '.fern-qwen21-turbo-openvino.json', '.fern-sample-sigmas.json',
        '.fern-validation.json', '.fern-validation.png', 'LICENSE', 'NOTICE',
        'README.md', 'model_index.json',
        *(f'{component}/openvino_model.{extension}'
          for component in ('transformer', 'text_encoder', 'text_encoder_i2i', 'vision_encoder', 'vae_encoder', 'vae_decoder')
          for extension in ('xml', 'bin')),
    }
    if not required_model_files.issubset(catalog_paths):
        raise ValueError('Missing or invalid pinned Qwen Turbo download catalog.')
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
