"""Opt-in real-model smoke test. Run with the release Python and a local export."""
import json
import os
import sys
import threading
from pathlib import Path
from text_generation_process import TextGenerationProcess
from text_model_registry import inspect_model

folder = str(Path(sys.argv[1]).resolve())
inspect_model(folder)
worker = TextGenerationProcess()
root = Path(__file__).resolve().parents[1]
reports = []

def generate(device, messages, cancel=False):
    event = threading.Event()
    chunks = []
    def token(text):
        chunks.append(text)
        if cancel:
            event.set()
            worker.interrupt()
    result = worker.generate(model_path=folder, device=device,
        command=[sys.executable, '-u', str(root / 'scripts/text_generation_worker.py'), folder, device],
        request={'op': 'generate', 'messages': messages, 'systemPrompt': 'Answer briefly and accurately.', 'maxNewTokens': 48 if not cancel else 1024, 'temperature': 0, 'topP': 0.9, 'seed': 42},
        cwd=root, env={**os.environ, 'PYTHONUTF8': '1'}, on_token=token,
        on_phase=lambda text: print(text[:300], flush=True), cancel_event=event)
    assert result['inputTokens'] > 1 and result['outputTokens'] > 0, result
    assert chunks, 'No streaming chunks'
    reports.append({'device': device, **result})
    print(json.dumps(reports[-1], ensure_ascii=False), flush=True)
    return result

try:
    first = generate('GPU', [{'role': 'user', 'content': 'Remember the code word fern. Reply with the code word only.'}])
    process = worker._process
    generate('GPU', [{'role': 'user', 'content': 'Remember the code word fern. Reply with the code word only.'}, {'role': 'assistant', 'content': first['text']}, {'role': 'user', 'content': 'What code word did I give you?'}])
    assert worker._process is process, 'Worker was not reused'
    try:
        generate('GPU', [{'role': 'user', 'content': 'Write a long numbered list of 100 facts about trees.'}], cancel=True)
        raise AssertionError('Cancellation unexpectedly returned a complete response')
    except (RuntimeError, InterruptedError):
        print('Cancellation interrupted worker successfully.', flush=True)
    generate('GPU', [{'role': 'user', 'content': 'What is two plus two?'}])
    generate('CPU', [{'role': 'user', 'content': 'What is two plus two?'}])
    target = root / 'artifacts/text-runtime-verification.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(reports, indent=2), encoding='utf-8')
    print('GPU, CPU, multi-turn, reuse, cancellation and recovery passed.', flush=True)
finally:
    worker.close()
