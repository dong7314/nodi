export type TagColor = "purple" | "blue" | "green" | "orange" | "pink" | "gray";

export type TagOption = {
  id: string;
  name: string;
  color: TagColor;
};

export const DEFAULT_TAG_OPTIONS: TagOption[] = [
  { id: "personal", name: "개인", color: "purple" },
  { id: "idea", name: "아이디어", color: "blue" },
  { id: "focus", name: "중요", color: "orange" },
  { id: "learning", name: "배움", color: "green" },
];

export const TAG_COLORS: TagColor[] = ["purple", "blue", "green", "orange", "pink", "gray"];

export function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
}

export function toDateInput(date: Date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function dateFromNow(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return toDateInput(date);
}
