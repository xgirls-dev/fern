"""Build the portable runtime ZIP without generated caches or local credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import zipfile


def create_archive(root: Path, target: Path) -> dict:
    temporary = target.with_name(target.name + '.part')
    count = 0
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for path in sorted(root.rglob('*')):
            if not path.is_file():
                continue
            relative = path.relative_to(root)
            if relative.parts[0] not in {'python-home', 'site-packages'}:
                raise ValueError(f'Unexpected runtime asset: {relative}')
            if '__pycache__' in relative.parts or path.suffix in {'.pyc', '.pyo', '.pdb', '.lib'}:
                continue
            if path.name.startswith('.env') or path.name in {'token', 'stored_tokens'}:
                raise ValueError(f'Local configuration or credential in runtime: {relative}')
            archive.write(path, relative.as_posix())
            count += 1
    os.replace(temporary, target)
    digest = hashlib.sha256()
    with target.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    manifest = {'schemaVersion': 1, 'archiveSha256': digest.hexdigest()}
    target.with_suffix('.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return {**manifest, 'files': count, 'bytes': target.stat().st_size}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    print('Runtime archive ready:', json.dumps(create_archive(args.root, args.target)))
