# Contributing

Thanks for helping improve Fern.

## Scope

Fern supports one image model: Flux.2 Klein 9B with OpenVINO Intel GPU,
OpenVINO NVIDIA plugin, and CPU devices. Please keep contributions focused on those
runtimes, their performance, the desktop experience, installation, reliability,
accessibility, and docs.

## Development workflow

1. Create a branch from `main`.
2. Install the Node and Python dependencies described in `README.md`.
3. Make a focused change with no generated models, outputs, runtimes, or release
   binaries.
4. Run `npm run check`.
5. Open a pull request describing the behavior and how it was verified.

GPU generation is intentionally not part of CI. If a change affects inference,
include the tested device, resolution, steps, and observed result in the pull
request.

