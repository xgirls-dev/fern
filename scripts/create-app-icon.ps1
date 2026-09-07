$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
$Python = if (Test-Path $VenvPython) { $VenvPython } else { "python" }
$Generator = Join-Path $PSScriptRoot "create_app_icon.py"

& $Python $Generator
if ($LASTEXITCODE -ne 0) {
    throw "Fern icon generation failed."
}
