import importlib.util
import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('release_audit', Path(__file__).parents[1] / 'scripts/audit-release-resources.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
archive_spec = importlib.util.spec_from_file_location('runtime_archive', Path(__file__).parents[1] / 'scripts/create-runtime-archive.py')
runtime_archive = importlib.util.module_from_spec(archive_spec)
archive_spec.loader.exec_module(runtime_archive)


class ReleaseResourceTests(unittest.TestCase):
    def payload(self, root):
        for name in audit.ALLOWED_BACKEND:
            (root / name).write_text('# fixture')
        scripts = Path(__file__).parents[1] / 'scripts'
        for name in (
            'model_catalog.json', 'flux3_klein_model_catalog.json',
            'tame_pony_model_catalog.json', 'qwen21_turbo_model_catalog.json',
            'tts_model_catalog.json', 'text_model_catalog.json',
        ):
            shutil.copyfile(scripts / name, root / name)
        components = ('transformer', 'text_encoder', 'text_encoder_i2i', 'vision_encoder', 'vae_encoder', 'vae_decoder')
        model_paths = [
            '.fern-qwen21-turbo-openvino.json', '.fern-sample-sigmas.json',
            '.fern-validation.json', '.fern-validation.png', 'LICENSE', 'NOTICE',
            'README.md', 'model_index.json',
            *(f'{component}/openvino_model.{extension}'
              for component in components for extension in ('xml', 'bin')),
        ]
        (root / 'qwen21_turbo_model_catalog.json').write_text(json.dumps({
            'repo': 'example/Qwen-Image-2.1-Turbo-OpenVINO-INT8',
            'revision': 'a' * 40,
            'bytes': len(model_paths),
            'files': [{'path': path, 'size': 1, 'sha256': 'b' * 64} for path in model_paths],
        }))
        for name in [*audit.LICENSES, 'qwen_3_tts_helper.py', 'qwen_tts/__init__.py']:
            path = root / 'tts_runtime' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('# fixture')

    def test_accepts_complete_inference_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.payload(root)
            self.assertGreater(audit.audit_backend(root), 20)

    def test_rejects_local_artifacts_and_missing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.payload(root)
            for name in ['.env', 'publish-qwen3-tts.py', 'sample.wav', 'tts_runtime/__pycache__/test.pyc', 'tts_runtime/model.safetensors']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'fixture')
                with self.assertRaisesRegex(ValueError, 'Unexpected backend resource'):
                    audit.audit_backend(root)
                path.unlink()
            (root / 'tts_model_catalog.json').unlink()
            with self.assertRaisesRegex(ValueError, 'Missing backend resources'):
                audit.audit_backend(root)

    def test_rejects_credentials_without_echoing_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.payload(root)
            fake_secret = 'hf_' + 'x' * 30
            (root / 'api_server.py').write_text(fake_secret)
            with self.assertRaises(ValueError) as caught:
                audit.audit_backend(root)
            self.assertNotIn(fake_secret, str(caught.exception))

    def test_rejects_inconsistent_qwen_model_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.payload(root)
            catalog_path = root / 'qwen21_turbo_model_catalog.json'
            catalog = json.loads(catalog_path.read_text())
            catalog['bytes'] = 2
            catalog_path.write_text(json.dumps(catalog))
            with self.assertRaisesRegex(ValueError, 'invalid pinned Qwen Turbo download catalog'):
                audit.audit_backend(root)

    def test_runtime_archive_excludes_caches_and_writes_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'runtime'
            for name in ['python-home/python.exe', 'site-packages/lib.py', 'python-home/Lib/__pycache__/lib.pyc']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'fixture')
            target = Path(directory) / 'runtime-release.zip'
            result = runtime_archive.create_archive(root, target)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(set(archive.namelist()), {'python-home/python.exe', 'site-packages/lib.py'})
            self.assertEqual(len(result['archiveSha256']), 64)
            self.assertTrue(target.with_suffix('.json').is_file())

    def test_bad_runtime_asset_never_replaces_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'runtime'
            path = root / 'site-packages/.env'
            path.parent.mkdir(parents=True)
            path.write_text('fixture')
            target = Path(directory) / 'runtime-release.zip'
            target.write_bytes(b'previous archive')
            with self.assertRaisesRegex(ValueError, 'Local configuration or credential'):
                runtime_archive.create_archive(root, target)
            self.assertEqual(target.read_bytes(), b'previous archive')
