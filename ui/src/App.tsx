import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs, type BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { ko } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import { createReactBlockSpec, getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote, type DefaultReactSuggestionItem } from "@blocknote/react";
import { createHighlighter } from "shiki";
import { InlineDatabase } from "./InlineDatabase";
import { PageSettingsPanel, type PageSettings } from "./PageSettings";
import { TagPicker } from "./TagPicker";
import { DEFAULT_TAG_OPTIONS, toDateInput } from "./types";
import { makeId } from "./types";
import { DatePicker } from "./components/ui/date-picker";
import { Select } from "./components/ui/select";
import { ConfirmDialog } from "./components/ui/confirm-dialog";
import { ChildPageBlock } from "./ChildPageBlock";
import {
  OPEN_PAGE_EVENT,
  MAX_FOLDER_DEPTH,
  ROOT_PAGE_ID,
  persistStoredFolders,
  persistStoredPages,
  readStoredFolders,
  readStoredPages,
  type StoredFolder,
  type StoredFolders,
  type StoredPage,
  type StoredPages,
} from "./page-store";
import "@blocknote/mantine/style.css";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  Code2,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Clock3,
  Cloud,
  Command,
  Download,
  Database,
  FileText,
  FolderPlus,
  Globe2,
  GripVertical,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Home,
  Inbox,
  LayoutGrid,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Lock,
  Menu,
  Moon,
  MoreHorizontal,
  Palette,
  PanelLeftClose,
  Pencil,
  Plus,
  Quote,
  Repeat2,
  Search,
  Settings,
  Settings2,
  Share2,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Type,
  X,
} from "lucide-react";

const CONTENT_STORAGE_KEY = "nodi:quick-note:content";
const TITLE_STORAGE_KEY = "nodi:quick-note:title";
const PAGE_SETTINGS_STORAGE_KEY = "nodi:quick-note:page-settings";
const PAGE_ARCHIVED_STORAGE_KEY = "nodi:quick-note:archived";
const PAGE_TRASH_STORAGE_KEY = "nodi:quick-note:trash";
const PAGE_DRAWER_WIDTH_STORAGE_KEY = "nodi:page-drawer-width";
const APP_THEME_STORAGE_KEY = "nodi:app-theme";
const APP_NOTICE_EVENT = "nodi:notice";

type AppTheme = "light" | "dark";
type BlockSelectionActionMenu = {
  kind: "transform" | "color";
  x: number;
  y: number;
};
type BlockColorName = "default" | "gray" | "brown" | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink";

const BLOCK_TRANSFORM_OPTIONS = [
  { key: "paragraph", label: "텍스트", type: "paragraph", icon: Type },
  { key: "heading-1", label: "제목 1", type: "heading", props: { level: 1, isToggleable: false }, icon: Heading1 },
  { key: "heading-2", label: "제목 2", type: "heading", props: { level: 2, isToggleable: false }, icon: Heading2 },
  { key: "heading-3", label: "제목 3", type: "heading", props: { level: 3, isToggleable: false }, icon: Heading3 },
  { key: "bulletListItem", label: "글머리 기호 목록", type: "bulletListItem", icon: List },
  { key: "numberedListItem", label: "번호 매기기 목록", type: "numberedListItem", icon: ListOrdered },
  { key: "checkListItem", label: "할 일 목록", type: "checkListItem", icon: ListChecks },
  { key: "quote", label: "인용", type: "quote", icon: Quote },
  { key: "codeBlock", label: "코드", type: "codeBlock", icon: Code2 },
] as const;

const BLOCK_COLOR_OPTIONS: readonly { value: BlockColorName; label: string }[] = [
  { value: "default", label: "기본" },
  { value: "gray", label: "회색" },
  { value: "brown", label: "갈색" },
  { value: "red", label: "빨강" },
  { value: "orange", label: "주황" },
  { value: "yellow", label: "노랑" },
  { value: "green", label: "초록" },
  { value: "blue", label: "파랑" },
  { value: "purple", label: "보라" },
  { value: "pink", label: "분홍" },
];

const CONVERTIBLE_BLOCK_TYPES = new Set(BLOCK_TRANSFORM_OPTIONS.map((option) => option.type));

function getInitialAppTheme(): AppTheme {
  try {
    return window.localStorage.getItem(APP_THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const defaultPageSettings: PageSettings = {
  icon: "✦",
  cover: "aurora",
  fullWidth: false,
  smallText: false,
  lockPage: false,
  publicAccess: false,
  showProperties: true,
  status: "초안",
  tags: ["개인"],
  date: toDateInput(new Date()),
};
const pageStatusOptions = [
  { value: "초안", label: "초안", className: "status-waiting" },
  { value: "진행 중", label: "진행 중", className: "status-progress" },
  { value: "완료", label: "완료", className: "status-done" },
];

function getFolderDepth(folders: StoredFolders, folderId: string | null) {
  let depth = 0;
  let currentFolderId = folderId;
  const visited = new Set<string>();
  while (currentFolderId && !visited.has(currentFolderId)) {
    const folder = folders[currentFolderId];
    if (!folder) break;
    visited.add(currentFolderId);
    depth += 1;
    currentFolderId = folder.parentId;
  }
  return depth;
}

function getFolderSubtreeHeight(
  folders: StoredFolders,
  folderId: string,
  visited = new Set<string>(),
): number {
  if (visited.has(folderId)) return 0;
  const nextVisited = new Set(visited).add(folderId);
  const childHeights = Object.values(folders)
    .filter((folder) => folder.parentId === folderId)
    .map((folder) => getFolderSubtreeHeight(folders, folder.id, nextVisited));
  return 1 + Math.max(0, ...childHeights);
}

function canPlaceFolderAtParent(
  folders: StoredFolders,
  folderId: string,
  parentId: string | null,
) {
  return getFolderDepth(folders, parentId) + getFolderSubtreeHeight(folders, folderId) <= MAX_FOLDER_DEPTH;
}

type ContextMenuState =
  | { kind: "page"; x: number; y: number }
  | { kind: "block"; x: number; y: number; blockId: string };

type SidebarContextMenuState =
  | { kind: "page"; pageId: string; x: number; y: number }
  | { kind: "folder"; folderId: string; x: number; y: number };

type SidebarRenameState =
  | { kind: "page"; id: string }
  | { kind: "folder"; id: string };

type SidebarPageDropTarget =
  | { kind: "page"; pageId: string; placement: "before" | "after" }
  | { kind: "folder"; folderId: string; placement: "before" | "inside" | "after" }
  | { kind: "unfiled" };

type SidebarFolderDropTarget =
  | { kind: "folder"; folderId: string; placement: "before" | "inside" | "after" }
  | { kind: "page"; pageId: string; placement: "before" | "after" }
  | { kind: "root" };

type SidebarOrderedItem =
  | { kind: "page"; id: string; order: number; createdAt: string; page: StoredPage }
  | { kind: "folder"; id: string; order: number; createdAt: string; folder: StoredFolder };

function getPageSidebarParentId(page: StoredPage, folders: StoredFolders) {
  return page.folderId && folders[page.folderId] ? page.folderId : null;
}

function getSidebarOrderedItems(
  pages: StoredPages,
  folders: StoredFolders,
  parentId: string | null,
): SidebarOrderedItem[] {
  const pageItems: SidebarOrderedItem[] = Object.values(pages)
    .filter((page) => page.id !== ROOT_PAGE_ID && getPageSidebarParentId(page, folders) === parentId)
    .sort((first, second) => first.order - second.order || first.createdAt.localeCompare(second.createdAt))
    .map((page) => ({ kind: "page", id: page.id, order: page.order, createdAt: page.createdAt, page }));
  const folderItems: SidebarOrderedItem[] = Object.values(folders)
    .filter((folder) => folder.parentId === parentId)
    .sort((first, second) => first.order - second.order || first.createdAt.localeCompare(second.createdAt))
    .map((folder) => ({ kind: "folder", id: folder.id, order: folder.order, createdAt: folder.createdAt, folder }));

  const pageOrders = new Set(pageItems.map((item) => item.order));
  const usesLegacySeparateOrder = folderItems.some((item) => pageOrders.has(item.order));
  if (usesLegacySeparateOrder) {
    return parentId === null ? [...pageItems, ...folderItems] : [...folderItems, ...pageItems];
  }

  return [...pageItems, ...folderItems].sort((first, second) => (
    first.order - second.order
    || first.createdAt.localeCompare(second.createdAt)
    || first.kind.localeCompare(second.kind)
  ));
}

function assignSidebarItemOrder(
  nextPages: StoredPages,
  nextFolders: StoredFolders,
  parentId: string | null,
  items: SidebarOrderedItem[],
) {
  items.forEach((item, order) => {
    if (item.kind === "page") {
      const page = nextPages[item.id];
      if (page) nextPages[item.id] = { ...page, folderId: parentId, order };
      return;
    }
    const folder = nextFolders[item.id];
    if (folder) nextFolders[item.id] = { ...folder, parentId, order };
  });
}

function getNextSidebarOrder(
  pages: StoredPages,
  folders: StoredFolders,
  parentId: string | null,
) {
  return Math.max(-1, ...getSidebarOrderedItems(pages, folders, parentId).map((item) => item.order)) + 1;
}

type SidebarSiblingDropTarget =
  | { kind: "page"; pageId: string; placement: "before" | "after" }
  | { kind: "folder"; folderId: string; placement: "before" | "after" };
type SidebarSiblingItemTarget =
  | { kind: "page"; pageId: string }
  | { kind: "folder"; folderId: string };

function getSidebarSiblingDropTargetFromGap(
  hitElement: HTMLElement | null,
  clientY: number,
  excludedItem: { kind: "page" | "folder"; id: string },
): SidebarSiblingDropTarget | null {
  const itemContainer = hitElement?.closest<HTMLElement>(".sidebar-unfiled-pages, .sidebar-folder-pages");
  if (!itemContainer) return null;

  const siblingRows: Array<{ target: SidebarSiblingItemTarget; top: number }> = [];
  Array.from(itemContainer.children).forEach((child) => {
    const element = child as HTMLElement;
    const pageId = element.dataset.sidebarPageId;
    if (pageId) {
      if (excludedItem.kind === "page" && excludedItem.id === pageId) return;
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) siblingRows.push({ target: { kind: "page", pageId }, top: rect.top });
      return;
    }

    const folderId = element.dataset.sidebarFolderId;
    if (!folderId || (excludedItem.kind === "folder" && excludedItem.id === folderId)) return;
    const folderRow = element.querySelector<HTMLElement>(":scope > [data-sidebar-folder-row-id]");
    if (!folderRow) return;
    const rect = folderRow.getBoundingClientRect();
    if (rect.height > 0) siblingRows.push({ target: { kind: "folder", folderId }, top: rect.top });
  });
  siblingRows.sort((first, second) => first.top - second.top);

  if (siblingRows.length === 0) return null;
  const nextRow = siblingRows.find((row) => clientY < row.top);
  if (nextRow) return { ...nextRow.target, placement: "before" };
  const lastRow = siblingRows[siblingRows.length - 1];
  return { ...lastRow.target, placement: "after" };
}

type BlockSelectionMarquee = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type BlockDropIndicator = {
  left: number;
  top: number;
  width: number;
};

const databaseBlockSpec = createReactBlockSpec(
  {
    type: "database",
    propSchema: { databaseId: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => <InlineDatabase
      databaseId={block.props.databaseId || `database-${block.id}`}
      locked={!editor.isEditable}
      onNotice={(message) => window.dispatchEvent(new CustomEvent(APP_NOTICE_EVENT, { detail: message }))}
      onRemove={() => editor.removeBlocks([block.id])}
    />,
  },
);

const childPageBlockSpec = createReactBlockSpec(
  {
    type: "childPage",
    propSchema: {
      pageId: { default: "" },
      title: { default: "제목 없음" },
    },
    content: "none",
  },
  {
    render: ({ block }) => (
      <ChildPageBlock
        pageId={block.props.pageId}
        fallbackTitle={block.props.title}
      />
    ),
  },
);

const CODE_BLOCK_LANGUAGES: Record<string, { name: string; aliases?: string[] }> = {
  text: { name: "일반 텍스트", aliases: ["plain", "plaintext", "txt"] },
  javascript: { name: "JavaScript", aliases: ["js"] },
  typescript: { name: "TypeScript", aliases: ["ts"] },
  jsx: { name: "JSX" },
  tsx: { name: "TSX" },
  html: { name: "HTML" },
  css: { name: "CSS" },
  json: { name: "JSON" },
  markdown: { name: "Markdown", aliases: ["md"] },
  python: { name: "Python", aliases: ["py"] },
  java: { name: "Java" },
  c: { name: "C" },
  cpp: { name: "C++", aliases: ["c++"] },
  csharp: { name: "C#", aliases: ["cs", "c#"] },
  go: { name: "Go", aliases: ["golang"] },
  rust: { name: "Rust", aliases: ["rs"] },
  php: { name: "PHP" },
  ruby: { name: "Ruby", aliases: ["rb"] },
  swift: { name: "Swift" },
  kotlin: { name: "Kotlin", aliases: ["kt"] },
  sql: { name: "SQL" },
  bash: { name: "Shell", aliases: ["sh", "shell", "zsh"] },
  yaml: { name: "YAML", aliases: ["yml"] },
};
const CODE_BLOCK_LANGUAGE_OPTIONS = Object.entries(CODE_BLOCK_LANGUAGES).map(([value, language]) => ({
  value,
  label: language.name,
}));
let closeActiveCodeLanguageMenu: (() => void) | null = null;

async function writeClipboardText(value: string) {
  if (navigator.clipboard?.writeText) {
    let timeoutId: number | undefined;
    try {
      await Promise.race([
        navigator.clipboard.writeText(value),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error("Clipboard permission timed out")), 700);
        }),
      ]);
      return;
    } catch {
      // Fall through to the legacy copy path when permission is denied or delayed.
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy failed");
}

async function createNodiCodeHighlighter() {
  const highlighter = await createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [],
  });
  const codeToTokens = highlighter.codeToTokens.bind(highlighter) as typeof highlighter.codeToTokens;
  highlighter.codeToTokens = ((code, options) => {
    const {
      theme: _theme,
      themes: _themes,
      defaultColor: _defaultColor,
      ...tokenOptions
    } = options as unknown as Record<string, unknown>;
    return codeToTokens(code, {
      ...tokenOptions,
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      defaultColor: false,
    } as never);
  }) as typeof highlighter.codeToTokens;
  return highlighter;
}

const baseCodeBlockSpec = createCodeBlockSpec({
  defaultLanguage: "text",
  supportedLanguages: CODE_BLOCK_LANGUAGES,
  createHighlighter: createNodiCodeHighlighter,
});
const baseCodeBlockRender = baseCodeBlockSpec.implementation.render;
const nodiCodeBlockRender: typeof baseCodeBlockRender = function (block, editor) {
  const rendered = baseCodeBlockRender.call(this, block, editor);
  const fragment = rendered.dom as DocumentFragment;
  const toolbar = fragment.firstElementChild as HTMLDivElement | null;
  const code = rendered.contentDOM as HTMLElement | undefined;

  if (!toolbar || !code) return rendered;

  toolbar.className = "nodi-code-block-toolbar";
  const languageSelect = toolbar.querySelector("select");
  let languageTrigger: HTMLButtonElement | null = null;
  let languageMenu: HTMLDivElement | null = null;
  let closeLanguageMenu: (() => void) | null = null;
  const stopLanguagePickerEvent = (event: Event) => event.stopPropagation();

  if (languageSelect) {
    const selectedLanguage = CODE_BLOCK_LANGUAGES[block.props.language] ? block.props.language : "text";
    const languagePicker = document.createElement("div");
    languagePicker.className = "nodi-code-language-picker";
    languagePicker.contentEditable = "false";
    languageTrigger = document.createElement("button");
    languageTrigger.type = "button";
    languageTrigger.className = "shadcn-select-trigger nodi-code-language-trigger";
    languageTrigger.disabled = !editor.isEditable;
    languageTrigger.setAttribute("role", "combobox");
    languageTrigger.setAttribute("aria-label", "코드 언어");
    languageTrigger.setAttribute("aria-haspopup", "listbox");
    languageTrigger.setAttribute("aria-controls", `nodi-code-language-menu-${block.id}`);

    const languageLabel = document.createElement("span");
    languageLabel.textContent = CODE_BLOCK_LANGUAGES[selectedLanguage].name;
    const languageChevron = document.createElement("span");
    languageChevron.className = "nodi-code-language-chevron";
    languageChevron.setAttribute("aria-hidden", "true");
    languageTrigger.append(languageLabel, languageChevron);
    languagePicker.appendChild(languageTrigger);
    languageSelect.replaceWith(languagePicker);

    const removeLanguageMenu = () => {
      const menu = languageMenu;
      if (!menu) return;
      languageMenu = null;
      if (closeActiveCodeLanguageMenu === closeLanguageMenu) closeActiveCodeLanguageMenu = null;
      document.removeEventListener("pointerdown", handleLanguageMenuOutsidePointer, true);
      document.removeEventListener("keydown", handleLanguageMenuKeyDown, true);
      window.removeEventListener("resize", removeLanguageMenu);
      window.removeEventListener("scroll", handleLanguageMenuScroll, true);
      menu.dataset.state = "closed";
      window.setTimeout(() => menu.remove(), 120);
    };
    const handleLanguageMenuOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (languageMenu?.contains(target) || languageTrigger?.contains(target))) return;
      removeLanguageMenu();
    };
    const handleLanguageMenuKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        removeLanguageMenu();
        languageTrigger?.focus();
        return;
      }
      if (event.key === "Tab") {
        removeLanguageMenu();
        return;
      }
      if (!languageMenu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = Array.from(languageMenu.querySelectorAll<HTMLButtonElement>('[role="option"]'));
      if (items.length === 0) return;
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? (currentIndex <= 0 ? items.length - 1 : currentIndex - 1)
            : (currentIndex + 1) % items.length;
      event.preventDefault();
      event.stopPropagation();
      items[nextIndex]?.focus();
    };
    const handleLanguageMenuScroll = (event: Event) => {
      if (event.target instanceof Node && languageMenu?.contains(event.target)) return;
      removeLanguageMenu();
    };
    const positionLanguageMenu = (menu: HTMLDivElement) => {
      if (!languageTrigger) return;
      const triggerRect = languageTrigger.getBoundingClientRect();
      const viewportPadding = 10;
      const menuWidth = 188;
      menu.style.left = `${Math.min(
        window.innerWidth - menuWidth - viewportPadding,
        Math.max(viewportPadding, triggerRect.left),
      )}px`;
      menu.style.top = `${triggerRect.bottom + 5}px`;
      const menuRect = menu.getBoundingClientRect();
      if (menuRect.bottom > window.innerHeight - viewportPadding && triggerRect.top > menuRect.height + viewportPadding) {
        menu.style.top = `${triggerRect.top - menuRect.height - 5}px`;
        menu.dataset.side = "top";
      } else {
        menu.dataset.side = "bottom";
      }
    };
    const openLanguageMenu = () => {
      if (!languageTrigger || languageTrigger.disabled || languageMenu) return;
      closeActiveCodeLanguageMenu?.();

      const menu = document.createElement("div");
      menu.id = `nodi-code-language-menu-${block.id}`;
      menu.className = "shadcn-select-content nodi-code-language-menu";
      menu.contentEditable = "false";
      menu.dataset.state = "open";
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", "코드 언어 선택");
      const viewport = document.createElement("div");
      viewport.className = "shadcn-select-viewport";
      let selectedItem: HTMLButtonElement | null = null;

      CODE_BLOCK_LANGUAGE_OPTIONS.forEach((option) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "shadcn-select-item";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(option.value === selectedLanguage));
        const itemLabel = document.createElement("span");
        itemLabel.className = "shadcn-select-item-label";
        itemLabel.textContent = option.label;
        const itemCheck = document.createElement("span");
        itemCheck.className = "nodi-code-language-check";
        itemCheck.setAttribute("aria-hidden", "true");
        itemCheck.textContent = "✓";
        item.append(itemLabel, itemCheck);
        if (option.value === selectedLanguage) selectedItem = item;
        item.addEventListener("pointerdown", stopLanguagePickerEvent);
        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          removeLanguageMenu();
          if (option.value !== selectedLanguage) {
            editor.updateBlock(block.id, { props: { language: option.value } });
          }
        });
        viewport.appendChild(item);
      });

      menu.appendChild(viewport);
      document.body.appendChild(menu);
      languageMenu = menu;
      closeLanguageMenu = removeLanguageMenu;
      closeActiveCodeLanguageMenu = removeLanguageMenu;
      document.addEventListener("pointerdown", handleLanguageMenuOutsidePointer, true);
      document.addEventListener("keydown", handleLanguageMenuKeyDown, true);
      window.addEventListener("resize", removeLanguageMenu);
      window.addEventListener("scroll", handleLanguageMenuScroll, true);
      positionLanguageMenu(menu);
      window.requestAnimationFrame(() => selectedItem?.focus());
    };
    const handleLanguageTriggerClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (languageMenu) removeLanguageMenu();
      else openLanguageMenu();
    };
    const handleLanguageTriggerKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        openLanguageMenu();
      } else if (event.key === "Escape") {
        removeLanguageMenu();
      }
    };
    languageTrigger.addEventListener("pointerdown", stopLanguagePickerEvent);
    languageTrigger.addEventListener("mousedown", stopLanguagePickerEvent);
    languageTrigger.addEventListener("click", handleLanguageTriggerClick);
    languageTrigger.addEventListener("keydown", handleLanguageTriggerKeyDown);
  }

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "nodi-code-copy-button";
  copyButton.contentEditable = "false";
  copyButton.setAttribute("aria-label", "코드 복사");
  copyButton.setAttribute("data-nodi-tooltip", "코드 복사");

  const copyIcon = document.createElement("span");
  copyIcon.className = "nodi-code-copy-icon";
  copyIcon.setAttribute("aria-hidden", "true");
  const copyLabel = document.createElement("span");
  copyLabel.textContent = "복사";
  copyButton.append(copyIcon, copyLabel);
  toolbar.appendChild(copyButton);

  const handleCopyPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const handleCopy = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await writeClipboardText(code.textContent ?? "");
      window.dispatchEvent(new CustomEvent(APP_NOTICE_EVENT, { detail: "코드를 클립보드에 복사했어요" }));
    } catch {
      window.dispatchEvent(new CustomEvent(APP_NOTICE_EVENT, { detail: "이 환경에서는 코드 복사를 지원하지 않아요" }));
    }
  };
  copyButton.addEventListener("pointerdown", handleCopyPointerDown);
  copyButton.addEventListener("click", handleCopy);

  const originalDestroy = rendered.destroy;
  return {
    ...rendered,
    destroy: () => {
      closeLanguageMenu?.();
      languageTrigger?.removeEventListener("pointerdown", stopLanguagePickerEvent);
      languageTrigger?.removeEventListener("mousedown", stopLanguagePickerEvent);
      copyButton.removeEventListener("pointerdown", handleCopyPointerDown);
      copyButton.removeEventListener("click", handleCopy);
      originalDestroy?.();
    },
  };
};
const nodiCodeBlockSpec = {
  ...baseCodeBlockSpec,
  implementation: {
    ...baseCodeBlockSpec.implementation,
    render: nodiCodeBlockRender,
  },
};

const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: nodiCodeBlockSpec,
    database: databaseBlockSpec(),
    childPage: childPageBlockSpec(),
  },
});

function getNodiSlashMenuItems(
  editor: BlockNoteEditor<any, any, any>,
  onCreatePage: () => void,
): DefaultReactSuggestionItem[] {
  const addPage = {
    title: "페이지",
    onItemClick: onCreatePage,
    aliases: ["page", "subpage", "child page", "페이지", "하위 페이지", "새 페이지"],
    group: "Nodi 블록",
    icon: <FileText size={18} />,
    subtext: "현재 위치에 하위 페이지를 만들고 엽니다.",
  };
  const addDatabase = {
    title: "데이터베이스",
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, {
        type: "database",
        props: { databaseId: makeId("database") },
      } as unknown as PartialBlock);
    },
    aliases: ["database", "db", "property", "properties", "table", "timeline", "데이터베이스", "속성", "테이블", "타임라인"],
    group: "Nodi 블록",
    icon: <Database size={18} />,
    subtext: "현재 위치에 비어 있는 독립 데이터베이스를 추가합니다.",
  };

  return [...getDefaultReactSlashMenuItems(editor), addPage, addDatabase];
}

const defaultBlocks: PartialBlock[] = [
  {
    type: "paragraph",
    content: "오늘 떠오른 생각을 가볍게 적어보세요.",
  },
  {
    type: "bulletListItem",
    content: "입력창에서 / 를 누르면 다양한 블록을 추가할 수 있어요.",
  },
  {
    type: "checkListItem",
    props: { checked: false },
    content: "가장 중요한 한 가지를 끝내기",
  },
];

function getSavedBlocks(): PartialBlock[] {
  try {
    const saved = window.localStorage.getItem(CONTENT_STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved) as PartialBlock[];
    }
  } catch {
    // A corrupt draft should never prevent opening the editor.
  }
  return defaultBlocks;
}

function getSavedPageSettings(): PageSettings {
  try {
    const saved = window.localStorage.getItem(PAGE_SETTINGS_STORAGE_KEY);
    if (saved) return { ...defaultPageSettings, ...(JSON.parse(saved) as Partial<PageSettings>) };
  } catch {
    // Settings fall back to a clean, readable page.
  }
  return defaultPageSettings;
}

function getInitialPages(): StoredPages {
  const storedPages = readStoredPages();
  if (storedPages?.[ROOT_PAGE_ID]) {
    let changed = false;
    const normalizedPages = Object.fromEntries(
      Object.values(storedPages)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((page, index) => {
          const normalizedPage: StoredPage = {
            ...page,
            settings: { ...defaultPageSettings, ...page.settings },
            folderId: typeof page.folderId === "string" ? page.folderId : null,
            order: typeof page.order === "number" ? page.order : index,
          };
          if (page.folderId === undefined || page.order === undefined || page.settings.publicAccess === undefined) changed = true;
          return [page.id, normalizedPage];
        }),
    );
    if (changed) persistStoredPages(normalizedPages);
    return normalizedPages;
  }

  const now = new Date().toISOString();
  const rootPage: StoredPage = {
    id: ROOT_PAGE_ID,
    parentId: null,
    folderId: null,
    order: 0,
    title: window.localStorage.getItem(TITLE_STORAGE_KEY) ?? "빠른 메모",
    settings: getSavedPageSettings(),
    blocks: getSavedBlocks(),
    archived: window.localStorage.getItem(PAGE_ARCHIVED_STORAGE_KEY) === "true",
    createdAt: now,
    updatedAt: now,
  };
  const pages = { [ROOT_PAGE_ID]: rootPage };
  persistStoredPages(pages);
  return pages;
}

function App() {
  const initialPages = useMemo(getInitialPages, []);
  const initialFolders = useMemo(readStoredFolders, []);
  const rootPage = initialPages[ROOT_PAGE_ID];
  const editor = useCreateBlockNote({
    schema: editorSchema,
    initialContent: rootPage.blocks as never,
    dictionary: ko,
  });
  const [pages, setPages] = useState<StoredPages>(initialPages);
  const [folders, setFolders] = useState<StoredFolders>(initialFolders);
  const [currentPageId, setCurrentPageId] = useState(ROOT_PAGE_ID);
  const [title, setTitle] = useState(rootPage.title);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [appTheme, setAppTheme] = useState<AppTheme>(getInitialAppTheme);
  const [isFavorite, setIsFavorite] = useState(false);
  const [savedAt, setSavedAt] = useState("방금 저장됨");
  const [notice, setNotice] = useState<string | null>(null);
  const [pageSettings, setPageSettings] = useState<PageSettings>(rootPage.settings);
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const [drawerPageId, setDrawerPageId] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<"draft" | "link" | "share" | null>(null);
  const [isArchived, setIsArchived] = useState(rootPage.archived);
  const [pendingPageDeletion, setPendingPageDeletion] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [sidebarContextMenu, setSidebarContextMenu] = useState<SidebarContextMenuState | null>(null);
  const [sidebarCreateMenuOpen, setSidebarCreateMenuOpen] = useState(false);
  const [sidebarRename, setSidebarRename] = useState<SidebarRenameState | null>(null);
  const [sidebarDraggedPageId, setSidebarDraggedPageId] = useState<string | null>(null);
  const [sidebarPageDropTarget, setSidebarPageDropTarget] = useState<SidebarPageDropTarget | null>(null);
  const [sidebarDraggedFolderId, setSidebarDraggedFolderId] = useState<string | null>(null);
  const [sidebarFolderDropTarget, setSidebarFolderDropTarget] = useState<SidebarFolderDropTarget | null>(null);
  const [pendingBlockDeletion, setPendingBlockDeletion] = useState<string[] | null>(null);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [isBlockSelectionMode, setIsBlockSelectionMode] = useState(false);
  const [blockSelectionActionMenu, setBlockSelectionActionMenu] = useState<BlockSelectionActionMenu | null>(null);
  const [isBlockDragging, setIsBlockDragging] = useState(false);
  const [blockDropIndicator, setBlockDropIndicator] = useState<BlockDropIndicator | null>(null);
  const [blockSelectionMarquee, setBlockSelectionMarquee] = useState<BlockSelectionMarquee | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editorStageRef = useRef<HTMLElement>(null);
  const editorContextRef = useRef<HTMLDivElement>(null);
  const blockSelectionToolbarRef = useRef<HTMLDivElement>(null);
  const blockSelectionOverlayRefs = useRef(new Map<string, HTMLDivElement>());
  const pagesRef = useRef(initialPages);
  const foldersRef = useRef(initialFolders);
  const sidebarDraggedPageIdRef = useRef<string | null>(null);
  const sidebarPageDropTargetRef = useRef<SidebarPageDropTarget | null>(null);
  const sidebarDraggedFolderIdRef = useRef<string | null>(null);
  const sidebarFolderDropTargetRef = useRef<SidebarFolderDropTarget | null>(null);
  const sidebarPagePointerDragRef = useRef<{
    pointerId: number;
    pageId: string;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const sidebarFolderPointerDragRef = useRef<{
    pointerId: number;
    folderId: string;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const sidebarSuppressClickRef = useRef(false);
  const currentPageIdRef = useRef(ROOT_PAGE_ID);
  const loadingPageRef = useRef(false);
  const blockSelectionModeRef = useRef(false);
  const blockSelectionAnchorRef = useRef<string | null>(null);
  const marginSelectionRef = useRef<{ pointerId: number; anchorId: string } | null>(null);
  const marqueeSelectionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    clickedBlockId: string | null;
    initialBlockIds: string[];
    additiveSelection: boolean;
    preserveClick: boolean;
  } | null>(null);
  const blockDragRef = useRef<{
    pointerId: number;
    blockIds: string[];
    startX: number;
    startY: number;
    dragging: boolean;
    dropTarget: { blockId: string; placement: "before" | "after" } | null;
  } | null>(null);
  const suppressEditorClickRef = useRef(false);
  const isDarkMode = appTheme === "dark";

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appTheme;
    document.documentElement.style.colorScheme = appTheme;
    try {
      window.localStorage.setItem(APP_THEME_STORAGE_KEY, appTheme);
    } catch {
      // The selected theme still applies for the current session.
    }
  }, [appTheme]);

  const commitPages = (nextPages: StoredPages) => {
    pagesRef.current = nextPages;
    setPages(nextPages);
    persistStoredPages(nextPages);
  };

  const commitFolders = (nextFolders: StoredFolders) => {
    foldersRef.current = nextFolders;
    setFolders(nextFolders);
    persistStoredFolders(nextFolders);
  };

  const updatePage = (pageId: string, patch: Partial<StoredPage>) => {
    const page = pagesRef.current[pageId];
    if (!page) return;
    const nextPage = { ...page, ...patch, updatedAt: new Date().toISOString() };
    commitPages({ ...pagesRef.current, [pageId]: nextPage });

    if (pageId === ROOT_PAGE_ID) {
      if (patch.blocks) window.localStorage.setItem(CONTENT_STORAGE_KEY, JSON.stringify(patch.blocks));
      if (patch.title !== undefined) window.localStorage.setItem(TITLE_STORAGE_KEY, patch.title);
      if (patch.settings) window.localStorage.setItem(PAGE_SETTINGS_STORAGE_KEY, JSON.stringify(patch.settings));
      if (patch.archived !== undefined) window.localStorage.setItem(PAGE_ARCHIVED_STORAGE_KEY, String(patch.archived));
    }
  };

  const saveDocument = () => {
    updatePage(currentPageIdRef.current, {
      blocks: editor.document as unknown as PartialBlock[],
      title: title.trim() || "제목 없음",
      settings: pageSettings,
      archived: isArchived,
    });
    setSavedAt("방금 저장됨");
  };

  useEffect(() => {
    const saveTimer = window.setTimeout(() => {
      updatePage(currentPageIdRef.current, { title: title.trim() || "제목 없음" });
    }, 300);
    return () => window.clearTimeout(saveTimer);
  }, [title, currentPageId]);

  useEffect(() => {
    updatePage(currentPageIdRef.current, { settings: pageSettings });
  }, [pageSettings, currentPageId]);

  useEffect(() => {
    updatePage(currentPageIdRef.current, { archived: isArchived });
  }, [isArchived, currentPageId]);

  const openPage = (pageId: string) => {
    if (pageId === currentPageIdRef.current) return;

    updatePage(currentPageIdRef.current, {
      blocks: editor.document as unknown as PartialBlock[],
      title: title.trim() || "제목 없음",
      settings: pageSettings,
      archived: isArchived,
    });

    const targetPage = pagesRef.current[pageId];
    if (!targetPage) {
      setNotice("페이지를 찾을 수 없어요");
      return;
    }

    loadingPageRef.current = true;
    currentPageIdRef.current = pageId;
    setCurrentPageId(pageId);
    setTitle(targetPage.title);
    setPageSettings(targetPage.settings);
    setIsArchived(targetPage.archived);
    setPageSettingsOpen(false);
    setDrawerPageId(null);
    setRightPanel(null);
    setContextMenu(null);
    editor.replaceBlocks(
      editor.document,
      (targetPage.blocks.length ? targetPage.blocks : [{ type: "paragraph", content: "" }]) as never,
    );
    editorStageRef.current?.scrollTo({ top: 0 });
    window.requestAnimationFrame(() => {
      loadingPageRef.current = false;
      titleInputRef.current?.focus();
    });
  };

  const createChildPage = (source: "slash" | "sidebar" = "slash", requestedFolderId?: string | null) => {
    if (pageSettings.lockPage) {
      setNotice("페이지 잠금을 해제한 뒤 하위 페이지를 만들 수 있어요");
      return;
    }

    const pageId = makeId("page");
    const pageTitle = "제목 없음";
    const pageBlock = {
      type: "childPage",
      props: { pageId, title: pageTitle },
    } as unknown as PartialBlock;

    if (source === "slash") {
      insertOrUpdateBlockForSlashMenu(editor as unknown as BlockNoteEditor<any, any, any>, pageBlock);
    } else {
      const lastBlock = editor.document.at(-1);
      if (lastBlock) editor.insertBlocks([pageBlock], lastBlock, "after");
    }

    const now = new Date().toISOString();
    const parentId = currentPageIdRef.current;
    const parent = pagesRef.current[parentId];
    const folderId = requestedFolderId !== undefined
      ? requestedFolderId
      : source === "slash"
        ? parent.folderId
        : null;
    const nextOrder = getNextSidebarOrder(pagesRef.current, foldersRef.current, folderId);
    const nextPage: StoredPage = {
      id: pageId,
      parentId,
      folderId,
      order: nextOrder,
      title: pageTitle,
      settings: { ...defaultPageSettings, tags: [] },
      blocks: [{ type: "paragraph", content: "" }],
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    commitPages({
      ...pagesRef.current,
      [parentId]: {
        ...parent,
        blocks: editor.document as unknown as PartialBlock[],
        updatedAt: now,
      },
      [pageId]: nextPage,
    });
    setRightPanel(null);
    setSidebarCreateMenuOpen(false);
    setDrawerPageId(pageId);
  };

  useEffect(() => {
    const handlePreviewPage = (event: Event) => {
      const pageId = (event as CustomEvent<{ pageId?: string }>).detail?.pageId;
      if (!pageId || !pagesRef.current[pageId]) return;
      setRightPanel(null);
      setDrawerPageId(pageId);
    };
    window.addEventListener(OPEN_PAGE_EVENT, handlePreviewPage);
    return () => window.removeEventListener(OPEN_PAGE_EVENT, handlePreviewPage);
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveDocument();
        setNotice("메모를 저장했어요");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const showAppNotice = (event: Event) => setNotice((event as CustomEvent<string>).detail);
    window.addEventListener(APP_NOTICE_EVENT, showAppNotice);
    return () => window.removeEventListener(APP_NOTICE_EVENT, showAppNotice);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".nodi-context-menu")) return;
      setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("mousedown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!sidebarContextMenu && !sidebarCreateMenuOpen) return;
    const closeSidebarMenus = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".sidebar-floating-menu, .sidebar-create-wrap")) return;
      setSidebarContextMenu(null);
      setSidebarCreateMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSidebarContextMenu(null);
      setSidebarCreateMenuOpen(false);
    };
    window.addEventListener("mousedown", closeSidebarMenus);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeSidebarMenus);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [sidebarContextMenu, sidebarCreateMenuOpen]);

  const applyTemplate = (template: "daily" | "brainstorm") => {
    const blocks: PartialBlock[] =
      template === "daily"
        ? [
            { type: "heading", props: { level: 2 }, content: "오늘의 초점" },
            { type: "checkListItem", props: { checked: false }, content: "" },
            { type: "heading", props: { level: 2 }, content: "메모" },
            { type: "paragraph", content: "" },
            { type: "heading", props: { level: 2 }, content: "하루 회고" },
            { type: "bulletListItem", content: "잘한 일" },
            { type: "bulletListItem", content: "내일의 나에게" },
          ]
        : [
            { type: "heading", props: { level: 2 }, content: "문제" },
            { type: "paragraph", content: "" },
            { type: "heading", props: { level: 2 }, content: "아이디어" },
            { type: "bulletListItem", content: "" },
            { type: "heading", props: { level: 2 }, content: "다음 행동" },
            { type: "checkListItem", props: { checked: false }, content: "" },
          ];

    editor.replaceBlocks(editor.document, blocks);
    setTitle(template === "daily" ? "오늘의 기록" : "아이디어 스케치");
    setNotice("템플릿을 적용했어요");
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ title, pageSettings, blocks: editor.document }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.trim() || "nodi-note"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice("JSON 파일을 내보냈어요");
  };

  const addDraft = (kind: "plan" | "meeting") => {
    if (pageSettings.lockPage) {
      setNotice("페이지 잠금을 해제한 뒤 초안을 추가할 수 있어요");
      return;
    }
    const blocks: PartialBlock[] = kind === "plan"
      ? [
          { type: "heading", props: { level: 2 }, content: "다음 행동" },
          { type: "checkListItem", props: { checked: false }, content: "가장 중요한 일" },
          { type: "checkListItem", props: { checked: false }, content: "작게 시작할 일" },
        ]
      : [
          { type: "heading", props: { level: 2 }, content: "회의 요약" },
          { type: "bulletListItem", content: "논의한 내용" },
          { type: "heading", props: { level: 2 }, content: "결정 사항" },
          { type: "checkListItem", props: { checked: false }, content: "담당자와 기한" },
        ];
    const lastBlock = editor.document.at(-1);
    if (lastBlock) editor.insertBlocks(blocks, lastBlock, "after");
    setRightPanel(null);
    setNotice(kind === "plan" ? "실행 계획 초안을 추가했어요" : "회의록 초안을 추가했어요");
  };

  const copyPageLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNotice("이 페이지의 링크를 복사했어요");
    } catch {
      setNotice("링크 복사를 지원하지 않는 환경입니다");
    }
  };

  const toggleArchive = () => {
    setIsArchived((archived) => !archived);
    setNotice(isArchived ? "페이지를 보관함에서 복원했어요" : "페이지를 보관함으로 옮겼어요");
  };

  const createFolder = (parentId: string | null = null) => {
    const folderId = makeId("folder");
    const safeParentId = parentId && foldersRef.current[parentId] ? parentId : null;
    if (safeParentId && getFolderDepth(foldersRef.current, safeParentId) >= MAX_FOLDER_DEPTH) {
      setSidebarCreateMenuOpen(false);
      setSidebarContextMenu(null);
      setNotice(`폴더는 최대 ${MAX_FOLDER_DEPTH}단계까지만 만들 수 있어요`);
      return;
    }
    const nextOrder = getNextSidebarOrder(pagesRef.current, foldersRef.current, safeParentId);
    const folder: StoredFolder = {
      id: folderId,
      parentId: safeParentId,
      title: "새 폴더",
      order: nextOrder,
      collapsed: false,
      createdAt: new Date().toISOString(),
    };
    const nextFolders = { ...foldersRef.current, [folderId]: folder };
    if (safeParentId && nextFolders[safeParentId]?.collapsed) {
      nextFolders[safeParentId] = { ...nextFolders[safeParentId], collapsed: false };
    }
    commitFolders(nextFolders);
    setSidebarCreateMenuOpen(false);
    setSidebarContextMenu(null);
    setSidebarRename({ kind: "folder", id: folderId });
  };

  const renameSidebarItem = (rename: SidebarRenameState, nextTitle: string) => {
    const normalizedTitle = nextTitle.trim() || (rename.kind === "page" ? "제목 없음" : "새 폴더");
    if (rename.kind === "page") {
      updatePage(rename.id, { title: normalizedTitle });
      if (rename.id === currentPageIdRef.current) setTitle(normalizedTitle);
    } else {
      const folder = foldersRef.current[rename.id];
      if (folder) commitFolders({ ...foldersRef.current, [rename.id]: { ...folder, title: normalizedTitle } });
    }
    setSidebarRename(null);
  };

  const toggleFolder = (folderId: string) => {
    const folder = foldersRef.current[folderId];
    if (!folder) return;
    commitFolders({ ...foldersRef.current, [folderId]: { ...folder, collapsed: !folder.collapsed } });
  };

  const reorderSidebarItem = (kind: "page" | "folder", id: string, direction: -1 | 1) => {
    const parentId = kind === "page"
      ? pagesRef.current[id] ? getPageSidebarParentId(pagesRef.current[id], foldersRef.current) : null
      : foldersRef.current[id]?.parentId ?? null;
    const siblings = getSidebarOrderedItems(pagesRef.current, foldersRef.current, parentId);
    const currentIndex = siblings.findIndex((candidate) => candidate.kind === kind && candidate.id === id);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= siblings.length) return;
    const reorderedItems = [...siblings];
    [reorderedItems[currentIndex], reorderedItems[targetIndex]] = [
      reorderedItems[targetIndex],
      reorderedItems[currentIndex],
    ];
    const nextPages = { ...pagesRef.current };
    const nextFolders = { ...foldersRef.current };
    assignSidebarItemOrder(nextPages, nextFolders, parentId, reorderedItems);
    commitPages(nextPages);
    commitFolders(nextFolders);
    setSidebarContextMenu(null);
  };

  const reorderPage = (pageId: string, direction: -1 | 1) => {
    reorderSidebarItem("page", pageId, direction);
  };

  const reorderFolder = (folderId: string, direction: -1 | 1) => {
    reorderSidebarItem("folder", folderId, direction);
  };

  const folderContainsFolder = (ancestorFolderId: string, candidateFolderId: string | null) => {
    let currentFolderId = candidateFolderId;
    const visited = new Set<string>();
    while (currentFolderId && !visited.has(currentFolderId)) {
      if (currentFolderId === ancestorFolderId) return true;
      visited.add(currentFolderId);
      currentFolderId = foldersRef.current[currentFolderId]?.parentId ?? null;
    }
    return false;
  };

  const moveSidebarFolder = (folderId: string, target: SidebarFolderDropTarget) => {
    const draggedFolder = foldersRef.current[folderId];
    if (!draggedFolder) return;

    const targetFolder = target.kind === "folder" ? foldersRef.current[target.folderId] : null;
    const targetPage = target.kind === "page" ? pagesRef.current[target.pageId] : null;
    if (target.kind === "folder" && (!targetFolder || folderId === target.folderId)) return;
    if (target.kind === "page" && !targetPage) return;
    const destinationParentId = target.kind === "root"
      ? null
      : target.kind === "page"
        ? getPageSidebarParentId(targetPage!, foldersRef.current)
        : target.placement === "inside"
          ? target.folderId
          : targetFolder?.parentId ?? null;
    if (folderContainsFolder(folderId, destinationParentId)) return;
    if (
      draggedFolder.parentId !== destinationParentId
      && !canPlaceFolderAtParent(foldersRef.current, folderId, destinationParentId)
    ) {
      setNotice(`폴더는 최대 ${MAX_FOLDER_DEPTH}단계까지만 이동할 수 있어요`);
      return;
    }

    const sourceParentId = draggedFolder.parentId;
    const destinationItems = getSidebarOrderedItems(
      pagesRef.current,
      foldersRef.current,
      destinationParentId,
    ).filter((item) => !(item.kind === "folder" && item.id === folderId));
    let insertionIndex = destinationItems.length;
    if (target.kind === "page") {
      const targetIndex = destinationItems.findIndex((item) => item.kind === "page" && item.id === target.pageId);
      if (targetIndex < 0) return;
      insertionIndex = targetIndex + (target.placement === "after" ? 1 : 0);
    } else if (target.kind === "folder" && target.placement !== "inside") {
      const targetIndex = destinationItems.findIndex((item) => item.kind === "folder" && item.id === target.folderId);
      if (targetIndex < 0) return;
      insertionIndex = targetIndex + (target.placement === "after" ? 1 : 0);
    }
    destinationItems.splice(insertionIndex, 0, {
      kind: "folder",
      id: draggedFolder.id,
      order: draggedFolder.order,
      createdAt: draggedFolder.createdAt,
      folder: draggedFolder,
    });

    const nextPages = { ...pagesRef.current };
    const nextFolders = { ...foldersRef.current };
    if (sourceParentId !== destinationParentId) {
      const sourceItems = getSidebarOrderedItems(
        pagesRef.current,
        foldersRef.current,
        sourceParentId,
      ).filter((item) => !(item.kind === "folder" && item.id === folderId));
      assignSidebarItemOrder(nextPages, nextFolders, sourceParentId, sourceItems);
    }
    assignSidebarItemOrder(nextPages, nextFolders, destinationParentId, destinationItems);
    if (destinationParentId && nextFolders[destinationParentId]?.collapsed) {
      nextFolders[destinationParentId] = { ...nextFolders[destinationParentId], collapsed: false };
    }
    commitPages(nextPages);
    commitFolders(nextFolders);
    const destinationLabel = destinationParentId
      ? `“${foldersRef.current[destinationParentId]?.title ?? "폴더"}” 안으로`
      : "개인 페이지로";
    setNotice(`“${draggedFolder.title}” 폴더를 ${destinationLabel} 이동했어요`);
  };

  const movePageToFolder = (pageId: string, folderId: string | null) => {
    const page = pagesRef.current[pageId];
    if (!page || page.folderId === folderId) {
      setSidebarContextMenu(null);
      return;
    }
    const sourceParentId = getPageSidebarParentId(page, foldersRef.current);
    const destinationItems = getSidebarOrderedItems(
      pagesRef.current,
      foldersRef.current,
      folderId,
    ).filter((item) => !(item.kind === "page" && item.id === pageId));
    destinationItems.push({
      kind: "page",
      id: page.id,
      order: page.order,
      createdAt: page.createdAt,
      page,
    });
    const nextPages = { ...pagesRef.current };
    const nextFolders = { ...foldersRef.current };
    const sourceItems = getSidebarOrderedItems(
      pagesRef.current,
      foldersRef.current,
      sourceParentId,
    ).filter((item) => !(item.kind === "page" && item.id === pageId));
    assignSidebarItemOrder(nextPages, nextFolders, sourceParentId, sourceItems);
    assignSidebarItemOrder(nextPages, nextFolders, folderId, destinationItems);
    nextPages[pageId] = { ...nextPages[pageId], updatedAt: new Date().toISOString() };
    if (folderId && nextFolders[folderId]?.collapsed) {
      nextFolders[folderId] = { ...nextFolders[folderId], collapsed: false };
    }
    commitPages(nextPages);
    commitFolders(nextFolders);
    setSidebarContextMenu(null);
    setNotice(folderId ? "페이지를 폴더로 이동했어요" : "페이지를 폴더 밖으로 이동했어요");
  };

  const moveSidebarPage = (pageId: string, target: SidebarPageDropTarget) => {
    const page = pagesRef.current[pageId];
    if (!page) return;
    const targetPage = target.kind === "page" ? pagesRef.current[target.pageId] : null;
    if (target.kind === "page" && (!targetPage || targetPage.id === pageId)) return;
    const targetFolder = target.kind === "folder" ? foldersRef.current[target.folderId] : null;
    if (target.kind === "folder" && !targetFolder) return;
    const targetFolderId = target.kind === "page"
      ? getPageSidebarParentId(targetPage!, foldersRef.current)
      : target.kind === "folder" && target.placement === "inside"
        ? target.folderId
        : target.kind === "folder"
          ? targetFolder?.parentId ?? null
          : null;
    const sourceFolderId = getPageSidebarParentId(page, foldersRef.current);
    const destinationItems = getSidebarOrderedItems(
      pagesRef.current,
      foldersRef.current,
      targetFolderId,
    ).filter((item) => !(item.kind === "page" && item.id === pageId));
    let insertionIndex = destinationItems.length;
    if (target.kind === "page") {
      const targetIndex = destinationItems.findIndex((item) => item.kind === "page" && item.id === target.pageId);
      if (targetIndex < 0) return;
      insertionIndex = targetIndex + (target.placement === "after" ? 1 : 0);
    } else if (target.kind === "folder" && target.placement !== "inside") {
      const targetIndex = destinationItems.findIndex((item) => item.kind === "folder" && item.id === target.folderId);
      if (targetIndex < 0) return;
      insertionIndex = targetIndex + (target.placement === "after" ? 1 : 0);
    }
    destinationItems.splice(insertionIndex, 0, {
      kind: "page",
      id: page.id,
      order: page.order,
      createdAt: page.createdAt,
      page,
    });

    const nextPages = { ...pagesRef.current };
    const nextFolders = { ...foldersRef.current };
    if (sourceFolderId !== targetFolderId) {
      const sourceItems = getSidebarOrderedItems(
        pagesRef.current,
        foldersRef.current,
        sourceFolderId,
      ).filter((item) => !(item.kind === "page" && item.id === pageId));
      assignSidebarItemOrder(nextPages, nextFolders, sourceFolderId, sourceItems);
    }
    assignSidebarItemOrder(nextPages, nextFolders, targetFolderId, destinationItems);
    nextPages[pageId] = { ...nextPages[pageId], updatedAt: new Date().toISOString() };
    commitPages(nextPages);

    if (targetFolderId && foldersRef.current[targetFolderId]?.collapsed) {
      nextFolders[targetFolderId] = { ...nextFolders[targetFolderId], collapsed: false };
    }
    commitFolders(nextFolders);
    const destinationLabel = targetFolderId ? `“${foldersRef.current[targetFolderId]?.title ?? "폴더"}”` : "개인 페이지";
    setNotice(`${destinationLabel}에서 페이지 위치를 변경했어요`);
  };

  const setSidebarDropTarget = (target: SidebarPageDropTarget | null) => {
    const current = sidebarPageDropTargetRef.current;
    if (JSON.stringify(current) === JSON.stringify(target)) return;
    sidebarPageDropTargetRef.current = target;
    setSidebarPageDropTarget(target);
  };

  const beginSidebarPagePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, pageId: string) => {
    if (event.button !== 0) return;
    if (sidebarDraggedFolderIdRef.current) return;
    if (sidebarRename) {
      event.preventDefault();
      return;
    }
    sidebarPagePointerDragRef.current = {
      pointerId: event.pointerId,
      pageId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const finishSidebarPageDrag = () => {
    sidebarPagePointerDragRef.current = null;
    sidebarDraggedPageIdRef.current = null;
    sidebarPageDropTargetRef.current = null;
    setSidebarDraggedPageId(null);
    setSidebarPageDropTarget(null);
  };

  const updateSidebarPageDropTargetFromPoint = (
    clientX: number,
    clientY: number,
    draggedPageId: string,
  ) => {
    const hitElement = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const targetPageElement = hitElement?.closest<HTMLElement>("[data-sidebar-page-id]");
    const targetPageId = targetPageElement?.dataset.sidebarPageId;
    if (targetPageId && targetPageId !== draggedPageId) {
      const targetRect = targetPageElement.getBoundingClientRect();
      setSidebarDropTarget({
        kind: "page",
        pageId: targetPageId,
        placement: clientY < targetRect.top + targetRect.height / 2 ? "before" : "after",
      });
      return;
    }
    const targetFolderRow = hitElement?.closest<HTMLElement>("[data-sidebar-folder-row-id]");
    const targetFolderId = targetFolderRow?.dataset.sidebarFolderRowId;
    if (targetFolderId) {
      const targetRect = targetFolderRow.getBoundingClientRect();
      const pointerRatio = Math.max(0, Math.min(1, (clientY - targetRect.top) / Math.max(1, targetRect.height)));
      setSidebarDropTarget({
        kind: "folder",
        folderId: targetFolderId,
        placement: pointerRatio < .3 ? "before" : pointerRatio > .7 ? "after" : "inside",
      });
      return;
    }
    const siblingTarget = getSidebarSiblingDropTargetFromGap(
      hitElement,
      clientY,
      { kind: "page", id: draggedPageId },
    );
    if (siblingTarget) {
      setSidebarDropTarget(siblingTarget);
      return;
    }
    if (hitElement?.closest(".sidebar-unfiled-pages, .pages-section > .section-label")) {
      setSidebarDropTarget({ kind: "unfiled" });
      return;
    }
    setSidebarDropTarget(null);
  };

  const updateSidebarPagePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragState = sidebarPagePointerDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (!dragState.dragging && distance < 5) return;
    event.preventDefault();
    event.stopPropagation();
    if (!dragState.dragging) {
      dragState.dragging = true;
      sidebarDraggedPageIdRef.current = dragState.pageId;
      setSidebarDraggedPageId(dragState.pageId);
      setSidebarContextMenu(null);
      setSidebarCreateMenuOpen(false);
    }
    updateSidebarPageDropTargetFromPoint(event.clientX, event.clientY, dragState.pageId);
  };

  const completeSidebarPagePointerDrop = () => {
    const dragState = sidebarPagePointerDragRef.current;
    if (!dragState) return false;
    const dropTarget = sidebarPageDropTargetRef.current;
    if (dragState.dragging) {
      sidebarSuppressClickRef.current = true;
      if (dropTarget) moveSidebarPage(dragState.pageId, dropTarget);
      window.setTimeout(() => {
        sidebarSuppressClickRef.current = false;
      }, 0);
    }
    const wasDragging = dragState.dragging;
    finishSidebarPageDrag();
    return wasDragging;
  };

  const finishSidebarPagePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragState = sidebarPagePointerDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (dragState.dragging) {
      event.preventDefault();
      event.stopPropagation();
    }
    completeSidebarPagePointerDrop();
  };

  const finishSidebarPageMouseDrag = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const dragState = sidebarPagePointerDragRef.current;
    if (!dragState?.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    completeSidebarPagePointerDrop();
  };

  const openSidebarPage = (pageId: string) => {
    if (sidebarSuppressClickRef.current) {
      sidebarSuppressClickRef.current = false;
      return;
    }
    openPage(pageId);
  };

  useEffect(() => {
    if (!sidebarDraggedPageId) return;
    const updateFromWindow = (event: PointerEvent | MouseEvent) => {
      const dragState = sidebarPagePointerDragRef.current;
      if (!dragState?.dragging) return;
      updateSidebarPageDropTargetFromPoint(event.clientX, event.clientY, dragState.pageId);
    };
    const finishFromWindow = (event: PointerEvent | MouseEvent) => {
      const dragState = sidebarPagePointerDragRef.current;
      if (!dragState?.dragging) return;
      event.preventDefault();
      event.stopPropagation();
      completeSidebarPagePointerDrop();
    };
    window.addEventListener("pointermove", updateFromWindow, true);
    window.addEventListener("mousemove", updateFromWindow, true);
    window.addEventListener("pointerup", finishFromWindow, true);
    window.addEventListener("mouseup", finishFromWindow, true);
    return () => {
      window.removeEventListener("pointermove", updateFromWindow, true);
      window.removeEventListener("mousemove", updateFromWindow, true);
      window.removeEventListener("pointerup", finishFromWindow, true);
      window.removeEventListener("mouseup", finishFromWindow, true);
    };
  }, [sidebarDraggedPageId]);

  const setSidebarFolderTarget = (target: SidebarFolderDropTarget | null) => {
    const current = sidebarFolderDropTargetRef.current;
    if (JSON.stringify(current) === JSON.stringify(target)) return;
    sidebarFolderDropTargetRef.current = target;
    setSidebarFolderDropTarget(target);
  };

  const beginSidebarFolderPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, folderId: string) => {
    if (event.button !== 0 || sidebarDraggedPageIdRef.current || sidebarRename) return;
    sidebarFolderPointerDragRef.current = {
      pointerId: event.pointerId,
      folderId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const finishSidebarFolderDrag = () => {
    sidebarFolderPointerDragRef.current = null;
    sidebarDraggedFolderIdRef.current = null;
    sidebarFolderDropTargetRef.current = null;
    setSidebarDraggedFolderId(null);
    setSidebarFolderDropTarget(null);
  };

  const updateSidebarFolderDropTargetFromPoint = (
    clientX: number,
    clientY: number,
    draggedFolderId: string,
  ) => {
    const hitElement = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const targetPageElement = hitElement?.closest<HTMLElement>("[data-sidebar-page-id]");
    const targetPageId = targetPageElement?.dataset.sidebarPageId;
    if (targetPageId) {
      const targetPage = pagesRef.current[targetPageId];
      const destinationParentId = targetPage
        ? getPageSidebarParentId(targetPage, foldersRef.current)
        : null;
      const draggedFolder = foldersRef.current[draggedFolderId];
      if (
        !targetPage
        || folderContainsFolder(draggedFolderId, destinationParentId)
        || (
          draggedFolder?.parentId !== destinationParentId
          && !canPlaceFolderAtParent(foldersRef.current, draggedFolderId, destinationParentId)
        )
      ) {
        setSidebarFolderTarget(null);
        return;
      }
      const targetRect = targetPageElement.getBoundingClientRect();
      setSidebarFolderTarget({
        kind: "page",
        pageId: targetPageId,
        placement: clientY < targetRect.top + targetRect.height / 2 ? "before" : "after",
      });
      return;
    }
    const targetFolderRow = hitElement?.closest<HTMLElement>("[data-sidebar-folder-row-id]");
    const targetFolderId = targetFolderRow?.dataset.sidebarFolderRowId;
    if (targetFolderId && targetFolderId !== draggedFolderId) {
      const targetFolder = foldersRef.current[targetFolderId];
      const targetRect = targetFolderRow.getBoundingClientRect();
      const pointerRatio = Math.max(0, Math.min(1, (clientY - targetRect.top) / Math.max(1, targetRect.height)));
      const placement = pointerRatio < .27 ? "before" : pointerRatio > .73 ? "after" : "inside";
      const destinationParentId = placement === "inside" ? targetFolderId : targetFolder?.parentId ?? null;
      const draggedFolder = foldersRef.current[draggedFolderId];
      if (
        folderContainsFolder(draggedFolderId, destinationParentId)
        || (
          draggedFolder?.parentId !== destinationParentId
          && !canPlaceFolderAtParent(foldersRef.current, draggedFolderId, destinationParentId)
        )
      ) {
        setSidebarFolderTarget(null);
        return;
      }
      setSidebarFolderTarget({
        kind: "folder",
        folderId: targetFolderId,
        placement,
      });
      return;
    }

    const siblingTarget = getSidebarSiblingDropTargetFromGap(
      hitElement,
      clientY,
      { kind: "folder", id: draggedFolderId },
    );
    if (siblingTarget) {
      const destinationParentId = siblingTarget.kind === "folder"
        ? foldersRef.current[siblingTarget.folderId]?.parentId ?? null
        : pagesRef.current[siblingTarget.pageId]
          ? getPageSidebarParentId(pagesRef.current[siblingTarget.pageId], foldersRef.current)
          : null;
      const draggedFolder = foldersRef.current[draggedFolderId];
      if (
        !folderContainsFolder(draggedFolderId, destinationParentId)
        && (
          draggedFolder?.parentId === destinationParentId
          || canPlaceFolderAtParent(foldersRef.current, draggedFolderId, destinationParentId)
        )
      ) {
        setSidebarFolderTarget(siblingTarget);
      } else {
        setSidebarFolderTarget(null);
      }
      return;
    }

    if (hitElement?.closest(".pages-section")) {
      setSidebarFolderTarget({ kind: "root" });
      return;
    }
    setSidebarFolderTarget(null);
  };

  const updateSidebarFolderPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = sidebarFolderPointerDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (!dragState.dragging && distance < 5) return;
    event.preventDefault();
    event.stopPropagation();
    if (!dragState.dragging) {
      dragState.dragging = true;
      sidebarDraggedFolderIdRef.current = dragState.folderId;
      setSidebarDraggedFolderId(dragState.folderId);
      setSidebarContextMenu(null);
      setSidebarCreateMenuOpen(false);
    }
    updateSidebarFolderDropTargetFromPoint(event.clientX, event.clientY, dragState.folderId);
  };

  const completeSidebarFolderPointerDrop = () => {
    const dragState = sidebarFolderPointerDragRef.current;
    if (!dragState) return false;
    const dropTarget = sidebarFolderDropTargetRef.current;
    if (dragState.dragging) {
      sidebarSuppressClickRef.current = true;
      if (dropTarget) moveSidebarFolder(dragState.folderId, dropTarget);
      window.setTimeout(() => {
        sidebarSuppressClickRef.current = false;
      }, 0);
    }
    const wasDragging = dragState.dragging;
    finishSidebarFolderDrag();
    return wasDragging;
  };

  const finishSidebarFolderPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = sidebarFolderPointerDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (dragState.dragging) {
      event.preventDefault();
      event.stopPropagation();
    }
    completeSidebarFolderPointerDrop();
  };

  const finishSidebarFolderMouseDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    const dragState = sidebarFolderPointerDragRef.current;
    if (!dragState?.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    completeSidebarFolderPointerDrop();
  };

  useEffect(() => {
    if (!sidebarDraggedFolderId) return;
    const updateFromWindow = (event: PointerEvent | MouseEvent) => {
      const dragState = sidebarFolderPointerDragRef.current;
      if (!dragState?.dragging) return;
      updateSidebarFolderDropTargetFromPoint(event.clientX, event.clientY, dragState.folderId);
    };
    const finishFromWindow = (event: PointerEvent | MouseEvent) => {
      const dragState = sidebarFolderPointerDragRef.current;
      if (!dragState?.dragging) return;
      event.preventDefault();
      event.stopPropagation();
      completeSidebarFolderPointerDrop();
    };
    window.addEventListener("pointermove", updateFromWindow, true);
    window.addEventListener("mousemove", updateFromWindow, true);
    window.addEventListener("pointerup", finishFromWindow, true);
    window.addEventListener("mouseup", finishFromWindow, true);
    return () => {
      window.removeEventListener("pointermove", updateFromWindow, true);
      window.removeEventListener("mousemove", updateFromWindow, true);
      window.removeEventListener("pointerup", finishFromWindow, true);
      window.removeEventListener("mouseup", finishFromWindow, true);
    };
  }, [sidebarDraggedFolderId]);

  const removeFolder = (folderId: string) => {
    const folder = foldersRef.current[folderId];
    if (!folder) return;
    const nextPages = { ...pagesRef.current };
    const nextFolders = { ...foldersRef.current };
    const parentItems = getSidebarOrderedItems(pagesRef.current, foldersRef.current, folder.parentId)
      .filter((item) => !(item.kind === "folder" && item.id === folderId));
    const promotedItems = getSidebarOrderedItems(pagesRef.current, foldersRef.current, folderId);
    delete nextFolders[folderId];
    assignSidebarItemOrder(nextPages, nextFolders, folder.parentId, [...parentItems, ...promotedItems]);
    promotedItems.forEach((item) => {
      if (item.kind === "page" && nextPages[item.id]) {
        nextPages[item.id] = { ...nextPages[item.id], updatedAt: new Date().toISOString() };
      }
    });
    commitPages(nextPages);
    commitFolders(nextFolders);
    setSidebarContextMenu(null);
    setNotice(`“${folder.title}” 폴더를 삭제하고 내부 항목은 상위 위치로 이동했어요`);
  };

  const deletePage = (pageId: string) => {
    const page = pagesRef.current[pageId];
    if (!page) return;

    if (pageId === ROOT_PAGE_ID) {
      window.localStorage.setItem(PAGE_TRASH_STORAGE_KEY, JSON.stringify({
        id: pageId,
        title,
        pageSettings,
        blocks: editor.document,
        deletedAt: new Date().toISOString(),
      }));
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "" }]);
      setTitle("제목 없음");
      setPageSettings(defaultPageSettings);
      setIsArchived(false);
      setPendingPageDeletion(null);
      setNotice("페이지를 휴지통으로 옮겼어요");
      return;
    }

    const pageIdsToDelete = new Set<string>([pageId]);
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      Object.values(pagesRef.current).forEach((candidate) => {
        if (candidate.parentId && pageIdsToDelete.has(candidate.parentId) && !pageIdsToDelete.has(candidate.id)) {
          pageIdsToDelete.add(candidate.id);
          foundDescendant = true;
        }
      });
    }
    const deletedPages = [...pageIdsToDelete].map((id) => pagesRef.current[id]).filter(Boolean);
    window.localStorage.setItem(PAGE_TRASH_STORAGE_KEY, JSON.stringify({
      pages: deletedPages,
      deletedAt: new Date().toISOString(),
    }));

    const nextPages: StoredPages = {};
    Object.values(pagesRef.current).forEach((candidate) => {
      if (pageIdsToDelete.has(candidate.id)) return;
      const blocks = candidate.blocks.filter((block) => {
        const childBlock = block as unknown as { type?: string; props?: { pageId?: string } };
        return !(childBlock.type === "childPage" && childBlock.props?.pageId && pageIdsToDelete.has(childBlock.props.pageId));
      });
      nextPages[candidate.id] = { ...candidate, blocks };
    });

    const liveChildBlocks = editor.document.filter((block) => {
      const childBlock = block as unknown as { type?: string; props?: { pageId?: string } };
      return childBlock.type === "childPage" && !!childBlock.props?.pageId && pageIdsToDelete.has(childBlock.props.pageId);
    });
    if (liveChildBlocks.length > 0 && !pageIdsToDelete.has(currentPageIdRef.current)) {
      editor.removeBlocks(liveChildBlocks.map((block) => block.id));
    }

    const currentPageWasDeleted = pageIdsToDelete.has(currentPageIdRef.current);
    const fallbackPageId = page.parentId && nextPages[page.parentId] ? page.parentId : ROOT_PAGE_ID;
    commitPages(nextPages);
    if (drawerPageId && pageIdsToDelete.has(drawerPageId)) setDrawerPageId(null);
    setPendingPageDeletion(null);
    setSidebarContextMenu(null);
    if (currentPageWasDeleted) openPage(fallbackPageId);
    setNotice(pageIdsToDelete.size > 1 ? `${pageIdsToDelete.size}개 페이지를 휴지통으로 옮겼어요` : "페이지를 휴지통으로 옮겼어요");
  };

  const getOrderedBlockIds = () => {
    const ids: string[] = [];
    const visit = (blocks: readonly { id: string; children?: readonly unknown[] }[]) => {
      blocks.forEach((block) => {
        ids.push(block.id);
        if (block.children?.length) {
          visit(block.children as readonly { id: string; children?: readonly unknown[] }[]);
        }
      });
    };
    visit(editor.document);
    return ids;
  };

  const normalizeBlockIds = (blockIds: string[]) => {
    const selected = new Set(blockIds);
    const normalized: string[] = [];
    const visit = (
      blocks: readonly { id: string; children?: readonly unknown[] }[],
      parentIsSelected = false,
    ) => {
      blocks.forEach((block) => {
        const isSelected = selected.has(block.id);
        if (isSelected && !parentIsSelected) normalized.push(block.id);
        if (block.children?.length) {
          visit(
            block.children as readonly { id: string; children?: readonly unknown[] }[],
            parentIsSelected || isSelected,
          );
        }
      });
    };
    visit(editor.document);
    return normalized;
  };

  const setBlockSelectionState = (blockIds: string[], anchorId?: string) => {
    const uniqueIds = [...new Set(blockIds)];
    blockSelectionModeRef.current = uniqueIds.length > 0;
    setIsBlockSelectionMode(uniqueIds.length > 0);
    setSelectedBlockIds(uniqueIds);
    if (anchorId) blockSelectionAnchorRef.current = anchorId;
  };

  const clearBlockSelection = () => {
    blockSelectionModeRef.current = false;
    blockSelectionAnchorRef.current = null;
    setIsBlockSelectionMode(false);
    setSelectedBlockIds([]);
    setBlockSelectionActionMenu(null);
  };

  const selectBlockRange = (anchorId: string, targetId: string) => {
    const orderedIds = getOrderedBlockIds();
    const anchorIndex = orderedIds.indexOf(anchorId);
    const targetIndex = orderedIds.indexOf(targetId);
    if (anchorIndex < 0 || targetIndex < 0) return;
    const from = Math.min(anchorIndex, targetIndex);
    const to = Math.max(anchorIndex, targetIndex);
    const rangeIds = orderedIds.slice(from, to + 1);
    setBlockSelectionState(rangeIds, anchorId);
    setFocusedBlockId(targetId);
  };

  const selectSingleBlock = (blockId: string) => {
    setFocusedBlockId(blockId);
    setBlockSelectionState([blockId], blockId);
  };

  const getBlockElementAtPoint = (clientX: number, clientY: number) => {
    const root = editorContextRef.current;
    if (!root) return null;
    const directTarget = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const directBlock = directTarget?.closest<HTMLElement>("[data-node-type='blockContainer']");
    if (directBlock && root.contains(directBlock)) return directBlock;
    const candidates = [...root.querySelectorAll<HTMLElement>("[data-node-type='blockContainer']")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return clientY >= rect.top && clientY <= rect.bottom;
      })
      .sort((first, second) => first.getBoundingClientRect().height - second.getBoundingClientRect().height);
    return candidates[0] ?? null;
  };

  const getLiveSelectedBlockIds = () => selectedBlockIds.filter((blockId) => Boolean(editor.getBlock(blockId)));

  const getEventBlockId = (
    target: EventTarget | null,
    clientX?: number,
    clientY?: number,
  ) => {
    const targetBlockId = target instanceof HTMLElement
      ? target.closest<HTMLElement>("[data-node-type='blockContainer']")?.dataset.id
      : undefined;
    if (targetBlockId) return targetBlockId;
    if (clientX !== undefined && clientY !== undefined) {
      return getBlockElementAtPoint(clientX, clientY)?.dataset.id;
    }
    return undefined;
  };

  const isPointOverRenderedText = (
    container: HTMLElement,
    clientX: number,
    clientY: number,
  ) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      if (textNode.textContent?.trim()) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const isOverText = [...range.getClientRects()].some((rect) => (
          clientX >= rect.left - 5
          && clientX <= rect.right + 5
          && clientY >= rect.top - 3
          && clientY <= rect.bottom + 3
        ));
        range.detach();
        if (isOverText) return true;
      }
      textNode = walker.nextNode();
    }
    return false;
  };

  const beginMarqueeSelection = (
    event: ReactPointerEvent<HTMLDivElement>,
    clickedBlockId: string | null,
    preserveClick = false,
  ) => {
    const isAdditiveSelection = event.metaKey || event.ctrlKey;
    const initialBlockIds = isAdditiveSelection ? getLiveSelectedBlockIds() : [];
    marqueeSelectionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      clickedBlockId,
      initialBlockIds,
      additiveSelection: isAdditiveSelection,
      preserveClick,
    };
    if (!preserveClick) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      suppressEditorClickRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      if (!isAdditiveSelection) clearBlockSelection();
    }
  };

  const updateMarqueeSelection = (
    event: ReactPointerEvent<HTMLDivElement>,
    marqueeState: NonNullable<typeof marqueeSelectionRef.current>,
  ) => {
    const deltaX = event.clientX - marqueeState.startX;
    const deltaY = event.clientY - marqueeState.startY;
    const dragDistance = Math.hypot(deltaX, deltaY);
    if (!marqueeState.dragging && dragDistance < 4) return;
    if (!marqueeState.dragging && marqueeState.preserveClick) {
      const currentBlockId = getBlockElementAtPoint(event.clientX, event.clientY)?.dataset.id;
      const staysOnTextLine = currentBlockId === marqueeState.clickedBlockId
        && Math.abs(deltaY) < 8;
      if (staysOnTextLine) return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (!marqueeState.dragging) {
      marqueeState.dragging = true;
      if (marqueeState.preserveClick) {
        event.currentTarget.focus({ preventScroll: true });
        suppressEditorClickRef.current = true;
        window.getSelection()?.removeAllRanges();
        event.currentTarget.setPointerCapture(event.pointerId);
        if (!marqueeState.additiveSelection) clearBlockSelection();
      }
    }

    const scrollArea = editorStageRef.current;
    if (scrollArea) {
      const scrollRect = scrollArea.getBoundingClientRect();
      const edgeSize = 54;
      const topDistance = event.clientY - scrollRect.top;
      const bottomDistance = scrollRect.bottom - event.clientY;
      if (topDistance < edgeSize) {
        scrollArea.scrollTop -= Math.ceil((edgeSize - Math.max(0, topDistance)) / 3);
      } else if (bottomDistance < edgeSize) {
        scrollArea.scrollTop += Math.ceil((edgeSize - Math.max(0, bottomDistance)) / 3);
      }
    }

    const left = Math.min(marqueeState.startX, event.clientX);
    const top = Math.min(marqueeState.startY, event.clientY);
    const right = Math.max(marqueeState.startX, event.clientX);
    const bottom = Math.max(marqueeState.startY, event.clientY);
    const marquee = {
      left,
      top,
      width: right - left,
      height: bottom - top,
    };
    setBlockSelectionMarquee(marquee);

    const root = editorContextRef.current;
    if (!root) return;
    const hitIds = [...root.querySelectorAll<HTMLElement>("[data-node-type='blockContainer']")]
      .filter((element) => {
        const content = element.querySelector<HTMLElement>(":scope > .bn-block-content")
          ?? element.querySelector<HTMLElement>(".bn-block-content");
        if (!content) return false;
        const rect = content.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return left <= rect.right
          && right >= rect.left
          && top <= rect.bottom
          && bottom >= rect.top;
      })
      .map((element) => element.dataset.id)
      .filter((blockId): blockId is string => Boolean(blockId));
    const nextSelection = [...new Set([...marqueeState.initialBlockIds, ...hitIds])];
    const orderedIds = getOrderedBlockIds();
    nextSelection.sort((first, second) => orderedIds.indexOf(first) - orderedIds.indexOf(second));
    if (nextSelection.length > 0) {
      setBlockSelectionState(nextSelection, nextSelection[0]);
      setFocusedBlockId(nextSelection.at(-1) ?? nextSelection[0]);
    } else {
      clearBlockSelection();
    }
  };

  const finishMarqueeSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const marqueeState = marqueeSelectionRef.current;
    if (!marqueeState || marqueeState.pointerId !== event.pointerId) return false;
    if (marqueeState.dragging || !marqueeState.preserveClick) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.type === "pointerup" && !marqueeState.dragging && !marqueeState.preserveClick) {
      if (marqueeState.clickedBlockId) selectSingleBlock(marqueeState.clickedBlockId);
      else clearBlockSelection();
    }
    marqueeSelectionRef.current = null;
    setBlockSelectionMarquee(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    return true;
  };

  const moveBlocksToDropTarget = (
    blockIds: string[],
    targetBlockId: string,
    placement: "before" | "after",
  ) => {
    const selected = new Set(normalizeBlockIds(blockIds));
    if (selected.size === 0 || selected.has(targetBlockId)) return;

    const rootBlocks = [...editor.document];
    const movingBlocks = rootBlocks.filter((block) => selected.has(block.id));
    if (movingBlocks.length === 0) return;

    const remainingBlocks = rootBlocks.filter((block) => !selected.has(block.id));
    const targetIndex = remainingBlocks.findIndex((block) => block.id === targetBlockId);
    if (targetIndex < 0) return;

    const insertionIndex = targetIndex + (placement === "after" ? 1 : 0);
    const nextDocument = [
      ...remainingBlocks.slice(0, insertionIndex),
      ...movingBlocks,
      ...remainingBlocks.slice(insertionIndex),
    ];
    const nextIds = movingBlocks.map((block) => block.id);

    editor.replaceBlocks(editor.document, nextDocument as never);
    setBlockSelectionState(nextIds, nextIds[0]);
    setFocusedBlockId(nextIds[0]);
    setNotice(`${nextIds.length}개 블록을 이동했어요`);
  };

  const finishBlockDrag = () => {
    blockDragRef.current = null;
    setIsBlockDragging(false);
    setBlockDropIndicator(null);
  };

  const handleEditorPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pageSettings.lockPage || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const dragHandle = target.closest<HTMLElement>(".bn-side-menu button[draggable='true']");
    if (dragHandle) {
      const blockId = getEventBlockId(event.target, event.clientX, event.clientY);
      if (!blockId) return;
      const liveSelection = getLiveSelectedBlockIds();
      const blockIds = liveSelection.includes(blockId) ? liveSelection : [blockId];
      event.preventDefault();
      event.stopPropagation();
      suppressEditorClickRef.current = true;
      blockDragRef.current = {
        pointerId: event.pointerId,
        blockIds,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        dropTarget: null,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setBlockSelectionState(blockIds, blockId);
      setFocusedBlockId(blockId);
      return;
    }
    if (target.closest(".bn-side-menu, button, input, textarea, select, [role='button'], [role='menu']")) return;
    const blockElement = getBlockElementAtPoint(event.clientX, event.clientY);
    const blockId = blockElement?.dataset.id;
    if (!blockId || !blockElement) {
      if (target.matches(".block-editor-context-target, .block-selection-gutter, .bn-container, .bn-editor, .bn-block-group")) {
        beginMarqueeSelection(event, null);
      }
      return;
    }
    const contentElement = blockElement?.querySelector<HTMLElement>(":scope > .bn-block-content")
      ?? blockElement?.querySelector<HTMLElement>(".bn-block-content");
    if (!contentElement) return;
    const contentRect = contentElement.getBoundingClientRect();
    const isBlockMargin = event.clientX < contentRect.left - 6 || event.clientX > contentRect.right + 6;
    const isInlineWhitespace = !isBlockMargin
      && !target.closest(".database-block, [contenteditable='false']")
      && !isPointOverRenderedText(contentElement, event.clientX, event.clientY);
    if (!isBlockMargin && !isInlineWhitespace) return;

    if (!event.shiftKey) {
      beginMarqueeSelection(event, isBlockMargin ? null : blockId, isInlineWhitespace);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressEditorClickRef.current = true;
    marginSelectionRef.current = { pointerId: event.pointerId, anchorId: blockId };
    event.currentTarget.setPointerCapture(event.pointerId);
    selectSingleBlock(blockId);
  };

  const handleEditorStagePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!blockSelectionModeRef.current || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (editorContextRef.current?.contains(target)) return;
    if (target.closest("button, input, textarea, select, [role='button'], [role='menu'], [role='dialog']")) return;
    clearBlockSelection();
    setFocusedBlockId(null);
  };

  const handleEditorPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const marqueeState = marqueeSelectionRef.current;
    if (marqueeState && marqueeState.pointerId === event.pointerId) {
      updateMarqueeSelection(event, marqueeState);
      return;
    }

    const dragState = blockDragRef.current;
    if (dragState && dragState.pointerId === event.pointerId) {
      const dragDistance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
      if (!dragState.dragging && dragDistance < 4) return;
      event.preventDefault();
      event.stopPropagation();
      if (!dragState.dragging) {
        dragState.dragging = true;
        setIsBlockDragging(true);
      }

      const targetElement = getBlockElementAtPoint(event.clientX, event.clientY);
      const targetBlockId = targetElement?.dataset.id;
      if (!targetBlockId || dragState.blockIds.includes(targetBlockId)) {
        dragState.dropTarget = null;
        setBlockDropIndicator(null);
        return;
      }
      const targetRect = targetElement.getBoundingClientRect();
      const placement: "before" | "after" = event.clientY < targetRect.top + targetRect.height / 2
        ? "before"
        : "after";
      const nextTarget = { blockId: targetBlockId, placement };
      dragState.dropTarget = nextTarget;
      const horizontalPadding = 7;
      const nextIndicator = {
        left: targetRect.left - horizontalPadding,
        top: placement === "before" ? targetRect.top : targetRect.bottom,
        width: targetRect.width + horizontalPadding * 2,
      };
      setBlockDropIndicator((current) => (
        current
        && current.left === nextIndicator.left
        && current.top === nextIndicator.top
        && current.width === nextIndicator.width
          ? current
          : nextIndicator
      ));
      return;
    }

    const selection = marginSelectionRef.current;
    if (!selection || selection.pointerId !== event.pointerId) return;
    event.preventDefault();
    const blockId = getBlockElementAtPoint(event.clientX, event.clientY)?.dataset.id;
    if (blockId) selectBlockRange(selection.anchorId, blockId);
  };

  const finishEditorPointerInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (finishMarqueeSelection(event)) return;

    const dragState = blockDragRef.current;
    if (dragState && dragState.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "pointerup" && dragState.dragging && dragState.dropTarget) {
        moveBlocksToDropTarget(
          dragState.blockIds,
          dragState.dropTarget.blockId,
          dragState.dropTarget.placement,
        );
      }
      finishBlockDrag();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }

    const selection = marginSelectionRef.current;
    if (!selection || selection.pointerId !== event.pointerId) return;
    marginSelectionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleEditorFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    const blockId = (event.target as HTMLElement)
      .closest<HTMLElement>("[data-node-type='blockContainer']")
      ?.dataset.id;
    if (blockId) {
      setFocusedBlockId(blockId);
      if (!blockSelectionModeRef.current) blockSelectionAnchorRef.current = blockId;
    }
  };

  const handleEditorClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressEditorClickRef.current) {
      suppressEditorClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const blockId = getEventBlockId(event.target, event.clientX, event.clientY);
    if (!blockId) return;
    const isToggleBlockClick = event.shiftKey && (event.metaKey || event.altKey);
    if (isToggleBlockClick) {
      event.preventDefault();
      event.stopPropagation();
      const nextSelection = new Set(getLiveSelectedBlockIds());
      if (nextSelection.has(blockId)) nextSelection.delete(blockId);
      else nextSelection.add(blockId);
      const orderedIds = getOrderedBlockIds();
      const nextIds = [...nextSelection]
        .sort((first, second) => orderedIds.indexOf(first) - orderedIds.indexOf(second));
      if (nextIds.length > 0) {
        setBlockSelectionState(nextIds, blockSelectionAnchorRef.current ?? blockId);
        setFocusedBlockId(blockId);
      } else {
        clearBlockSelection();
      }
      return;
    }
    if (event.shiftKey && blockSelectionModeRef.current) {
      event.preventDefault();
      selectBlockRange(blockSelectionAnchorRef.current ?? selectedBlockIds[0] ?? blockId, blockId);
      return;
    }
    clearBlockSelection();
    setFocusedBlockId(blockId);
    blockSelectionAnchorRef.current = blockId;
  };

  const syncEditorSelection = () => {
    let cursorBlockId: string | null = null;
    try {
      cursorBlockId = editor.getTextCursorPosition().block.id;
    } catch {
      cursorBlockId = null;
    }
    if (cursorBlockId) setFocusedBlockId(cursorBlockId);

    const selection = editor.getSelection();
    const selectionType = editor.prosemirrorView.state.selection.constructor.name;
    const isNodeSelection = selectionType === "NodeSelection" || selectionType === "MultipleNodeSelection";
    if (blockSelectionModeRef.current || isNodeSelection) {
      const ids = selection?.blocks.map((block) => block.id)
        ?? (cursorBlockId ? [cursorBlockId] : []);
      if (ids.length > 0) {
        setBlockSelectionState(ids, blockSelectionAnchorRef.current ?? ids[0]);
      }
    } else {
      setSelectedBlockIds([]);
      setIsBlockSelectionMode(false);
    }
  };

  const moveBlocksByIds = (blockIds: string[], direction: "up" | "down") => {
    if (pageSettings.lockPage || blockIds.length === 0) return;
    const rootIds = editor.document.map((block) => block.id);
    const selected = normalizeBlockIds(blockIds)
      .filter((id) => rootIds.includes(id))
      .sort((first, second) => rootIds.indexOf(first) - rootIds.indexOf(second));
    if (selected.length === 0) {
      clearBlockSelection();
      return;
    }
    const boundaryIndex = direction === "up"
      ? rootIds.indexOf(selected[0]) - 1
      : rootIds.indexOf(selected[selected.length - 1]) + 1;
    const targetBlockId = rootIds[boundaryIndex];
    if (!targetBlockId) {
      setNotice("이 위치에서는 블록을 더 이동할 수 없어요");
      return;
    }
    moveBlocksToDropTarget(selected, targetBlockId, direction === "up" ? "before" : "after");
  };

  const moveSelectedBlocks = (direction: "up" | "down") => {
    moveBlocksByIds(selectedBlockIds, direction);
  };

  const duplicateBlocks = (blockIds: string[]) => {
    if (pageSettings.lockPage) return;
    const normalizedIds = normalizeBlockIds(blockIds);
    type EditorBlock = NonNullable<ReturnType<typeof editor.getBlock>>;
    const blocks = normalizedIds
      .map((blockId) => editor.getBlock(blockId))
      .filter((block): block is EditorBlock => block !== undefined);
    const referenceBlock = blocks.at(-1);
    if (!referenceBlock) return;
    const cloneBlock = (block: EditorBlock): PartialBlock => ({
      type: block.type,
      props: block.type === "database"
        ? { ...block.props, databaseId: makeId("database") }
        : block.props,
      content: block.content,
      children: block.children.map((child) => cloneBlock(child as EditorBlock)),
    } as unknown as PartialBlock);
    const insertedBlocks = editor.insertBlocks(
      blocks.map((block) => cloneBlock(block)),
      referenceBlock.id,
      "after",
    );
    if (insertedBlocks.length > 0) {
      const insertedIds = insertedBlocks.map((block) => block.id);
      setBlockSelectionState(insertedIds, insertedIds[0]);
      setFocusedBlockId(insertedIds[0]);
    }
    setContextMenu(null);
    setNotice(`${blocks.length}개 블록을 복제했어요`);
  };

  const removeBlocks = (blockIds: string[]) => {
    if (pageSettings.lockPage) return;
    const normalizedIds = normalizeBlockIds(blockIds);
    if (normalizedIds.length === 0) return;
    const everyRootBlockSelected = editor.document.every((block) => normalizedIds.includes(block.id));
    if (everyRootBlockSelected) {
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "" }]);
    } else {
      editor.removeBlocks(normalizedIds);
    }
    clearBlockSelection();
    setPendingBlockDeletion(null);
    setContextMenu(null);
    setNotice(`${normalizedIds.length}개 블록을 삭제했어요 · ⌘/Ctrl+Z로 되돌릴 수 있어요`);
    window.requestAnimationFrame(() => editor.focus());
  };

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const isEditorEvent = Boolean(target.closest(".bn-editor"));
    if (pageSettings.lockPage || (!isEditorEvent && !blockSelectionModeRef.current)) return;
    const hasPrimaryModifier = event.metaKey || event.ctrlKey;
    let cursorBlockId: string | undefined;
    try {
      cursorBlockId = editor.getTextCursorPosition().block.id;
    } catch {
      cursorBlockId = undefined;
    }
    const blockId = getEventBlockId(event.target) ?? cursorBlockId ?? focusedBlockId ?? undefined;

    if (event.key === "Escape") {
      if (document.querySelector(".bn-suggestion-menu")) return;
      event.preventDefault();
      event.stopPropagation();
      if (blockSelectionModeRef.current) {
        clearBlockSelection();
      } else if (blockId) {
        selectSingleBlock(blockId);
      }
      return;
    }
    if (hasPrimaryModifier && event.key.toLowerCase() === "a" && blockId && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      selectSingleBlock(blockId);
      return;
    }
    if (!blockSelectionModeRef.current || selectedBlockIds.length === 0) return;

    if ((event.key === "Backspace" || event.key === "Delete") && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      removeBlocks(selectedBlockIds);
      return;
    }
    if (hasPrimaryModifier && event.key.toLowerCase() === "d") {
      event.preventDefault();
      event.stopPropagation();
      duplicateBlocks(selectedBlockIds);
      return;
    }
    if (hasPrimaryModifier && event.key === "/") {
      event.preventDefault();
      event.stopPropagation();
      const targetId = selectedBlockIds[0];
      const target = editorContextRef.current?.querySelector<HTMLElement>(
        `[data-node-type='blockContainer'][data-id="${CSS.escape(targetId)}"]`,
      );
      const rect = target?.getBoundingClientRect();
      if (rect) {
        setContextMenu({
          kind: "block",
          blockId: targetId,
          x: Math.min(rect.left + 24, window.innerWidth - 228),
          y: Math.min(rect.top + 24, window.innerHeight - 260),
        });
      }
      return;
    }
    if (hasPrimaryModifier && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      event.stopPropagation();
      moveSelectedBlocks(event.key === "ArrowUp" ? "up" : "down");
      return;
    }
    if (event.key === "Enter" && selectedBlockIds[0]) {
      event.preventDefault();
      event.stopPropagation();
      const targetId = selectedBlockIds[0];
      clearBlockSelection();
      editor.setTextCursorPosition(targetId, "start");
      editor.focus();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      const orderedIds = getOrderedBlockIds();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const edgeId = direction < 0 ? selectedBlockIds[0] : selectedBlockIds[selectedBlockIds.length - 1];
      const nextId = orderedIds[orderedIds.indexOf(edgeId) + direction];
      if (!nextId) return;
      if (event.shiftKey) {
        selectBlockRange(blockSelectionAnchorRef.current ?? selectedBlockIds[0], nextId);
      } else {
        selectSingleBlock(nextId);
      }
      editorContextRef.current
        ?.querySelector<HTMLElement>(`[data-node-type='blockContainer'][data-id="${CSS.escape(nextId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  };

  useEffect(() => {
    if (selectedBlockIds.length === 0) return;
    const liveBlockIds = getLiveSelectedBlockIds();
    if (liveBlockIds.length === selectedBlockIds.length) return;
    if (liveBlockIds.length > 0) {
      setBlockSelectionState(liveBlockIds, liveBlockIds[0]);
    } else {
      clearBlockSelection();
    }
  }, [pages, selectedBlockIds]);

  useLayoutEffect(() => {
    const root = editorContextRef.current;
    if (!root) return;
    const editorRoot = root.querySelector<HTMLElement>(".bn-editor");
    const scrollArea = editorStageRef.current;
    let frame = 0;

    const updatePosition = () => {
      const rects = selectedBlockIds
        .map((blockId) => {
          const overlay = blockSelectionOverlayRefs.current.get(blockId);
          const element = root.querySelector<HTMLElement>(
            `[data-node-type='blockContainer'][data-id="${CSS.escape(blockId)}"]`,
          );
          if (!element || !overlay) {
            overlay?.removeAttribute("data-positioned");
            return null;
          }
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            overlay.removeAttribute("data-positioned");
            return null;
          }
          const selectionGap = Math.min(1, rect.height / 4);
          const selectionRect = {
            left: rect.left - 7,
            top: rect.top + selectionGap,
            width: rect.width + 14,
            height: Math.max(2, rect.height - selectionGap * 2),
          };
          overlay.style.left = `${selectionRect.left}px`;
          overlay.style.top = `${selectionRect.top}px`;
          overlay.style.width = `${selectionRect.width}px`;
          overlay.style.height = `${selectionRect.height}px`;
          overlay.dataset.positioned = "true";
          return selectionRect;
        })
        .filter((rect): rect is BlockSelectionMarquee => Boolean(rect));

      const toolbar = blockSelectionToolbarRef.current;
      if (!toolbar || rects.length === 0) {
        toolbar?.removeAttribute("data-positioned");
        return;
      }
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.left + rect.width));
      toolbar.style.left = `${Math.min(window.innerWidth - 12, right)}px`;
      toolbar.style.top = `${Math.max(58, top - 42)}px`;
      toolbar.dataset.positioned = "true";
    };

    const schedulePosition = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updatePosition();
      });
    };
    const resizeObserver = new ResizeObserver(schedulePosition);
    const mutationObserver = new MutationObserver(schedulePosition);
    resizeObserver.observe(root);
    if (editorRoot) mutationObserver.observe(editorRoot, { childList: true, subtree: true, characterData: true });
    scrollArea?.addEventListener("scroll", updatePosition, { passive: true });
    window.addEventListener("resize", schedulePosition);
    updatePosition();
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      scrollArea?.removeEventListener("scroll", updatePosition);
      window.removeEventListener("resize", schedulePosition);
    };
  }, [currentPageId, selectedBlockIds]);

  useEffect(() => {
    document.documentElement.classList.toggle("is-nodi-block-dragging", isBlockDragging);
    return () => document.documentElement.classList.remove("is-nodi-block-dragging");
  }, [isBlockDragging]);

  useEffect(() => {
    if (!blockSelectionActionMenu) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest(".block-selection-action-menu, .block-selection-menu-button")) return;
      setBlockSelectionActionMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBlockSelectionActionMenu(null);
    };
    const closeOnViewportChange = () => setBlockSelectionActionMenu(null);
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [blockSelectionActionMenu]);

  useEffect(() => {
    clearBlockSelection();
    setFocusedBlockId(null);
  }, [currentPageId]);

  const openSidebarContextMenu = (
    event: ReactMouseEvent,
    target: { kind: "page"; pageId: string } | { kind: "folder"; folderId: string },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const x = Math.min(Math.max(event.clientX, 10), window.innerWidth - 264);
    const y = Math.min(Math.max(event.clientY, 10), window.innerHeight - 410);
    setSidebarCreateMenuOpen(false);
    setContextMenu(null);
    setSidebarContextMenu({ ...target, x, y } as SidebarContextMenuState);
  };

  const openContextMenu = (event: ReactMouseEvent, menu: ContextMenuState["kind"], blockId?: string) => {
    event.preventDefault();
    const x = Math.min(Math.max(event.clientX, 12), window.innerWidth - 228);
    const y = Math.min(Math.max(event.clientY, 12), window.innerHeight - 260);
    setRightPanel(null);
    setContextMenu(menu === "block" && blockId ? { kind: "block", x, y, blockId } : { kind: "page", x, y });
  };

  const openEditorContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const blockElement = (event.target as HTMLElement).closest<HTMLElement>("[data-node-type='blockContainer']");
    const blockId = blockElement?.dataset.id;
    if (!blockId) {
      openContextMenu(event, "page");
      return;
    }
    const clickedInsideSelection = blockSelectionModeRef.current && selectedBlockIds.includes(blockId);
    if (!clickedInsideSelection) {
      try {
        editor.setTextCursorPosition(blockId, "end");
        clearBlockSelection();
        setFocusedBlockId(blockId);
      } catch {
        // The selected block may have been replaced between pointer events.
      }
    }
    event.stopPropagation();
    openContextMenu(event, "block", blockId);
  };

  const addBlockAfter = () => {
    if (contextMenu?.kind !== "block" || pageSettings.lockPage) return;
    const [insertedBlock] = editor.insertBlocks([{ type: "paragraph", content: "" }], contextMenu.blockId, "after");
    editor.setTextCursorPosition(insertedBlock.id, "start");
    editor.focus();
    setContextMenu(null);
    setNotice("새 블록을 추가했어요");
  };

  const duplicateBlock = () => {
    if (contextMenu?.kind !== "block" || pageSettings.lockPage) return;
    const targetIds = blockSelectionModeRef.current && selectedBlockIds.includes(contextMenu.blockId)
      ? selectedBlockIds
      : [contextMenu.blockId];
    if (!editor.getBlock(contextMenu.blockId)) {
      setContextMenu(null);
      setNotice("블록을 찾을 수 없어요");
      return;
    }
    duplicateBlocks(targetIds);
  };

  const moveContextBlock = (direction: "up" | "down") => {
    if (contextMenu?.kind !== "block" || pageSettings.lockPage) return;
    const targetIds = blockSelectionModeRef.current && selectedBlockIds.includes(contextMenu.blockId)
      ? selectedBlockIds
      : [contextMenu.blockId];
    moveBlocksByIds(targetIds, direction);
    setContextMenu(null);
  };

  const requestBlockDeletion = () => {
    if (contextMenu?.kind !== "block" || pageSettings.lockPage) return;
    const targetIds = blockSelectionModeRef.current && selectedBlockIds.includes(contextMenu.blockId)
      ? selectedBlockIds
      : [contextMenu.blockId];
    setPendingBlockDeletion(targetIds);
    setContextMenu(null);
  };

  const deleteBlock = () => {
    if (!pendingBlockDeletion || pageSettings.lockPage) return;
    removeBlocks(pendingBlockDeletion);
  };

  const runSelectionToolbarPointerAction = (
    event: ReactPointerEvent<HTMLButtonElement>,
    action: () => void,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  const runSelectionToolbarKeyboardAction = (
    event: ReactMouseEvent<HTMLButtonElement>,
    action: () => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.detail !== 0) return;
    action();
  };

  const currentPage = pages[currentPageId] ?? rootPage;
  const parentPage = currentPage.parentId ? pages[currentPage.parentId] : null;
  const folderChildren = (parentId: string | null) => Object.values(folders)
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  const folderPages = (folderId: string) => Object.values(pages)
    .filter((page) => page.id !== ROOT_PAGE_ID && page.folderId === folderId)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  const sidebarItems = (parentId: string | null) => getSidebarOrderedItems(pages, folders, parentId);
  const rootSidebarItems = sidebarItems(null);
  const folderContentCount = (folderId: string, visited = new Set<string>()): number => {
    if (visited.has(folderId)) return 0;
    const nextVisited = new Set(visited).add(folderId);
    return folderPages(folderId).length
      + folderChildren(folderId).reduce(
        (count, childFolder) => count + 1 + folderContentCount(childFolder.id, nextVisited),
        0,
      );
  };
  const personalPageCount = Object.keys(pages).length - 1;
  const liveSelectedBlockIds = getLiveSelectedBlockIds();
  type LiveEditorBlock = NonNullable<ReturnType<typeof editor.getBlock>>;
  const liveSelectedBlocks = liveSelectedBlockIds
    .map((blockId) => editor.getBlock(blockId))
    .filter((block): block is LiveEditorBlock => block !== undefined);
  const canTransformSelectedBlocks = liveSelectedBlocks.length > 0
    && liveSelectedBlocks.every((block) => CONVERTIBLE_BLOCK_TYPES.has(block.type as typeof BLOCK_TRANSFORM_OPTIONS[number]["type"]));
  const canColorSelectedBlocks = liveSelectedBlocks.length > 0
    && liveSelectedBlocks.every((block) => "textColor" in block.props && "backgroundColor" in block.props);
  const selectedTransformKeys = liveSelectedBlocks.map((block) => (
    block.type === "heading"
      ? `heading-${String((block.props as { level?: number }).level ?? 1)}`
      : block.type
  ));
  const selectedTransformKey = selectedTransformKeys.length > 0
    && selectedTransformKeys.every((key) => key === selectedTransformKeys[0])
    ? selectedTransformKeys[0]
    : null;
  const getSharedSelectedColor = (property: "textColor" | "backgroundColor"): BlockColorName | null => {
    const values = liveSelectedBlocks.map((block) => String((block.props as Record<string, unknown>)[property] ?? "default"));
    const value = values[0];
    if (!value || !values.every((candidate) => candidate === value)) return null;
    return BLOCK_COLOR_OPTIONS.some((option) => option.value === value) ? value as BlockColorName : null;
  };
  const selectedTextColor = getSharedSelectedColor("textColor");
  const selectedBackgroundColor = getSharedSelectedColor("backgroundColor");
  const toggleBlockSelectionActionMenu = (
    kind: BlockSelectionActionMenu["kind"],
    trigger: HTMLButtonElement,
  ) => {
    const canOpen = kind === "transform" ? canTransformSelectedBlocks : canColorSelectedBlocks;
    if (!canOpen || pageSettings.lockPage) {
      setNotice("텍스트 블록을 선택했을 때 사용할 수 있어요");
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const menuWidth = kind === "transform" ? 232 : 288;
    const estimatedHeight = kind === "transform" ? 326 : 224;
    const x = Math.min(Math.max(12, rect.right - menuWidth), window.innerWidth - menuWidth - 12);
    const y = rect.bottom + estimatedHeight + 8 <= window.innerHeight
      ? rect.bottom + 6
      : Math.max(12, rect.top - estimatedHeight - 6);
    setBlockSelectionActionMenu((current) => current?.kind === kind ? null : { kind, x, y });
  };
  const transformSelectedBlocks = (option: typeof BLOCK_TRANSFORM_OPTIONS[number]) => {
    if (!canTransformSelectedBlocks || pageSettings.lockPage) return;
    editor.transact(() => {
      liveSelectedBlocks.forEach((block) => {
        const update = "props" in option
          ? { type: option.type, props: { ...option.props } }
          : { type: option.type };
        editor.updateBlock(block, update as never);
      });
    });
    setBlockSelectionState(liveSelectedBlockIds, liveSelectedBlockIds[0]);
    setBlockSelectionActionMenu(null);
    setNotice(`${liveSelectedBlockIds.length}개 블록을 ${option.label}(으)로 전환했어요`);
  };
  const colorSelectedBlocks = (
    property: "textColor" | "backgroundColor",
    color: BlockColorName,
    label: string,
  ) => {
    if (!canColorSelectedBlocks || pageSettings.lockPage) return;
    editor.transact(() => {
      liveSelectedBlocks.forEach((block) => {
        editor.updateBlock(block, { props: { [property]: color } } as never);
      });
    });
    setBlockSelectionState(liveSelectedBlockIds, liveSelectedBlockIds[0]);
    setBlockSelectionActionMenu(null);
    setNotice(`${liveSelectedBlockIds.length}개 블록의 ${label}을 변경했어요`);
  };

  const renderSidebarPage = (page: StoredPage, nested = false): ReactNode => {
    const pageMoveDropTarget = sidebarPageDropTarget?.kind === "page" && sidebarPageDropTarget.pageId === page.id
      ? sidebarPageDropTarget.placement
      : null;
    const folderMoveDropTarget = sidebarFolderDropTarget?.kind === "page" && sidebarFolderDropTarget.pageId === page.id
      ? sidebarFolderDropTarget.placement
      : null;
    return (
      <NavItem
        key={page.id}
        icon={<span className="nav-emoji">{page.settings.icon || "📄"}</span>}
        label={page.title || "제목 없음"}
        active={currentPageId === page.id}
        nested={nested}
        editing={sidebarRename?.kind === "page" && sidebarRename.id === page.id}
        draggable
        dragging={sidebarDraggedPageId === page.id}
        dropPlacement={pageMoveDropTarget ?? folderMoveDropTarget}
        pageId={page.id}
        onClick={() => openSidebarPage(page.id)}
        onContextMenu={(event) => openSidebarContextMenu(event, { kind: "page", pageId: page.id })}
        onRename={(nextTitle) => renameSidebarItem({ kind: "page", id: page.id }, nextTitle)}
        onPointerDown={(event) => beginSidebarPagePointerDrag(event, page.id)}
        onPointerMove={updateSidebarPagePointerDrag}
        onPointerUp={finishSidebarPagePointerDrag}
        onPointerCancel={finishSidebarPagePointerDrag}
        onMouseUp={finishSidebarPageMouseDrag}
      />
    );
  };

  const renderSidebarFolder = (folder: StoredFolder, depth = 0): ReactNode => {
    const childItems = sidebarItems(folder.id);
    const folderDropPlacement = sidebarFolderDropTarget?.kind === "folder"
      && sidebarFolderDropTarget.folderId === folder.id
      ? sidebarFolderDropTarget.placement
      : null;
    const pageDropPlacement = sidebarPageDropTarget?.kind === "folder"
      && sidebarPageDropTarget.folderId === folder.id
      ? sidebarPageDropTarget.placement
      : null;
    const folderIsEditing = sidebarRename?.kind === "folder" && sidebarRename.id === folder.id;
    const hasChildren = childItems.length > 0;
    return (
      <div
        className={`sidebar-folder ${depth > 0 ? "is-nested-folder" : ""} ${pageDropPlacement ? `is-page-drop-${pageDropPlacement}` : ""} ${folderDropPlacement ? `is-folder-drop-${folderDropPlacement}` : ""} ${sidebarDraggedFolderId === folder.id ? "is-folder-dragging" : ""}`}
        key={folder.id}
        data-sidebar-folder-id={folder.id}
        data-sidebar-folder-depth={depth}
      >
        <div
          role="button"
          tabIndex={0}
          aria-expanded={!folder.collapsed}
          data-sidebar-folder-row-id={folder.id}
          className={`sidebar-folder-row is-folder-draggable ${folder.collapsed ? "is-collapsed" : ""} ${folderIsEditing ? "is-editing" : ""}`}
          onClick={() => {
            if (sidebarSuppressClickRef.current) {
              sidebarSuppressClickRef.current = false;
              return;
            }
            toggleFolder(folder.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") toggleFolder(folder.id);
          }}
          onContextMenu={(event) => openSidebarContextMenu(event, { kind: "folder", folderId: folder.id })}
          onPointerDown={folderIsEditing ? undefined : (event) => beginSidebarFolderPointerDrag(event, folder.id)}
          onPointerMove={folderIsEditing ? undefined : updateSidebarFolderPointerDrag}
          onPointerUp={folderIsEditing ? undefined : finishSidebarFolderPointerDrag}
          onPointerCancel={folderIsEditing ? undefined : finishSidebarFolderPointerDrag}
          onMouseUp={folderIsEditing ? undefined : finishSidebarFolderMouseDrag}
        >
          <ChevronRight size={14} />
          <SidebarFolderIcon open={!folder.collapsed} />
          {folderIsEditing
            ? <InlineNavRename
                value={folder.title}
                ariaLabel="폴더 이름"
                onCancel={() => setSidebarRename(null)}
                onSubmit={(nextTitle) => renameSidebarItem({ kind: "folder", id: folder.id }, nextTitle)}
              />
            : <span>{folder.title}</span>}
          <em>{folderContentCount(folder.id)}</em>
        </div>
        {!folder.collapsed && (
          <div className="sidebar-folder-pages">
            {childItems.map((item) => (
              item.kind === "folder"
                ? renderSidebarFolder(item.folder, depth + 1)
                : renderSidebarPage(item.page, true)
            ))}
            {!hasChildren && (
              <button className="empty-folder-action" type="button" onClick={() => createChildPage("sidebar", folder.id)}>
                <Plus size={13} /> 페이지 추가
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="app-shell" data-theme={appTheme}>
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="워크스페이스 메뉴">
        <div className="workspace-head">
          <button className="workspace-switcher" type="button">
            <span className="workspace-mark">N</span>
            <span className="workspace-name">나의 공간</span>
            <ChevronsUpDown size={14} />
          </button>
          <button className="icon-button quiet" type="button" aria-label="사이드바 닫기" onClick={() => setSidebarOpen(false)}>
            <PanelLeftClose size={18} />
          </button>
        </div>

        <button className="search-trigger" type="button" onClick={() => titleInputRef.current?.focus()}>
          <Search size={16} />
          <span>검색</span>
          <kbd>⌘ K</kbd>
        </button>

        <nav className="main-nav">
          <NavItem icon={<Home size={17} />} label="홈" />
          <NavItem icon={<Inbox size={17} />} label="받은 편지함" count="3" />
          <NavItem icon={<LayoutGrid size={17} />} label="모든 페이지" />
        </nav>

        <div className="nav-section">
          <div className="section-label"><span>즐겨찾기</span><button type="button" aria-label="즐겨찾기 추가"><Plus size={15} /></button></div>
          <NavItem
            icon={<Star size={16} fill="currentColor" />}
            label={pages[ROOT_PAGE_ID]?.title || "빠른 메모"}
            active={currentPageId === ROOT_PAGE_ID}
            onClick={() => openPage(ROOT_PAGE_ID)}
          />
          <NavItem icon={<BookOpen size={16} />} label="독서 노트" />
        </div>

        <div className={`nav-section pages-section ${sidebarFolderDropTarget?.kind === "root" ? "is-folder-root-drop-target" : ""}`}>
          <div className="section-label">
            <span>개인 페이지</span>
            <div className="sidebar-create-wrap">
              <button
                type="button"
                aria-label="페이지 및 폴더 추가"
                aria-expanded={sidebarCreateMenuOpen}
                onClick={() => {
                  setSidebarContextMenu(null);
                  setSidebarCreateMenuOpen((open) => !open);
                }}
              >
                <Plus size={15} />
              </button>
              {sidebarCreateMenuOpen && (
                <div className="sidebar-create-menu sidebar-floating-menu" role="menu">
                  <span>새로 만들기</span>
                  <button type="button" role="menuitem" onClick={() => createChildPage("sidebar", null)}>
                    <FileText size={15} />
                    <span><strong>페이지</strong><small>현재 페이지 아래에 추가</small></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => createFolder(null)}>
                    <FolderPlus size={15} />
                    <span><strong>폴더</strong><small>페이지를 묶어 정리</small></span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {personalPageCount === 0 && Object.keys(folders).length === 0
            ? <span className="empty-page-nav">+ 버튼이나 /페이지로 시작해보세요</span>
            : <>
              <div
                className={`sidebar-unfiled-pages ${sidebarDraggedPageId ? "is-drag-active" : ""} ${sidebarPageDropTarget?.kind === "unfiled" ? "is-drop-target" : ""}`}
              >
                {rootSidebarItems.map((item) => (
                  item.kind === "folder"
                    ? renderSidebarFolder(item.folder)
                    : renderSidebarPage(item.page)
                ))}
              </div>
            </>}
        </div>

        <div className="sidebar-footer">
          <button type="button" className="footer-nav"><Settings size={16} /> 설정</button>
          <button
            type="button"
            className="footer-nav theme-toggle"
            role="switch"
            aria-checked={isDarkMode}
            aria-label={isDarkMode ? "라이트 모드로 전환" : "다크 모드로 전환"}
            onClick={() => setAppTheme((theme) => theme === "dark" ? "light" : "dark")}
          >
            {isDarkMode ? <Sun size={16} /> : <Moon size={16} />}
            <span>다크 모드</span>
            <span className="theme-toggle-track" aria-hidden="true"><span /></span>
          </button>
          <div className="profile-row">
            <div className="avatar">L</div>
            <div><strong>Lee</strong><span>Free plan</span></div>
            <MoreHorizontal size={17} />
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && <button className="icon-button" type="button" aria-label="사이드바 열기" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>}
            {parentPage && (
              <button className="crumb-back" type="button" aria-label={`${parentPage.title} 페이지로 돌아가기`} onClick={() => openPage(parentPage.id)}>
                <ChevronLeft size={17} />
              </button>
            )}
            <div className="crumb">
              <span className="crumb-icon">{currentPage.settings.icon || "✦"}</span>
              <span>{parentPage?.title || "개인"}</span>
              <ChevronDown size={14} />
              <span className="crumb-divider">/</span>
              <span className="muted">{currentPage.title || "제목 없음"}</span>
            </div>
          </div>
          <div className="topbar-actions">
            <span className="save-state"><Cloud size={15} /> {savedAt}</span>
            <button className={`icon-button ${isFavorite ? "is-favorite" : ""}`} type="button" aria-label="즐겨찾기" onClick={() => setIsFavorite((value) => !value)}><Star size={18} fill={isFavorite ? "currentColor" : "none"} /></button>
            <button className="icon-button" type="button" aria-label="공유" onClick={() => setRightPanel("share")}><Share2 size={18} /></button>
            <button className="page-settings-trigger" type="button" aria-label="페이지 설정" onClick={() => setPageSettingsOpen(true)}><Settings2 size={16} /> 설정</button>
            <button className="more-button" type="button" aria-label="더 보기" onClick={exportJson}><Download size={16} /> 내보내기</button>
          </div>
        </header>

        <div className="editor-scroll-area">
        <section ref={editorStageRef} className={`editor-stage ${pageSettings.fullWidth ? "is-wide" : ""} ${pageSettings.smallText ? "uses-small-text" : ""}`} onPointerDownCapture={handleEditorStagePointerDown}>
          {isArchived && <div className="archive-banner"><Archive size={15} /> 이 페이지는 보관됨 상태입니다.<button type="button" onClick={toggleArchive}>복원</button></div>}
          <div className={`cover cover--${pageSettings.cover}`} aria-hidden="true"><div className="cover-orb orb-one" /><div className="cover-orb orb-two" /><div className="cover-grid" /></div>
          <article className={`note-page ${pageSettings.fullWidth ? "page-wide" : ""}`} onContextMenu={(event) => openContextMenu(event, "page")}>
            <button className="page-emoji" type="button" aria-label="페이지 아이콘 설정" onClick={() => setPageSettingsOpen(true)}>{pageSettings.icon}</button>
            <input
              ref={titleInputRef}
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="페이지 제목"
              placeholder="제목 없음"
              disabled={pageSettings.lockPage}
            />
            {pageSettings.showProperties && <div className="page-properties" aria-label="페이지 속성">
              <div className="property property-updated"><Clock3 size={14} /><span>수정</span><strong>지금</strong></div>
              <div className="property property-status"><Hash size={14} /><span>상태</span><Select disabled={pageSettings.lockPage} value={pageSettings.status} onValueChange={(value) => setPageSettings({ ...pageSettings, status: value as PageSettings["status"] })} options={pageStatusOptions} ariaLabel="페이지 상태" className={`status-select ${pageSettings.status === "초안" ? "status-waiting" : pageSettings.status === "진행 중" ? "status-progress" : "status-done"}`} /></div>
              <div className="property property-tags"><Hash size={14} /><span>태그</span><TagPicker value={pageSettings.tags} options={DEFAULT_TAG_OPTIONS} disabled={pageSettings.lockPage} compact onChange={(tags) => setPageSettings({ ...pageSettings, tags })} /></div>
              <div className="property property-date"><Clock3 size={14} /><span>날짜</span><DatePicker compact disabled={pageSettings.lockPage} value={pageSettings.date} onChange={(date) => setPageSettings({ ...pageSettings, date })} ariaLabel="페이지 날짜" /></div>
              <span className="page-property-separator" aria-hidden="true" />
              <button className="add-property" type="button" onClick={() => setPageSettingsOpen(true)}><Plus size={14} /> 속성 설정</button>
            </div>}
            <div className="divider" />
            <div
              ref={editorContextRef}
              tabIndex={-1}
              className={`block-editor-context-target ${isBlockSelectionMode ? "has-block-selection" : ""} ${isBlockDragging ? "is-block-dragging" : ""} ${blockSelectionMarquee ? "is-block-marquee-selecting" : ""}`}
              onContextMenu={openEditorContextMenu}
              onFocusCapture={handleEditorFocus}
              onClickCapture={handleEditorClick}
              onPointerDownCapture={handleEditorPointerDown}
              onPointerMoveCapture={handleEditorPointerMove}
              onPointerUpCapture={finishEditorPointerInteraction}
              onPointerCancelCapture={finishEditorPointerInteraction}
              onKeyDownCapture={handleEditorKeyDown}
            >
              <div className="block-selection-gutter is-left" aria-hidden="true" />
              <div className="block-selection-gutter is-right" aria-hidden="true" />
              {selectedBlockIds.map((blockId) => (
                <div
                  key={blockId}
                  ref={(element) => {
                    if (element) blockSelectionOverlayRefs.current.set(blockId, element);
                    else blockSelectionOverlayRefs.current.delete(blockId);
                  }}
                  className="block-selected-overlay"
                  aria-hidden="true"
                />
              ))}
              {blockDropIndicator && (
                <div
                  className="block-drop-indicator"
                  aria-hidden="true"
                  style={{
                    left: blockDropIndicator.left,
                    top: blockDropIndicator.top,
                    width: blockDropIndicator.width,
                  }}
                />
              )}
              {blockSelectionMarquee && (
                <div
                  className="block-selection-marquee"
                  aria-hidden="true"
                  style={{
                    left: blockSelectionMarquee.left,
                    top: blockSelectionMarquee.top,
                    width: blockSelectionMarquee.width,
                    height: blockSelectionMarquee.height,
                  }}
                >
                  {liveSelectedBlockIds.length > 0 && <span>{liveSelectedBlockIds.length}개 블록</span>}
                </div>
              )}
              {isBlockSelectionMode
                && liveSelectedBlockIds.length > 0
                && !blockSelectionMarquee
                && !isBlockDragging && (
                <div
                  ref={blockSelectionToolbarRef}
                  className="block-selection-toolbar"
                  role="toolbar"
                  aria-label={`${liveSelectedBlockIds.length}개 블록 선택됨`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <span className="block-selection-count">
                    <GripVertical size={14} />
                    {liveSelectedBlockIds.length}개 블록
                  </span>
                  <span className="block-selection-hint">선택한 블록을 함께 편집</span>
                  <span className="block-selection-divider" aria-hidden="true" />
                  <button
                    type="button"
                    aria-label="선택한 블록 위로 이동"
                    title="위로 이동 (⌘/Ctrl+Shift+↑)"
                    onPointerDown={(event) => runSelectionToolbarPointerAction(event, () => moveSelectedBlocks("up"))}
                    onClick={(event) => runSelectionToolbarKeyboardAction(event, () => moveSelectedBlocks("up"))}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label="선택한 블록 아래로 이동"
                    title="아래로 이동 (⌘/Ctrl+Shift+↓)"
                    onPointerDown={(event) => runSelectionToolbarPointerAction(event, () => moveSelectedBlocks("down"))}
                    onClick={(event) => runSelectionToolbarKeyboardAction(event, () => moveSelectedBlocks("down"))}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label="선택한 블록 복제"
                    title="복제 (⌘/Ctrl+D)"
                    onPointerDown={(event) => runSelectionToolbarPointerAction(event, () => duplicateBlocks(liveSelectedBlockIds))}
                    onClick={(event) => runSelectionToolbarKeyboardAction(event, () => duplicateBlocks(liveSelectedBlockIds))}
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    className="is-danger"
                    type="button"
                    aria-label="선택한 블록 삭제"
                    title="삭제"
                    onPointerDown={(event) => runSelectionToolbarPointerAction(event, () => setPendingBlockDeletion(liveSelectedBlockIds))}
                    onClick={(event) => runSelectionToolbarKeyboardAction(event, () => setPendingBlockDeletion(liveSelectedBlockIds))}
                  >
                    <Trash2 size={15} />
                  </button>
                  <button
                    className="block-selection-menu-button"
                    type="button"
                    aria-label="선택한 블록 전환"
                    aria-expanded={blockSelectionActionMenu?.kind === "transform"}
                    title={canTransformSelectedBlocks ? "블록 전환" : "텍스트 블록에서 사용할 수 있어요"}
                    disabled={pageSettings.lockPage || !canTransformSelectedBlocks}
                    onPointerDown={(event) => runSelectionToolbarPointerAction(event, () => toggleBlockSelectionActionMenu("transform", event.currentTarget))}
                    onClick={(event) => runSelectionToolbarKeyboardAction(event, () => toggleBlockSelectionActionMenu("transform", event.currentTarget))}
                  >
                    <Repeat2 size={15} />
                    <span>전환</span>
                    <ChevronDown size={12} />
                  </button>
                  <button
                    className="block-selection-menu-button"
                    type="button"
                    aria-label="선택한 블록 색상 변경"
                    aria-expanded={blockSelectionActionMenu?.kind === "color"}
                    title={canColorSelectedBlocks ? "글자 및 배경 색상" : "색상을 지원하는 블록에서 사용할 수 있어요"}
                    disabled={pageSettings.lockPage || !canColorSelectedBlocks}
                    onPointerDown={(event) => runSelectionToolbarPointerAction(event, () => toggleBlockSelectionActionMenu("color", event.currentTarget))}
                    onClick={(event) => runSelectionToolbarKeyboardAction(event, () => toggleBlockSelectionActionMenu("color", event.currentTarget))}
                  >
                    <Palette size={15} />
                    <span>색상</span>
                    <ChevronDown size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label="블록 선택 해제"
                    title="선택 해제"
                    onPointerDown={(event) => runSelectionToolbarPointerAction(event, clearBlockSelection)}
                    onClick={(event) => runSelectionToolbarKeyboardAction(event, clearBlockSelection)}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              <BlockNoteView
                editor={editor}
                onChange={() => {
                  if (loadingPageRef.current) return;
                  updatePage(currentPageIdRef.current, {
                    blocks: editor.document as unknown as PartialBlock[],
                  });
                  setSavedAt("저장됨");
                }}
                onSelectionChange={syncEditorSelection}
                theme={appTheme}
                editable={!pageSettings.lockPage}
                slashMenu={false}
                data-theming-css-variables-demo
              >
                <SuggestionMenuController
                  triggerCharacter="/"
                  getItems={async (query) => filterSuggestionItems(
                    getNodiSlashMenuItems(editor, () => createChildPage("slash")),
                    query,
                  )}
                />
              </BlockNoteView>
            </div>

            <div className="editor-hint"><Command size={14} /> <span>빈 여백을 드래그해 여러 블록 선택 · <strong>Shift+↑↓</strong> 범위 확장 · <strong>⋮⋮</strong>로 함께 이동</span></div>
          </article>
        </section>
        <EditorScrollOverlay targetRef={editorStageRef} />
        </div>

      </main>

      {rightPanel && <QuickActionPanel type={rightPanel} pageLink={window.location.href} isPublic={pageSettings.publicAccess} onPublicChange={(publicAccess) => setPageSettings({ ...pageSettings, publicAccess })} onClose={() => setRightPanel(null)} onCopy={copyPageLink} onDraft={addDraft} />}
      {sidebarContextMenu && (
        <SidebarItemContextMenu
          menu={sidebarContextMenu}
          page={sidebarContextMenu.kind === "page" ? pages[sidebarContextMenu.pageId] : undefined}
          folder={sidebarContextMenu.kind === "folder" ? folders[sidebarContextMenu.folderId] : undefined}
          pages={pages}
          folders={folders}
          onClose={() => setSidebarContextMenu(null)}
          onOpenPage={(pageId) => {
            setSidebarContextMenu(null);
            openPage(pageId);
          }}
          onPreviewPage={(pageId) => {
            setSidebarContextMenu(null);
            setDrawerPageId(pageId);
          }}
          onRename={(rename) => {
            setSidebarContextMenu(null);
            setSidebarRename(rename);
          }}
          onReorderPage={reorderPage}
          onReorderFolder={reorderFolder}
          onMovePage={movePageToFolder}
          onToggleFolder={toggleFolder}
          onCreatePage={(folderId) => {
            setSidebarContextMenu(null);
            createChildPage("sidebar", folderId);
          }}
          onCreateFolder={(parentId) => createFolder(parentId)}
          onDeleteFolder={removeFolder}
          onDeletePage={(pageId) => {
            setSidebarContextMenu(null);
            setPendingPageDeletion(pageId);
          }}
        />
      )}
      {drawerPageId && pages[drawerPageId] && (
        <PagePreviewDrawer
          key={drawerPageId}
          page={pages[drawerPageId]}
          parentTitle={pages[pages[drawerPageId].parentId || ""]?.title}
          theme={appTheme}
          onClose={() => setDrawerPageId(null)}
          onOpenPage={() => openPage(drawerPageId)}
          onChange={(patch) => updatePage(drawerPageId, patch)}
        />
      )}

      {contextMenu && <NodiContextMenu
        menu={contextMenu}
        archived={isArchived}
        locked={pageSettings.lockPage}
        selectedBlockCount={contextMenu.kind === "block" && selectedBlockIds.includes(contextMenu.blockId)
          ? selectedBlockIds.length
          : 1}
        onAddBlock={addBlockAfter}
        onMoveBlock={moveContextBlock}
        onDuplicateBlock={duplicateBlock}
        onDeleteBlock={requestBlockDeletion}
        onOpenSettings={() => { setContextMenu(null); setPageSettingsOpen(true); }}
        onCopyLink={() => { setContextMenu(null); void copyPageLink(); }}
        onToggleArchive={() => { setContextMenu(null); toggleArchive(); }}
        onExport={() => { setContextMenu(null); exportJson(); }}
        onDeletePage={() => { setContextMenu(null); setPendingPageDeletion(currentPageId); }}
      />}

      {blockSelectionActionMenu && (
        <div
          className={`block-selection-action-menu is-${blockSelectionActionMenu.kind}`}
          role="menu"
          aria-label={blockSelectionActionMenu.kind === "transform" ? "블록 전환" : "블록 색상"}
          style={{ left: blockSelectionActionMenu.x, top: blockSelectionActionMenu.y }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {blockSelectionActionMenu.kind === "transform" ? <>
            <header>
              <strong>블록 전환</strong>
              <small>{liveSelectedBlockIds.length}개 블록에 적용</small>
            </header>
            <div className="block-transform-options">
              {BLOCK_TRANSFORM_OPTIONS.map((option) => {
                const Icon = option.icon;
                const isSelected = selectedTransformKey === option.key;
                return <button
                  key={option.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => transformSelectedBlocks(option)}
                >
                  <Icon size={16} />
                  <span>{option.label}</span>
                  {isSelected && <Check size={14} />}
                </button>;
              })}
            </div>
          </> : <>
            <header>
              <strong>색상</strong>
              <small>글자와 배경을 각각 설정</small>
            </header>
            <section className="block-color-section" aria-label="글자 색">
              <span>글자 색</span>
              <div>
                {BLOCK_COLOR_OPTIONS.map((option) => (
                  <button
                    key={`text-${option.value}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedTextColor === option.value}
                    aria-label={`글자 색 ${option.label}`}
                    title={`글자 색 ${option.label}`}
                    onClick={() => colorSelectedBlocks("textColor", option.value, "글자 색")}
                  >
                    <span className="block-color-swatch is-text" data-block-color={option.value}>A</span>
                    <span>{option.label}</span>
                    {selectedTextColor === option.value && <Check size={13} />}
                  </button>
                ))}
              </div>
            </section>
            <section className="block-color-section" aria-label="배경 색">
              <span>배경 색</span>
              <div>
                {BLOCK_COLOR_OPTIONS.map((option) => (
                  <button
                    key={`background-${option.value}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedBackgroundColor === option.value}
                    aria-label={`배경 색 ${option.label}`}
                    title={`배경 색 ${option.label}`}
                    onClick={() => colorSelectedBlocks("backgroundColor", option.value, "배경 색")}
                  >
                    <span className="block-color-swatch is-background" data-block-color={option.value}>A</span>
                    <span>{option.label}</span>
                    {selectedBackgroundColor === option.value && <Check size={13} />}
                  </button>
                ))}
              </div>
            </section>
          </>}
        </div>
      )}

      <div className="template-dock">
        <span className="dock-label">시작하기</span>
        <button type="button" onClick={() => applyTemplate("daily")}><span>☀️</span> 데일리 노트</button>
        <button type="button" onClick={() => applyTemplate("brainstorm")}><span>💡</span> 아이디어</button>
        <button type="button" onClick={() => { editor.focus(); setNotice("새 블록을 작성해보세요"); }}><FileText size={15} /> 빈 페이지</button>
      </div>

      <NodiTooltipLayer />
      {notice && <div className="toast"><Bell size={16} />{notice}<button type="button" onClick={() => setNotice(null)} aria-label="알림 닫기"><X size={14} /></button></div>}
      {pageSettingsOpen && <PageSettingsPanel settings={pageSettings} onChange={setPageSettings} onClose={() => setPageSettingsOpen(false)} />}
      {pendingPageDeletion && pages[pendingPageDeletion] && (
        <PageDeleteConfirm
          title={pages[pendingPageDeletion].title}
          onCancel={() => setPendingPageDeletion(null)}
          onConfirm={() => deletePage(pendingPageDeletion)}
        />
      )}
      {pendingBlockDeletion && <BlockDeleteConfirm count={pendingBlockDeletion.length} onCancel={() => setPendingBlockDeletion(null)} onConfirm={deleteBlock} />}
    </div>
  );
}

type NodiTooltipState = {
  text: string;
  left: number;
  top: number;
  placement: "top" | "bottom";
};

const NODI_TOOLTIP_ID = "nodi-global-tooltip";
const NODI_TOOLTIP_TRIGGER_SELECTOR = [
  "[data-nodi-tooltip]",
  "button[aria-label]",
  "[role='button'][aria-label]",
  "[role='separator'][aria-label]",
].join(", ");

function NodiTooltipLayer() {
  const [tooltip, setTooltip] = useState<NodiTooltipState | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const tooltipElement = tooltipRef.current;
    if (!tooltipElement) return;

    tooltipElement.style.setProperty("--nodi-tooltip-shift-x", "0px");
    const rect = tooltipElement.getBoundingClientRect();
    const viewportPadding = 9;
    const shift = rect.left < viewportPadding
      ? viewportPadding - rect.left
      : rect.right > window.innerWidth - viewportPadding
        ? window.innerWidth - viewportPadding - rect.right
        : 0;
    tooltipElement.style.setProperty("--nodi-tooltip-shift-x", `${shift}px`);
  }, [tooltip]);

  useEffect(() => {
    let activeTarget: HTMLElement | null = null;
    let describedTarget: HTMLElement | null = null;
    let previousDescribedBy: string | null = null;
    let showTimer: number | undefined;
    let hideTimer: number | undefined;

    const prepareElement = (element: Element) => {
      const nativeTitle = element.getAttribute("title")?.trim();
      if (!nativeTitle) return;
      element.setAttribute("data-nodi-tooltip", nativeTitle);
      element.removeAttribute("title");
    };
    const prepareTree = (root: ParentNode) => {
      if (root instanceof Element) prepareElement(root);
      root.querySelectorAll?.("[title]").forEach(prepareElement);
    };
    prepareTree(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.target instanceof Element) {
          prepareElement(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) prepareTree(node);
        });
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["title"],
    });

    const resolveTrigger = (target: EventTarget | null) => (
      target instanceof Element
        ? target.closest<HTMLElement>(NODI_TOOLTIP_TRIGGER_SELECTOR)
        : null
    );
    const getTooltipText = (target: HTMLElement) => {
      const explicitText = target.dataset.nodiTooltip?.trim();
      if (explicitText) return explicitText;
      if (target.textContent?.trim()) return "";
      return target.getAttribute("aria-label")?.trim() ?? "";
    };
    const restoreDescription = () => {
      if (!describedTarget) return;
      if (previousDescribedBy) describedTarget.setAttribute("aria-describedby", previousDescribedBy);
      else describedTarget.removeAttribute("aria-describedby");
      describedTarget = null;
      previousDescribedBy = null;
    };
    const describeTarget = (target: HTMLElement) => {
      restoreDescription();
      describedTarget = target;
      previousDescribedBy = target.getAttribute("aria-describedby");
      const ids = new Set((previousDescribedBy ?? "").split(/\s+/).filter(Boolean));
      ids.add(NODI_TOOLTIP_ID);
      target.setAttribute("aria-describedby", [...ids].join(" "));
    };
    const hideNow = () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      activeTarget = null;
      restoreDescription();
      setTooltip(null);
    };
    const scheduleHide = () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hideNow, 70);
    };
    const scheduleShow = (target: HTMLElement, delay: number) => {
      const text = getTooltipText(target);
      if (!text) return;
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      activeTarget = target;
      showTimer = window.setTimeout(() => {
        if (!target.isConnected || activeTarget !== target) return;
        const rect = target.getBoundingClientRect();
        const placement = rect.top >= 54 ? "top" : "bottom";
        describeTarget(target);
        setTooltip({
          text,
          left: rect.left + rect.width / 2,
          top: placement === "top" ? rect.top - 8 : rect.bottom + 8,
          placement,
        });
      }, delay);
    };
    const handleMouseOver = (event: MouseEvent) => {
      const target = resolveTrigger(event.target);
      if (!target || target === activeTarget) return;
      scheduleShow(target, 320);
    };
    const handleMouseMove = (event: MouseEvent) => {
      const target = resolveTrigger(event.target);
      if (target) {
        if (target !== activeTarget) scheduleShow(target, 320);
        return;
      }
      if (activeTarget && document.activeElement !== activeTarget) scheduleHide();
    };
    const handleMouseOut = (event: MouseEvent) => {
      const target = resolveTrigger(event.target);
      if (!target || target !== activeTarget) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      scheduleHide();
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = resolveTrigger(event.target);
      if (target) scheduleShow(target, 80);
    };
    const handleFocusOut = (event: FocusEvent) => {
      const target = resolveTrigger(event.target);
      if (!target || target !== activeTarget) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      scheduleHide();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideNow();
    };

    document.addEventListener("mouseover", handleMouseOver, true);
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("mouseout", handleMouseOut, true);
    document.addEventListener("pointerdown", hideNow, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", hideNow);
    window.addEventListener("scroll", hideNow, true);

    return () => {
      observer.disconnect();
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      restoreDescription();
      document.removeEventListener("mouseover", handleMouseOver, true);
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("mouseout", handleMouseOut, true);
      document.removeEventListener("pointerdown", hideNow, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", hideNow);
      window.removeEventListener("scroll", hideNow, true);
    };
  }, []);

  if (!tooltip) return null;
  return createPortal(
    <div
      ref={tooltipRef}
      id={NODI_TOOLTIP_ID}
      className="nodi-tooltip"
      data-placement={tooltip.placement}
      role="tooltip"
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}

function EditorScrollOverlay({ targetRef }: { targetRef: { current: HTMLElement | null } }) {
  const [metrics, setMetrics] = useState({ canScroll: false, height: 0, top: 0 });
  const [isScrolling, setIsScrolling] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const visibilityTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let frame = 0;
    const reveal = () => {
      setIsScrolling(true);
      if (visibilityTimerRef.current) window.clearTimeout(visibilityTimerRef.current);
      visibilityTimerRef.current = window.setTimeout(() => setIsScrolling(false), 700);
    };
    const refresh = () => {
      const maxScroll = target.scrollHeight - target.clientHeight;
      const canScroll = maxScroll > 1;
      const height = canScroll ? Math.max(36, (target.clientHeight * target.clientHeight) / target.scrollHeight) : 0;
      const top = canScroll ? (target.scrollTop / maxScroll) * (target.clientHeight - height) : 0;
      setMetrics((current) => current.canScroll === canScroll && Math.abs(current.height - height) < .5 && Math.abs(current.top - top) < .5 ? current : { canScroll, height, top });
    };
    const scheduleRefresh = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(refresh); };
    const onScroll = () => { scheduleRefresh(); reveal(); };
    const resizeObserver = new ResizeObserver(scheduleRefresh);
    const mutationObserver = new MutationObserver(scheduleRefresh);
    resizeObserver.observe(target);
    const notePage = target.querySelector(".note-page");
    if (notePage) resizeObserver.observe(notePage);
    mutationObserver.observe(target, { childList: true, subtree: true, characterData: true });
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", scheduleRefresh);
    scheduleRefresh();
    return () => {
      window.cancelAnimationFrame(frame);
      if (visibilityTimerRef.current) window.clearTimeout(visibilityTimerRef.current);
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", scheduleRefresh);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [targetRef]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    if (!target) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, startScrollTop: target.scrollTop };
    setIsDragging(true);
  };
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    const start = dragRef.current;
    if (!target || !start) return;
    const multiplier = target.scrollHeight / Math.max(target.clientHeight, 1);
    target.scrollTop = start.startScrollTop + (event.clientY - start.startY) * multiplier;
  };
  const endDrag = () => { dragRef.current = null; setIsDragging(false); };

  if (!metrics.canScroll) return null;
  return <div className={`editor-scrollbar ${isScrolling ? "is-scrolling" : ""} ${isDragging ? "is-dragging" : ""}`} aria-hidden="true"><div className="editor-scrollbar-thumb" style={{ height: metrics.height, transform: `translateY(${metrics.top}px)` }} onPointerDown={beginDrag} onPointerMove={drag} onPointerUp={endDrag} onLostPointerCapture={endDrag} /></div>;
}

function InlineNavRename({ value, ariaLabel, onSubmit, onCancel }: { value: string; ariaLabel: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    window.requestAnimationFrame(() => inputRef.current?.select());
  }, []);

  return (
    <input
      ref={inputRef}
      className="sidebar-inline-rename"
      value={draft}
      aria-label={ariaLabel}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (!cancelledRef.current) onSubmit(draft);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit(draft);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

function NavItem({
  icon,
  label,
  count,
  active = false,
  nested = false,
  editing = false,
  draggable = false,
  dragging = false,
  dropPlacement = null,
  pageId,
  onClick,
  onContextMenu,
  onRename,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onMouseUp,
}: {
  icon: React.ReactNode;
  label: string;
  count?: string;
  active?: boolean;
  nested?: boolean;
  editing?: boolean;
  draggable?: boolean;
  dragging?: boolean;
  dropPlacement?: "before" | "after" | null;
  pageId?: string;
  onClick?: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onRename?: (value: string) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onMouseUp?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`nav-item ${active ? "active" : ""} ${nested ? "is-nested" : ""} ${editing ? "is-editing" : ""} ${draggable ? "is-page-draggable" : ""} ${dragging ? "is-dragging" : ""} ${dropPlacement ? `is-drop-${dropPlacement}` : ""}`}
      data-sidebar-page-id={pageId}
      onClick={() => {
        if (!editing) onClick?.();
      }}
      onContextMenu={onContextMenu}
      onPointerDown={editing ? undefined : onPointerDown}
      onPointerMove={editing ? undefined : onPointerMove}
      onPointerUp={editing ? undefined : onPointerUp}
      onPointerCancel={editing ? undefined : onPointerCancel}
      onMouseUp={editing ? undefined : onMouseUp}
    >
      <span className="nav-icon">{icon}</span>
      {editing && onRename
        ? <InlineNavRename value={label} ariaLabel="페이지 이름" onSubmit={onRename} onCancel={() => onRename(label)} />
        : <span>{label}</span>}
      {count && <em>{count}</em>}
    </button>
  );
}

function SidebarFolderIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      className={`sidebar-folder-icon ${open ? "is-open" : ""}`}
      viewBox="0 0 20 18"
      width="17"
      height="16"
      aria-hidden="true"
    >
      <path className="sidebar-folder-icon-back" d="M2.2 4.1c0-1 .8-1.8 1.8-1.8h3.2c.6 0 1.1.2 1.5.7l1 1.1h6.2c1 0 1.9.8 1.9 1.9v1.1H2.2v-3Z" />
      <path className="sidebar-folder-icon-paper" d="M4.1 5.1h11.8v7.7H4.1z" />
      <path className="sidebar-folder-icon-front" d="M2.1 6.3c0-.7.6-1.3 1.3-1.3h13.4c.8 0 1.3.7 1.1 1.4l-1.6 7.8c-.2.9-1 1.5-1.9 1.5H4c-.9 0-1.7-.7-1.8-1.6L2.1 6.3Z" />
      <path className="sidebar-folder-icon-shine" d="M4.2 7.3h11.2" />
    </svg>
  );
}

function SidebarItemContextMenu({
  menu,
  page,
  folder,
  pages,
  folders,
  onOpenPage,
  onPreviewPage,
  onRename,
  onReorderPage,
  onReorderFolder,
  onMovePage,
  onToggleFolder,
  onCreatePage,
  onCreateFolder,
  onDeleteFolder,
  onDeletePage,
}: {
  menu: SidebarContextMenuState;
  page?: StoredPage;
  folder?: StoredFolder;
  pages: StoredPages;
  folders: StoredFolders;
  onClose: () => void;
  onOpenPage: (pageId: string) => void;
  onPreviewPage: (pageId: string) => void;
  onRename: (rename: SidebarRenameState) => void;
  onReorderPage: (pageId: string, direction: -1 | 1) => void;
  onReorderFolder: (folderId: string, direction: -1 | 1) => void;
  onMovePage: (pageId: string, folderId: string | null) => void;
  onToggleFolder: (folderId: string) => void;
  onCreatePage: (folderId: string) => void;
  onCreateFolder: (parentId: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onDeletePage: (pageId: string) => void;
}) {
  const flattenFolders = (parentId: string | null, depth = 0, visited = new Set<string>()): Array<{ folder: StoredFolder; depth: number }> => (
    Object.values(folders)
      .filter((candidate) => candidate.parentId === parentId && !visited.has(candidate.id))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .flatMap((candidate) => {
        const nextVisited = new Set(visited).add(candidate.id);
        return [
          { folder: candidate, depth },
          ...flattenFolders(candidate.id, depth + 1, nextVisited),
        ];
      })
  );
  const orderedFolderEntries = flattenFolders(null);

  if (menu.kind === "page" && page) {
    const siblings = getSidebarOrderedItems(pages, folders, getPageSidebarParentId(page, folders));
    const pageIndex = siblings.findIndex((candidate) => candidate.kind === "page" && candidate.id === page.id);
    return (
      <div
        className="sidebar-item-context sidebar-floating-menu"
        role="menu"
        aria-label={`${page.title} 페이지 메뉴`}
        style={{ left: menu.x, top: menu.y }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="sidebar-context-heading"><span>{page.settings.icon || "📄"}</span><strong>{page.title || "제목 없음"}</strong></div>
        <button type="button" role="menuitem" onClick={() => onOpenPage(page.id)}><ArrowUpRight size={15} /> 전체 페이지로 열기</button>
        <button type="button" role="menuitem" onClick={() => onPreviewPage(page.id)}><ChevronRight size={15} /> 옆에서 열기</button>
        <button type="button" role="menuitem" onClick={() => onRename({ kind: "page", id: page.id })}><Pencil size={15} /> 이름 바꾸기</button>
        <div className="sidebar-context-divider" />
        <span className="sidebar-context-label">순서</span>
        <div className="sidebar-context-row">
          <button type="button" role="menuitem" disabled={pageIndex <= 0} onClick={() => onReorderPage(page.id, -1)}><ArrowUp size={14} /> 위로</button>
          <button type="button" role="menuitem" disabled={pageIndex < 0 || pageIndex >= siblings.length - 1} onClick={() => onReorderPage(page.id, 1)}><ArrowDown size={14} /> 아래로</button>
        </div>
        <div className="sidebar-context-divider" />
        <span className="sidebar-context-label">폴더로 이동</span>
        <div className="sidebar-folder-targets">
          <button type="button" className={page.folderId === null ? "is-selected" : ""} onClick={() => onMovePage(page.id, null)}><LayoutGrid size={14} /> 폴더 없음{page.folderId === null && <span>✓</span>}</button>
          {orderedFolderEntries.map(({ folder: targetFolder, depth }) => (
            <button
              type="button"
              key={targetFolder.id}
              className={page.folderId === targetFolder.id ? "is-selected" : ""}
              onClick={() => onMovePage(page.id, targetFolder.id)}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
            >
              <SidebarFolderIcon /> {targetFolder.title}
              {page.folderId === targetFolder.id && <span>✓</span>}
            </button>
          ))}
        </div>
        <div className="sidebar-context-divider" />
        <button type="button" role="menuitem" className="sidebar-context-danger" onClick={() => onDeletePage(page.id)}><Trash2 size={15} /> 페이지 삭제</button>
      </div>
    );
  }

  if (menu.kind === "folder" && folder) {
    const siblings = getSidebarOrderedItems(pages, folders, folder.parentId);
    const folderIndex = siblings.findIndex((candidate) => candidate.kind === "folder" && candidate.id === folder.id);
    const folderDepth = getFolderDepth(folders, folder.id);
    const reachedFolderDepthLimit = folderDepth >= MAX_FOLDER_DEPTH;
    return (
      <div
        className="sidebar-item-context sidebar-floating-menu"
        role="menu"
        aria-label={`${folder.title} 폴더 메뉴`}
        style={{ left: menu.x, top: menu.y }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="sidebar-context-heading"><SidebarFolderIcon open={!folder.collapsed} /><strong>{folder.title}</strong></div>
        <button type="button" role="menuitem" onClick={() => onCreatePage(folder.id)}><Plus size={15} /> 이 폴더에 페이지 추가</button>
        <button
          type="button"
          role="menuitem"
          disabled={reachedFolderDepthLimit}
          title={reachedFolderDepthLimit ? `폴더는 최대 ${MAX_FOLDER_DEPTH}단계까지 만들 수 있어요` : undefined}
          onClick={() => onCreateFolder(folder.id)}
        >
          <FolderPlus size={15} />
          하위 폴더 추가
          {reachedFolderDepthLimit && <small className="sidebar-depth-limit">최대 {MAX_FOLDER_DEPTH}단계</small>}
        </button>
        <button type="button" role="menuitem" onClick={() => onRename({ kind: "folder", id: folder.id })}><Pencil size={15} /> 이름 바꾸기</button>
        <button type="button" role="menuitem" onClick={() => onToggleFolder(folder.id)}><ChevronRight size={15} /> {folder.collapsed ? "폴더 펼치기" : "폴더 접기"}</button>
        <div className="sidebar-context-divider" />
        <span className="sidebar-context-label">순서</span>
        <div className="sidebar-context-row">
          <button type="button" role="menuitem" disabled={folderIndex <= 0} onClick={() => onReorderFolder(folder.id, -1)}><ArrowUp size={14} /> 위로</button>
          <button type="button" role="menuitem" disabled={folderIndex < 0 || folderIndex >= siblings.length - 1} onClick={() => onReorderFolder(folder.id, 1)}><ArrowDown size={14} /> 아래로</button>
        </div>
        <div className="sidebar-context-divider" />
        <button type="button" role="menuitem" className="sidebar-context-danger" onClick={() => onDeleteFolder(folder.id)}><Trash2 size={15} /> 폴더 삭제</button>
        <small className="sidebar-context-note">내부 페이지와 폴더는 한 단계 위로 이동합니다.</small>
      </div>
    );
  }

  return null;
}

function PagePreviewDrawer({
  page,
  parentTitle,
  theme,
  onClose,
  onOpenPage,
  onChange,
}: {
  page: StoredPage;
  parentTitle?: string;
  theme: AppTheme;
  onClose: () => void;
  onOpenPage: () => void;
  onChange: (patch: Partial<StoredPage>) => void;
}) {
  const previewEditor = useCreateBlockNote({
    schema: editorSchema,
    initialContent: (page.blocks.length ? page.blocks : [{ type: "paragraph", content: "" }]) as never,
    dictionary: ko,
  });
  const [previewTitle, setPreviewTitle] = useState(page.title);
  const [drawerWidth, setDrawerWidth] = useState(() => {
    const savedWidth = Number(window.localStorage.getItem(PAGE_DRAWER_WIDTH_STORAGE_KEY));
    const preferredWidth = Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : 680;
    const minimumWidth = Math.min(440, window.innerWidth);
    const maximumWidth = Math.max(minimumWidth, window.innerWidth - 48);
    return Math.min(Math.max(preferredWidth, minimumWidth), maximumWidth);
  });
  const [isResizing, setIsResizing] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  const onOpenPageRef = useRef(onOpenPage);
  const drawerWidthRef = useRef(drawerWidth);
  const isClosingRef = useRef(false);
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const closeWithAnimation = (afterClose?: () => void) => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      (afterClose ?? onCloseRef.current)();
    }, 180);
  };

  useEffect(() => {
    onCloseRef.current = onClose;
    onOpenPageRef.current = onOpenPage;
  }, [onClose, onOpenPage]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWithAnimation();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const fitDrawerToViewport = () => {
      const minimumWidth = Math.min(440, window.innerWidth);
      const maximumWidth = Math.max(minimumWidth, window.innerWidth - 48);
      setDrawerWidth((width) => Math.min(Math.max(width, minimumWidth), maximumWidth));
    };
    window.addEventListener("resize", fitDrawerToViewport);
    return () => window.removeEventListener("resize", fitDrawerToViewport);
  }, []);

  const resizeDrawer = (nextWidth: number, persist = false) => {
    const minimumWidth = Math.min(440, window.innerWidth);
    const maximumWidth = Math.max(minimumWidth, window.innerWidth - 48);
    const clampedWidth = Math.min(Math.max(nextWidth, minimumWidth), maximumWidth);
    drawerWidthRef.current = clampedWidth;
    setDrawerWidth(clampedWidth);
    if (persist) window.localStorage.setItem(PAGE_DRAWER_WIDTH_STORAGE_KEY, String(Math.round(clampedWidth)));
  };

  const beginDrawerResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = { pointerX: event.clientX, width: drawerWidth };
    setIsResizing(true);
  };

  const continueDrawerResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const resizeStart = resizeStartRef.current;
    if (!resizeStart) return;
    resizeDrawer(resizeStart.width + resizeStart.pointerX - event.clientX);
  };

  const endDrawerResize = () => {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    setIsResizing(false);
    window.localStorage.setItem(PAGE_DRAWER_WIDTH_STORAGE_KEY, String(Math.round(drawerWidthRef.current)));
  };

  useEffect(() => {
    if (!isResizing) return;
    const moveFromWindow = (event: PointerEvent) => {
      const resizeStart = resizeStartRef.current;
      if (!resizeStart) return;
      resizeDrawer(resizeStart.width + resizeStart.pointerX - event.clientX);
    };
    const endFromWindow = () => endDrawerResize();
    window.addEventListener("pointermove", moveFromWindow);
    window.addEventListener("pointerup", endFromWindow);
    window.addEventListener("pointercancel", endFromWindow);
    return () => {
      window.removeEventListener("pointermove", moveFromWindow);
      window.removeEventListener("pointerup", endFromWindow);
      window.removeEventListener("pointercancel", endFromWindow);
    };
  }, [isResizing]);

  return (
    <div className={`page-preview-layer ${isClosing ? "is-closing" : ""}`} role="presentation" onMouseDown={() => closeWithAnimation()}>
      <aside
        className={`page-preview-drawer ${isResizing ? "is-resizing" : ""} ${isClosing ? "is-closing" : ""}`}
        style={{ width: drawerWidth }}
        role="dialog"
        aria-modal="true"
        aria-label={`${previewTitle || "제목 없음"} 페이지 미리보기`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="page-preview-resize-handle"
          role="separator"
          aria-label="페이지 미리보기 너비 조절"
          aria-orientation="vertical"
          aria-valuemin={440}
          aria-valuemax={Math.max(440, window.innerWidth - 48)}
          aria-valuenow={Math.round(drawerWidth)}
          tabIndex={0}
          onPointerDown={beginDrawerResize}
          onPointerMove={continueDrawerResize}
          onPointerUp={endDrawerResize}
          onPointerCancel={endDrawerResize}
          onLostPointerCapture={endDrawerResize}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              resizeDrawer(drawerWidth + 24, true);
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              resizeDrawer(drawerWidth - 24, true);
            }
          }}
        >
          <span />
        </div>
        <header className="page-preview-header">
          <div className="page-preview-path">
            <span>{page.settings.icon || "📄"}</span>
            <span>{parentTitle || "개인"}</span>
            <ChevronRight size={13} />
            <strong>{previewTitle || "제목 없음"}</strong>
          </div>
          <div className="page-preview-actions">
            <button type="button" aria-label="전체 페이지로 열기" title="전체 페이지로 열기" onClick={() => closeWithAnimation(() => onOpenPageRef.current())}>
              <ArrowUpRight size={17} />
            </button>
            <button type="button" aria-label="페이지 미리보기 닫기" title="닫기" onClick={() => closeWithAnimation()}>
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="page-preview-scroll">
          <div className="page-preview-content">
            <div className="page-preview-icon" aria-hidden="true">{page.settings.icon || "📄"}</div>
            <input
              className="page-preview-title"
              value={previewTitle}
              onChange={(event) => {
                const nextTitle = event.target.value;
                setPreviewTitle(nextTitle);
                onChange({ title: nextTitle.trim() || "제목 없음" });
              }}
              onBlur={() => {
                if (!previewTitle.trim()) setPreviewTitle("제목 없음");
              }}
              placeholder="제목 없음"
              aria-label="미리보기 페이지 제목"
              disabled={page.settings.lockPage}
            />

            {page.settings.showProperties && (
              <div className="page-preview-properties">
                <span><Hash size={14} /> 상태 <strong>{page.settings.status}</strong></span>
                {page.settings.tags.length > 0 && <span><Hash size={14} /> 태그 <strong>{page.settings.tags.join(", ")}</strong></span>}
                <span><Clock3 size={14} /> 날짜 <strong>{page.settings.date}</strong></span>
              </div>
            )}

            <div className="page-preview-divider" />
            <BlockNoteView
              editor={previewEditor}
              theme={theme}
              editable={!page.settings.lockPage}
              onChange={() => onChange({ blocks: previewEditor.document as unknown as PartialBlock[] })}
              data-theming-css-variables-demo
            />
          </div>
        </div>
      </aside>
    </div>
  );
}

function QuickActionPanel({ type, pageLink, isPublic, onPublicChange, onClose, onCopy, onDraft }: { type: "draft" | "link" | "share"; pageLink: string; isPublic: boolean; onPublicChange: (isPublic: boolean) => void; onClose: () => void; onCopy: () => void; onDraft: (kind: "plan" | "meeting") => void }) {
  const copyLabel = type === "share" ? "공유 링크 복사" : "페이지 링크 복사";
  return <aside className="quick-action-panel" aria-label={type === "draft" ? "초안 도구" : type === "link" ? "링크 도구" : "공유 도구"}><header><span>{type === "draft" ? <><Sparkles size={17} /> 초안 도구</> : type === "link" ? <><Link size={17} /> 페이지 링크</> : <><Share2 size={17} /> 공유</>}</span><button type="button" aria-label="패널 닫기" onClick={onClose}><X size={17} /></button></header>{type === "draft" ? <div className="quick-panel-body"><p>API 연결 전에도 바로 쓸 수 있는 구조 초안을 추가합니다.</p><button type="button" onClick={() => onDraft("plan")}><Sparkles size={15} /><span><strong>실행 계획</strong><small>다음 행동 체크리스트 추가</small></span></button><button type="button" onClick={() => onDraft("meeting")}><FileText size={15} /><span><strong>회의록</strong><small>요약과 결정 사항 추가</small></span></button></div> : <div className="quick-panel-body">{type === "share" && <div className={`share-access-card ${isPublic ? "is-public" : ""}`}><span className="share-access-icon">{isPublic ? <Globe2 size={17} /> : <Lock size={17} />}</span><span className="share-access-copy"><strong>{isPublic ? "웹에 공개됨" : "비공개 페이지"}</strong><small>{isPublic ? "링크가 있는 모든 사람이 볼 수 있음" : "나만 볼 수 있음"}</small></span><button className="share-access-switch" type="button" role="switch" aria-label="페이지 공개 전환" aria-checked={isPublic} onClick={() => onPublicChange(!isPublic)}><span /></button></div>}<p>{type === "share" ? isPublic ? "아래 링크를 복사해 다른 사람에게 전달할 수 있어요." : "공개 스위치를 켜야 공유 링크를 사용할 수 있어요." : "현재 페이지 주소입니다."}</p><div className="quick-link"><span>{pageLink}</span></div><button className="copy-action" type="button" disabled={type === "share" && !isPublic} onClick={onCopy}><Copy size={15} /> {copyLabel}</button>{type === "share" && <small className="share-note">공개 상태는 저장됩니다. 실제 외부 접속은 인증·공개 API 서버를 연결한 뒤 활성화됩니다.</small>}</div>}</aside>;
}

function NodiContextMenu({ menu, archived, locked, selectedBlockCount, onAddBlock, onMoveBlock, onDuplicateBlock, onDeleteBlock, onOpenSettings, onCopyLink, onToggleArchive, onExport, onDeletePage }: { menu: ContextMenuState; archived: boolean; locked: boolean; selectedBlockCount: number; onAddBlock: () => void; onMoveBlock: (direction: "up" | "down") => void; onDuplicateBlock: () => void; onDeleteBlock: () => void; onOpenSettings: () => void; onCopyLink: () => void; onToggleArchive: () => void; onExport: () => void; onDeletePage: () => void }) {
  return <div className="nodi-context-menu" role="menu" aria-label={menu.kind === "block" ? "블록 메뉴" : "페이지 메뉴"} style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
    {menu.kind === "block" ? <>
      <span className="context-menu-heading">{selectedBlockCount > 1 ? `${selectedBlockCount}개 블록` : "블록"}</span>
      <button type="button" role="menuitem" disabled={locked} onClick={onAddBlock}><Plus size={15} /> 아래에 새 블록</button>
      <button type="button" role="menuitem" disabled={locked} onClick={() => onMoveBlock("up")}><ArrowUp size={15} /><span>위로 이동</span><kbd>⌘⇧↑</kbd></button>
      <button type="button" role="menuitem" disabled={locked} onClick={() => onMoveBlock("down")}><ArrowDown size={15} /><span>아래로 이동</span><kbd>⌘⇧↓</kbd></button>
      <button type="button" role="menuitem" disabled={locked} onClick={onDuplicateBlock}><Copy size={15} /><span>{selectedBlockCount > 1 ? "선택한 블록 복제" : "블록 복제"}</span><kbd>⌘D</kbd></button>
      <div className="context-menu-divider" />
      <button type="button" role="menuitem" className="context-menu-danger" disabled={locked} onClick={onDeleteBlock}><Trash2 size={15} /><span>{selectedBlockCount > 1 ? "선택한 블록 삭제" : "블록 삭제"}</span><kbd>Del</kbd></button>
    </> : <>
      <span className="context-menu-heading">페이지</span>
      <button type="button" role="menuitem" onClick={onOpenSettings}><Settings2 size={15} /> 페이지 설정</button>
      <button type="button" role="menuitem" onClick={onCopyLink}><Link size={15} /> 페이지 링크 복사</button>
      <button type="button" role="menuitem" onClick={onToggleArchive}><Archive size={15} /> {archived ? "페이지 복원" : "페이지 보관"}</button>
      <button type="button" role="menuitem" onClick={onExport}><Download size={15} /> JSON 내보내기</button>
      <div className="context-menu-divider" />
      <button type="button" role="menuitem" className="context-menu-danger" onClick={onDeletePage}><Trash2 size={15} /> 페이지 휴지통으로 이동</button>
    </>}
  </div>;
}

function PageDeleteConfirm({ title, onCancel, onConfirm }: { title: string; onCancel: () => void; onConfirm: () => void }) {
  return <ConfirmDialog ariaLabel="페이지 삭제" title="페이지를 휴지통으로 옮길까요?" description={`“${title || "제목 없음"}” 페이지의 본문과 속성의 스냅샷이 로컬 휴지통에 보관됩니다.`} confirmLabel="휴지통으로 이동" onCancel={onCancel} onConfirm={onConfirm} />;
}

function BlockDeleteConfirm({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  return <ConfirmDialog ariaLabel="블록 삭제" title="블록을 삭제할까요?" description={`${count > 1 ? `선택한 ${count}개 블록이` : "선택한 블록이"} 현재 페이지에서 삭제됩니다. 삭제 후에도 ⌘/Ctrl+Z로 되돌릴 수 있습니다.`} confirmLabel={count > 1 ? `${count}개 블록 삭제` : "블록 삭제"} onCancel={onCancel} onConfirm={onConfirm} />;
}

export default App;
