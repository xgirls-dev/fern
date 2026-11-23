import { useId, useState } from "react";
import type { ChatPreset } from "../lib/textThreads";
import { Button, InlineConfirmation, Input, Select } from "./ui/controls";
import { Disclosure } from "./ui/Disclosure";

export function ChatPresets({ presets, disabled, onApply, onSave, onDelete }: {
  presets: readonly ChatPreset[];
  disabled: boolean;
  onApply: (id: string) => void;
  onSave: (name: string, id?: string) => string | undefined;
  onDelete: (id: string) => void;
}) {
  const selectId = useId();
  const nameId = useId();
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = presets.find((preset) => preset.id === selectedId);
  const proposed = name.trim();
  const duplicate = presets.some((preset) => preset.name.toLowerCase() === proposed.toLowerCase());

  return <Disclosure className="chat-advanced-settings" appearance="section" label="Chat presets">
    <div className="text-settings-grid">
      {presets.length > 0 && <>
        <div className="field">
          <label htmlFor={selectId}>Saved preset</label>
          <Select id={selectId} disabled={disabled} value={selected?.id ?? ""} onChange={(id) => {
            setSelectedId(id);
            setConfirmDelete(false);
          }} options={[{ value: "", label: "Choose a preset" }, ...presets.map(({ id, name: label }) => ({ value: id, label }))]} />
        </div>
        {selected && <div className="chat-model-defaults">
          <Button variant="secondary" disabled={disabled} onClick={() => onApply(selected.id)}>Apply preset</Button>
          <Button variant="ghost" disabled={disabled} onClick={() => onSave(selected.name, selected.id)}>Update preset</Button>
          {!confirmDelete && <Button variant="ghost" disabled={disabled} onClick={() => setConfirmDelete(true)}>Remove preset</Button>}
        </div>}
        {selected && confirmDelete && <InlineConfirmation confirmLabel="Remove preset" disabled={disabled}
          onCancel={() => setConfirmDelete(false)} onConfirm={() => {
            onDelete(selected.id);
            setSelectedId("");
            setConfirmDelete(false);
          }}>Remove {selected.name}?</InlineConfirmation>}
      </>}
      <form className="field chat-preset-create" onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !proposed || duplicate) return;
        const id = onSave(proposed);
        if (id) {
          setSelectedId(id);
          setName("");
        }
      }}>
        <label htmlFor={nameId}>New preset name</label>
        <Input id={nameId} value={name} disabled={disabled} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} />
        {duplicate && <small role="status">A preset with this name already exists.</small>}
        <Button variant="secondary" type="submit" disabled={disabled || !proposed || duplicate}>Save as preset</Button>
      </form>
    </div>
  </Disclosure>;
}
