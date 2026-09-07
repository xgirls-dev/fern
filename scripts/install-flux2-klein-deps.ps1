param(
    [string] $Python = ".venv\Scripts\python.exe"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $repoRoot $Python

if (-not (Test-Path $pythonPath)) {
    throw "Python not found at $pythonPath. Create the app venv first."
}

Write-Host "Installing Flux.2 Klein OpenVINO dependencies into the app venv..."
Write-Host "Intel GPU, NVIDIA GPU, and CPU all use the same OpenVINO Flux.2 Klein model."

& $pythonPath -m pip install -r (Join-Path $repoRoot "requirements.txt")

if ($LASTEXITCODE -ne 0) {
    throw "FLUX.2 Klein dependency install failed with exit code $LASTEXITCODE."
}

& $pythonPath -c "from optimum.intel import OVFlux2KleinPipeline; import openvino, torch; print('OVFlux2KleinPipeline ready'); print('openvino', openvino.__version__); print('torch', torch.__version__)"

if ($LASTEXITCODE -ne 0) {
    throw "FLUX.2 Klein dependency verification failed with exit code $LASTEXITCODE."
}

$nvidiaPluginReady = $true
try {
    & $pythonPath -c "import openvino_nvidia; import openvino as ov; print('OpenVINO NVIDIA devices', list(ov.Core().available_devices))"
    if ($LASTEXITCODE -ne 0) { throw "plugin import failed" }
} catch {
    $nvidiaPluginReady = $false
    Write-Warning "OpenVINO NVIDIA plugin is not installed. Run scripts\install-openvino-nvidia-plugin.ps1 before bundling NVIDIA support."
}

if ($nvidiaPluginReady) {
    Write-Host "OpenVINO NVIDIA plugin is ready."
}
Write-Host "Done. Use scripts\bootstrap_install.py to download the shared Flux.2 Klein OpenVINO model."

