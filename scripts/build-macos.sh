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

if [[ "${FERN_MAC_PRECOMPILE_GGUF:-false}" == true ]]; then
  llama_revision=52975342ff6b85127ff31930d39e36725fd08809
  llama_source="$stage/llama-cpp"
  git init -q "$llama_source"
  git -C "$llama_source" fetch --depth=1 https://github.com/ggml-org/llama.cpp.git "$llama_revision"
  git -C "$llama_source" checkout --quiet --detach FETCH_HEAD
  test "$(git -C "$llama_source" rev-parse HEAD)" = "$llama_revision"
  if ! xcrun -sdk macosx metal --version; then
    xcodebuild -downloadComponent MetalToolchain
  fi
  cmake -S "$llama_source" -B "$stage/llama-build" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH=@loader_path \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 -DGGML_NATIVE=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=OFF \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_APP=OFF -DLLAMA_OPENSSL=OFF \
    -DLLAMA_BUILD_NUMBER=12498 -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF
  cmake --build "$stage/llama-build" --target llama-server ggml-metal-lib --parallel 3
  package="$runtime/llama-b12498-macos-arm64-precompiled"
  mkdir "$package"
  cp -L "$stage/llama-build/bin/llama-server" "$stage"/llama-build/bin/*.dylib "$stage"/llama-build/bin/*.metallib "$package/"
  cp "$llama_source/LICENSE" "$package/LICENSE-llama.cpp.txt"
  python3 - "$package" <<'PY'
import json
import sys
from pathlib import Path

runtime = Path(sys.argv[1])
files = {file.name: file.stat().st_size for file in runtime.iterdir() if file.is_file()}
required = {"llama-server", "default.metallib", "libggml-metal.dylib", "libllama-server-impl.dylib", "libmtmd.dylib"}
if not required <= files.keys() or any(size == 0 for size in files.values()):
    raise RuntimeError("The precompiled Metal runtime is incomplete.")
(runtime / "runtime.json").write_text(json.dumps(files, sort_keys=True), encoding="utf-8")
PY
fi

npm run package:macos --workspace @fern/desktop
