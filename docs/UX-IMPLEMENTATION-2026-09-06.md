# Fern UX implementation — September 6, 2026

Implemented the coordinated changes from [the 34-finding audit](../UX-AUDIT-2026-09-06.md), including the final direction to put a small search icon beside the Fern logo. Clicking it opens a focused thread-search dialog; there is no inline sidebar search field.

This is a source implementation and verified desktop build. A new installer has not been published. Real GPU generation, installed-app upgrade behavior, Windows display scaling, and screen-reader announcements remain release validation tasks.

## Finding-by-finding changes

| Audit ID | Implemented behavior |
|---|---|
| 01 | Removed the redundant sidebar runtime card. Device diagnostics remain in relevant settings surfaces. |
| 02 | Typing and settings edits preserve thread names. An unnamed thread receives its automatic name on its first accepted generation, then keeps it until explicitly renamed. |
| 03 | Render info is a collapsed disclosure below the preview, outside the image stage. |
| 04 | Added 720 × 1280, 1280 × 720, 1920 × 1088, and 1088 × 1920. The wide preset does not claim an exact 16:9 ratio. |
| 05 | Image actions use compact, dismissible notifications outside canvas layout. Ordinary success messages expire; errors and Undo actions remain available until dismissed or used. |
| 06 | Every gallery image exposes Delete through shared actions. Confirmation explains that the file moves to Windows Recycle Bin. Views reconcile after deletion, including the last selected image. |
| 07 | Device options use short adapter labels, including NVIDIA GPU. Diagnostic sentences are outside the selector. Unavailable devices remain disabled. |
| 08 | Remix creates a new variation thread and preserves the existing draft. |
| 09 | New reference-based generations preserve original reference bytes and provenance. Remix restores that reference; missing or legacy provenance produces an explicit warning and clears unrelated reference state. |
| 10 | Recipe application and removal have Undo. Application Undo is scoped to the original thread and affected fields, even after navigation. Recipe selection reflects subsequent edits. |
| 11 | Custom resolution activates dimension editing and focuses Width. Numeric fields accept temporary empty edits without immediately replacing them with zero. |
| 12 | Connection, persistence, operation, and field errors have separate lifecycles. Successful background polling does not erase validation failures. |
| 13 | Invalid submission reveals settings and focuses the first invalid field. Inline messages connect to controls through accessible invalid/described-by attributes. |
| 14 | New default settings use random seeds. Composer controls expose random/fixed state. Existing saved seed policies remain intact. |
| 15 | Both attachment paths validate the 10 MB and 16-megapixel limits early. Failed replacement preserves the previous valid reference. |
| 16 | Runtime loading/failure can be dismissed to continue into the workspace. Library remains accessible, with a compact recovery path for generation. |
| 17 | Open modals block unrelated background keyboard shortcuts. Focus trapping respects nested dialogs. |
| 18 | Progress tracks batch image number and per-image steps. A running batch cannot display 100% based on a previous image's last step. |
| 19 | Open-image and output-folder handlers interpret Electron's error-string result and surface failure. |
| 20 | Notifications carry explicit severity; error treatment does not depend on English wording. |
| 21 | Completion/failure notices identify the originating thread and provide a direct navigation action. |
| 22 | Use current output checks the response, shows attachment work in progress, catches errors, and preserves a valid existing reference. |
| 23 | The Library viewer includes metadata and shared Save, Remix, Copy, Open, Folder, and Delete actions. Previous/next follows the filtered order without replacing drafts. |
| 24 | Viewer supports Fit, 100%, zoom controls, scroll/pan, and image-load retry. |
| 25 | Filtered galleries show matching and total counts. Removed misleading persistent thumbnail selection from another review context. |
| 26 | Gallery query, sort, view choice, render limit, and scroll position survive ordinary workspace navigation. Starting a render does not force the user out of the gallery. |
| 27 | Preview, viewer, and thumbnail failures have retry paths. Thumbnail identity includes file modification time. Shared actions remain available for unavailable images. |
| 28 | Command search now uses connected combobox/listbox semantics, stable option IDs, selected state, and active-descendant navigation. |
| 29 | Canvas and device controls lead the inspector. Recipes are collapsed initially; redundant model chrome and duplicate dimension-swap controls are removed. |
| 30 | Activity follows output only while the reader is at the bottom. Scrolling back preserves position and exposes Jump to latest. |
| 31 | Gallery renders 48 images initially, with Show more. Sidebar/search render 60 thread rows at a time. Status polling is separated from image listings, metadata is read once per listing, draft persistence is debounced with a dirty-state flush, and stable sidebar summaries avoid keystroke-driven row updates. |
| 32 | Logo search icon opens a searchable thread dialog with archive, restore, rename, and delete. Search remains accessible in the compact sidebar. |
| 33 | Narrow settings layouts transfer focus, support Escape dismissal, and prevent interaction with the covered canvas. Thread management remains accessible through search. |
| 34 | Increased small secondary text and simplified action hierarchy: Save and Remix are prominent; secondary actions share More. |

Pinning and project grouping were optional ideas in the audit, not implementation requirements, and were not added.

## Verification results

All checks below passed against the implemented source:

- Renderer and main/preload TypeScript checks.
- Production Electron/Vite build: main, preload, and renderer bundles.
- Python discovery suite: **21 tests**, including exact preset acceptance, original reference-byte preservation across batches, one metadata read per listing, and preventing deleted output resurrection through status.
- `tests/ux-workflows.mjs`: logo search dialog/focus, stable naming, presets and Custom, persistent inline validation/focus, recipe Undo, metadata placement, notifications, draft-safe Remix, filtered review, zoom, nested deletion, modal shortcut isolation, archive/restore, batch progress, runtime recovery, and responsive/theme checks.
- `tests/ux-edge-cases.mjs`: cross-thread recipe Undo, saved-recipe recovery after navigation, reference limits and preservation, original reference restoration, OS-action errors, command selection semantics, and activity scroll retention.
- `tests/renderer-interactions.mjs`: existing sidebar/navigation regressions, rename and delete cancellation/confirmation, active and last-thread deletion, reload persistence, running-thread protection, retained images, scrolling, Preferences, and themes.
- `tests/ux-scale.mjs`: bounded rendering and interaction measurements with 100/1,000 images and 100/500 threads.
- `tests/native-image-actions.cjs`: Electron moved a disposable test PNG to Windows Recycle Bin and reported the missing-file open error. No user image was deleted during verification.

The browser suites use an isolated profile with mocked device, generation, image, and OS responses. Browser success does not establish GPU correctness or full native integration. The native test covers the underlying Electron shell behavior separately. No uncaught browser exceptions were reported by the completed suites.

### Scale measurements

These are local development-fixture timings, not production performance guarantees. Input-to-frame includes browser automation overhead.

| Images / threads | Input-to-frame p95 | Open Library | Filter | Initial cards / thread rows | Status calls / image listings during sample |
|---|---:|---:|---:|---:|---:|
| 100 / 100 | 93.6 ms | 195.4 ms | 37.5 ms | 48 / 60 | 6 / 2 |
| 1,000 / 500 | 121.1 ms | 106.2 ms | 36.9 ms | 48 / 60 | 7 / 2 |

The workload still loads the complete gallery index periodically; pagination limits rendered elements, not the backend index. Production memory profiling and sustained scrolling with real images remain useful follow-up measurements. The debounce reduces synchronous persistence work but a sudden process termination can still lose the most recent unflushed edit.

## Evidence and reproduction

Fresh local evidence is under `artifacts/ux-verification/` (ignored generated artifacts):

- `search-dialog.png`: requested logo search interaction.
- `settings-1080.png`, `settings-1440.png`, `settings-390.png`: settings hierarchy and responsive layouts.
- `dark-preview.png`, `viewer.png`: theme and image-review surfaces.
- `navigation/`: existing interaction-suite captures.
- `results.json`, `scale-results.json`, `native-results.json`: machine-readable results.

The older audit's `.cache/fern-ui` evidence is historical; use the fresh artifact directory for this implementation. Test sources are retained in `tests/` and generate fresh fixtures rather than operating on personal data.

Run type checks with the repository TypeScript binary and build with `electron-vite build` from `apps/desktop`. Run Python discovery with a Python environment containing the repository dependencies. Browser suites accept `FERN_PLAYWRIGHT_MODULE` and `FERN_CHROME_PATH` to select the local Playwright module and Chrome executable. For the native script, launch it with Electron with `ELECTRON_RUN_AS_NODE` unset.

## Data and release considerations

Image deletion moves the output PNG to Recycle Bin; it does not permanently erase the image. Its metadata and original reference provenance remain in local application data so that a restored output retains context. Clear local data removes those retained application records. Reference provenance is available for newly generated outputs; older files cannot retroactively recover an unavailable original attachment.

Before publishing an installer, exercise actual generation at the new sizes on supported devices, runtime-failure recovery in the installed app, real Windows file dialogs, Windows 125%/150% scaling, and screen-reader announcements. The current checks validate UI behavior, backend contracts, buildability, and selected native primitives; they do not certify these remaining release scenarios.
