# Fern Wallpapers

Generate a wallpaper with Fern and set it from the Omarchy bar. The panel uses the running Fern app and its installed FLUX.2 Klein 4B model to generate a 1280 × 720 image locally. Applying it keeps a copy under `$XDG_DATA_HOME/fern-wallpapers` (normally `~/.local/share/fern-wallpapers`) so the wallpaper survives changes to Fern’s gallery.

## Install on Omarchy

Requires Omarchy Quattro, system Python 3, a supported Intel GPU, and a Fern build from the source that includes this plugin. The Omarchy beta package can be built on x86-64 Arch with `npm ci` and `npm run package:omarchy`. See the [Fern build requirements](../../../README.md#build-installable-packages).

After installing and opening that Fern build, install **FLUX.2 Klein 4B** in **Models** and leave Fern running. From the root of the Fern checkout, install the plugin into your Omarchy config directory.

```bash
source=plugins/omarchy/fern-wallpapers
target="$HOME/.config/omarchy/plugins/xgirls-dev.fern-wallpapers"
omarchy plugin validate "$source" &&
    mkdir -p "$target" &&
    install -m 644 "$source/manifest.json" "$source/WallpaperWidget.qml" "$source/wallpaper.py" "$target/" &&
    omarchy-shell shell rescanPlugins &&
    omarchy plugin enable xgirls-dev.fern-wallpapers
```

Click the picture icon in the bar. Enter a prompt, select **Generate**, and select **Apply** once the preview appears. If Fern is busy with another job, wait for it to finish and try again.
