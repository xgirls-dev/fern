#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo "Build the Fern Mac preview on an Apple Silicon macOS runner." >&2
  exit 1
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
root=$PWD
# The signing tool scans the bundled Python wheels concurrently.
file_limit=$(ulimit -Hn)
if [[ "$file_limit" == unlimited ]] || (( file_limit > 32768 )); then
  file_limit=32768
fi
ulimit -Sn "$file_limit"
printf 'Mac packaging file limit %s\n' "$(ulimit -Sn)"

mkdir -p "$root/.runtime"
stage=$(mktemp -d "$root/.runtime/macos-build.XXXXXX")
cleanup() {
  python3 -c 'import shutil, sys; shutil.rmtree(sys.argv[1])' "$stage"
}
trap cleanup EXIT

uv python install 3.12.13 --install-dir "$stage/python" --no-bin
python=$(UV_PYTHON_INSTALL_DIR="$stage/python" uv python find --managed-python 3.12.13)
python_home=${python%/bin/*}
packages=$python_home/lib/python3.12/site-packages
uv pip install --no-deps --only-binary :all: --python "$python" --target "$packages" \
  --link-mode copy -r scripts/requirements-macos.txt
uv pip check --python "$python"
PYTHONNOUSERSITE=1 "$python" scripts/audit-release-resources.py --stage

runtime=$root/apps/desktop/resources/runtime-macos
python3 - "$python_home" "$runtime" <<'PY'
import shutil
import sys
from pathlib import Path

source, target = (Path(argument) for argument in sys.argv[1:])
# Wheels include thousands of C++ headers and caches used by build tools.
# Fern only uses the prebuilt inference libraries in the preview.
packages = source / "lib" / "python3.12" / "site-packages"
for path in (
    source / "include",
    packages / "torch" / "include",
    packages / "torch" / "share" / "cmake",
    *source.rglob("__pycache__"),
):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
if target.is_symlink():
    raise RuntimeError("The Mac runtime staging location must not be a symlink.")
if target.exists():
    shutil.rmtree(target)
target.mkdir()
source.rename(target / "python-home")
PY

npm run package:macos --workspace @fern/desktop
