# Fern interface primitives

Fern uses a restrained, utility-first interface: content leads, controls are quiet until needed, and each surface has one clear boundary. The renderer's shared definitions live in `apps/desktop/src/renderer/src/styles/design-system.css`; the React primitives live in `apps/desktop/src/renderer/src/components/ui/controls.tsx`.

## Foundations

- Spacing uses the shared 4, 8, 12, 16, and 20 px tokens. Give text and controls room inside their parent; do not use borders as a substitute for spacing.
- Standard controls are 32 px high, with a 7 px radius and 12 px type. Icon buttons use a 32 px square target. A checkbox is always 16 × 16 px, including its minimum and maximum dimensions.
- Use the existing light/dark semantic colors (`--background`, `--card`, `--foreground`, `--muted`, and `--border`). Use one surface border; use a divider or whitespace for nested content rather than another boxed surface.
- Align controls by their center, truncate long names only when the full value remains available to assistive technology or in a tooltip, and allow descriptions and errors to wrap.

## Components

- `Button` provides primary, secondary, ghost, and danger variants. `IconButton` provides square or circular icon targets and default, primary, or danger treatments. `NavigationButton` standardizes active state and alignment for app navigation. `MenuItem` standardizes menu action rows and destructive state. `ui-disclosure-trigger` styles a native `<summary>` like a standard control without replacing its disclosure behavior. Always provide an accessible name for icon-only controls.
- `Checkbox` is a native checkbox with fixed dimensions. Pair it with a label and preserve visible keyboard focus.
- `Input` and `Select` use the standard field dimensions and focus states. Use a label or an accessible name.
- `ui-link` styles inline links with a visible underline and keyboard focus without browser-specific visited colors.
- `ErrorMessage` gives failures a consistent, wrapping treatment and announces them as alerts.
- `ui-empty-state` centers a short title, supporting explanation, and optional recovery action without adding another surface border.
- `ChoiceCard` is for selectable options with supporting detail. It provides consistent selected, focus, and disabled states while the containing layout controls whether options appear in a row or a grid. `ToggleRow` combines an icon, label, description, and on/off state for preference-style settings.
- `SegmentedControl` groups related choices and exposes the selected state with `aria-pressed`. `ToggleChip` handles compact optional modifiers with the same selected and focus behavior.
- `PageHeader` keeps the title, description, and optional actions aligned across top-level pages.
- `ModelCard`, `ModelCardHeading`, `ModelStatus`, and `ModelCardActions` give image, text, and audio models the same spacing, action placement, status treatment, and responsive behavior. Confirmations may expand into a full-width action row.
- `InlineConfirmation` presents the consequence above consistently spaced actions, focuses Cancel, and supports Escape. Use a specific destructive action label, explain whether files are deleted or only unlinked, and restore focus to the trigger when cancelling (the `useReturnFocus` hook supports triggers that are temporarily unmounted).

All primitives support disabled and keyboard-focus states. Avoid adding page-specific size or border overrides when a primitive already covers the need. Test the empty, installed, downloading, error, expanded, disabled, narrow-window, and dark-theme states when changing a flow.

## Migration

Model management, generation settings and the image composer, text and audio workspaces, preferences, sidebar navigation, local data, library actions, thread search, command-palette search, and common image/audio menu actions use these primitives. Keep platform window controls, command-palette options, sliders, audio seeking, and disclosure summaries native or purpose-built when their semantics require it; align their height, focus, and spacing with the shared tokens. A specialized control should not introduce a second general-purpose button, field, or checkbox treatment.

During migration, replace ordinary actions and fields with the shared components while keeping the existing behavior and accessibility labels. Do not wrap native menu items or disclosure summaries in a `<button>`. Use a shared icon button when the action is icon-only; keep an accessible name even when the label is visually hidden.
