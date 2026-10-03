"""Pinned, anonymous downloads of ready-made Qwen3-TTS OpenVINO exports."""
from __future__ import annotations
import hashlib,json,os,re,shutil,time,urllib.request
from pathlib import Path,PurePosixPath
CATALOG_PATH=Path(__file__).with_name('tts_model_catalog.json')
COMPONENTS=(
 'openvino_talker_language_model','openvino_talker_embedding_model',
 'openvino_talker_text_embedding_model','openvino_talker_text_projection_model',
 'openvino_talker_code_predictor_embedding_model','openvino_talker_code_predictor_model',
 'speech_tokenizer/openvino_speech_tokenizer_encoder_model','speech_tokenizer/openvino_speech_tokenizer_decoder_model',
)
def required_files(model):
 components=COMPONENTS+('openvino_speaker_encoder_model',) if model.startswith('base-') else COMPONENTS
 return [name+ext for name in components for ext in ('.xml','.bin')]+['config.json','tokenizer_config.json','tokenizer.json','speech_tokenizer/config.json','speech_tokenizer/preprocessor_config.json']
def model_ready(folder,model):
 try:return all((folder/name).is_file() and (folder/name).stat().st_size>0 for name in required_files(model))
 except OSError:return False

def catalog_spec(model):
 catalog=json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
 if model not in catalog:raise ValueError('Choose a supported Qwen3-TTS model.')
 spec=catalog[model]
 if not re.fullmatch(r'[a-f0-9]{40}',spec.get('revision') or ''):raise RuntimeError('This speech export has not been published yet. Update Fern after publication.')
 if not re.fullmatch(r'[\w.-]+/[\w.-]+',spec['repo']):raise ValueError('Invalid speech model repository.')
 seen=set()
 for file in spec['files']:
  path=PurePosixPath(file['path'])
  if path.is_absolute() or '..' in path.parts or '\\' in file['path'] or file['path'] in seen or path.as_posix()!=file['path']:raise ValueError('Invalid speech export path.')
  if file['size']<=0 or not re.fullmatch(r'[a-f0-9]{64}',file['sha256']):raise ValueError('Invalid speech export checksum or size.')
  seen.add(file['path'])
 if not set(required_files(model)).issubset(seen):raise ValueError('Speech manifest is incomplete.')
 return spec

def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(4*1024*1024),b''):h.update(block)
 return h.hexdigest()
def verified(path,file):
 return path.is_file() and path.stat().st_size==file['size'] and digest(path)==file['sha256']

def download_file(url,target,file,progress):
 target.parent.mkdir(parents=True,exist_ok=True);partial=target.with_name(target.name+'.part')
 if verified(target,file):return
 offset=partial.stat().st_size if partial.exists() else 0
 if offset>file['size']:partial.unlink();offset=0
 if offset==file['size']:
  if digest(partial)==file['sha256']:os.replace(partial,target);return
  partial.unlink();offset=0
 headers={'User-Agent':'Fern-Qwen3-TTS-Installer/1','Accept-Encoding':'identity'}
 if offset:headers['Range']=f'bytes={offset}-'
 with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=60) as response:
  status=response.getcode()
  if offset and status==206:
   value=response.headers.get('Content-Range','')
   if not value.startswith(f'bytes {offset}-'):raise RuntimeError('Server returned an incorrect download range. Retry setup.')
  elif status==200:offset=0
  elif status!=206:raise RuntimeError(f'Unexpected model download response: {status}')
  downloaded=offset;last=0.0
  with partial.open('ab' if offset else 'wb') as stream:
   while block:=response.read(1024*1024):
    downloaded+=len(block)
    if downloaded>file['size']:raise RuntimeError('Model download exceeded its expected size.')
    stream.write(block)
    now=time.monotonic()
    if now-last>=2:
     progress(f'Downloading {file["path"]} · {downloaded/file["size"]*100:.0f}%');last=now
 if partial.stat().st_size!=file['size']:raise RuntimeError('Model download interrupted. Retry setup to resume.')
 progress(f'Verifying {file["path"]}.')
 if digest(partial)!=file['sha256']:
  partial.unlink();raise RuntimeError('Model checksum verification failed. Retry setup to download the file again.')
 os.replace(partial,target)

def install_model(model,model_root,progress=print):
 spec=catalog_spec(model);root=Path(model_root).resolve();root.mkdir(parents=True,exist_ok=True)
 folder=root/spec['folder'];stage=root/(spec['folder']+'.download')
 if folder.parent!=root or stage.parent!=root:raise ValueError('Invalid speech model folder.')
 marker=folder/'.fern-tts-model.json'
 if marker.is_file():
  try:
   metadata=json.loads(marker.read_text())
   if metadata.get('revision')==spec['revision'] and model_ready(folder,model) and all((folder/f['path']).stat().st_size==f['size'] for f in spec['files']):
    progress('OpenVINO speech model is already installed.');return folder
  except (OSError,ValueError):pass
 stage.mkdir(exist_ok=True)
 missing=0
 for file in spec['files']:
  target=stage/file['path']
  if verified(target,file):continue
  partial=target.with_name(target.name+'.part')
  offset=partial.stat().st_size if partial.is_file() else 0
  # A full but invalid partial will be restarted, so reserve its full size.
  missing+=file['size']-offset if 0<offset<file['size'] else file['size']
 if shutil.disk_usage(root).free<missing+512*1024**2:raise RuntimeError(f'Free at least {(missing+512*1024**2)/1024**3:.1f} GiB before installing this speech model.')
 progress(f'Downloading ready-made OpenVINO model · {spec["bytes"]/1024**3:.2f} GiB. No conversion is needed.')
 for file in spec['files']:
  url=f'https://huggingface.co/{spec["repo"]}/resolve/{spec["revision"]}/{file["path"]}'
  download_file(url,stage/file['path'],file,progress)
 if not model_ready(stage,model):raise RuntimeError('Downloaded speech model is incomplete.')
 (stage/'.fern-tts-model.json').write_text(json.dumps({'model':model,'repo':spec['repo'],'revision':spec['revision'],'format':'openvino-ir','verifiedSha256':True},indent=2))
 previous=None
 if folder.exists():
  previous=root/(spec['folder']+f'.previous-{time.time_ns()}');os.replace(folder,previous)
 try:os.replace(stage,folder)
 except BaseException:
  if previous:os.replace(previous,folder)
  raise
 progress('OpenVINO speech model installed and verified. Ready to generate.')
 return folder
