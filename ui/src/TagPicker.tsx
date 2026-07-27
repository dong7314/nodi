import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, Plus, Tag, X } from "lucide-react";
import type { TagOption } from "./types";

type TagPickerProps = {
  value: string[];
  options: TagOption[];
  onChange: (next: string[]) => void;
  onCreate?: (name: string) => void;
  disabled?: boolean;
  compact?: boolean;
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  collisionPadding?: number;
};

export function TagPicker({ value, options, onChange, onCreate, disabled = false, compact = false, label = "태그", open, onOpenChange, side = "bottom", align = "start", collisionPadding = 12 }: TagPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const isOpen = open ?? internalOpen;
  const selected = options.filter((option) => value.includes(option.name));
  const handleOpenChange = (nextOpen: boolean) => {
    if (open === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const toggleTag = (name: string) => {
    onChange(value.includes(name) ? value.filter((tag) => tag !== name) : [...value, name]);
  };

  const addTag = () => {
    const name = newTag.trim();
    if (!name || !onCreate) return;
    onCreate(name);
    onChange(value.includes(name) ? value : [...value, name]);
    setNewTag("");
  };

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
      <div className={`tag-picker ${compact ? "is-compact" : ""}`}>
      <Popover.Trigger asChild>
        <button
        className="tag-picker-trigger"
        type="button"
        disabled={disabled}
        aria-label={`${label} 편집`}
        aria-expanded={isOpen}
        >
        {selected.length > 0 ? selected.map((option) => <span className={`tag-chip tag-${option.color}`} key={option.id}>{option.name}{!compact && <X size={11} />}</span>) : <span className="tag-picker-empty"><Tag size={13} /> {compact ? "태그" : "+ 태그 추가"}</span>}
        </button>
      </Popover.Trigger>
      {!disabled && <Popover.Portal>
        <Popover.Content className="tag-picker-menu" role="menu" side={side} align={align} sideOffset={6} collisionPadding={collisionPadding} onCloseAutoFocus={(event) => event.preventDefault()}>
          <p>{label} 선택</p>
          {options.map((option) => {
            const checked = value.includes(option.name);
            return <button type="button" className="tag-picker-option" key={option.id} onClick={() => toggleTag(option.name)}><span className={`tag-chip tag-${option.color}`}>{option.name}</span>{checked && <Check size={14} />}</button>;
          })}
          {onCreate && <div className="tag-create"><input value={newTag} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} placeholder="새 칩 만들기" /><button type="button" aria-label="새 태그 추가" onClick={addTag}><Plus size={14} /></button></div>}
        </Popover.Content>
      </Popover.Portal>}
      </div>
    </Popover.Root>
  );
}
