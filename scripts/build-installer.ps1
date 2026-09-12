$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$Desktop = Join-Path $Root "apps\desktop"
$IconScript = Join-Path $Root "scripts\create-app-icon.ps1"

if (-not (Test-Path (Join-Path $Desktop "resources\icon.ico"))) {
    & $IconScript
}

Write-Host "Preparing self-contained runtime and backend scripts..."
& (Join-Path $Root "scripts\bundle-python-runtime.ps1")
& (Join-Path $Root "scripts\bundle-app-resources.ps1")
$RuntimeZip = Join-Path $Desktop "resources\runtime-release.zip"
if (Test-Path $RuntimeZip) {
    Remove-Item $RuntimeZip -Force
}
$SevenZip = Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\7zip@*" `
    -Recurse -Filter "7za.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($SevenZip) {
    & $SevenZip.FullName a -tzip -mx=0 -y $RuntimeZip `
        (Join-Path $Desktop "resources\runtime-release\*")
} else {
    tar -a -cf $RuntimeZip -C (Join-Path $Desktop "resources\runtime-release") .
}
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $RuntimeZip)) {
    throw "Failed to create the bundled runtime ZIP."
}

Write-Host "Building one-click installer..."
Write-Host "  Python and OpenVINO are bundled. Optional models download from Preferences; the NVIDIA plugin is bundled when installed in the build environment."

Push-Location $Desktop
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:CI -ErrorAction SilentlyContinue
$NpmCommand = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }
& $NpmCommand run package
if ($LASTEXITCODE -ne 0) {
    throw "Installer packaging failed (npm exit $LASTEXITCODE)."
}
Pop-Location

$Installer = Get-ChildItem -Path (Join-Path $Desktop "release") -Filter "*Setup*.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $Installer) {
    throw "Installer was not produced. Check apps\desktop\release"
}

$sizeMb = [math]::Round($Installer.Length / 1MB, 1)
Write-Host ""
Write-Host "Installer ready (${sizeMb} MB):"
Write-Host "  $($Installer.FullName)"
Write-Host ""
Write-Host "Double-click to install. No Python, Git, terminal, or project checkout is required."

