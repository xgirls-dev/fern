param(
    [Parameter(Mandatory = $true)][string]$BasePython,
    [Parameter(Mandatory = $true)][string]$ModelRoot
)
$ErrorActionPreference = 'Stop'
$envDir = Join-Path (Split-Path -Parent (Split-Path -Parent $ModelRoot)) '.venv-qwen3-tts'
$python = Join-Path $envDir 'Scripts/python.exe'
# Portable Fern Python uses these variables; keep them for venv creation only.
if (-not (Test-Path -LiteralPath $python)) {
    & $BasePython -m venv $envDir
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Qwen3-TTS Python environment.' }
}
Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
function Write-ProgressLine([string]$message) { Write-Output ('FERN_TTS_PROGRESS:' + $message) }
Write-ProgressLine 'Installing the speech runtime. Models are downloaded already converted.'
& $python -m pip install -r (Join-Path $PSScriptRoot 'requirements-qwen3-tts-runtime.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install the Qwen3-TTS inference runtime.' }
$env:PYTHONPATH = Join-Path $PSScriptRoot 'tts_runtime'
& $python -c "import openvino, torch, qwen_tts, soundfile; from qwen_3_tts_helper import OVQwen3TTSModel; print('Speech runtime ready. OpenVINO', openvino.__version__)"
if ($LASTEXITCODE -ne 0) { throw 'Qwen3-TTS inference runtime verification failed.' }
$hasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $requirementsHash = [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'requirements-qwen3-tts-runtime.txt')))).Replace('-', '').ToLowerInvariant()
} finally { $hasher.Dispose() }
$runtimeMarker = @{
    schemaVersion = 1
    requirementsSha256 = $requirementsHash
}
$runtimeMarker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $envDir '.fern-runtime.json') -Encoding utf8
New-Item -ItemType Directory -Force -Path $ModelRoot | Out-Null
Write-ProgressLine 'Speech runtime installed. Ready to download the selected OpenVINO model.'
