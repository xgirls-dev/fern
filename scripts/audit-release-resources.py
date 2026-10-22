"""Check the actual backend payload before it goes into a Fern installer."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ALLOWED_BACKEND = {
    'api_server.py', 'media_http.py', 'model_catalog.py', 'model_catalog.json',
    'model_manager.py', 'model_capabilities.py', 'device_adapters.py',
    'flux2_klein_pipeline.py', 'flux3_klein_model_catalog.json',
    'flux3_klein_pipeline.py', 'flux3_klein_runtime.py',
    'tame_pony_model_catalog.json', 'tame_pony_pipeline.py',
    'custom_image_registry.py', 'custom_image_pipeline.py', 'custom_image_download.py',
    'requirements-flux3-klein-overlay.txt',
    'qwen3_tts_worker.py', 'tts_generation_worker.py',
    'qwen21_turbo_openvino.py',
    'qwen21_turbo_download.py', 'qwen21_turbo_model_catalog.json',
    'tts_model_download.py', 'tts_model_catalog.json', 'requirements-qwen3-tts-runtime.txt',
    'text_generation_worker.py', 'text_generation_process.py', 'text_model_registry.py',
    'text_model_download.py', 'text_model_catalog.json',
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
            not isinstance(path_value, str) or not path_value or relative.is_absolute() or relative.drive
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
    try:
        flux3_catalog = json.loads((root / 'flux3_klein_model_catalog.json').read_text(encoding='utf-8'))
        flux3 = flux3_catalog['flux3-klein']
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ValueError('Missing or invalid pinned FLUX.3 Klein download catalog.') from error
    if not (
        flux3.get('repo') == 'xgirls/flux-3-klein-openvino-int4-awq'
        and re.fullmatch(r'[0-9a-f]{40}', flux3.get('revision', ''))
        and flux3.get('folder') == 'flux3-klein-openvino-int4-awq'
        and isinstance(flux3.get('files'), list) and flux3['files']
    ):
        raise ValueError('Missing or invalid pinned FLUX.3 Klein download catalog.')
    flux3_paths = set()
    for item in flux3['files']:
        if not isinstance(item, dict):
            raise ValueError('Missing or invalid pinned FLUX.3 Klein download catalog.')
        path_value = item.get('path')
        relative = Path(path_value) if isinstance(path_value, str) else Path('')
        sha256 = item.get('sha256')
        blob = item.get('blob')
        if (
            not path_value or relative.is_absolute() or relative.drive
            or '..' in relative.parts or not isinstance(item.get('size'), int)
            or item['size'] <= 0
            or (sha256 is not None and (
                not isinstance(sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', sha256)
            ))
            or not isinstance(blob, str) or not re.fullmatch(r'[0-9a-f]{40}', blob)
            or relative.as_posix() in flux3_paths
        ):
            raise ValueError('Missing or invalid pinned FLUX.3 Klein download catalog.')
        flux3_paths.add(relative.as_posix())
    required_flux3_files = {
        'LICENSE.md', 'NOTICE.md', 'model_index.json', 'modular_model_index.json',
        'openvino_config.json', 'quantization_config.json', 'scheduler/scheduler_config.json',
        'text_encoder/config.json', 'text_encoder/openvino_model.bin',
        'text_encoder/openvino_model.xml', 'tokenizer/tokenizer_config.json',
        'tokenizer/tokenizer.json', 'tokenizer/openvino_tokenizer.bin',
        'tokenizer/openvino_tokenizer.xml', 'tokenizer/openvino_detokenizer.bin',
        'tokenizer/openvino_detokenizer.xml', 'transformer/config.json',
        'transformer/openvino_model.bin', 'transformer/openvino_model.xml',
        'vae/config.json', 'vae_bn_stats.npz', 'vae_encoder/openvino_model.bin',
        'vae_encoder/openvino_model.xml', 'vae_decoder/openvino_model.bin',
        'vae_decoder/openvino_model.xml',
    }
    if not required_flux3_files.issubset(flux3_paths):
        raise ValueError('FLUX.3 Klein catalog is missing required runtime or license files.')
    try:
        pony_catalog = json.loads((root / 'tame_pony_model_catalog.json').read_text(encoding='utf-8'))
    except (OSError, ValueError, TypeError) as error:
        raise ValueError('Missing or invalid pinned Tame Pony SDXL download catalog.') from error
    pony_specs = {
        'tame-pony-v25-sdxl': (
            'xgirls/tame-pony-the-authenticity-machine-v25-sdxl-openvino',
            'bc4d4142a48219c18b5fcee383c9b9288aa8bfc4',
            'tame-pony-the-authenticity-machine-v25-sdxl-openvino',
            'OVStableDiffusionXLPipeline',
        ),
        'tame-pony-v25-sdxl-int8': (
            'xgirls/tame-pony-the-authenticity-machine-v25-sdxl-openvino-8bit',
            'dfac9f3d6cf998d3de386291f4800a831205bf29',
            'tame-pony-the-authenticity-machine-v25-sdxl-openvino-8bit',
            'OVStableDiffusionXLPipeline',
        ),
    }
    for model_id, (repo, revision, folder, pipeline) in pony_specs.items():
        pony = pony_catalog.get(model_id)
        if not (
            isinstance(pony, dict) and pony.get('repo') == repo
            and pony.get('revision') == revision and pony.get('folder') == folder
            and pony.get('pipeline') == pipeline
            and isinstance(pony.get('files'), list) and pony['files']
        ):
            raise ValueError(f'Missing or invalid pinned Tame Pony catalog for {model_id}.')
        pony_paths = set()
        pony_bytes = 0
        for item in pony['files']:
            if not isinstance(item, dict):
                raise ValueError(f'Invalid Tame Pony file catalog for {model_id}.')
            path_value = item.get('path')
            relative = Path(path_value) if isinstance(path_value, str) else Path('')
            sha256 = item.get('sha256')
            blob = item.get('blob')
            if (
                not path_value or relative.is_absolute() or relative.drive
                or '..' in relative.parts or 'model_cache' in relative.parts
                or not isinstance(item.get('size'), int) or item['size'] <= 0
                or (sha256 is not None and (
                    not isinstance(sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', sha256)
                ))
                or not isinstance(blob, str) or not re.fullmatch(r'[0-9a-f]{40}', blob)
                or relative.as_posix() in pony_paths
            ):
                raise ValueError(f'Invalid Tame Pony file catalog for {model_id}.')
            pony_paths.add(relative.as_posix())
            pony_bytes += item['size']
        if pony_bytes != pony.get('bytes'):
            raise ValueError(f'Invalid Tame Pony catalog byte count for {model_id}.')
        required_pony_files = {
            'README.md', 'model_index.json', 'scheduler/scheduler_config.json',
            *(f'{component}/config.json' for component in ('text_encoder', 'text_encoder_2', 'unet', 'vae_encoder', 'vae_decoder')),
            *(f'{component}/openvino_model.{extension}'
              for component in ('text_encoder', 'text_encoder_2', 'unet', 'vae_encoder', 'vae_decoder')
              for extension in ('xml', 'bin')),
        }
        if model_id.endswith('-int8'):
            required_pony_files.update({
                'openvino_config.json', 'tokenizer/tokenizer_config.json',
                'tokenizer/merges.txt', 'tokenizer/vocab.json',
                'tokenizer_2/tokenizer_config.json', 'tokenizer_2/merges.txt',
                'tokenizer_2/vocab.json',
            })
        else:
            required_pony_files.update({
                'tokenizer/tokenizer_config.json', 'tokenizer/tokenizer.json',
                'tokenizer_2/tokenizer_config.json', 'tokenizer_2/tokenizer.json',
            })
        if not required_pony_files.issubset(pony_paths):
            raise ValueError(f'Tame Pony catalog omits required OpenVINO components for {model_id}.')
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
