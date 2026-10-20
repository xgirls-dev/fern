"""Reject retired experiment dependencies before bundling the image runtime."""
from __future__ import annotations

import importlib.metadata as metadata
import json
from pathlib import Path
from packaging.requirements import Requirement


def verify_runtime() -> dict[str, str]:
    installed = {distribution.metadata['Name'].lower().replace('_', '-'): distribution
                 for distribution in metadata.distributions()}
    forbidden = {'qwen-tts', 'qwen3-tts'} & installed.keys()
    if forbidden:
        raise RuntimeError(f'Retired/separate model dependencies in the build environment: {sorted(forbidden)}')
    for line in (Path(__file__).parents[1] / 'requirements-release.txt').read_text(encoding='utf-8-sig').splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        requirement = Requirement(line)
        if requirement.marker and not requirement.marker.evaluate():
            continue
        distribution = metadata.distribution(requirement.name)
        if requirement.specifier and not requirement.specifier.contains(distribution.version, prereleases=True):
            raise RuntimeError(f'{requirement.name} must match requirements-release.txt before bundling.')
        if requirement.url:
            expected_url, expected_commit = requirement.url.removeprefix('git+').rsplit('@', 1)
            source = json.loads(distribution.read_text('direct_url.json') or '{}')
            if source.get('url') != expected_url or source.get('vcs_info', {}).get('commit_id') != expected_commit:
                raise RuntimeError(f'{requirement.name} must come from the locked Git commit in requirements-release.txt.')
    from optimum.intel import OVFlux2KleinPipeline
    assert OVFlux2KleinPipeline is not None
    import openvino_genai
    import openvino_tokenizers
    assert openvino_genai.LLMPipeline is not None
    assert openvino_tokenizers is not None
    return {name: metadata.version(name) for name in ('openvino', 'openvino-genai', 'openvino-tokenizers', 'torch', 'diffusers', 'optimum-intel')}


if __name__ == '__main__':
    print('Release runtime verified:', json.dumps(verify_runtime(), sort_keys=True))
