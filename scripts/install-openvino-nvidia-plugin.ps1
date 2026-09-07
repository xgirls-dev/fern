param(
    [string] $Python = ".venv\Scripts\python.exe",
    [string] $Source = ".cache\openvino_contrib",
    [string] $OpenVinoHome = "",
    [string] $OpenVinoTag = "2026.0.0"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PythonPath = Join-Path $Root $Python

if (-not (Test-Path $PythonPath)) {
    throw "Python not found at $PythonPath. Create the app venv and install requirements first."
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required to fetch openvino_contrib."
}

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    throw "CMake is required to build the OpenVINO NVIDIA plugin."
}

$CudaRoot = $env:CUDA_PATH
$Nvcc = if ($env:CUDACXX) { $env:CUDACXX } elseif ($CudaRoot) { Join-Path $CudaRoot "bin\nvcc.exe" } else { "" }
if (-not $Nvcc -or -not (Test-Path $Nvcc)) {
    throw "CUDA nvcc was not found. Install the CUDA toolkit and set CUDA_PATH or CUDACXX."
}
$env:CUDACXX = $Nvcc

$SourcePath = if ([IO.Path]::IsPathRooted($Source)) { $Source } else { Join-Path $Root $Source }
if (-not (Test-Path (Join-Path $SourcePath "modules\nvidia_plugin\wheel\setup.py"))) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SourcePath) | Out-Null
    Write-Host "Fetching openvino_contrib..."
    & git clone --recurse-submodules --depth 1 https://github.com/openvinotoolkit/openvino_contrib.git $SourcePath
    if ($LASTEXITCODE -ne 0) {
        throw "openvino_contrib clone failed with exit code $LASTEXITCODE."
    }
}

$PluginRoot = Join-Path $SourcePath "modules\nvidia_plugin"
$SetupPy = Join-Path $PluginRoot "wheel\setup.py"
$env:OPENVINO_REPO_DOWNLOAD_URL = "https://github.com/openvinotoolkit/openvino.git"
$env:OPENVINO_REPO_TAG = $OpenVinoTag
if ($OpenVinoHome) {
    $env:OPENVINO_HOME = (Resolve-Path $OpenVinoHome).Path
}

Write-Host "Building the OpenVINO NVIDIA plugin against OpenVINO $OpenVinoTag..."
Write-Host "The plugin uses the shared Flux.2 Klein OpenVINO IR model and registers device NVIDIA."
& $PythonPath $SetupPy install
if ($LASTEXITCODE -ne 0) {
    throw "OpenVINO NVIDIA plugin build/install failed with exit code $LASTEXITCODE."
}

& $PythonPath -c "import openvino_nvidia; import openvino as ov; devices = [str(device) for device in ov.Core().available_devices]; print('OpenVINO NVIDIA devices:', devices); raise SystemExit(0 if any(device == 'NVIDIA' or device.startswith('NVIDIA.') for device in devices) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "The plugin installed, but OpenVINO did not expose an NVIDIA device. Check the NVIDIA driver, CUDA, cuDNN, and cuTENSOR libraries."
}

Write-Host "OpenVINO NVIDIA plugin is ready."

