param(
    [string] $PythonHome = "",
    [string] $SourceVenv = ".venv"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$VenvPath = Join-Path $Root $SourceVenv
$SitePackages = Join-Path $VenvPath "Lib\site-packages"
$RuntimeDir = Join-Path $Root "apps\desktop\resources\runtime-release"
$PythonHomeTarget = Join-Path $RuntimeDir "python-home"
$SitePackagesTarget = Join-Path $RuntimeDir "site-packages"

if (-not (Test-Path (Join-Path $VenvPath "Scripts\python.exe"))) {
    throw "Source venv not found at $VenvPath. Create it and install requirements first."
}

if (-not $PythonHome) {
    $PythonHome = (& (Join-Path $VenvPath "Scripts\python.exe") -c "import sys; print(sys.base_prefix)").Trim()
}

if (-not (Test-Path $PythonHome)) {
    throw "Python home not found at $PythonHome. Set -PythonHome to your Python 3.12 install path."
}

if (-not (Test-Path $SitePackages)) {
    throw "site-packages not found at $SitePackages"
}

Write-Host "Bundling portable Python runtime..."
Write-Host "  Python home: $PythonHome"
Write-Host "  site-packages: $SitePackages"

if (Test-Path $RuntimeDir) {
    Remove-Item $RuntimeDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PythonHomeTarget, $SitePackagesTarget | Out-Null

$PythonExcludeDirs = @("tcl", "idlelib", "test", "tests", "__pycache__", "Doc", "include", "libs", "Library")
$PythonExcludeArgs = $PythonExcludeDirs | ForEach-Object { "/XD", $_ }

robocopy $PythonHome $PythonHomeTarget /E /NFL /NDL /NJH /NJS /nc /ns /np @PythonExcludeArgs /XF *.pdb | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "Failed to copy Python home (robocopy exit $LASTEXITCODE)"
}

# We ship deps in runtime/site-packages via PYTHONPATH — drop the duplicate tree
# copied from the system Python install to save ~2-3 GB in the installer.
$DuplicateSitePackages = Join-Path $PythonHomeTarget "Lib\site-packages"
if (Test-Path $DuplicateSitePackages) {
    Write-Host "Removing duplicate Lib\site-packages from python-home..."
    Remove-Item $DuplicateSitePackages -Recurse -Force
}

$SiteExcludeDirs = @("__pycache__", "pip", "setuptools", "pkg_resources")
$SiteExcludeArgs = $SiteExcludeDirs | ForEach-Object { "/XD", $_ }

robocopy $SitePackages $SitePackagesTarget /E /NFL /NDL /NJH /NJS /nc /ns /np @SiteExcludeArgs /XF *.pdb *.lib | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "Failed to copy site-packages (robocopy exit $LASTEXITCODE)"
}


$PythonExe = Join-Path $PythonHomeTarget "python.exe"
$VerifyScript = @"
import sys
sys.path.insert(0, r'$SitePackagesTarget')
import PIL
import openvino
import torch
print('bundled-python-ok', sys.version)
print('openvino', openvino.__version__)
print('torch', torch.__version__)
try:
    import openvino_nvidia
    print('openvino-nvidia', openvino_nvidia.__file__)
except Exception as exc:
    print('openvino-nvidia-not-bundled', exc)
"@

& $PythonExe -c $VerifyScript
if ($LASTEXITCODE -ne 0) {
    throw "Bundled Python verification failed."
}

Write-Host "Bundled Python runtime ready at $RuntimeDir"

