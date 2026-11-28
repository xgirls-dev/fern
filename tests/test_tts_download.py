import hashlib,io,json,sys,tempfile,threading,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import tts_model_download as download
import api_server
class Response(io.BytesIO):
 def __init__(self,data,status=200,headers=None):super().__init__(data);self.status=status;self.headers=headers or {}
 def getcode(self):return self.status
class TtsDownloadTests(unittest.TestCase):
 def test_interrupted_runtime_setup_is_not_reported_ready(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);runtime=root/'runtime';models=root/'models'
   python=runtime/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python')
   python.parent.mkdir(parents=True);python.write_bytes(b'python placeholder');models.mkdir()
   with patch.object(api_server,'TTS_ENV',runtime),patch.object(api_server,'TTS_MODEL_ROOT',models):
    self.assertFalse(api_server.tts_environment_ready())
 def file(self,path,data):return {'path':path,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()}
 def test_http_range_resume_is_verified(self):
  data=b'resume-this-model';f=self.file('test.bin',data)
  with tempfile.TemporaryDirectory() as tmp:
   target=Path(tmp)/'test.bin';target.with_suffix('.bin.part').write_bytes(data[:7])
   with patch.object(download.urllib.request,'urlopen',return_value=Response(data[7:],206,{'Content-Range':f'bytes 7-{len(data)-1}/{len(data)}'})) as fetch:
    download.download_file('https://example.test/model',target,f,lambda _:None)
   self.assertEqual(fetch.call_args.args[0].get_header('Range'),'bytes=7-');self.assertEqual(target.read_bytes(),data)
 def test_server_ignoring_range_restarts_safely(self):
  data=b'complete';f=self.file('test.bin',data)
  with tempfile.TemporaryDirectory() as tmp:
   target=Path(tmp)/'test.bin';target.with_suffix('.bin.part').write_bytes(b'old')
   with patch.object(download.urllib.request,'urlopen',return_value=Response(data)):
    download.download_file('https://example.test/model',target,f,lambda _:None)
   self.assertEqual(target.read_bytes(),data)
 def test_corrupt_download_never_publishes_model(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);spec={'repo':'xgirls/fixture','revision':'a'*40,'folder':'base-0.6b-OV','bytes':4,'files':[self.file('bad.bin',b'good')]}
   with patch.object(download.shutil,'disk_usage',return_value=SimpleNamespace(free=10**10)),patch.object(download,'catalog_spec',return_value=spec),patch.object(download.urllib.request,'urlopen',return_value=Response(b'evil')):
    with self.assertRaisesRegex(RuntimeError,'checksum'):download.install_model('base-0.6b',root,lambda _:None)
   self.assertFalse((root/spec['folder']).exists());self.assertFalse((root/(spec['folder']+'.download')/'bad.bin.part').exists())
 def test_complete_install_is_atomic_and_idempotent(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);files=[self.file(name,b'IR-fixture') for name in download.required_files('base-0.6b')]
   spec={'repo':'xgirls/fixture','revision':'a'*40,'folder':'base-0.6b-OV','bytes':sum(f['size'] for f in files),'files':files}
   with patch.object(download.shutil,'disk_usage',return_value=SimpleNamespace(free=10**10)),patch.object(download,'catalog_spec',return_value=spec),patch.object(download.urllib.request,'urlopen',side_effect=lambda *a,**k:Response(b'IR-fixture')) as fetch:
    folder=download.install_model('base-0.6b',root,lambda _:None);count=fetch.call_count
    download.install_model('base-0.6b',root,lambda _:None);self.assertEqual(fetch.call_count,count)
   self.assertTrue(download.model_ready(folder,'base-0.6b'));self.assertTrue(json.loads((folder/'.fern-tts-model.json').read_text())['verifiedSha256'])
   (folder/'openvino_talker_language_model.bin').unlink();self.assertFalse(download.model_ready(folder,'base-0.6b'))
 def test_catalog_reports_model_space_and_required_companions(self):
  with patch.object(api_server, 'tts_environment_ready', return_value=False):
   models = {model['id']: model for model in api_server.tts_snapshot()['models']}
  voice = models['custom-0.6b']
  self.assertEqual(voice['bytes'], download.catalog_spec('custom-0.6b')['bytes'])
  self.assertEqual(voice['minimumFreeBytes'], voice['bytes'] + download.DOWNLOAD_RESERVE_BYTES)
  self.assertEqual(voice['downloadIncludes'], ['Speech tokenizer'])
  self.assertEqual(models['base-0.6b']['downloadIncludes'], ['Speech tokenizer', 'Speaker encoder'])

 def test_fresh_disk_check_stops_before_runtime_setup(self):
  model = 'custom-0.6b'
  required = download.model_download_details(model)['minimumFreeBytes']
  with (
   tempfile.TemporaryDirectory() as tmp,
   patch.object(api_server, 'TTS_MODEL_ROOT', Path(tmp) / 'speech'),
   patch.dict(api_server.TTS_JOB, {'id': 'test-setup', 'status': 'setting_up', 'logs': [], 'diagnostics': []}),
   patch.object(download.shutil, 'disk_usage', return_value=SimpleNamespace(free=required - 1)),
   patch.object(api_server, 'run_tts_process') as process,
   patch.object(api_server.TEXT_GENERATION_WORKER, 'close') as close,
  ):
   api_server.run_tts_setup(model, 'test-setup', threading.Event())
   self.assertEqual(api_server.TTS_JOB['status'], 'failed')
   self.assertRegex(api_server.TTS_JOB['error'], r'Free at least [0-9.]+ GB')
   self.assertTrue(api_server.TTS_JOB['logs'][-1].endswith('Model setup failed.'))
   self.assertIn('Free at least', api_server.TTS_JOB['diagnostics'][-1])
   process.assert_not_called()
   close.assert_not_called()

 def test_runtime_only_setup_reuses_existing_speech_files(self):
  model = 'base-0.6b'
  with tempfile.TemporaryDirectory() as tmp:
   root = Path(tmp)
   for name in download.required_files(model):
    target = root / f'{model}-OV' / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'legacy OpenVINO export')
   with (
    patch.object(api_server, 'TTS_MODEL_ROOT', root),
    patch.dict(api_server.TTS_JOB, {'id': 'test-setup', 'status': 'setting_up', 'logs': [], 'diagnostics': []}),
    patch.object(api_server, 'tts_environment_ready', return_value=False),
    patch.object(api_server.shutil, 'which', return_value='powershell.exe'),
    patch.object(api_server, 'run_tts_process', return_value=(0, '')) as process,
   ):
    api_server.run_tts_setup(model, 'test-setup', threading.Event())
    self.assertEqual(api_server.TTS_JOB['status'], 'complete')
    self.assertTrue(api_server.TTS_JOB['logs'][-1].endswith('Model setup complete. Ready to generate speech.'))
    process.assert_called_once()
    self.assertIn('install-qwen3-tts.ps1', ' '.join(process.call_args.args[0]))

 def test_speech_setup_platform_reason(self):
  with patch.object(api_server, 'apple_silicon', return_value=False):
   for platform, expected in (('win32', None), ('linux', 'Qwen3-TTS setup is unavailable in the Linux beta.'),
                              ('darwin', 'Speech setup requires Fern on Windows x64.')):
    with self.subTest(platform=platform), patch.object(api_server.sys, 'platform', platform):
     self.assertEqual(api_server.tts_setup_unavailable(), expected)

 def test_manifest_cannot_escape_destination(self):
  with tempfile.TemporaryDirectory() as tmp:
   catalog=Path(tmp)/'catalog.json';catalog.write_text(json.dumps({'base-0.6b':{'repo':'xgirls/fixture','revision':'a'*40,'files':[self.file('../escape.bin',b'bad')]}}))
   with patch.object(download,'CATALOG_PATH',catalog),self.assertRaisesRegex(ValueError,'path'):download.catalog_spec('base-0.6b')
