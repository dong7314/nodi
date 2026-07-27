import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
  className?: string;
};

type SelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  contentClassName?: string;
  placeholder?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  collisionPadding?: number;
};

/** A shadcn/ui-style Select composed from the Radix Select primitive. */
export function Select({ value, onValueChange, options, disabled = false, ariaLabel, className = "", contentClassName = "", placeholder = "선택", open, onOpenChange, side = "bottom", align = "start", collisionPadding = 12 }: SelectProps) {
  const selected = options.find((option) => option.value === value);

  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled} open={open} onOpenChange={onOpenChange}>
      <SelectPrimitive.Trigger aria-label={ariaLabel} className={`shadcn-select-trigger ${className}`}>
        <SelectPrimitive.Value placeholder={placeholder}>{selected?.label}</SelectPrimitive.Value>
        <SelectPrimitive.Icon><ChevronDown size={13} /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className={`shadcn-select-content ${contentClassName}`} position="popper" side={side} align={align} sideOffset={5} collisionPadding={collisionPadding}>
          <SelectPrimitive.Viewport className="shadcn-select-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item key={option.value} value={option.value} className="shadcn-select-item">
                <span className={option.className ? `shadcn-select-item-chip ${option.className}` : "shadcn-select-item-label"}>{option.label}</span>
                <SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
