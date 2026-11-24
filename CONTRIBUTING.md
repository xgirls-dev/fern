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

## Desktop chat smoke test

Run `npm run test:electron --workspace @fern/desktop` for the source-built
desktop app. To verify a package, set `FERN_E2E_EXECUTABLE` to the absolute path
of its executable and run `node apps/desktop/e2e/smoke.mjs` on the target OS.
The release workflows run the same smoke tests in the packaged app.
They seed an isolated history and verify exact search, reply deletion, Undo,
and persistence through reload without downloading a model. The composer test
uses Chromium's input pipeline for multiline typing, composition, chooser
selection and cancellation, and file drops. On each supported OS, also try
candidate selection and cancellation with an installed input method, paste text
and an image, and attach a document using the system file picker.

## Verify workspace backup and search

Run `npm run build`, then `node apps/desktop/e2e/workspace-backup.mjs`. The test uses disposable profiles and verifies backup, restore, and search in the original and recovered workspaces.

Set `FERN_E2E_EXECUTABLE` to run against the packaged app. To check an upgrade, set `FERN_E2E_PREVIOUS_EXECUTABLE` to a prior package with Save Backup, or set `FERN_E2E_PREVIOUS_SOURCE_ENTRY` to that checkout’s built `apps/desktop/out/main/index.js`. The test opens the same profile on the new build before restoring the archive.

## Release notes

Add user-visible changes to `CHANGELOG.md` under **Unreleased** as they land.
Before a release, move those notes into a dated `## [version]` section and group
them under **Added**, **Improved**, or **Fixed**. The release workflow requires
that section and publishes it as the GitHub Release description, including when
rebuilding an existing release tag.

New model support should include a pinned catalog, safe download and removal
behavior, packaging-resource entries, model-specific control constraints,
automated regression coverage, and a concise user-facing setup path. Do not add
large model weights, generated media, credentials, or environment-specific
caches to the repository.

