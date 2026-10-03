import hashlib,io,json,sys,tempfile,unittest
from pathlib import Path
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
   with patch.object(download,'catalog_spec',return_value=spec),patch.object(download.urllib.request,'urlopen',return_value=Response(b'evil')):
    with self.assertRaisesRegex(RuntimeError,'checksum'):download.install_model('base-0.6b',root,lambda _:None)
   self.assertFalse((root/spec['folder']).exists());self.assertFalse((root/(spec['folder']+'.download')/'bad.bin.part').exists())
 def test_complete_install_is_atomic_and_idempotent(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);files=[self.file(name,b'IR-fixture') for name in download.required_files('base-0.6b')]
   spec={'repo':'xgirls/fixture','revision':'a'*40,'folder':'base-0.6b-OV','bytes':sum(f['size'] for f in files),'files':files}
   with patch.object(download,'catalog_spec',return_value=spec),patch.object(download.urllib.request,'urlopen',side_effect=lambda *a,**k:Response(b'IR-fixture')) as fetch:
    folder=download.install_model('base-0.6b',root,lambda _:None);count=fetch.call_count
    download.install_model('base-0.6b',root,lambda _:None);self.assertEqual(fetch.call_count,count)
   self.assertTrue(download.model_ready(folder,'base-0.6b'));self.assertTrue(json.loads((folder/'.fern-tts-model.json').read_text())['verifiedSha256'])
   (folder/'openvino_talker_language_model.bin').unlink();self.assertFalse(download.model_ready(folder,'base-0.6b'))
 def test_manifest_cannot_escape_destination(self):
  with tempfile.TemporaryDirectory() as tmp:
   catalog=Path(tmp)/'catalog.json';catalog.write_text(json.dumps({'base-0.6b':{'repo':'xgirls/fixture','revision':'a'*40,'files':[self.file('../escape.bin',b'bad')]}}))
   with patch.object(download,'CATALOG_PATH',catalog),self.assertRaisesRegex(ValueError,'path'):download.catalog_spec('base-0.6b')
