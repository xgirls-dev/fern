#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]] || ! command -v makepkg >/dev/null; then
    echo "Build the Omarchy x86-64 package on Arch Linux with makepkg." >&2
    exit 1
fi
if (( EUID == 0 )); then
    echo "Run the build as a regular user." >&2
    exit 1
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
root=$PWD
desktop=$root/apps/desktop
release=$desktop/release-omarchy
mkdir -p "$root/.runtime"
stage=$(mktemp -d "$root/.runtime/omarchy-build.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT

uv python install 3.12.13 --install-dir "$stage/python" --no-bin
python=$(UV_PYTHON_INSTALL_DIR="$stage/python" uv python find --managed-python 3.12.13)
home=${python%/bin/*}
packages=$home/lib/python3.12/site-packages

# Use the pinned CPU Torch wheel. Image generation uses OpenVINO's GPU plugin.
torch_version=$(sed -n 's/^torch==//p' requirements-release.txt)
sed '/^torch==/d' requirements-release.txt > "$stage/requirements.txt"
uv pip install --python "$python" --target "$packages" --link-mode copy --no-deps \
    --index-url https://download.pytorch.org/whl/cpu "torch==${torch_version}+cpu"
uv pip install --python "$python" --target "$packages" --link-mode copy --no-deps \
    -r "$stage/requirements.txt"
uv pip check --python "$python"
PYTHONNOUSERSITE=1 "$python" scripts/check-release-runtime.py
"$python" scripts/audit-release-resources.py --stage

find "$home" -type d -name __pycache__ -prune -exec rm -rf -- {} +
mkdir "$stage/runtime"
mv -- "$home" "$stage/runtime/python-home"
rm -rf -- "$desktop/resources/runtime-linux"
mv -- "$stage/runtime" "$desktop/resources/runtime-linux"

npm run package:omarchy --workspace @fern/desktop

export FERN_VERSION
FERN_VERSION=$(node -p 'require("./apps/desktop/package.json").version')
export FERN_UNPACKED="$release/linux-unpacked"
export PKGDEST="$release"
cp -- scripts/omarchy/PKGBUILD "$stage/"
cd -- "$stage"
makepkg --force --noconfirm --nodeps
printf 'Omarchy package ready at %s/fern-%s-1-x86_64.pkg.tar.zst\n' "$release" "$FERN_VERSION"
