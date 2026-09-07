# Fern UI/UX Audit

Date: 2026-08-03  
Scope: Windows desktop renderer, first-run setup, runtime/model loading, generation, device selection, stopping, output review, local data management, and responsive/accessibility behavior.

## Executive summary

Fern already has a strong compact studio foundation: the main generation flow is visible in one dashboard, the app exposes Intel GPU, NVIDIA GPU, and CPU choices, generation can be stopped, most form controls have labels, images have explicit dimensions, reduced motion is supported, and destructive local-data deletion requires confirmation.

The largest UX risk is not visual polish; it is recovery and state clarity around runtime startup. The app can show a loading dialog, but the loading experience does not yet form a complete state machine for loading, failure, retry, and device/plugin remediation. On a hybrid laptop, a user needs to know which GPU was selected, why it was selected, and what to do if the NVIDIA OpenVINO plugin is unavailable. The current UI can collapse several different causes into a generic “model missing” or dashboard error state.

The next release should prioritize:

1. A recoverable runtime-startup dialog with explicit progress, failure details, Retry, and device guidance.
2. A clearly reported effective device, especially “NVIDIA selected” on hybrid Intel/NVIDIA laptops.
3. A fully guarded generation lifecycle: prevent duplicate submits, make Stop stateful, and announce completion/cancellation/failure.
4. Modal focus management and semantic landmarks so keyboard and assistive-technology users can operate the studio reliably.
5. Action feedback for saving/opening outputs and resilient image/error states.

## Audit method and confidence

This is a source-level UI/UX and accessibility audit of the current Fern renderer and first-run window. Findings include exact file/line references so they can become implementation tickets. The review used the current [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) as a checklist for forms, focus, dialogs, loading states, touch targets, responsive layout, and motion.

Evidence level: high for component structure, state wiring, semantics, and CSS behavior; medium for visual hierarchy because no live packaged-app interaction session or screenshot comparison was run in this audit. The acceptance checklist at the end is therefore required before calling the improvements verified.

## Severity scale

- **P0 — blocker:** a user can be trapped, lose work, or cannot recover from a core state.
- **P1 — important:** creates a likely failure, ambiguity, or accessibility barrier in a primary flow.
- **P2 — enhancement:** improves clarity, efficiency, polish, or resilience without blocking the core flow.

## What is working well

- `GenerationControls` uses real labels for the prompt, resolution, device, seed, and other controls: `apps/desktop/src/renderer/src/components/GenerationControls.tsx:187-357`.
- Style controls expose pressed state through `aria-pressed`: `apps/desktop/src/renderer/src/components/GenerationControls.tsx:198-206`.
- The generation stop action is visible during generation and changes to “Stopping…” while the request is in flight: `apps/desktop/src/renderer/src/components/GenerationControls.tsx:460-475`.
- Runtime and data dialogs use `role="dialog"`, `aria-modal`, and labelled headings: `apps/desktop/src/renderer/src/components/RuntimeLoadingDialog.tsx:22-28`; `apps/desktop/src/renderer/src/components/DataManagementDialog.tsx:132-144`.
- Data management already focuses the dialog, supports Escape, uses live loading/error messaging, and confirms destructive reset: `apps/desktop/src/renderer/src/components/DataManagementDialog.tsx:79-89`, `apps/desktop/src/renderer/src/components/DataManagementDialog.tsx:159-160`, `apps/desktop/src/renderer/src/components/DataManagementDialog.tsx:240-242`.
- Images generally provide `alt`, explicit width/height, and lazy loading for thumbnails: `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:53-67`, `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:131-143`.
- The stylesheet includes keyboard focus-visible styling and reduced-motion handling: `apps/desktop/src/renderer/src/styles/globals.css:1543-1550`, `apps/desktop/src/renderer/src/styles/globals.css:1572-1580`.
- Dialog backdrops contain scroll, and the data dialog caps its height for smaller windows: `apps/desktop/src/renderer/src/styles/globals.css:1274-1293`.
- The first-run window uses a semantic `main`, a visible status message, and a reduced-motion spinner fallback: `apps/desktop/src/main/first-run-setup.ts:64-70`.

## Prioritized findings and recommendations

### 1. Runtime startup and model loading

#### P1 — Loading is not a complete recoverable state

The runtime dialog renders a spinner, message, selected device, recent logs, and a “keep Fern open” footer, but it has no progress estimate, Retry action, or failure variant: `apps/desktop/src/renderer/src/components/RuntimeLoadingDialog.tsx:20-53`. The app renders the dialog independently of the dashboard error state, so a failed startup can leave the user with a generic dashboard error rather than a clear recovery path: `apps/desktop/src/renderer/src/App.tsx:53-77`, `apps/desktop/src/renderer/src/App.tsx:145-153`.

Recommendation: model runtime startup explicitly as `idle -> loading -> ready -> failed`. Keep the dialog open for `failed`, replace the spinner with a clear failure icon/state, show the failed stage, and provide:

- **Retry startup**.
- **Choose another device**.
- **Use CPU** as a deliberate fallback when a GPU plugin is missing or initialization fails.
- **Copy diagnostic details** or open the activity log.

Acceptance criterion: a user who starts Fern without a working GPU plugin can reach a successful ready state without restarting the app or guessing what “model missing” means.

#### P1 — Model missing, plugin missing, and backend failure are conflated

The control footer can report “model missing” when the selected adapter is unavailable, even though the actual cause may be an absent NVIDIA OpenVINO plugin, a runtime initialization error, or a backend startup failure: `apps/desktop/src/renderer/src/components/GenerationControls.tsx:321-341`; startup errors are set in `apps/desktop/src/renderer/src/hooks/useStudio.ts:196-252`.

Recommendation: expose distinct user-facing states:

- `Model not installed` — the shared Klein model is not present.
- `NVIDIA OpenVINO plugin unavailable` — the NVIDIA adapter cannot load.
- `Device initialization failed` — the adapter exists but failed to start.
- `Backend unavailable` — Fern’s local service did not come up.

Each state should include the next action, not only a technical message. Keep the shared model identity visible so users know NVIDIA and Intel are using the same Klein/OpenVINO model.

#### P1 — Hybrid GPU choice needs visible “why” feedback

The device selector has Auto, Intel GPU, NVIDIA GPU, and CPU choices, but the visible selection does not clearly communicate the effective hardware chosen after auto-detection: `apps/desktop/src/renderer/src/components/GenerationControls.tsx:321-341`. The title-bar state also uses a compact status pill without an assistive live announcement: `apps/desktop/src/renderer/src/components/TitleBar.tsx:63-66`.

Recommendation: keep Auto as the default, label it “Auto — NVIDIA preferred on hybrid laptops,” and add a secondary readout such as `Using NVIDIA GPU — GeForce GTX 1660 Ti`. When Auto selects NVIDIA over Intel, show a one-time informational note. If NVIDIA detection succeeds but the plugin is unavailable, say so directly and offer CPU or Intel as an explicit fallback.

#### P2 — Startup has no visible progress model

The runtime dialog shows recent log lines but not the startup phases or approximate progress: `apps/desktop/src/renderer/src/components/RuntimeLoadingDialog.tsx:37-49`.

Recommendation: use a four-step progress display: `Detecting hardware`, `Loading OpenVINO runtime`, `Loading Klein model`, `Ready`. If exact percentage is unavailable, use an indeterminate progress bar with a clear phase label rather than implying that the spinner itself is progress.

### 2. Generation flow and cancellation

#### P1 — Duplicate generation requests are possible

`useStudio` tracks `submitting`, but `GenerationControls` only disables the primary action from `running` and `modelInstalled`: `apps/desktop/src/renderer/src/hooks/useStudio.ts:143`, `apps/desktop/src/renderer/src/hooks/useStudio.ts:302-338`, `apps/desktop/src/renderer/src/components/GenerationControls.tsx:460-466`. A fast double-click or keyboard repeat can submit before the first request has updated backend status.

Recommendation: pass `submitting` into the controls and disable Generate for `submitting || running`. Add `aria-busy="true"` while submitting and make the label “Starting generation…” until the backend reports running. Guard the backend call as well, so UI timing cannot create duplicate jobs.

#### P1 — Stop needs a complete post-cancellation state

The Stop button correctly appears during generation and changes label while stopping, but the UI needs an explicit completion result after the backend responds: `apps/desktop/src/renderer/src/components/GenerationControls.tsx:467-475`; `apps/desktop/src/renderer/src/hooks/useStudio.ts:340-352`.

Recommendation: announce one of `Generation stopped`, `Generation completed`, or `Generation failed`. Keep the last preview visible after cancellation, preserve the prompt/settings, and return focus to Generate unless the user has moved focus elsewhere. Disable Stop while the stop request is in flight and prevent a new generation until the prior job is definitively terminal.

#### P2 — Keyboard shortcut copy is platform-specific incorrectly

The footer always displays `Ctrl + Enter`, even though the app’s shortcut logic distinguishes Meta from Control: `apps/desktop/src/renderer/src/App.tsx:15-23`; `apps/desktop/src/renderer/src/components/GenerationControls.tsx:480`.

Recommendation: display `⌘ Enter` on macOS and `Ctrl Enter` on Windows/Linux from the same platform helper used by the handler.

#### P2 — Generation errors are global rather than actionable at the field or action

The hook stores a single string error and the dashboard renders it as a global alert: `apps/desktop/src/renderer/src/hooks/useStudio.ts:138`, `apps/desktop/src/renderer/src/App.tsx:145-148`. This is useful for system failures but does not tell a user whether to change the prompt, device, dimensions, or runtime.

Recommendation: retain the global alert for system errors, but classify common failures and attach a nearby action: focus the prompt for a missing prompt, offer smaller dimensions for memory errors, offer CPU/NVIDIA fallback for device errors, and provide Retry for transient backend errors.

### 3. Accessibility and keyboard behavior

#### P0 — Modal focus is not fully managed

The data dialog focuses itself and closes on Escape, but it does not trap focus or restore focus to the button that opened it: `apps/desktop/src/renderer/src/components/DataManagementDialog.tsx:79-89`. The runtime dialog has neither initial focus management nor focus restoration: `apps/desktop/src/renderer/src/components/RuntimeLoadingDialog.tsx:20-28`. The lightbox only listens for Escape and does not manage focus: `apps/desktop/src/renderer/src/components/Lightbox.tsx:10-20`.

Recommendation: use one shared modal primitive for runtime, data, and lightbox surfaces. On open, save the opener, focus the first meaningful control or dialog heading, trap Tab/Shift+Tab inside the modal, and restore focus on close. Mark the app shell inert while a modal is active. Add an accessible name to the lightbox, such as `aria-labelledby` or a visually hidden heading.

#### P1 — The primary dashboard lacks semantic landmarks

The main shell is a `div.dashboard`; the output surface is also a `div` with an ARIA label: `apps/desktop/src/renderer/src/App.tsx:53`; `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:43`. This makes navigation by landmark less reliable for screen-reader and keyboard users.

Recommendation: add a skip link and structure the screen as `header`/title bar, `aside`/controls, `main`/output workspace, and `section`/activity history. Give each region a concise accessible name and ensure there is one clear page-level heading.

#### P1 — Runtime and app status are not consistently announced

The initial dashboard spinner has no live status semantics: `apps/desktop/src/renderer/src/App.tsx:53-66`. The title-bar status pill is visual only: `apps/desktop/src/renderer/src/components/TitleBar.tsx:63-66`. Activity logs place the entire log body in a polite live region, which can cause excessive announcements as lines stream in: `apps/desktop/src/renderer/src/components/ActivityTerminal.tsx:160`.

Recommendation: add a single concise `aria-live="polite"` status region for state transitions and announce only meaningful events. Keep raw logs out of the live region by default; provide a user-invoked “announce latest” or `aria-label`ed log viewer instead.

#### P1 — Lightbox backdrop is more interactive than its semantics suggest

The backdrop closes on click and the image stops propagation, but the dialog has no labelled heading and the close control has no initial focus: `apps/desktop/src/renderer/src/components/Lightbox.tsx:20-30`.

Recommendation: make the backdrop a non-content layer, keep the explicit Close action, give the preview a title/alt-derived accessible name, and add keyboard navigation if previous/next image controls are introduced.

#### P2 — Decorative SVG semantics are inconsistent

Most icons correctly use `aria-hidden`, but the lightbox X and Preview Metadata HUD icons do not: `apps/desktop/src/renderer/src/components/Lightbox.tsx:21-30`; `apps/desktop/src/renderer/src/components/PreviewMetadataHud.tsx:101-113`.

Recommendation: mark decorative SVGs `aria-hidden="true"` and make the surrounding button’s accessible name the only announced label.

#### P2 — Resizable activity terminal has incomplete keyboard affordances

The terminal exposes a separator with min/max/current values and Arrow-key resizing: `apps/desktop/src/renderer/src/components/ActivityTerminal.tsx:97-136`. Add Home/End to jump to minimum/maximum and announce the resulting height, so keyboard users have the same efficiency as pointer users.

### 4. Output review, saving, and history

#### P1 — Output actions fail silently

Save, open-image, and open-folder actions do not expose success or failure feedback, and save has no catch path in the component: `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:35-40`, `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:93-112`.

Recommendation: add a small action status region with `Saved to…`, `Save cancelled`, or the error and next step. Disable the action only while it is in flight, not permanently. Use the same feedback pattern for opening the file/folder when Windows rejects or cannot resolve the path.

#### P1 — The selected thumbnail is visual-only

The active thumbnail is represented by a CSS class, but the button does not expose selected/current state: `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:126-143`.

Recommendation: add `aria-current="true"` or `aria-pressed` to the selected thumbnail, use a visible focus ring independent of the active border, and announce the selected image name and position in the gallery.

#### P1 — Broken preview images have no recovery UI

The main preview and thumbnails render image elements but do not provide an `onError` fallback: `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:53-67`, `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:131-143`.

Recommendation: show a stable empty/error panel with `Preview unavailable`, `Retry`, and `Open output folder`. Keep metadata and filename available even when the bitmap fails to load.

#### P2 — History is not designed for large collections

All images are mapped into the DOM and the gallery is a scrollable panel: `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:119-171`; `apps/desktop/src/renderer/src/styles/globals.css:170-177`, `apps/desktop/src/renderer/src/styles/globals.css:1088-1099`.

Recommendation: virtualize or paginate once history grows, add a count and “Load more,” and preserve the selected item when new results arrive. Consider filters for device, date, and prompt before the list becomes difficult to scan.

#### P2 — Empty state does not provide a next action

The empty output surface shows an icon and text but no action to focus the prompt or explain the quickest first generation: `apps/desktop/src/renderer/src/components/OutputWorkspace.tsx:70-72`.

Recommendation: add a concise “Describe an image to begin” message and a `Focus prompt` action. Keep it hidden once a generation has started.

### 5. Forms and device settings

#### P1 — Device availability needs inline explanation

Unavailable device options are disabled, but the selector does not explain why an option is unavailable or how to recover: `apps/desktop/src/renderer/src/components/GenerationControls.tsx:321-341`.

Recommendation: expose availability text beneath the selector, for example `NVIDIA GPU — plugin not installed` or `Intel GPU — available`. Do not rely on disabled options alone; disabled controls are poor diagnostic surfaces. Link the selected device to the runtime startup state.

#### P2 — The form is dense and uses very small secondary text

The stylesheet uses many 9–11px labels, notes, and footer elements, while some secondary actions are only text-sized: `apps/desktop/src/renderer/src/styles/globals.css:242-274`, `apps/desktop/src/renderer/src/styles/globals.css:570-578`, `apps/desktop/src/renderer/src/styles/globals.css:1532-1541`.

Recommendation: reserve 9–10px text for metadata only. Raise instructions and error copy to at least 11–12px, strengthen label/value contrast, and give secondary text actions a minimum hit area of roughly 32px high. Test at Windows display scaling of 125% and 150%.

#### P2 — Text fields need explicit validation and content guidance

The prompt textarea has a label and placeholder, but validation is performed only when Generate is invoked: `apps/desktop/src/renderer/src/components/GenerationControls.tsx:187-206`; `apps/desktop/src/renderer/src/hooks/useStudio.ts:302-310`.

Recommendation: preserve the prompt on error, attach `aria-describedby` to helper/error text, and move focus to the invalid field when appropriate. Add short guidance about prompt length and how reference images affect generation if the backend has limits.

### 6. Visual hierarchy and design system

#### P2 — The interface prioritizes density over task hierarchy

The dashboard uses a fixed 320px controls column and nested scrolling: `apps/desktop/src/renderer/src/styles/globals.css:90-96`, `apps/desktop/src/renderer/src/styles/globals.css:136-174`. This can make the primary action compete with advanced settings, especially at laptop height or high display scaling.

Recommendation: keep Prompt, Reference, Device, and Generate in a persistent “primary” group. Put dimensions, seed, and advanced options under a clearly named Advanced disclosure. Consider making the Generate/Stop action sticky at the bottom of the controls column so it remains reachable without scrolling.

#### P2 — Status color should not be the only state signal

The status pill uses a colored dot for running/ready/error: `apps/desktop/src/renderer/src/styles/globals.css:675-704`. The text is present, which is good, but the visual system should also distinguish state through iconography or a stronger label treatment.

Recommendation: pair each status with a compact icon and a short verb phrase (`Ready`, `Loading model`, `Generating`, `Needs attention`). Add a tooltip/details popover with the effective device and last transition time.

#### P2 — Transitions should stay property-specific

The CSS already uses property-specific transitions in most places, but hover/focus behavior should be audited whenever new state styles are added: `apps/desktop/src/renderer/src/styles/globals.css:416`, `apps/desktop/src/renderer/src/styles/globals.css:512`, `apps/desktop/src/renderer/src/styles/globals.css:1119`.

Recommendation: retain property-specific transitions, ensure they are covered by the reduced-motion rule, and avoid animating layout during generation or gallery updates.

### 7. Responsive and platform behavior

#### P1 — One breakpoint is not enough for a desktop app with scaling

The responsive layout switches at 900px and changes the dashboard to a stacked arrangement, but there are no additional rules for short laptop heights, Windows scaling, or title-bar action crowding: `apps/desktop/src/renderer/src/styles/globals.css:1552-1570`.

Recommendation: test at 1280×720, 1366×768, 1920×1080, 125% scaling, and 150% scaling. Add a short-height mode that reduces nonessential spacing, and ensure the title bar and output actions wrap or collapse without clipping. Avoid forcing users to scroll two nested panels to reach Generate or the current output.

#### P2 — Theme and system integration could be more complete

The stylesheet declares dark and light color schemes, but the HTML head does not declare a theme color: `apps/desktop/src/renderer/src/styles/globals.css:2`, `apps/desktop/src/renderer/index.html:1-5`.

Recommendation: add a theme-color meta tag or update it when the user toggles theme, and verify native title-bar/window-control contrast in both themes.

#### P2 — First-run setup needs the same interaction quality as the main app

The first-run page has a status paragraph and spinner but no `aria-live`, determinate/indeterminate progress semantics, cancel action, or clear failure/retry path: `apps/desktop/src/main/first-run-setup.ts:64-75`, `apps/desktop/src/main/first-run-setup.ts:83-141`.

Recommendation: add `role="status"` or `aria-live="polite"` to the status, expose setup phases, provide Cancel when safe, and render a Retry/Copy details action on failure. If closing the setup window is intentionally unsupported, say that directly and provide a safe quit path.

## Recommended product behavior

The clearest first-launch and generation journey is:

```text
Open Fern
  -> Detect hardware
  -> Show “NVIDIA preferred” when hybrid hardware is found
  -> Load shared Klein/OpenVINO model into the chosen device
  -> Ready: show effective device and model status
  -> Generate: lock duplicate submits and show phase/progress
  -> Stop: show stopping, then stopped; keep current preview and settings
  -> Review: select, remix, save, open, or browse history
```

At every arrow, the UI should answer three questions: What is Fern doing? Which device is doing it? What can I do if it fails?

## Implementation roadmap

### Before the next public release

- Create a shared modal/focus-management primitive and apply it to runtime loading, data management, and lightbox.
- Add runtime `failed` and `retrying` states with Retry, device guidance, and a clear distinction between model, plugin, device, and backend errors.
- Wire `submitting` into Generate and add a backend-side duplicate guard.
- Add a single concise live status region for loading, generation, cancellation, and failure.
- Add save/open success and failure feedback.
- Report the effective device in the UI, with explicit NVIDIA preference on hybrid laptops.

### Next iteration

- Add `aria-current`/`aria-pressed` for the selected output and a resilient broken-image state.
- Add semantic landmarks, skip navigation, and consistent icon semantics.
- Improve first-run setup progress, cancellation, and failure recovery.
- Rebalance typography and hit areas; test Windows scaling and short laptop heights.
- Add an empty-state Focus prompt action and sticky primary controls.

### Later polish

- Virtualize or paginate long history.
- Add output filters and richer metadata search.
- Add keyboard shortcuts for gallery navigation and terminal Home/End resizing.
- Add a compact status details popover with effective device, model, and last transition.

## Acceptance checklist

### Runtime and device selection

- [ ] On a hybrid Intel/NVIDIA laptop, Auto visibly reports NVIDIA as the effective device when the NVIDIA adapter is available.
- [ ] If the NVIDIA plugin is missing, the UI says that specifically and offers a clear CPU fallback or device change.
- [ ] First open shows a loading phase, selected device, and meaningful progress/status.
- [ ] Runtime failure stays recoverable in the dialog with Retry and diagnostics.
- [ ] The same Klein/OpenVINO model identity is shown for Intel GPU, NVIDIA GPU, and CPU paths.

### Generation

- [ ] Double-clicking Generate creates only one job.
- [ ] Generate shows a starting state before backend polling reports running.
- [ ] Stop is available during generation, becomes busy while stopping, and announces the final result.
- [ ] The last successful preview, prompt, and settings remain available after cancellation.
- [ ] Prompt, device, memory, and backend failures provide targeted next actions.

### Accessibility

- [ ] Keyboard focus enters each modal, stays inside it, and returns to the opener on close.
- [ ] Escape behavior is consistent across data, runtime, and lightbox dialogs.
- [ ] Main controls are reachable through semantic landmarks and a skip link.
- [ ] State changes are announced once, without streaming raw log noise.
- [ ] Selected gallery item, loading, errors, and save results are conveyed without relying on color.
- [ ] All decorative icons are hidden from the accessibility tree.

### Responsive and visual QA

- [ ] Verify 1280×720, 1366×768, 1920×1080, 125% scaling, and 150% scaling.
- [ ] Verify both dark and light themes, including native title-bar controls.
- [ ] Verify reduced motion and keyboard-only operation.
- [ ] Verify broken/slow image loading and Windows save/open failures.
- [ ] Verify history with 1, 50, and 500 outputs.

## Suggested ticket breakdown

1. `ui: add runtime failure, retry, and device-remediation states`
2. `ui: surface effective NVIDIA selection on hybrid laptops`
3. `ui: guard duplicate generation submits and complete stop feedback`
4. `a11y: add shared modal focus trap and focus restoration`
5. `a11y: add landmarks, live status region, and selected-gallery semantics`
6. `ui: add output action feedback and broken-image recovery`
7. `ui: improve first-run setup progress and retry/cancel behavior`
8. `ui: tune density, hit targets, short-height layout, and display scaling`
9. `perf: virtualize large output history`


