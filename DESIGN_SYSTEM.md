# Fern interface primitives

Fern gives content visual priority and keeps controls quiet until needed. Each surface has one clear boundary. Shared styles live in `apps/desktop/src/renderer/src/styles/design-system.css`. React primitives live in `apps/desktop/src/renderer/src/components/ui`.

## Foundations

- Spacing uses the shared 4, 8, 12, 16, and 20 px tokens. Give text and controls room inside their parent; do not use borders as a substitute for spacing.
- Standard controls are 32 px high, with a 7 px radius and 12 px type. Icon buttons use a 32 px square target. A checkbox is always 16 × 16 px, including its minimum and maximum dimensions.
- Use the existing light/dark semantic colors (`--background`, `--card`, `--foreground`, `--muted`, and `--border`). Use one surface border; use a divider or whitespace for nested content rather than another boxed surface.
- Align controls by their center, truncate long names only when the full value remains available to assistive technology or in a tooltip, and allow descriptions and errors to wrap.
- Keep the workspace title visible at the same scale when the sidebar collapses. A quiet switch control beside it opens the shared thread picker. In keyboard search, keep the focused field, active choice, and pointer hover visually distinct when all three are present. Align result rows and shortcut labels on shared columns.
- At compact widths the sidebar opens over the workspace from the icon rail. It uses the same history rows and actions as the expanded sidebar. Escape and outside dismissal restore focus. Choosing a destination closes the sidebar and keeps the saved workspace drafts and wide-window preference.

## Components

- `Button` provides primary, secondary, ghost, and danger variants. `IconButton` provides square or circular icon targets and default, primary, or danger treatments. `NavigationButton` standardizes active state and alignment for app navigation. `MenuItem` standardizes menu action rows and destructive state. `ui-disclosure-trigger` styles a native `<summary>` like a standard control without replacing its disclosure behavior. Always provide an accessible name for icon-only controls.
- `Checkbox` is a native checkbox with fixed dimensions. Pair it with a label and preserve visible keyboard focus.
- `Input` and `Select` use the standard field dimensions and focus states. Label each field. Give `Select` a controlled value, a list of labeled options, and an `onChange` callback that receives the chosen value. Use a searchable dialog when choosing from a growing history, as in the compact workspace header.
- `NumberField` keeps the text a user is typing separate from the number a setting accepts. Give it a minimum and maximum. Enable `integer` for whole numbers and `optional` when an intentional clear should restore the setting’s default.
- `NumberInput` shares the same field and draft behavior for settings with their own validation, such as model-specific image sizes. Pass the validation error from the caller so it stays linked to the field.
- `Slider` uses a native range input with shared track, thumb, and focus styles. Give it a label and a numeric range. Use the compact variant for audio seeking and expose the current time through `aria-valuetext`.
- `Textarea` uses standard field styling. Enable `autosize` for a field that grows with its draft, and set a maximum height so longer drafts can scroll inside it.
- `Dropdown` holds actions or radio choices. Compose the trigger with a shared button and use `DropdownItem`, `DropdownRadioGroup`, or `DropdownSeparator` to organize the menu. Popup positioning, arrow-key navigation, typeahead, and focus restoration are shared. Use `useDropdownActions` for sidebar, message, image, and speech menus that close on ancestor scroll and hand off focus after selecting an action. In a modal, use a portal container inside the modal to keep the menu in its focus scope.
- `Popover` holds a small form or interactive panel. Give the panel an accessible label and choose its first focus target when the default order would slow down the task. Use the shared popup surface for positioning, dismissal, and focus restoration.
- `ModelMenu` is the composer’s single-choice model control. It puts available options first, shows why an option is disabled, and keeps model management outside the scrolling list.
- `Dialog` holds a modal task. Its search variant gives the command palette, thread search, and split-chat picker a consistent position and height. Give the dialog a `DialogTitle` and use `DialogDescription` for consequences or instructions. Use `DialogClose` for the dismiss action. The modal keeps keyboard focus within its contents and restores focus when it closes. Use `alert` for destructive confirmations, group buttons with `ui-dialog-actions`, and give Cancel initial focus.
- `SearchDialogField` is the shared search header inside a dialog. Label the field and close button. Supply the keyboard behavior for the results that belong to the field.
- `Disclosure` groups optional content with a native summary that opens and closes with the keyboard. Use `inline` for details within a message and `section` for a full-width settings group. Use `open` and `onOpenChange` when another part of the interface tracks the open state. `lockOpen` keeps a search result visible while Find is active.
- `Tooltip` provides a brief hint on hover and keyboard focus. Use `TooltipIconButton` for an icon action or `triggerTooltip` for a dropdown or select trigger. Wrap a large set of triggers in `TooltipScope` to share one popup. Give the trigger an accessible name and keep information needed to complete a task visible within the interface.
- `ProgressLabel` pairs a spinner with a short description of ongoing work. Place live announcements on the surrounding status region when the same progress appears in more than one location.
- `ui-link` styles inline links with a visible underline and keyboard focus without browser-specific visited colors.
- `ErrorMessage` gives failures a consistent, wrapping treatment and announces them as alerts.
- `InlineNotice` places status or error text beside recovery actions. Enable `announce` when the notice itself should announce a new error. Keep it off when another live region already announces the outcome.
- `ui-empty-state` centers a short title, supporting explanation, and optional recovery action without adding another surface border.
- `ChoiceCard` is for selectable options with supporting detail. It provides consistent selected, focus, and disabled states while the containing layout controls whether options appear in a row or a grid. `ToggleRow` combines an icon, label, description, and on/off state for preference-style settings.
- `SegmentedControl` groups related choices and exposes the selected state with `aria-pressed`. `ToggleChip` handles compact optional modifiers with the same selected and focus behavior.
- `VersionStepper` displays the selected position and the number of saved versions. Its previous and next controls retain focus at the ends of the list.
- `PageHeader` keeps the title, description, and optional actions aligned across top-level pages.
- `ModelCard`, `ModelCardHeading`, `ModelStatus`, and `ModelCardActions` give image, text, and audio models the same spacing, action placement, status treatment, and responsive behavior. Confirmations may expand into a full-width action row.
- `InlineConfirmation` presents the consequence above consistently spaced actions and exposes it as the confirmation group's accessible description. It focuses Cancel and supports Escape. Give the group a label that fits the action and restore focus to the trigger when cancelling. The `useReturnFocus` hook supports triggers that are temporarily unmounted.

All primitives support disabled and keyboard-focus states. Avoid adding page-specific size or border overrides when a primitive already covers the need. Test the empty, installed, downloading, error, expanded, disabled, narrow-window, and dark-theme states when changing a flow.

## Migration

Model management, generation settings and the image composer, text and audio workspaces, preferences, sidebar navigation, local data, library actions, thread search, command-palette search, and common image/audio menu actions use these primitives. Keep platform window controls, command-palette options, and disclosure summaries native or purpose-built when their semantics require it; align their height, focus, and spacing with the shared tokens. A specialized control should not introduce a second general-purpose button, field, or checkbox treatment.

During migration, replace ordinary actions and fields with the shared components while keeping the existing behavior and accessibility labels. Do not wrap native menu items or disclosure summaries in a `<button>`. Use a shared icon button when the action is icon-only; keep an accessible name even when the label is visually hidden.
