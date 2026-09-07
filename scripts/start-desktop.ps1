$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    throw "Python venv not found at $Python. Create it and install requirements first."
}

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Host "Installing desktop dependencies..."
    Push-Location $Root
    npm install
    Pop-Location
}

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

Push-Location $Root
npm run dev
Pop-Location
