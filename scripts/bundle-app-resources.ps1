param()

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Resources = Join-Path $Root "apps\desktop\resources"
$ScriptsTarget = Join-Path $Resources "scripts"

if (Test-Path $ScriptsTarget) {
    Remove-Item $ScriptsTarget -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $ScriptsTarget | Out-Null

$ScriptFiles = @(
    "api_server.py",
    "model_catalog.py",
    "model_catalog.json",
    "model_manager.py",
    "model_capabilities.py",
    "device_adapters.py",
    "flux2_klein_pipeline.py",
    "gallery_store.py",
    "generation_worker.py",
    "storage_manager.py",
    "bootstrap_install.py"
)

foreach ($file in $ScriptFiles) {
    $source = Join-Path $Root "scripts\$file"
    if (-not (Test-Path $source)) {
        throw "Missing script: $source"
    }
    Copy-Item $source (Join-Path $ScriptsTarget $file) -Force
}

Write-Host "Bundled backend scripts -> $ScriptsTarget"

