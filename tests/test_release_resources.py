import importlib.util
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
