# Fern canvas workspace

Implemented September 5, 2026, in the Fern desktop renderer.

## Experience

The Create view now places a large image canvas above a persistent prompt composer. A toggleable inspector holds recipes, styles, references, canvas dimensions, device selection, and advanced settings. The composer provides reference attachment, dimensions, image count, Generate, and Stop.

The visual treatment uses charcoal workspace surfaces, a darker navigation sidebar, a rounded composer, restrained borders, system typography, and a monochrome primary action. Light mode follows the same hierarchy. Green is reserved for Fern branding and readiness indicators.

The sidebar contains named generation threads, navigation, and device status. New thread (Ctrl+N) starts an independent draft. Selecting a thread opens its prompt, settings, reference image, and generated images in the main workspace. Threads can be renamed in the sidebar. A compact thread selector remains available with a collapsed sidebar or a narrow window.

Image history uses large, uncropped thumbnails in the main workspace. Each thread has Preview and Thread images views; threads with multiple images open to their image grid. Library shows all images, including older images created before threads existed. Library previews do not change the active thread. Remix opens the owning thread, or creates a thread for an older unassigned image.

Thread drafts and selection persist in local browser storage. Reference images persist separately in IndexedDB. Generation requests and saved gallery metadata carry the originating thread ID, including every image in a batch. A render finishing while another thread is open updates its own thread. Fern still runs one generation job at a time; other threads show that the device is busy. Reset local data clears thread drafts and stored references along with the existing creative data.

New installations start with an empty prompt. Existing saved prompts remain intact. Activity and image metadata start collapsed unless the user has already saved a preference. Generation validates settings even when the inspector is closed, and Ctrl+Enter is restricted to Create with no modal open.

## Verification

- `npm.cmd run check`: TypeScript, Python compilation, all 18 Python tests, and Electron production build passed.
- `git diff --check`: passed.
- Browser checks used the real React renderer with a fixture API and Electron bridge; no model inference was performed.
- Confirmed prompt, dimensions, batch count, and reference image reach the generation request; Generate and Stop transition correctly.
- Confirmed empty prompts cannot submit and invalid dimensions are rejected with the inspector closed.
- Confirmed Library filtering, full-size preview, Remix, sidebar collapse persistence, dark/light themes, and keyboard generation.
- Measured Generate and Image settings button bounds at 1440×920, 1080×720, 720×800, and 390×844. Both controls remain inside the viewport.
- No browser page errors occurred in the final interaction pass.
- Thread verification covered creating and renaming two threads, different prompts and canvas settings, reference isolation, switching during generation, completion in the originating thread, reload persistence, per-thread thumbnail groups, Library preview separation, and the narrow-window thread selector.
- Backend regression tests validate thread IDs and check that a two-image batch keeps its originating thread in persisted gallery metadata after a later thread generates another image.

Local verification scripts and screenshots are stored in the ignored `.cache/fern-ui/` directory. `threads-product-studies.png` shows two named threads and the selected thread's large image thumbnails. `threads-1080.png` and `threads-narrow.png` show smaller windows. Images are clearly labelled synthetic verification fixtures and are not included in the app bundle.

GPU inference, native file-dialog behavior, and a new installer were not verified in this UI pass.

## September 5: neutral visual system review

- Consolidated the competing theme token blocks into one definition per theme. Neutral charcoal and gray surfaces, monochrome Fern marks, neutral selection/focus controls, and consistent sans-serif labels replace green/purple decorative accents and mixed typography.
- Removed remote font loading. Raised small labels to an 11px floor, with 12px inspector controls and 13px thread navigation. Removed the decorative welcome tile and repeated gallery heading.
- Preserved persistent thread navigation, independent drafts, and large main-area image previews. Thumbnail height adapts to the available window height so the whole image remains visible with the inspector open.
- Corrected the Preferences shortcut label for New thread, missing model metadata display, command-button accessible name, reduced-motion toggle positioning, and theme-color metadata.
- Browser verification used synthetic image fixtures and a mocked Electron/backend bridge: dark/light at 1440x920 and 1080x720, neutral navigation icon colors, thumbnail sizing, settings, preferences, command palette keyboard access, thread switching and draft reload. No browser exceptions. This verifies renderer behavior, not native dialogs or real GPU inference.
- Verification scripts and screenshots are local in `.cache/fern-ui/`. Production build, TypeScript, and 18 Python tests pass.

## Preferences and storage shell destinations

Preferences and Local data now open inside the persistent main shell from the sidebar and command palette. They have page headers, scrollable content, and active navigation states; neither uses a modal backdrop or focus trap. Thread drafts remain available when returning to a thread. Storage stays mounted across navigation so an in-flight cleanup retains its busy state. Destructive reset still requires inline confirmation.

Renderer verification covered both themes, 1440px/1080px/390px layouts, thread return, cache cleanup across navigation, reset cancellation without a deletion request, and command-palette navigation. Storage operations were mocked; no user files were deleted. TypeScript and the Electron production build passed.


## Compact controls and contextual generation actions

Added a full-width divider below New thread. Standard desktop action buttons use 28px height and regular text weight; sidebar navigation uses 30px rows. Appearance choices and secondary controls use less padding. Removed the redundant Create navigation item and top-bar Data action. Open folder now belongs to Library.

The active thread header owns elapsed generation time and Stop. Other threads offer a link to the rendering thread. The composer indicates that generation is busy without duplicating Stop. Progress is an inline row above the canvas; it no longer blurs or covers previous output.

Browser fixtures passed in both themes at 1440px, 1080px, and 390px: header-only Stop and timer, single cancellation request, thread switching, post-cancellation composer state, compact button bounds, and Library folder access. No browser exceptions. Final TypeScript, production build, and diff whitespace checks passed on September 6. Real model inference was not exercised by these renderer checks.

## Interaction audit and thread lifecycle

- Sidebar thread rows and navigation actions now have 4px separation. View tabs have a 12px inset below the header. The Threads label stays visible when its list scrolls; keyboard outlines sit inside rows so the scroll container does not clip them.
- Rename and Delete appear on row hover and keyboard focus. Touch users can see the actions without hovering. Delete requires inline confirmation, preserves generated images in Library, blocks rendering threads, and selects a remaining thread or creates a blank thread when deleting the last one.
- Escape cancels a rename without committing through blur. Cancelled deletions and completed renames restore focus to the thread. Confirmed deletion restores focus to a remaining thread.
- Added `tests/renderer-interactions.mjs`, a standalone fixture browser regression test. It starts and closes a local Vite server, uses mocked Electron/backend interfaces, and verifies geometry, hover/focus states, rename cancellation, deletion of inactive/active/last threads, reload persistence, rendering protection, retained Library outputs, and scrolling through 45 long thread titles in both themes.

Run with `node tests/renderer-interactions.mjs` where Playwright and a browser are available. `FERN_PLAYWRIGHT_MODULE` can specify an absolute ESM module URL; `FERN_CHROME_PATH` can specify Chrome. Optional `FERN_UI_URL` targets an existing preview instead. Screenshots default to `.cache/fern-ui/audit`. No real image files are deleted by this fixture test.
