# Contributing

Thanks for helping improve Fern.

## Scope

Fern provides separate image, text, and audio workspaces. Image model families
include Flux.2 Klein, FLUX.3 Klein, Qwen Image 2.1 Turbo, and Tame Pony SDXL;
text and speech models use their own OpenVINO runtimes. Model integrations must
preserve the workspace boundaries, verify pinned model downloads, expose only
supported controls, and report device/runtime limitations clearly. Keep
contributions focused on those integrations, performance, desktop experience,
installation, reliability, accessibility, and docs.

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

New model support should include a pinned catalog, safe download and removal
behavior, packaging-resource entries, model-specific control constraints,
automated regression coverage, and a concise user-facing setup path. Do not add
large model weights, generated media, credentials, or environment-specific
caches to the repository.

