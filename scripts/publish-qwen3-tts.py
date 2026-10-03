"""Prepare and publish Fern's existing Qwen3-TTS IR exports. Never converts models."""
from __future__ import annotations
import argparse,hashlib,json,os,shutil,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCES={
 'custom-0.6b':'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
 'custom-1.7b':'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
 'base-0.6b':'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
 'base-1.7b':'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
 'voice-design-1.7b':'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
}
def sha256(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(8*1024*1024),b''):h.update(block)
 return h.hexdigest()
def credential():
 token=os.environ.get('HF_TOKEN')
 if not token and (ROOT/'.env').is_file():
  for line in (ROOT/'.env').read_text(encoding='utf-8-sig').splitlines():
   key,sep,value=line.partition('=')
   if key.strip()=='HF_TOKEN' and sep:token=value.strip().strip('\"\'')
 if not token:raise RuntimeError('Set HF_TOKEN in the environment or local .env before publishing.')
 return token

def prepare(namespace):
 catalog={};staging=ROOT/'tmp/hf-qwen3-tts-publish';staging.mkdir(parents=True,exist_ok=True)
 for key,source in SOURCES.items():
  model=ROOT/'models/qwen3-tts'/f'{key}-OV';dest=staging/key;dest.mkdir(exist_ok=True)
  config=json.loads((model/'config.json').read_text(encoding="utf-8"));kind='base' if key.startswith('base') else 'voice_design' if key.startswith('voice-design') else 'custom_voice'
  if config['tts_model_type']!=kind:raise RuntimeError(f'{key}: mismatched model type')
  files=[]
  for p in sorted(model.rglob('*')):
   if not p.is_file():continue
   relative=p.relative_to(model).as_posix()
   if p.suffix.lower() not in {'.xml','.bin','.json','.txt'} or 'checkpoint_path' in p.name:raise RuntimeError(f'Unexpected export file: {relative}')
   if p.suffix=='.xml' and not p.with_suffix('.bin').is_file():raise RuntimeError(f'Missing BIN pair: {relative}')
   print(f'Hashing {key}/{relative}',flush=True)
   files.append({'path':relative,'size':p.stat().st_size,'sha256':sha256(p)})
   target=dest/relative;target.parent.mkdir(parents=True,exist_ok=True)
   if not target.exists():os.link(p,target)
   elif sha256(target)!=files[-1]['sha256']:raise RuntimeError('Staged export changed; use a fresh staging folder.')
  snapshots=ROOT/'models/qwen3-tts/huggingface-cache/hub'/('models--'+source.replace('/','--'))/'snapshots'
  source_revisions=sorted(p.name for p in snapshots.iterdir() if p.is_dir()) if snapshots.exists() else []
  repo=f'{namespace}/{source.split("/")[1]}-OpenVINO'
  manifest={'schemaVersion':1,'model':key,'sourceModel':source,'sourceSnapshotRevisions':source_revisions,'format':'openvino-ir-fp16-compressed','quantizationConfig':None,'openvinoVersion':'2026.4.0','qwenSourceCommit':'1ab0dd75353392f28a0d05d9ca960c9954b13c83','inferenceHelperSha256':'d054da021f701707072d0b8c7b68fe476a2db20555a5f8b5bbd723af496991c8','files':files}
  (dest/'fern-export-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding="utf-8")
  shutil.copy2(ROOT/'models/qwen3-tts/Qwen3-TTS/LICENSE',dest/'LICENSE')
  (dest/'NOTICE').write_text(f'Original Qwen3-TTS weights and source: Alibaba Qwen team. Apache-2.0.\nSource model: {source}\nOpenVINO export prepared for Fern from the OpenVINO notebook conversion path.\nNo fine-tuning, voice reference recordings, generated audio, user data, or credentials are included.\n',encoding="utf-8")
  gib=sum(f['size'] for f in files)/1024**3
  (dest/'README.md').write_text(f'''---
license: apache-2.0
library_name: openvino
pipeline_tag: text-to-speech
base_model: {source}
tags:
- qwen3-tts
- openvino
- fern
- text-to-speech
---
# {source.split('/')[1]} — OpenVINO export for Fern

Ready-made OpenVINO IR export of [{source}](https://huggingface.co/{source}). This repository lets Fern download the converted model directly, without downloading the original PyTorch checkpoint or exporting it on the user's machine.

Mode: `{kind}`. Export size: {gib:.3f} GiB. The IR uses FP16-compressed constants with no NNCF quantization configuration. This is an export of the original model, without fine-tuning.

Includes every XML/BIN pair, the local processor/tokenizer files, and both OpenVINO speech-tokenizer components. Base variants also include the speaker encoder required for voice cloning. `fern-export-manifest.json` records every model file's size and SHA-256 and the local source-cache revisions. No original checkpoints, caches, private voice recordings, or generated WAVs are uploaded.

## Runtime

Use Fern's bundled `tts_runtime/qwen_3_tts_helper.py` and Qwen3-TTS source at commit `1ab0dd75353392f28a0d05d9ca960c9954b13c83`. Validated local dependencies: OpenVINO 2026.4.0, Transformers 4.57.3, PyTorch 2.8.0 and torchaudio 2.8.0 (helper dependencies), Qwen-TTS 0.0.4. Speech-model inference runs on the selected OpenVINO Intel GPU. First load still compiles the downloaded IR locally; model conversion is unnecessary.

Example, with Fern's `scripts/tts_runtime` on Python's module path:

```python
from huggingface_hub import snapshot_download
from qwen_3_tts_helper import OVQwen3TTSModel
folder = snapshot_download("{repo}", revision="<pinned Hub commit>")
model = OVQwen3TTSModel.from_pretrained(model_dir=folder, device="GPU")
```

The local export family produced non-silent 24 kHz WAVs in Fern's prior API validation. Native voice-clone generation was also validated in Fern's later UI work. This does not imply independent benchmarking of every variant on every device. The pinned download path is tested separately after publication.

## License and attribution

Apache-2.0; see LICENSE and NOTICE. Original model and implementation: Alibaba Qwen team. Conversion/inference integration follows the [OpenVINO Qwen3-TTS notebook](https://github.com/openvinotoolkit/openvino_notebooks/tree/latest/notebooks/qwen3-tts). These are community exports, not an official Qwen or Intel release.
''',encoding="utf-8")
  catalog[key]={'repo':repo,'revision':None,'folder':f'{key}-OV','bytes':sum(f['size'] for f in files),'files':files}
 path=ROOT/'scripts/tts_model_catalog.json';path.write_text(json.dumps(catalog,indent=2)+'\n',encoding="utf-8")
 return catalog,staging

def publish(catalog,staging):
 from huggingface_hub import HfApi
 api=HfApi(token=credential());account=api.whoami()['name'];print('Publishing with account:',account,flush=True)
 receipts={}
 for key,spec in catalog.items():
  repo=spec['repo'];print('Uploading:',repo,flush=True)
  api.create_repo(repo_id=repo,repo_type='model',private=False,exist_ok=True)
  allow=[f['path'] for f in spec['files']]+['README.md','LICENSE','NOTICE','fern-export-manifest.json']
  api.upload_large_folder(repo_id=repo,repo_type='model',folder_path=staging/key,allow_patterns=allow,num_workers=4,print_report_every=60)
  info=api.model_info(repo,files_metadata=True);remote={f.rfilename:f for f in info.siblings}
  for f in spec['files']:
   entry=remote.get(f['path'])
   if entry is None or entry.size!=f['size']:raise RuntimeError(f'Remote file missing or wrong size: {repo}/{f["path"]}')
   if entry.lfs and entry.lfs.sha256!=f['sha256']:raise RuntimeError(f'Remote SHA-256 mismatch: {repo}/{f["path"]}')
  # Pin only after a complete verified upload.
  spec['revision']=info.sha
  (ROOT/'scripts/tts_model_catalog.json').write_text(json.dumps(catalog,indent=2)+'\n',encoding="utf-8")
  receipts[key]={'repo':repo,'revision':info.sha,'bytes':spec['bytes'],'files':len(spec['files'])}
  (ROOT/'artifacts/tts-huggingface-publication').mkdir(parents=True,exist_ok=True)
  (ROOT/'artifacts/tts-huggingface-publication/upload-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n',encoding="utf-8")
  print('Verified publication:',repo,info.sha,flush=True)

def main():
 p=argparse.ArgumentParser();p.add_argument('--namespace',default='xgirls');p.add_argument('--publish',action='store_true');p.add_argument('--resume',action='store_true');args=p.parse_args()
 if args.resume:
  catalog=json.loads((ROOT/'scripts/tts_model_catalog.json').read_text(encoding="utf-8"));staging=ROOT/'tmp/hf-qwen3-tts-publish'
 else:catalog,staging=prepare(args.namespace)
 if args.publish:publish(catalog,staging)
if __name__=='__main__':main()
