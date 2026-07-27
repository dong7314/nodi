import * as Popover from "@radix-ui/react-popover";
import { useRef, useState } from "react";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import { DayPicker, type DateRange } from "react-day-picker";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { toDateInput } from "../../types";
import "react-day-picker/style.css";

type DatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  minDate?: string;
  compact?: boolean;
  allowRange?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  collisionPadding?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function parseDate(value: string) {
  const date = value ? new Date(`${value}T00:00:00`) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

function parseDateValue(value: string): DateRange | undefined {
  const [fromValue, toValue] = value.split("..");
  const from = parseDate(fromValue);
  const to = parseDate(toValue);
  return from ? { from, to } : undefined;
}

function formatDateValue(range: DateRange | undefined) {
  if (!range?.from) return "날짜 선택";
  const start = format(range.from, "yyyy. MM. dd.", { locale: ko });
  return range.to ? `${start} → ${format(range.to, "MM. dd.", { locale: ko })}` : start;
}

/** A shadcn/ui-style Calendar + Popover date picker. */
export function DatePicker({ value, onChange, disabled = false, ariaLabel, minDate, compact = false, allowRange = false, side = "bottom", align = "start", collisionPadding = 12, open: controlledOpen, onOpenChange }: DatePickerProps) {
  const selectedRange = parseDateValue(value);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [rangeMode, setRangeMode] = useState(Boolean(selectedRange?.to));
  const [draftRange, setDraftRange] = useState<DateRange | undefined>();
  const restartRangeOnNextPickRef = useRef(false);
  const disabledDates = minDate ? { before: parseDate(minDate)! } : undefined;
  const calendarProps = {
    locale: ko,
    weekStartsOn: 1 as const,
    fixedWeeks: true,
    showOutsideDays: true,
    disabled: disabledDates,
    components: { Chevron: ({ orientation }: { orientation?: "down" | "left" | "right" | "up" }) => orientation === "left" ? <ChevronLeft size={16} /> : <ChevronRight size={16} /> },
    classNames: { root: "shadcn-calendar", month_caption: "shadcn-calendar-caption", weekdays: "shadcn-calendar-weekdays", weekday: "shadcn-calendar-weekday", day: "shadcn-calendar-day", selected: "shadcn-calendar-selected", today: "shadcn-calendar-today", outside: "shadcn-calendar-outside", disabled: "shadcn-calendar-disabled", nav: "shadcn-calendar-nav", button_previous: "shadcn-calendar-nav-button", button_next: "shadcn-calendar-nav-button", day_button: "shadcn-calendar-day-button", range_start: "shadcn-calendar-range-start", range_middle: "shadcn-calendar-range-middle", range_end: "shadcn-calendar-range-end" },
  };
  const selectRange = (range: DateRange | undefined, triggerDate?: Date) => {
    if (!range?.from) { setDraftRange(undefined); return; }
    if (restartRangeOnNextPickRef.current) {
      restartRangeOnNextPickRef.current = false;
      setDraftRange({ from: triggerDate ?? range.from });
      return;
    }
    if (!range.to || range.from.toDateString() === range.to.toDateString()) { setDraftRange({ from: range.from }); return; }
    setDraftRange(range);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen) { setDraftRange(undefined); restartRangeOnNextPickRef.current = false; return; }
    setRangeMode(Boolean(selectedRange?.to));
    setDraftRange(selectedRange);
    restartRangeOnNextPickRef.current = Boolean(selectedRange?.to);
  };
  const applySelection = () => {
    if (!draftRange?.from) { onChange(""); handleOpenChange(false); return; }
    onChange(rangeMode && draftRange.to ? `${toDateInput(draftRange.from)}..${toDateInput(draftRange.to)}` : toDateInput(draftRange.from));
    handleOpenChange(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button className={`shadcn-date-trigger ${compact ? "is-compact" : ""}`} type="button" disabled={disabled} aria-label={ariaLabel}>
          <CalendarDays size={compact ? 13 : 15} />
          <span>{formatDateValue(selectedRange)}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="shadcn-date-content" side={side} sideOffset={7} align={align} collisionPadding={collisionPadding} onCloseAutoFocus={(event) => event.preventDefault()}>
          {allowRange && <div className="shadcn-date-mode"><button type="button" className={!rangeMode ? "active" : ""} onClick={() => { setRangeMode(false); setDraftRange(selectedRange?.from ? { from: selectedRange.from } : undefined); restartRangeOnNextPickRef.current = false; }}>단일 날짜</button><button type="button" className={rangeMode ? "active" : ""} onClick={() => { setRangeMode(true); setDraftRange(selectedRange?.to ? selectedRange : undefined); restartRangeOnNextPickRef.current = Boolean(selectedRange?.to); }}>기간 선택</button></div>}
          {rangeMode ? <DayPicker {...calendarProps} mode="range" selected={draftRange} onSelect={selectRange} /> : <DayPicker {...calendarProps} mode="single" selected={draftRange?.from} onSelect={(date) => { if (date) setDraftRange({ from: date }); }} />}
          <div className="shadcn-date-actions"><button type="button" onClick={() => { setDraftRange({ from: new Date() }); restartRangeOnNextPickRef.current = false; }}>오늘</button><div><button className="shadcn-date-clear" type="button" onClick={() => { setDraftRange(undefined); restartRangeOnNextPickRef.current = false; }}><X size={13} /> 지우기</button><button className="shadcn-date-apply" type="button" onClick={applySelection}>적용</button></div></div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
