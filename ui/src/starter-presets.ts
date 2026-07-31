import type { PartialBlock } from "@blocknote/core";
import { isPageIcon } from "./page-icons";

export const STARTER_PRESETS_STORAGE_KEY = "nodi:starter-presets";
export const STARTER_PRESETS_CHANGED_EVENT = "nodi:starter-presets-changed";
export const MAX_STARTER_PRESETS = 5;

export type StarterPreset = {
  id: string;
  name: string;
  icon: string;
  pageTitle: string;
  blocks: PartialBlock[];
  sourceFileName?: string;
};

export const DEFAULT_STARTER_PRESETS: StarterPreset[] = [
  {
    id: "daily",
    name: "데일리 노트",
    icon: "☀️",
    pageTitle: "오늘의 기록",
    blocks: [
      { type: "heading", props: { level: 2 }, content: "오늘의 초점" },
      { type: "checkListItem", props: { checked: false }, content: "" },
      { type: "heading", props: { level: 2 }, content: "메모" },
      { type: "paragraph", content: "" },
      { type: "heading", props: { level: 2 }, content: "하루 회고" },
      { type: "bulletListItem", content: "잘한 일" },
      { type: "bulletListItem", content: "내일의 나에게" },
    ],
  },
  {
    id: "brainstorm",
    name: "아이디어",
    icon: "💡",
    pageTitle: "아이디어 스케치",
    blocks: [
      { type: "heading", props: { level: 2 }, content: "문제" },
      { type: "paragraph", content: "" },
      { type: "heading", props: { level: 2 }, content: "아이디어" },
      { type: "bulletListItem", content: "" },
      { type: "heading", props: { level: 2 }, content: "다음 행동" },
      { type: "checkListItem", props: { checked: false }, content: "" },
    ],
  },
  {
    id: "blank",
    name: "빈 페이지",
    icon: "📄",
    pageTitle: "제목 없음",
    blocks: [{ type: "paragraph", content: "" }],
  },
];

export function readStarterPresets(): StarterPreset[] {
  try {
    const saved = window.localStorage.getItem(STARTER_PRESETS_STORAGE_KEY);
    if (!saved) return cloneStarterPresets(DEFAULT_STARTER_PRESETS);
    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) return cloneStarterPresets(DEFAULT_STARTER_PRESETS);

    const ids = new Set<string>();
    const presets = parsed
      .filter((preset): preset is Partial<StarterPreset> => Boolean(preset) && typeof preset === "object")
      .map((preset, index) => {
        const fallbackId = `preset-${index + 1}`;
        const requestedId = typeof preset.id === "string" && preset.id.trim() ? preset.id.trim() : fallbackId;
        let id = requestedId;
        let suffix = 2;
        while (ids.has(id)) {
          id = `${requestedId}-${suffix}`;
          suffix += 1;
        }
        ids.add(id);
        return {
          id,
          name: typeof preset.name === "string" && preset.name.trim()
            ? preset.name.trim().slice(0, 24)
            : `프리셋 ${index + 1}`,
          icon: isPageIcon(preset.icon) ? preset.icon : "✨",
          pageTitle: typeof preset.pageTitle === "string" && preset.pageTitle.trim()
            ? preset.pageTitle.trim().slice(0, 80)
            : "제목 없음",
          blocks: Array.isArray(preset.blocks) && preset.blocks.length > 0
            ? preset.blocks as PartialBlock[]
            : [{ type: "paragraph", content: "" }],
          sourceFileName: typeof preset.sourceFileName === "string" && preset.sourceFileName.trim()
            ? preset.sourceFileName.trim().slice(0, 120)
            : undefined,
        } satisfies StarterPreset;
      })
      .slice(0, MAX_STARTER_PRESETS);

    return presets;
  } catch {
    return cloneStarterPresets(DEFAULT_STARTER_PRESETS);
  }
}

export function persistStarterPresets(presets: StarterPreset[]) {
  const nextPresets = cloneStarterPresets(presets.slice(0, MAX_STARTER_PRESETS));
  window.localStorage.setItem(STARTER_PRESETS_STORAGE_KEY, JSON.stringify(nextPresets));
  window.dispatchEvent(new CustomEvent(STARTER_PRESETS_CHANGED_EVENT));
}

export function createStarterPreset(index: number): StarterPreset {
  return {
    id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: `새 프리셋 ${index}`,
    icon: "✨",
    pageTitle: "제목 없음",
    blocks: [{ type: "paragraph", content: "" }],
  };
}

export function cloneStarterPresets(presets: StarterPreset[]) {
  return JSON.parse(JSON.stringify(presets)) as StarterPreset[];
}
