import { insertAttachmentFiles, updateAttachmentBlock } from "./editor-attachments";
import { jsonEqual } from "./json-equal";
import { isComposingKey } from "./ime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { TextSelection } from "prosemirror-state";
import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs, prosemirrorSliceToSlicedBlocks, type BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { ko } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import { createReactBlockSpec, getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote, type DefaultReactSuggestionItem } from "@blocknote/react";
import { createHighlighter } from "shiki";
import { BlockCommentPanel } from "./BlockCommentPanel";
import { BlockNotePopoverScrollOverlays } from "./BlockNotePopoverScrollOverlays";
import { AuthDialog, type AuthDialogMode } from "./AuthDialog";
import { DATABASE_COLUMN_RESIZE_START_EVENT, INLINE_DATABASE_REALTIME_EVENT, InlineDatabase, InlineDatabaseSyncProvider, type DatabaseState } from "./InlineDatabase";
import { PageSharePanel } from "./PageSharePanel";
import { PageSettingsPanel, type PageSettings } from "./PageSettings";
import { SharedPagesView } from "./SharedPagesView";
import { TrashView } from "./TrashView";
import { SidebarScrollOverlay } from "./SidebarScrollOverlay";
import { TagPicker } from "./TagPicker";
import { NodiUserAvatar } from "./NodiUserAvatar";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";
import { WorkspaceSearchDialog } from "./WorkspaceSearchDialog";
import {
  authApi,
  workspaceApi,
  type ServerCommentThread,
  type ServerFolder,
  type ServerHome,
  type ServerNotification,
  type ServerPage,
  type ServerPageRealtimeEvent,
  type ServerRealtimeParticipant,
  type ServerShare,
} from "./server-api";
import { APP_NOTICE_EVENT, uploadNodiAttachment } from "./attachment-storage";
import { DEFAULT_TAG_OPTIONS, toDateInput, type TagOption } from "./types";
import { makeId } from "./types";
import { DatePicker } from "./components/ui/date-picker";
import { Select } from "./components/ui/select";
import { ConfirmDialog } from "./components/ui/confirm-dialog";
import { ChildPageBlock } from "./ChildPageBlock";
import { replacePageDocument } from "./editor-document";
import { collectDatabaseSnapshots, copyDatabase, copyDatabaseReferences } from "./database-copy";
import {
  persistStoredBlockComments,
  readStoredBlockComments,
  type BlockCommentThread,
  type StoredBlockComments,
} from "./comment-store";
import {
  bootstrapLocalAuth,
  logoutLocalAccount,
  readApprovedLocalUsers,
  readLocalAuthUser,
  readRegistrationRequests,
  REGISTRATION_REQUESTS_CHANGED_EVENT,
  restoreServerAuth,
  updateLocalAccountProfile,
  type LocalAuthUser,
} from "./account-store";
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
import {
  REGISTERED_NODI_USERS,
  persistStoredPageShares,
  readStoredPageShares,
  type NodiAvatarColor,
  type PageShareRecord,
  type SharePermission,
  type StoredPageShares,
} from "./sharing-store";
import {
  persistStarterPresets,
  readStarterPresets,
  type StarterPreset,
} from "./starter-presets";
import "@blocknote/mantine/style.css";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bell,
  Check,
  Code2,
  Copy,
  CopyPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Command,
  Download,
  Eye,
  Database,
  FileText,
  FolderPlus,
  Globe2,
  GripVertical,
  HardDrive,
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
  LoaderCircle,
  LogIn,
  MessageCircle,
  Moon,
  MoreHorizontal,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Quote,
  Repeat2,
  Search,
  Settings2,
  Share2,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Type,
  UserPlus,
  Users,
  X,
} from "lucide-react";

const NODI_DICTIONARY = {
  ...ko,
  color_picker: {
    ...ko.color_picker,
    colors: {
      ...ko.color_picker.colors,
      default: "기본",
    },
  },
};

const CONTENT_STORAGE_KEY = "nodi:quick-note:content";
const TITLE_STORAGE_KEY = "nodi:quick-note:title";
const PAGE_SETTINGS_STORAGE_KEY = "nodi:quick-note:page-settings";
const PAGE_ARCHIVED_STORAGE_KEY = "nodi:quick-note:archived";
const PAGE_TRASH_STORAGE_KEY = "nodi:quick-note:trash";
const PAGE_DRAWER_WIDTH_STORAGE_KEY = "nodi:page-drawer-width";
const APP_THEME_STORAGE_KEY = "nodi:app-theme";
const HOME_PAGE_TITLE_STORAGE_KEY = "nodi:home-title-v2";
const USER_NAME_STORAGE_KEY = "nodi:user:name";
const USER_PROFILE_STORAGE_KEYS = ["nodi:user:profile", "nodi:auth:user"];
const NODI_BLOCK_CLIPBOARD_MIME = "application/x-nodi-blocks+json";
const DEFAULT_USER_NAME = "Lee";
const USER_PROFILE_CHANGED_EVENT = "nodi:user-profile-changed";
type AppTheme = "light" | "dark";
type LocalSaveState = "saving" | "saved" | "error";
type NodiPreferences = {
  theme?: AppTheme;
  [key: string]: unknown;
};
type WorkspaceSection = "pages" | "shared" | "shared-page" | "trash";
type PageNavigationOptions = {
  skipCurrentPageSave?: boolean;
  historyMode?: "push" | "replace" | "none";
};
type InboxNotification = {
  id: string;
  kind: "share" | "comment" | "mention";
  title: string;
  description: string;
  time: string;
  unread: boolean;
  pageId?: string | null;
};

function getPrimaryShortcutLabel() {
  if (typeof navigator === "undefined") return "Ctrl";
  const platform = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘" : "Ctrl";
}

function getStoredUserName() {
  const authenticatedUser = readLocalAuthUser();
  if (!authenticatedUser) return "게스트";

  try {
    const directName = window.localStorage.getItem(USER_NAME_STORAGE_KEY)?.trim();
    if (directName) return directName;

    for (const storageKey of USER_PROFILE_STORAGE_KEYS) {
      const storedProfile = window.localStorage.getItem(storageKey);
      if (!storedProfile) continue;
      const profile = JSON.parse(storedProfile) as {
        name?: unknown;
        displayName?: unknown;
        username?: unknown;
      };
      const profileName = [profile.name, profile.displayName, profile.username]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
      if (profileName) return profileName.trim();
    }
  } catch {
    // A future authentication provider can replace the local profile source.
  }
  return DEFAULT_USER_NAME;
}

function getHomePageTitle(userName = getStoredUserName()) {
  return `${userName}의 홈 공간입니다.`;
}

function formatHomePageUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "최근 수정";
  const today = new Date();
  const isToday = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  if (isToday) return "오늘";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(date);
}

function formatPageUpdatedAt(value: string, now = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "최근";

  const elapsed = Math.max(0, now - date.getTime());
  if (elapsed < 60_000) return "지금";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}분 전`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}시간 전`;

  const current = new Date(now);
  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()
  ) return "어제";

  if (date.getFullYear() === current.getFullYear()) {
    return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatExactUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function RelativeUpdatedAt({ value }: { value: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [value]);

  return <strong title={formatExactUpdatedAt(value)}>{formatPageUpdatedAt(value, now)}</strong>;
}

function arePageSettingsEqual(first: PageSettings, second: PageSettings) {
  return first.icon === second.icon
    && first.cover === second.cover
    && first.fullWidth === second.fullWidth
    && first.smallText === second.smallText
    && first.lockPage === second.lockPage
    && first.publicAccess === second.publicAccess
    && first.showProperties === second.showProperties
    && first.status === second.status
    && first.date === second.date
    && first.tags.length === second.tags.length
    && first.tags.every((tag, index) => tag === second.tags[index]);
}

function formatHomeMemoDate() {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date());
}

type BlockSelectionActionMenu = {
  kind: "transform" | "color";
  x: number;
  y: number;
  placement: "top" | "bottom";
  maxHeight: number;
  anchor: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
};
type BlockColorName =
  | "default"
  | "gray"
  | "slate"
  | "brown"
  | "red"
  | "rose"
  | "orange"
  | "yellow"
  | "lime"
  | "green"
  | "teal"
  | "blue"
  | "indigo"
  | "purple"
  | "pink";

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
  { value: "slate", label: "슬레이트" },
  { value: "brown", label: "갈색" },
  { value: "red", label: "빨강" },
  { value: "rose", label: "로즈" },
  { value: "orange", label: "주황" },
  { value: "yellow", label: "노랑" },
  { value: "lime", label: "라임" },
  { value: "green", label: "초록" },
  { value: "teal", label: "청록" },
  { value: "blue", label: "파랑" },
  { value: "indigo", label: "인디고" },
  { value: "purple", label: "보라" },
  { value: "pink", label: "분홍" },
];

const CONVERTIBLE_BLOCK_TYPES = new Set(BLOCK_TRANSFORM_OPTIONS.map((option) => option.type));

function getBlockPreview(block: unknown) {
  const collectText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(collectText).join("");
    if (!value || typeof value !== "object") return "";
    const candidate = value as { text?: unknown; content?: unknown; type?: unknown };
    if (typeof candidate.text === "string") return candidate.text;
    return collectText(candidate.content);
  };
  const candidate = block as { content?: unknown; type?: string } | null | undefined;
  const preview = collectText(candidate?.content).replace(/\s+/g, " ").trim();
  if (preview) return preview.slice(0, 120);
  const fallbackByType: Record<string, string> = {
    bulletListItem: "글머리 기호 목록",
    numberedListItem: "번호 매기기 목록",
    checkListItem: "할 일",
    heading: "제목",
    codeBlock: "코드",
    image: "이미지",
    file: "파일",
    database: "데이터베이스",
    childPage: "하위 페이지",
  };
  return fallbackByType[candidate?.type ?? ""] ?? "빈 블록";
}

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
  | { kind: "folder"; folderId: string; placement: "before" | "start" | "inside" | "after" }
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
    .filter((page) => (
      page.id !== ROOT_PAGE_ID
      && !page.archived
      && (page.permission ?? "owner") === "owner"
      && getPageSidebarParentId(page, folders) === parentId
    ))
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
  nested?: boolean;
};

function clipboardContentPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(clipboardContentPlainText).join("");
  }
  if (!content || typeof content !== "object") return "";

  const value = content as {
    type?: unknown;
    text?: unknown;
    content?: unknown;
    rows?: unknown;
  };
  if (typeof value.text === "string") return value.text;
  if (value.type === "tableContent" && Array.isArray(value.rows)) {
    return value.rows.map((row) => {
      if (!row || typeof row !== "object" || !("cells" in row) || !Array.isArray(row.cells)) return "";
      return row.cells.map(clipboardContentPlainText).join("\t");
    }).join("\n");
  }
  return clipboardContentPlainText(value.content);
}

function blockPlainText(block: { content?: unknown }) {
  return clipboardContentPlainText(block.content);
}

function clipboardBlocksPlainText(blocks: Array<{ content?: unknown; children?: unknown }>) {
  const blockText = (block: { content?: unknown; children?: unknown }): string => {
    const content = clipboardContentPlainText(block.content);
    const children = Array.isArray(block.children)
      ? block.children
        .filter((child): child is { content?: unknown; children?: unknown } => (
          Boolean(child) && typeof child === "object"
        ))
        .map(blockText)
        .filter(Boolean)
        .join("\n")
      : "";
    return [content, children].filter(Boolean).join("\n");
  };

  return blocks.map(blockText).join("\n");
}

function clipboardBlockWithoutId(value: unknown): PartialBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as {
    type?: unknown;
    props?: unknown;
    content?: unknown;
    children?: unknown;
  };
  if (typeof block.type !== "string") return null;

  const partialBlock: Record<string, unknown> = { type: block.type };
  if (block.props && typeof block.props === "object" && !Array.isArray(block.props)) {
    partialBlock.props = block.props;
  }
  if ("content" in block && block.content !== undefined) {
    partialBlock.content = block.content;
  }
  if (Array.isArray(block.children)) {
    const children = block.children
      .map(clipboardBlockWithoutId)
      .filter((child): child is PartialBlock => child !== null);
    if (children.length > 0) partialBlock.children = children;
  }
  return partialBlock as unknown as PartialBlock;
}

function writeEditorBlocksToClipboard(
  clipboardData: DataTransfer,
  activeEditor: BlockNoteEditor<any, any, any>,
  blocks: PartialBlock[],
) {
  const payload = JSON.stringify({ version: 1, blocks, databases: collectDatabaseSnapshots(blocks, true) });
  const externalHtml = activeEditor.blocksToHTMLLossy(blocks);
  const blockNoteHtml = activeEditor.blocksToFullHTML(blocks);
  clipboardData.clearData();
  clipboardData.setData(NODI_BLOCK_CLIPBOARD_MIME, payload);
  clipboardData.setData("blocknote/html", blockNoteHtml);
  clipboardData.setData("text/html", externalHtml);
  clipboardData.setData("text/plain", clipboardBlocksPlainText(blocks));
}

function copySelectedDatabaseBlocks(
  event: Pick<ClipboardEvent, "target" | "clipboardData" | "preventDefault" | "stopPropagation">,
  activeEditor: BlockNoteEditor<any, any, any>,
  cut = false,
) {
  if (!event.clipboardData) return false;
  // Cell inputs and other native controls own their text selection even while
  // ProseMirror retains an earlier whole-document selection.
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select")) return false;
  const view = activeEditor.prosemirrorView;
  const { state } = view;
  let { from, to } = state.selection;
  const nativeSelection = window.getSelection();
  if (nativeSelection?.rangeCount && !nativeSelection.isCollapsed
    && view.dom.contains(nativeSelection.anchorNode) && view.dom.contains(nativeSelection.focusNode)) {
    const range = nativeSelection.getRangeAt(0);
    const parent = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const island = parent?.closest('[contenteditable="false"]');
    if (island && island !== view.dom && view.dom.contains(island)) return false;
    // Capture runs before ProseMirror observes the native selection. This also
    // handles native selections in a read-only preview without changing it.
    from = view.posAtDOM(range.startContainer, range.startOffset);
    to = view.posAtDOM(range.endContainer, range.endOffset);
  }
  if (from === to) return false;
  const slice = state.doc.slice(from, to, true);
  let includesDatabase = false;
  slice.content.descendants((node) => {
    if (node.type.name === "database") includesDatabase = true;
  });
  if (!includesDatabase) return false;

  event.preventDefault();
  event.stopPropagation();
  try {
    // Keep partial paragraphs at either edge instead of copying whole blocks.
    const blocks = prosemirrorSliceToSlicedBlocks(slice).blocks as PartialBlock[];
    writeEditorBlocksToClipboard(event.clipboardData, activeEditor, blocks);
    if (cut && activeEditor.isEditable) {
      view.dispatch(state.tr.deleteRange(from, to).scrollIntoView().setMeta("uiEvent", "cut"));
    }
  } catch (error) {
    window.dispatchEvent(new CustomEvent(APP_NOTICE_EVENT, {
      detail: error instanceof Error ? error.message : "블록을 클립보드에 복사하지 못했어요",
    }));
  }
  return true;
}

function parseNodiClipboardBlocks(clipboardData: DataTransfer | null, copyDatabases = false): PartialBlock[] | null {
  const rawPayload = clipboardData?.getData(NODI_BLOCK_CLIPBOARD_MIME);
  if (!rawPayload) return null;
  try {
    const payload = JSON.parse(rawPayload) as { version?: unknown; blocks?: unknown; databases?: Record<string, DatabaseState> };
    if (payload.version !== 1 || !Array.isArray(payload.blocks)) return null;
    const sourceBlocks = copyDatabases ? copyDatabaseReferences(payload.blocks, payload.databases) : payload.blocks;
    const blocks = sourceBlocks
      .map(clipboardBlockWithoutId)
      .filter((block): block is PartialBlock => block !== null);
    return blocks.length > 0 ? blocks : null;
  } catch (error) {
    if (copyDatabases) {
      window.dispatchEvent(new CustomEvent(APP_NOTICE_EVENT, {
        detail: error instanceof Error ? error.message : "복사한 표를 불러오지 못했어요",
      }));
      return [];
    }
    return null;
  }
}

function pasteNodiClipboardBlocks(
  activeEditor: BlockNoteEditor<any, any, any>,
  clipboardData: DataTransfer | null,
) {
  const blocks = parseNodiClipboardBlocks(clipboardData, true);
  if (!blocks) return false;
  if (blocks.length === 0) return true;

  return pasteClipboardBlocks(activeEditor, blocks);
}

function pasteClipboardBlocks(
  activeEditor: BlockNoteEditor<any, any, any>,
  blocks: PartialBlock[],
) {
  if (blocks.length === 0) return false;

  let targetBlock = activeEditor.document.at(-1);
  try {
    targetBlock = activeEditor.getTextCursorPosition().block;
  } catch {
    // A non-text block may currently hold a node selection. In that case,
    // appending after the final document block is the safest deterministic
    // fallback.
  }
  if (!targetBlock) return true;

  const isEmptyParagraph = targetBlock.type === "paragraph"
    && blockPlainText(targetBlock).length === 0
    && targetBlock.children.length === 0;
  const insertedBlocks = isEmptyParagraph
    ? activeEditor.replaceBlocks([targetBlock.id], blocks).insertedBlocks
    : activeEditor.insertBlocks(blocks, targetBlock.id, "after");
  const finalInsertedBlock = insertedBlocks.at(-1);
  if (finalInsertedBlock) {
    window.requestAnimationFrame(() => {
      activeEditor.focus();
      try {
        activeEditor.setTextCursorPosition(finalInsertedBlock.id, "end");
      } catch {
        // Blocks without inline content cannot receive a text cursor.
      }
    });
  }
  return true;
}

function clipboardHTMLWithLineBreaksToText(value: string) {
  if (!value) return "";
  const parsed = new DOMParser().parseFromString(value, "text/html");
  parsed.body.querySelectorAll("br").forEach((lineBreak) => {
    lineBreak.replaceWith(parsed.createTextNode("\n"));
  });
  parsed.body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr").forEach((block) => {
    if (block.nextSibling) block.append(parsed.createTextNode("\n"));
  });
  return (parsed.body.textContent ?? "")
    .replaceAll("\u00a0", " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n$/, "");
}

function codeBlockClipboardText(clipboardData: DataTransfer | null) {
  if (!clipboardData) return "";
  const copiedBlocks = parseNodiClipboardBlocks(clipboardData);
  if (copiedBlocks) {
    return clipboardBlocksPlainText(copiedBlocks);
  }

  const plainText = clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");

  // BlockNote keeps hard breaks in its HTML payload even when a browser's
  // text/plain representation flattens a multi-line selection.
  for (const mimeType of ["blocknote/html", "text/html"]) {
    const richText = clipboardHTMLWithLineBreaksToText(clipboardData.getData(mimeType));
    if (richText.includes("\n")) return richText;
  }
  return plainText;
}

function hydratePublicResourceBlocks(
  blocks: PartialBlock[],
  childPageTitles: Record<string, string>,
): PartialBlock[] {
  return blocks.map((typedBlock) => {
    const block = typedBlock as unknown as {
      type?: string;
      props?: Record<string, unknown>;
      children?: PartialBlock[];
      [key: string]: unknown;
    };
    const props = block.type === "childPage"
      && typeof block.props?.pageId === "string"
      && childPageTitles[block.props.pageId]
        ? { ...block.props, title: childPageTitles[block.props.pageId] }
        : block.props;
    return {
      ...block,
      props,
      children: block.children
        ? hydratePublicResourceBlocks(block.children, childPageTitles)
        : block.children,
    } as unknown as PartialBlock;
  });
}

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

function resolveCodeBlockLanguage(info: string) {
  const requested = info.trim().toLocaleLowerCase().replace(/^language-/, "");
  if (!requested) return "text";
  for (const [languageId, language] of Object.entries(CODE_BLOCK_LANGUAGES)) {
    if (languageId.toLocaleLowerCase() === requested) return languageId;
    if (language.aliases?.some((alias) => alias.toLocaleLowerCase() === requested)) return languageId;
  }
  return "text";
}

function parseFencedCodeClipboard(value: string): PartialBlock | null {
  const normalized = value.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  if (lines.length < 2) return null;

  const opening = lines[0].match(/^ {0,3}(`{3,}|~{3,})(?:[ \t]*([^\s`~]+))?[ \t]*$/);
  const closing = lines.at(-1)?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  if (!opening || !closing) return null;
  if (opening[1][0] !== closing[1][0] || closing[1].length < opening[1].length) return null;

  return {
    type: "codeBlock",
    props: { language: resolveCodeBlockLanguage(opening[2] ?? "") },
    content: lines.slice(1, -1).join("\n"),
  } as PartialBlock;
}

function pasteFencedCodeClipboard(
  activeEditor: BlockNoteEditor<any, any, any>,
  clipboardData: DataTransfer | null,
) {
  const plainText = clipboardData?.getData("text/plain");
  if (!plainText) return false;
  const codeBlock = parseFencedCodeClipboard(plainText);
  return codeBlock ? pasteClipboardBlocks(activeEditor, [codeBlock]) : false;
}

function pasteStructuredMarkdownClipboard(
  activeEditor: BlockNoteEditor<any, any, any>,
  clipboardData: DataTransfer | null,
) {
  const plainText = clipboardData?.getData("text/plain");
  if (!plainText) return false;

  const markdown = plainText.replace(/\r\n?/g, "\n");
  const hasBlockSyntax = [
    /(?:^|\n) {0,3}#{1,6}[ \t]+\S/,
    /(?:^|\n) {0,3}(?:`{3,}|~{3,})[^\n]*\n/,
    /(?:^|\n)[ \t]{0,5}(?:[-+*]|\d+\.)[ \t]+\S/,
    /(?:^|\n) {0,3}>[ \t]+\S/,
    /(?:^|\n) {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\n|$)/,
    /(?:^|\n)[ \t]*\|[^\n]+\|[ \t]*\n[ \t]*\|?[ :|-]+\|/,
  ].some((pattern) => pattern.test(markdown));
  if (!hasBlockSyntax) return false;

  activeEditor.pasteMarkdown(markdown);
  return true;
}

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
      if (isComposingKey(event)) return;
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
      if (event.target instanceof HTMLInputElement) return;
      if (!languageMenu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = Array.from(languageMenu.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        .filter((item) => !item.hidden);
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
      const searchWrap = document.createElement("label");
      searchWrap.className = "nodi-code-language-search";
      const searchIcon = document.createElement("span");
      searchIcon.setAttribute("aria-hidden", "true");
      searchIcon.textContent = "⌕";
      const searchInput = document.createElement("input");
      searchInput.type = "search";
      searchInput.placeholder = "언어 검색";
      searchInput.setAttribute("aria-label", "코드 언어 검색");
      searchWrap.append(searchIcon, searchInput);
      const viewport = document.createElement("div");
      viewport.className = "shadcn-select-viewport";
      let selectedItem: HTMLButtonElement | null = null;

      CODE_BLOCK_LANGUAGE_OPTIONS.forEach((option) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "shadcn-select-item";
        item.dataset.search = [option.label, option.value, ...(CODE_BLOCK_LANGUAGES[option.value].aliases ?? [])]
          .join(" ")
          .toLocaleLowerCase("ko-KR");
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

      const emptyResult = document.createElement("span");
      emptyResult.className = "nodi-code-language-empty";
      emptyResult.textContent = "일치하는 언어가 없습니다.";
      emptyResult.hidden = true;
      const filterLanguages = () => {
        const query = searchInput.value.trim().toLocaleLowerCase("ko-KR");
        let visibleCount = 0;
        viewport.querySelectorAll<HTMLButtonElement>('[role="option"]').forEach((item) => {
          const visible = !query || item.dataset.search?.includes(query);
          item.hidden = !visible;
          if (visible) visibleCount += 1;
        });
        emptyResult.hidden = visibleCount > 0;
      };
      searchInput.addEventListener("input", filterLanguages);
      searchInput.addEventListener("pointerdown", stopLanguagePickerEvent);
      searchInput.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          removeLanguageMenu();
          languageTrigger?.focus();
          return;
        }
        if (event.key !== "ArrowDown") return;
        const firstVisibleItem = Array.from(viewport.querySelectorAll<HTMLButtonElement>('[role="option"]'))
          .find((item) => !item.hidden);
        if (firstVisibleItem) {
          event.preventDefault();
          firstVisibleItem.focus();
        }
      });
      menu.append(searchWrap, viewport, emptyResult);
      document.body.appendChild(menu);
      languageMenu = menu;
      closeLanguageMenu = removeLanguageMenu;
      closeActiveCodeLanguageMenu = removeLanguageMenu;
      document.addEventListener("pointerdown", handleLanguageMenuOutsidePointer, true);
      document.addEventListener("keydown", handleLanguageMenuKeyDown, true);
      window.addEventListener("resize", removeLanguageMenu);
      window.addEventListener("scroll", handleLanguageMenuScroll, true);
      positionLanguageMenu(menu);
      window.requestAnimationFrame(() => {
        searchInput.focus();
        selectedItem?.scrollIntoView({ block: "nearest" });
      });
    };
    const handleLanguageTriggerClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (languageMenu) removeLanguageMenu();
      else openLanguageMenu();
    };
    const handleLanguageTriggerKeyDown = (event: KeyboardEvent) => {
      if (isComposingKey(event)) return;
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

  const visibleDefaultItems = getDefaultReactSlashMenuItems(editor).filter((item) => {
    const title = item.title.trim().toLocaleLowerCase();
    return !["video", "audio", "비디오", "오디오"].includes(title);
  });

  return [...visibleDefaultItems, addPage, addDatabase];
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
    if (saved) {
      return {
        ...defaultPageSettings,
        ...(JSON.parse(saved) as Partial<PageSettings>),
        publicAccess: false,
      };
    }
  } catch {
    // Settings fall back to a clean, readable page.
  }
  return defaultPageSettings;
}

function getInitialPages(): StoredPages {
  const homePageTitle = getHomePageTitle();
  const storedPages = readStoredPages();
  if (storedPages?.[ROOT_PAGE_ID]) {
    let changed = false;
    const previousGeneratedHomeTitle = window.localStorage.getItem(HOME_PAGE_TITLE_STORAGE_KEY);
    const storedHomeTitle = storedPages[ROOT_PAGE_ID].title;
    const shouldMigrateHomeTitle = previousGeneratedHomeTitle !== homePageTitle
      && (
        !storedHomeTitle
        || storedHomeTitle === previousGeneratedHomeTitle
        || storedHomeTitle === "내이름의 홈 공간입니다."
        || storedHomeTitle === "나의 홈"
      );
    const normalizedPages = Object.fromEntries(
      Object.values(storedPages)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((page, index) => {
          const normalizedPage: StoredPage = {
            ...page,
            title: page.id === ROOT_PAGE_ID && shouldMigrateHomeTitle ? homePageTitle : page.title,
            settings: {
              ...defaultPageSettings,
              ...page.settings,
              publicAccess: page.id === ROOT_PAGE_ID ? false : Boolean(page.settings.publicAccess),
            },
            folderId: typeof page.folderId === "string" ? page.folderId : null,
            order: typeof page.order === "number" ? page.order : index,
            favoritedAt: page.id === ROOT_PAGE_ID
              ? null
              : typeof page.favoritedAt === "string" ? page.favoritedAt : null,
          };
          if (
            page.folderId === undefined
            || page.order === undefined
            || page.favoritedAt === undefined
            || page.settings.publicAccess === undefined
            || (page.id === ROOT_PAGE_ID && (page.favoritedAt !== null || page.settings.publicAccess))
            || (page.id === ROOT_PAGE_ID && shouldMigrateHomeTitle)
          ) changed = true;
          return [page.id, normalizedPage];
        }),
    );
    if (changed) {
      persistStoredPages(normalizedPages);
      window.localStorage.setItem(TITLE_STORAGE_KEY, normalizedPages[ROOT_PAGE_ID].title);
    }
    window.localStorage.setItem(HOME_PAGE_TITLE_STORAGE_KEY, homePageTitle);
    return normalizedPages;
  }

  const now = new Date().toISOString();
  const rootPage: StoredPage = {
    id: ROOT_PAGE_ID,
    parentId: null,
    folderId: null,
    order: 0,
    title: homePageTitle,
    settings: getSavedPageSettings(),
    blocks: getSavedBlocks(),
    archived: window.localStorage.getItem(PAGE_ARCHIVED_STORAGE_KEY) === "true",
    favoritedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const pages = { [ROOT_PAGE_ID]: rootPage };
  persistStoredPages(pages);
  window.localStorage.setItem(TITLE_STORAGE_KEY, homePageTitle);
  window.localStorage.setItem(HOME_PAGE_TITLE_STORAGE_KEY, homePageTitle);
  return pages;
}

const sameServerValue = jsonEqual;

type PageServerPatch = Partial<Pick<
  StoredPage,
  "parentId" | "folderId" | "order" | "title" | "settings" | "blocks" | "archived" | "revision"
>>;

function getPageServerPatch(previous: StoredPage, next: StoredPage): PageServerPatch {
  const permission = previous.permission ?? next.permission ?? "owner";
  const patch: PageServerPatch = {};
  if (permission === "owner") {
    if (previous.parentId !== next.parentId) patch.parentId = next.parentId;
    if (previous.folderId !== next.folderId) patch.folderId = next.folderId;
    if (previous.order !== next.order) patch.order = next.order;
    if (previous.archived !== next.archived) patch.archived = next.archived;
  }
  if (permission !== "view") {
    if (previous.title !== next.title) patch.title = next.title;
    if (!sameServerValue(previous.settings, next.settings)) patch.settings = next.settings;
    if (!sameServerValue(previous.blocks, next.blocks)) patch.blocks = next.blocks;
  }
  return patch;
}

function getPageEditableSnapshot(page: StoredPage) {
  return {
    parentId: page.parentId,
    folderId: page.folderId,
    order: page.order,
    title: page.title,
    settings: page.settings,
    blocks: page.blocks,
    archived: page.archived,
  };
}

type RealtimeBlockPatch = {
  blocks: PartialBlock[];
  changedBlockIds: string[];
  deletedBlockIds: string[];
  structural: boolean;
};

function realtimeBlockId(block: PartialBlock): string {
  return String((block as PartialBlock & { id?: string }).id ?? "");
}

function cloneRealtimeBlocks(blocks: PartialBlock[]): PartialBlock[] {
  return JSON.parse(JSON.stringify(blocks)) as PartialBlock[];
}

function buildRealtimeBlockPatch(previous: PartialBlock[], next: PartialBlock[]): RealtimeBlockPatch | null {
  const previousById = new Map(previous.map((block) => [realtimeBlockId(block), block]));
  const nextById = new Map(next.map((block) => [realtimeBlockId(block), block]));
  const previousIds = previous.map(realtimeBlockId).filter(Boolean);
  const nextIds = next.map(realtimeBlockId).filter(Boolean);
  if (nextIds.length !== next.length) return null;

  const changedBlockIds = nextIds.filter((id) => {
    const previousBlock = previousById.get(id);
    const nextBlock = nextById.get(id);
    return !previousBlock || !sameServerValue(previousBlock, nextBlock);
  });
  const deletedBlockIds = previousIds.filter((id) => !nextById.has(id));
  const structural = previousIds.length !== nextIds.length
    || previousIds.some((id, index) => nextIds[index] !== id);
  if (!structural && changedBlockIds.length === 0 && deletedBlockIds.length === 0) return null;
  return {
    blocks: cloneRealtimeBlocks(next),
    changedBlockIds,
    deletedBlockIds,
    structural,
  };
}

function storedPageFromServer(page: ServerPage): StoredPage {
  return {
    id: page.id,
    parentId: page.parentId,
    folderId: page.folderId,
    order: page.order,
    title: page.title,
    settings: { ...defaultPageSettings, ...page.settings },
    blocks: page.blocks?.length ? page.blocks : [{ type: "paragraph", content: "" }],
    archived: page.archived,
    favoritedAt: page.favoritedAt,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    ownerId: page.ownerId,
    permission: page.permission,
    revision: page.revision,
  };
}

function storedHomeFromServer(home: ServerHome): StoredPage {
  return {
    id: ROOT_PAGE_ID,
    parentId: null,
    folderId: null,
    order: 0,
    title: home.title,
    settings: { ...defaultPageSettings, ...home.settings, publicAccess: false },
    blocks: home.blocks?.length ? home.blocks : [{ type: "paragraph", content: "" }],
    archived: false,
    favoritedAt: null,
    createdAt: home.createdAt,
    updatedAt: home.updatedAt,
    ownerId: home.ownerId,
    permission: "owner",
    revision: home.revision,
  };
}

function storedFolderFromServer(folder: ServerFolder): StoredFolder {
  return {
    id: folder.id,
    parentId: folder.parentId,
    title: folder.title,
    order: folder.order,
    collapsed: folder.collapsed,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

function storedShareFromServer(share: ServerShare): PageShareRecord {
  return {
    pageId: share.pageId,
    ownerId: share.owner.id,
    ownerName: share.owner.name,
    members: share.members.map((member) => ({
      userId: member.user.id,
      permission: member.permission,
      sharedAt: member.sharedAt,
    })),
    updatedAt: share.updatedAt,
  };
}

function storedCommentFromServer(thread: ServerCommentThread): BlockCommentThread {
  return {
    id: thread.id,
    pageId: thread.pageId,
    blockId: thread.blockId,
    blockPreview: thread.blockPreview,
    resolvedAt: thread.resolvedAt,
    resolvedBy: thread.resolvedBy,
    updatedAt: thread.updatedAt,
    messages: thread.messages.map((message) => ({
      id: message.id,
      parentId: message.parentId,
      authorId: message.authorId,
      authorName: message.authorName,
      authorEmail: message.authorEmail,
      body: message.body,
      createdAt: message.createdAt,
    })),
  };
}

function notificationTimeLabel(createdAt: string) {
  const elapsed = Math.max(0, Date.now() - new Date(createdAt).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(new Date(createdAt));
}

function inboxNotificationFromServer(notification: ServerNotification): InboxNotification {
  return {
    id: notification.id,
    kind: notification.kind,
    title: notification.title,
    description: notification.description,
    time: notificationTimeLabel(notification.createdAt),
    unread: notification.readAt === null,
    pageId: notification.pageId,
  };
}

function pageDepth(pages: StoredPages, page: StoredPage) {
  let depth = 0;
  let parentId = page.parentId;
  const seen = new Set([page.id]);
  while (parentId && pages[parentId] && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = pages[parentId].parentId;
  }
  return depth;
}

function folderDepth(folders: StoredFolders, folder: StoredFolder) {
  let depth = 0;
  let parentId = folder.parentId;
  const seen = new Set([folder.id]);
  while (parentId && folders[parentId] && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = folders[parentId].parentId;
  }
  return depth;
}

function getPageLink(pageId: string, isPublic: boolean) {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set(isPublic ? "publicPage" : "page", pageId);
  return url.toString();
}

function App() {
  const publicPageId = useMemo(() => new URLSearchParams(window.location.search).get("publicPage"), []);
  const linkedPageId = useMemo(() => new URLSearchParams(window.location.search).get("page"), []);
  const initialAuthUser = useMemo(bootstrapLocalAuth, []);
  const initialPages = useMemo(getInitialPages, []);
  const initialFolders = useMemo(readStoredFolders, []);
  const initialPageShares = useMemo(readStoredPageShares, []);
  const initialBlockComments = useMemo(readStoredBlockComments, []);
  const initialPageId = linkedPageId && initialPages[linkedPageId] ? linkedPageId : ROOT_PAGE_ID;
  const rootPage = initialPages[ROOT_PAGE_ID];
  const initialPage = initialPages[initialPageId] ?? rootPage;
  const finishDetachedUploadRef = useRef<(pageId: string, blockId: string, url: string | null) => void>(() => undefined);
  const editor = useCreateBlockNote({
    schema: editorSchema,
    initialContent: initialPage.blocks as never,
    dictionary: NODI_DICTIONARY,
    pasteHandler: ({ event, editor: activeEditor, defaultPasteHandler }) => {
      const plainText = event.clipboardData?.getData("text/plain") ?? "";
      const hasFiles = event.clipboardData?.files.length;
      if (hasFiles && insertAttachmentFiles(event, activeEditor)) return true;
      const isCodeBlock = activeEditor.transact((transaction) => (
        transaction.selection.$from.parent.type.spec.code === true
        && transaction.selection.$to.parent.type.spec.code === true
      ));
      if (!hasFiles && isCodeBlock && plainText.length > 0) {
        const normalizedText = codeBlockClipboardText(event.clipboardData);
        const { state, dispatch } = activeEditor.prosemirrorView;
        dispatch(state.tr
          .insertText(normalizedText, state.selection.from, state.selection.to)
          .scrollIntoView());
        return true;
      }
      if (!hasFiles && !isCodeBlock && pasteNodiClipboardBlocks(activeEditor, event.clipboardData)) {
        return true;
      }
      if (!hasFiles && !isCodeBlock && pasteFencedCodeClipboard(activeEditor, event.clipboardData)) {
        return true;
      }
      if (!hasFiles && !isCodeBlock && pasteStructuredMarkdownClipboard(activeEditor, event.clipboardData)) {
        return true;
      }
      return defaultPasteHandler();
    },
    uploadFile: async (file, blockId) => {
      const ownerPageId = currentPageIdRef.current;
      let url: string;
      try {
        url = await uploadNodiAttachment(file, {
          authenticated: Boolean(readLocalAuthUser()),
          pageId: ownerPageId === ROOT_PAGE_ID ? null : ownerPageId,
        });
      } catch (error) {
        if (blockId) finishDetachedUploadRef.current(ownerPageId, blockId, null);
        throw error;
      }
      if (ownerPageId !== currentPageIdRef.current || !blockId || !editor.getBlock(blockId)) {
        if (blockId) finishDetachedUploadRef.current(ownerPageId, blockId, url);
        // FilePanel catches this too; it must not update the reused editor.
        throw new Error("첨부를 원래 페이지에 반영했습니다.");
      }
      if (!currentPageIsEditable()) throw new Error("페이지를 편집할 수 없습니다.");
      return url;
    },
  });
  const [pages, setPages] = useState<StoredPages>(initialPages);
  const [folders, setFolders] = useState<StoredFolders>(initialFolders);
  const [currentPageId, setCurrentPageId] = useState(initialPageId);
  const [title, setTitle] = useState(initialPage.title);
  const [authUser, setAuthUser] = useState<LocalAuthUser | null>(initialAuthUser);
  const [authDialogMode, setAuthDialogMode] = useState<AuthDialogMode | null>(null);
  const [userName, setUserName] = useState(() => initialAuthUser?.name ?? "게스트");
  const [registrationDirectoryRevision, setRegistrationDirectoryRevision] = useState(0);
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>("pages");
  const [pageShares, setPageShares] = useState<StoredPageShares>(initialPageShares);
  const [blockComments, setBlockComments] = useState<StoredBlockComments>(initialBlockComments);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [appTheme, setAppTheme] = useState<AppTheme>(getInitialAppTheme);
  const [localSaveState, setLocalSaveState] = useState<LocalSaveState>("saved");
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeClosing, setNoticeClosing] = useState(false);
  const [pageSettings, setPageSettings] = useState<PageSettings>(initialPage.settings);
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const [drawerPageId, setDrawerPageId] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<"draft" | "link" | "share" | null>(null);
  const [isArchived, setIsArchived] = useState(initialPage.archived);
  const [pendingPageDeletion, setPendingPageDeletion] = useState<string | null>(null);
  const [pendingPermanentPageDeletion, setPendingPermanentPageDeletion] = useState<string | "all" | null>(null);
  const [trashBusyPageId, setTrashBusyPageId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [sidebarContextMenu, setSidebarContextMenu] = useState<SidebarContextMenuState | null>(null);
  const [sidebarCreateMenuOpen, setSidebarCreateMenuOpen] = useState(false);
  const [sidebarRename, setSidebarRename] = useState<SidebarRenameState | null>(null);
  const [sidebarDraggedPageId, setSidebarDraggedPageId] = useState<string | null>(null);
  const [sidebarPageDropTarget, setSidebarPageDropTarget] = useState<SidebarPageDropTarget | null>(null);
  const [sidebarDraggedFolderId, setSidebarDraggedFolderId] = useState<string | null>(null);
  const [sidebarFolderDropTarget, setSidebarFolderDropTarget] = useState<SidebarFolderDropTarget | null>(null);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxNotifications, setInboxNotifications] = useState<InboxNotification[]>([]);
  const [serverDirectoryUsers, setServerDirectoryUsers] = useState<LocalAuthUser[]>([]);
  const [starterPresets, setStarterPresets] = useState<StarterPreset[]>(readStarterPresets);
  const [tagOptions, setTagOptions] = useState<TagOption[]>(DEFAULT_TAG_OPTIONS);
  const [starterDockPageId, setStarterDockPageId] = useState<string | null>(null);
  const [selectedStarterPreset, setSelectedStarterPreset] = useState<string | null>(null);
  const presetApplyVersionRef = useRef(0);
  const [pendingBlockDeletion, setPendingBlockDeletion] = useState<string[] | null>(null);
  const [activeCommentBlockId, setActiveCommentBlockId] = useState<string | null>(null);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [realtimeParticipants, setRealtimeParticipants] = useState<ServerRealtimeParticipant[]>([]);
  const [publicDatabaseStates, setPublicDatabaseStates] = useState<Record<string, DatabaseState>>({});
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const selectedBlockIdsRef = useRef<string[]>([]);
  const [isBlockSelectionMode, setIsBlockSelectionMode] = useState(false);
  const [blockSelectionActionMenu, setBlockSelectionActionMenu] = useState<BlockSelectionActionMenu | null>(null);
  const [isBlockDragging, setIsBlockDragging] = useState(false);
  const [blockDropIndicator, setBlockDropIndicator] = useState<BlockDropIndicator | null>(null);
  const [blockSelectionMarquee, setBlockSelectionMarquee] = useState<BlockSelectionMarquee | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editorStageRef = useRef<HTMLElement>(null);
  const favoritesScrollRef = useRef<HTMLDivElement>(null);
  const pagesScrollRef = useRef<HTMLDivElement>(null);
  const editorContextRef = useRef<HTMLDivElement>(null);
  const blockSelectionToolbarRef = useRef<HTMLDivElement>(null);
  const blockSelectionActionMenuRef = useRef<HTMLDivElement>(null);
  const blockSelectionOverlayRefs = useRef(new Map<string, HTMLDivElement>());
  const blockCommentMarkerRefs = useRef(new Map<string, HTMLButtonElement>());
  const blockPresenceMarkerRefs = useRef(new Map<string, HTMLSpanElement>());
  const localSaveStateTimerRef = useRef<number | null>(null);
  const inboxRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const inboxLastRefreshAtRef = useRef(0);
  const pagesRef = useRef(initialPages);
  const foldersRef = useRef(initialFolders);
  const serverWorkspaceReadyRef = useRef(false);
  const serverPagesSnapshotRef = useRef<StoredPages>(initialPages);
  const pageSharesRef = useRef<StoredPageShares>(initialPageShares);
  const realtimeSocketRef = useRef<WebSocket | null>(null);
  const realtimeConnectedPageIdRef = useRef<string | null>(null);
  const realtimeReconnectTimerRef = useRef<number | null>(null);
  const realtimeBlocksTimerRef = useRef<number | null>(null);
  const realtimeLocalBlocksRef = useRef<PartialBlock[]>(cloneRealtimeBlocks(initialPage.blocks));
  const realtimePendingBlocksRef = useRef<{ pageId: string; base: PartialBlock[]; next: PartialBlock[] } | null>(null);
  const realtimeProtectedBlockIdsRef = useRef(new Set<string>());
  const realtimeProtectedDeletedBlockIdsRef = useRef(new Set<string>());
  const realtimePresenceBlockRef = useRef<string | null>(null);
  const serverFoldersSnapshotRef = useRef<StoredFolders>(initialFolders);
  const serverPresetsSnapshotRef = useRef<StarterPreset[]>([]);
  const serverPreferencesRef = useRef<NodiPreferences>({});
  const serverPreferencesRevisionRef = useRef<number | undefined>(undefined);
  const serverPreferencesReadyRef = useRef(false);
  const serverThemeSnapshotRef = useRef<AppTheme | null>(null);
  const serverMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const serverPagesTimerRef = useRef<number | null>(null);
  const serverFoldersTimerRef = useRef<number | null>(null);
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
  const currentPageIdRef = useRef(initialPageId);
  const openPageRef = useRef<(pageId: string, options?: PageNavigationOptions) => void>(() => undefined);
  const editorPageIdRef = useRef(initialPageId);
  const editorLoadVersionRef = useRef(0);
  const loadingPageRef = useRef(false);
  const blockSelectionModeRef = useRef(false);
  const blockSelectionAnchorRef = useRef<string | null>(null);
  const marginSelectionRef = useRef<{ pointerId: number; anchorId: string } | null>(null);
  const marqueeSelectionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startContentY: number;
    lastClientX: number;
    lastClientY: number;
    dragging: boolean;
    clickedBlockId: string | null;
    initialBlockIds: string[];
    additiveSelection: boolean;
    preserveClick: boolean;
    spansEditorWidth: boolean;
  } | null>(null);
  const refreshMarqueeSelectionRef = useRef<(() => void) | null>(null);
  const marqueeAutoScrollFrameRef = useRef<number | null>(null);
  const marqueeApplyFrameRef = useRef<number | null>(null);
  const blockDragRef = useRef<{
    pointerId: number;
    blockIds: string[];
    startX: number;
    startY: number;
    dragging: boolean;
    dropTarget: { blockId: string; placement: "before" | "after" | "nested" } | null;
  } | null>(null);
  const suppressEditorClickRef = useRef(false);
  const isDarkMode = appTheme === "dark";
  const primaryShortcutLabel = useMemo(getPrimaryShortcutLabel, []);

  const loadEditorPage = (pageId: string, blocks: PartialBlock[], focusTitle = false) => {
    const version = ++editorLoadVersionRef.current;
    loadingPageRef.current = true;
    editorPageIdRef.current = pageId;
    replacePageDocument(editor, blocks);
    window.requestAnimationFrame(() => {
      // An older navigation must not finish a newer document's load.
      if (version !== editorLoadVersionRef.current) return;
      loadingPageRef.current = false;
      if (focusTitle) titleInputRef.current?.focus();
    });
  };

  const blockSelectionActionMenuPositionKey = blockSelectionActionMenu
    ? [
        blockSelectionActionMenu.kind,
        blockSelectionActionMenu.anchor.top,
        blockSelectionActionMenu.anchor.right,
        blockSelectionActionMenu.anchor.bottom,
      ].join(":")
    : "closed";

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appTheme;
    document.documentElement.style.colorScheme = appTheme;
    try {
      window.localStorage.setItem(APP_THEME_STORAGE_KEY, appTheme);
    } catch {
      // The selected theme still applies for the current session.
    }
  }, [appTheme]);

  useEffect(() => () => {
    if (localSaveStateTimerRef.current) window.clearTimeout(localSaveStateTimerRef.current);
    if (realtimeBlocksTimerRef.current) window.clearTimeout(realtimeBlocksTimerRef.current);
    if (marqueeApplyFrameRef.current !== null) {
      window.cancelAnimationFrame(marqueeApplyFrameRef.current);
    }
    if (marqueeAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(marqueeAutoScrollFrameRef.current);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void restoreServerAuth().then((user) => {
      if (!active) return;
      setAuthUser(user);
      setUserName(user?.name ?? "게스트");
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!publicPageId) return;
    let active = true;
    setLocalSaveState("saving");
    void workspaceApi.getPublicPage(publicPageId)
      .then((payload) => {
        if (!active) return;
        const childPageTitles = Object.fromEntries(payload.childPages.map((page) => [page.id, page.title]));
        const hydratedBlocks = hydratePublicResourceBlocks(
          (payload.page.blocks ?? []) as PartialBlock[],
          childPageTitles,
        );
        const publicPage = storedPageFromServer({
          ...payload.page,
          blocks: hydratedBlocks,
          permission: "view",
        });
        setPublicDatabaseStates(Object.fromEntries(
          payload.databases.map((database) => [database.id, database.state as DatabaseState]),
        ));
        const nextPages = { [publicPage.id]: publicPage };
        loadingPageRef.current = true;
        pagesRef.current = nextPages;
        foldersRef.current = {};
        currentPageIdRef.current = publicPage.id;
        setPages(nextPages);
        setFolders({});
        setPageShares({});
        setBlockComments({});
        setCurrentPageId(publicPage.id);
        setTitle(publicPage.title);
        setPageSettings(publicPage.settings);
        setIsArchived(false);
        setWorkspaceSection("pages");
        setSidebarOpen(false);
        loadEditorPage(publicPage.id, publicPage.blocks);
        setLocalSaveState("saved");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLocalSaveState("error");
        setNotice(error instanceof Error ? error.message : "공개 페이지를 불러오지 못했어요");
      });
    return () => {
      active = false;
    };
  }, [editor, publicPageId]);

  useEffect(() => {
    if (!sidebarOpen) setInboxOpen(false);
  }, [sidebarOpen]);

  useEffect(() => {
    if (rightPanel || pageSettingsOpen) setActiveCommentBlockId(null);
  }, [rightPanel, pageSettingsOpen]);

  const commitPages = (nextPages: StoredPages) => {
    pagesRef.current = nextPages;
    setPages(nextPages);
    setLocalSaveState("saving");
    if (localSaveStateTimerRef.current) {
      window.clearTimeout(localSaveStateTimerRef.current);
      localSaveStateTimerRef.current = null;
    }
    try {
      persistStoredPages(nextPages);
      if (!authUser || !serverWorkspaceReadyRef.current) {
        localSaveStateTimerRef.current = window.setTimeout(() => {
          localSaveStateTimerRef.current = null;
          setLocalSaveState("saved");
        }, 320);
      }
      return true;
    } catch {
      setLocalSaveState("error");
      setNotice("로컬 저장 공간이 부족하거나 사용할 수 없어요");
      return false;
    }
  };

  const commitFolders = (nextFolders: StoredFolders) => {
    foldersRef.current = nextFolders;
    setFolders(nextFolders);
    persistStoredFolders(nextFolders);
  };

  const commitPageShares = (updater: (current: StoredPageShares) => StoredPageShares) => {
    setPageShares((current) => {
      const nextPageShares = updater(current);
      persistStoredPageShares(nextPageShares);
      return nextPageShares;
    });
  };

  const commitBlockComments = (updater: (current: StoredBlockComments) => StoredBlockComments) => {
    setBlockComments((current) => {
      const nextComments = updater(current);
      persistStoredBlockComments(nextComments);
      return nextComments;
    });
  };

  const enqueueServerMutation = (task: () => Promise<void>) => {
    serverMutationQueueRef.current = serverMutationQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await task();
          setLocalSaveState("saved");
        } catch (error) {
          setLocalSaveState("error");
          setNotice(error instanceof Error ? error.message : "서버에 변경 사항을 저장하지 못했어요");
        }
      });
  };

  const acknowledgePageSave = (saved: StoredPage) => {
    const previous = serverPagesSnapshotRef.current[saved.id];
    // A realtime acknowledgement may have arrived before the HTTP response.
    if ((previous?.revision ?? 0) > (saved.revision ?? 0)) return;
    serverPagesSnapshotRef.current = { ...serverPagesSnapshotRef.current, [saved.id]: saved };
    const local = pagesRef.current[saved.id];
    if (!local) return;
    const nextPages = {
      ...pagesRef.current,
      [saved.id]: { ...local, ownerId: saved.ownerId, permission: saved.permission, revision: saved.revision },
    };
    pagesRef.current = nextPages;
    persistStoredPages(nextPages);
    setPages(nextPages);
  };

  const realtimeSocketIsReady = (pageId: string) => (
    realtimeConnectedPageIdRef.current === pageId
    && realtimeSocketRef.current?.readyState === WebSocket.OPEN
  );

  const currentPageIsEditable = () => {
    const page = pagesRef.current[currentPageIdRef.current];
    return Boolean(
      page
      && page.permission !== "view"
      && !page.settings.lockPage
      && !publicPageId,
    );
  };

  const flushRealtimeBlockPatch = () => {
    if (realtimeBlocksTimerRef.current) {
      window.clearTimeout(realtimeBlocksTimerRef.current);
      realtimeBlocksTimerRef.current = null;
    }
    const pending = realtimePendingBlocksRef.current;
    realtimePendingBlocksRef.current = null;
    if (!pending || !realtimeSocketIsReady(pending.pageId)) return false;
    const patch = buildRealtimeBlockPatch(pending.base, pending.next);
    if (!patch) return true;
    patch.changedBlockIds.forEach((id) => realtimeProtectedBlockIdsRef.current.add(id));
    patch.deletedBlockIds.forEach((id) => {
      realtimeProtectedBlockIdsRef.current.delete(id);
      realtimeProtectedDeletedBlockIdsRef.current.add(id);
    });
    realtimeSocketRef.current?.send(JSON.stringify({
      type: "page.blocks.patch",
      ...patch,
    }));
    setLocalSaveState("saving");
    return true;
  };

  const queueRealtimeBlockPatch = (blocks: PartialBlock[]) => {
    if (!currentPageIsEditable()) return false;
    const pageId = currentPageIdRef.current;
    if (!realtimeSocketIsReady(pageId)) return false;
    const nextBlocks = cloneRealtimeBlocks(blocks);
    const pending = realtimePendingBlocksRef.current;
    realtimePendingBlocksRef.current = pending?.pageId === pageId
      ? { ...pending, next: nextBlocks }
      : { pageId, base: cloneRealtimeBlocks(realtimeLocalBlocksRef.current), next: nextBlocks };
    realtimeLocalBlocksRef.current = nextBlocks;
    if (!realtimeBlocksTimerRef.current) {
      realtimeBlocksTimerRef.current = window.setTimeout(flushRealtimeBlockPatch, 70);
    }
    return true;
  };

  const sendRealtimePresence = (activeBlockId: string | null) => {
    const pageId = currentPageIdRef.current;
    const normalizedBlockId = activeBlockId && currentPageIsEditable() ? activeBlockId : null;
    if (realtimePresenceBlockRef.current === normalizedBlockId) return;
    realtimePresenceBlockRef.current = normalizedBlockId;
    if (!realtimeSocketIsReady(pageId)) return;
    realtimeSocketRef.current?.send(JSON.stringify({
      type: "presence.update",
      activeBlockId: normalizedBlockId ?? "",
    }));
  };

  useEffect(() => {
    if (!authUser || publicPageId) {
      serverWorkspaceReadyRef.current = false;
      setInboxNotifications([]);
      return;
    }
    let active = true;
    serverWorkspaceReadyRef.current = false;
    setInboxNotifications([]);

    // The sidebar share badge should not wait for the rest of the workspace
    // bootstrap (guest migration, presets, tags, directory, and comments).
    // Reuse this request in the full bootstrap below so signing in does not
    // issue a duplicate /shares request.
    const serverSharesPromise = workspaceApi.listAllShares();
    void serverSharesPromise
      .then((serverShares) => {
        if (!active) return;
        const nextPageShares = Object.fromEntries(serverShares.map((share) => [
          share.pageId,
          storedShareFromServer(share),
        ])) as StoredPageShares;
        persistStoredPageShares(nextPageShares);
        setPageShares(nextPageShares);
      })
      .catch(() => {
        // The full bootstrap reports the request failure through its existing
        // error path. Keep the cached badge visible in the meantime.
      });

    void (async () => {
      try {
        const migrationKey = `nodi:guest-workspace-migrated:${authUser.id}:v1`;
        if (!window.localStorage.getItem(migrationKey)) {
          const localPages = pagesRef.current;
          const localFolders = foldersRef.current;
          const guestPages = Object.values(localPages).filter((page) => page.id !== ROOT_PAGE_ID && !page.ownerId);
          const requiredFolderIds = new Set<string>();
          guestPages.forEach((page) => {
            let folderId = page.folderId;
            while (folderId && localFolders[folderId] && !requiredFolderIds.has(folderId)) {
              requiredFolderIds.add(folderId);
              folderId = localFolders[folderId].parentId;
            }
          });
          const folderIdMap = new Map(Array.from(requiredFolderIds).map((folderId) => [folderId, makeId("folder-import")]));
          const pageIdMap = new Map(guestPages.map((page) => [page.id, makeId("page-import")]));
          const foldersToImport = Array.from(requiredFolderIds)
            .map((folderId) => localFolders[folderId])
            .filter(Boolean)
            .sort((left, right) => folderDepth(localFolders, left) - folderDepth(localFolders, right));
          for (const folder of foldersToImport) {
            await workspaceApi.createFolder({
              ...folder,
              id: folderIdMap.get(folder.id)!,
              parentId: folder.parentId ? folderIdMap.get(folder.parentId) ?? null : null,
            });
          }
          const pagesToImport = [...guestPages].sort((left, right) => pageDepth(localPages, left) - pageDepth(localPages, right));
          for (const page of pagesToImport) {
            await workspaceApi.createPage({
              ...page,
              id: pageIdMap.get(page.id)!,
              parentId: page.parentId ? pageIdMap.get(page.parentId) ?? null : null,
              folderId: page.folderId ? folderIdMap.get(page.folderId) ?? null : null,
              title: page.title || "가져온 게스트 페이지",
              archived: false,
              favoritedAt: null,
              ownerId: undefined,
              permission: undefined,
              revision: undefined,
            });
          }
          const guestHome = localPages[ROOT_PAGE_ID];
          if (guestHome && !guestHome.ownerId && !sameServerValue(guestHome.blocks, defaultBlocks)) {
            await workspaceApi.createPage({
              ...guestHome,
              id: makeId("page-import"),
              parentId: null,
              folderId: null,
              order: Math.max(0, ...guestPages.map((page) => page.order)) + 1,
              title: "가져온 게스트 메모",
              settings: { ...guestHome.settings, publicAccess: false },
              archived: false,
              favoritedAt: null,
              ownerId: undefined,
              permission: undefined,
              revision: undefined,
            });
          }
          window.localStorage.setItem(migrationKey, new Date().toISOString());
        }

        const [home, details, serverFolders, directoryUsers, serverNotifications, serverPreferences, existingServerPresets, existingServerTags, serverShares, serverComments] = await Promise.all([
          workspaceApi.getHome(),
          workspaceApi.listPages(true, true),
          workspaceApi.listFolders(),
          authApi.searchUsers(""),
          workspaceApi.notifications(),
          workspaceApi.getPreferences<NodiPreferences>(),
          workspaceApi.listPresets(),
          workspaceApi.listTags(),
          serverSharesPromise,
          workspaceApi.listAllComments(),
        ]);
        const serverPresets = existingServerPresets.length > 0
          ? existingServerPresets
          : await Promise.all(readStarterPresets().map((preset, index) => workspaceApi.createPreset(preset, index)));
        const serverTags = existingServerTags.length > 0
          ? existingServerTags
          : await Promise.all(DEFAULT_TAG_OPTIONS.map((tag, index) => workspaceApi.createTag(tag, index)));
        if (!active) return;

        const backupKey = `nodi:local-workspace-backup:${authUser.id}`;
        if (!window.localStorage.getItem(backupKey)) {
          window.localStorage.setItem(backupKey, JSON.stringify({
            pages: pagesRef.current,
            folders: foldersRef.current,
            savedAt: new Date().toISOString(),
          }));
        }

        const nextPages: StoredPages = {
          [ROOT_PAGE_ID]: storedHomeFromServer(home),
        };
        details.forEach((page) => {
          nextPages[page.id] = storedPageFromServer(page);
        });
        const nextFolders = Object.fromEntries(serverFolders.map((folder) => [
          folder.id,
          storedFolderFromServer(folder),
        ])) as StoredFolders;

        serverPagesSnapshotRef.current = nextPages;
        serverFoldersSnapshotRef.current = nextFolders;
        pagesRef.current = nextPages;
        foldersRef.current = nextFolders;
        persistStoredPages(nextPages);
        persistStoredFolders(nextFolders);
        const nextPageShares = Object.fromEntries(serverShares.map((share) => [
          share.pageId,
          storedShareFromServer(share),
        ])) as StoredPageShares;
        const nextBlockComments = Object.fromEntries(serverComments.map((thread) => [
          thread.id,
          storedCommentFromServer(thread),
        ])) as StoredBlockComments;
        persistStoredPageShares(nextPageShares);
        persistStoredBlockComments(nextBlockComments);
        setPages(nextPages);
        setFolders(nextFolders);
        setPageShares(nextPageShares);
        setBlockComments(nextBlockComments);
        setServerDirectoryUsers(directoryUsers);
        setInboxNotifications(serverNotifications.map(inboxNotificationFromServer));
        const nextPresets = serverPresets.map(({ id, name, icon, pageTitle, blocks, sourceFileName }) => ({
          id,
          name,
          icon,
          pageTitle,
          blocks,
          sourceFileName,
        }));
        serverPresetsSnapshotRef.current = nextPresets;
        setStarterPresets(nextPresets);
        persistStarterPresets(nextPresets);
        setTagOptions(serverTags.map(({ id, name, color }) => ({ id, name, color })));
        serverPreferencesRef.current = serverPreferences.preferences;
        serverPreferencesRevisionRef.current = serverPreferences.revision;
        const preferredTheme = serverPreferences.preferences.theme;
        if (preferredTheme === "light" || preferredTheme === "dark") {
          serverThemeSnapshotRef.current = preferredTheme;
          setAppTheme(preferredTheme);
        } else {
          serverThemeSnapshotRef.current = appTheme;
        }
        serverPreferencesReadyRef.current = true;

        const requestedPageId = linkedPageId ?? currentPageIdRef.current;
        const nextPageId = nextPages[requestedPageId] ? requestedPageId : ROOT_PAGE_ID;
        const nextPage = nextPages[nextPageId];
        loadingPageRef.current = true;
        currentPageIdRef.current = nextPageId;
        setCurrentPageId(nextPageId);
        setWorkspaceSection(nextPageId !== ROOT_PAGE_ID && (nextPage.permission ?? "owner") !== "owner" ? "shared-page" : "pages");
        setTitle(nextPage.title);
        setPageSettings(nextPage.settings);
        setIsArchived(nextPage.archived);
        loadEditorPage(nextPageId, nextPage.blocks);
        serverWorkspaceReadyRef.current = true;
        setLocalSaveState("saved");
      } catch (error) {
        if (!active) return;
        serverWorkspaceReadyRef.current = false;
        serverPreferencesReadyRef.current = false;
        setNotice(error instanceof Error ? error.message : "서버 작업 공간을 불러오지 못했어요");
      }
    })();

    return () => {
      active = false;
      serverWorkspaceReadyRef.current = false;
      serverPreferencesReadyRef.current = false;
    };
  }, [authUser?.id, linkedPageId, publicPageId]);

  useEffect(() => {
    pageSharesRef.current = pageShares;
  }, [pageShares]);

  const refreshInbox = useCallback((options: { force?: boolean; reportError?: boolean } = {}) => {
    if (!authUser || publicPageId) return Promise.resolve();
    if (inboxRefreshPromiseRef.current) return inboxRefreshPromiseRef.current;
    if (!options.force && Date.now() - inboxLastRefreshAtRef.current < 5_000) return Promise.resolve();

    const request = Promise.all([
      workspaceApi.notifications(),
      workspaceApi.listAllShares(),
    ])
      .then(([serverNotifications, serverShares]) => {
        const nextPageShares = Object.fromEntries(serverShares.map((share) => [
          share.pageId,
          storedShareFromServer(share),
        ])) as StoredPageShares;
        pageSharesRef.current = nextPageShares;
        persistStoredPageShares(nextPageShares);
        setPageShares(nextPageShares);
        setInboxNotifications(serverNotifications.map(inboxNotificationFromServer));
        inboxLastRefreshAtRef.current = Date.now();
      })
      .catch((error: unknown) => {
        if (options.reportError) {
          setNotice(error instanceof Error ? error.message : "받은 편지함을 불러오지 못했어요");
        }
      })
      .finally(() => {
        if (inboxRefreshPromiseRef.current === request) inboxRefreshPromiseRef.current = null;
      });
    inboxRefreshPromiseRef.current = request;
    return request;
  }, [authUser?.id, publicPageId]);

  useEffect(() => {
    if (!authUser || publicPageId) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshInbox();
    };
    const timer = window.setInterval(refreshWhenVisible, 15_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [authUser?.id, publicPageId, refreshInbox]);

  useEffect(() => {
    if (!authUser || !serverPreferencesReadyRef.current || serverThemeSnapshotRef.current === appTheme) return;
    const nextPreferences = { ...serverPreferencesRef.current, theme: appTheme };
    enqueueServerMutation(async () => {
      const value = await workspaceApi.updatePreferences(nextPreferences, serverPreferencesRevisionRef.current);
      serverPreferencesRevisionRef.current = value.revision;
      serverPreferencesRef.current = value.preferences;
      serverThemeSnapshotRef.current = appTheme;
    });
  }, [appTheme, authUser?.id]);

  useEffect(() => {
    if (!authUser || !serverWorkspaceReadyRef.current) return;
    if (serverFoldersTimerRef.current) window.clearTimeout(serverFoldersTimerRef.current);
    serverFoldersTimerRef.current = window.setTimeout(() => {
      serverFoldersTimerRef.current = null;
      const after = folders;
      enqueueServerMutation(async () => {
        const before = serverFoldersSnapshotRef.current;
        if (sameServerValue(before, after)) return;
        const created = Object.values(after)
          .filter((folder) => !before[folder.id])
          .sort((left, right) => folderDepth(after, left) - folderDepth(after, right));
        for (const folder of created) await workspaceApi.createFolder(folder);

        for (const folder of Object.values(after)) {
          const previous = before[folder.id];
          if (!previous || sameServerValue(previous, folder)) continue;
          const patch: Pick<StoredFolder, "id"> & Partial<StoredFolder> = { id: folder.id };
          for (const key of ["parentId", "title", "order", "collapsed"] as const) {
            if (!sameServerValue(previous[key], folder[key])) Object.assign(patch, { [key]: folder[key] });
          }
          await workspaceApi.updateFolder(patch);
        }
        for (const folder of Object.values(before)) {
          if (!after[folder.id]) await workspaceApi.deleteFolder(folder.id);
        }
        serverFoldersSnapshotRef.current = after;
      });
    }, 350);
    return () => {
      if (serverFoldersTimerRef.current) window.clearTimeout(serverFoldersTimerRef.current);
    };
  }, [folders, authUser?.id]);

  useEffect(() => {
    if (!authUser || !serverWorkspaceReadyRef.current) return;
    if (serverPagesTimerRef.current) window.clearTimeout(serverPagesTimerRef.current);
    serverPagesTimerRef.current = window.setTimeout(() => {
      serverPagesTimerRef.current = null;
      enqueueServerMutation(async () => {
        // Queued work must use the latest draft, not the render that scheduled it.
        const after = pagesRef.current;
        const before = serverPagesSnapshotRef.current;
        if (sameServerValue(before, after)) return;
        const previousHome = before[ROOT_PAGE_ID];
        const nextHome = after[ROOT_PAGE_ID];
        if (previousHome && nextHome) {
          const homePatch: Partial<Pick<StoredPage, "title" | "settings" | "blocks" | "revision">> = {};
          if (previousHome.title !== nextHome.title) homePatch.title = nextHome.title;
          if (!sameServerValue(previousHome.settings, nextHome.settings)) homePatch.settings = nextHome.settings;
          if (!sameServerValue(previousHome.blocks, nextHome.blocks)) homePatch.blocks = nextHome.blocks;
          if (Object.keys(homePatch).length) {
            homePatch.revision = previousHome.revision;
            const savedHome = await workspaceApi.updateHome(homePatch);
            acknowledgePageSave(storedHomeFromServer(savedHome));
          }
        }

        const created = Object.values(after)
          .filter((page) => page.id !== ROOT_PAGE_ID && !before[page.id])
          .sort((left, right) => pageDepth(after, left) - pageDepth(after, right));
        for (const page of created) {
          const savedPage = await workspaceApi.createPage(page);
          acknowledgePageSave(storedPageFromServer(savedPage));
        }

        for (const page of Object.values(after)) {
          if (page.id === ROOT_PAGE_ID) continue;
          const previous = serverPagesSnapshotRef.current[page.id];
          if (!previous) continue;
          const patch = getPageServerPatch(previous, page);
          const isCollaborative = (page.permission ?? "owner") !== "owner"
            || (pageSharesRef.current[page.id]?.members.length ?? 0) > 0
            || realtimeSocketIsReady(page.id);
          // While the realtime room is connected, block mutations travel only
          // through the socket. Sending the same document through the HTTP
          // autosave path created duplicate revisions and stale conflicts.
          if (isCollaborative && realtimeSocketIsReady(page.id)) delete patch.blocks;
          if (Object.keys(patch).length) {
            if (!isCollaborative) patch.revision = previous.revision;
            const savedPage = await workspaceApi.updatePage(page.id, patch);
            acknowledgePageSave(storedPageFromServer(savedPage));
          }
          if (Boolean(previous.favoritedAt) !== Boolean(page.favoritedAt)) {
            await workspaceApi.favoritePage(page.id, Boolean(page.favoritedAt));
            const snapshot = serverPagesSnapshotRef.current[page.id];
            if (snapshot) serverPagesSnapshotRef.current = {
              ...serverPagesSnapshotRef.current,
              [page.id]: { ...snapshot, favoritedAt: page.favoritedAt },
            };
          }
        }

        for (const page of Object.values(before)) {
          if (page.id !== ROOT_PAGE_ID && !after[page.id] && (page.permission ?? "owner") === "owner") {
            await workspaceApi.archivePage(page.id);
          }
        }
      });
    }, 700);
    return () => {
      if (serverPagesTimerRef.current) window.clearTimeout(serverPagesTimerRef.current);
    };
  }, [pages, authUser?.id]);

  const updatePage = (
    pageId: string,
    patch: Partial<StoredPage>,
    options: { preserveUpdatedAt?: boolean } = {},
  ): StoredPage | null => {
    const page = pagesRef.current[pageId];
    if (!page || page.permission === "view") return null;
    const safePatch = pageId === ROOT_PAGE_ID
      ? {
          ...patch,
          favoritedAt: null,
          settings: patch.settings ? { ...patch.settings, publicAccess: false } : page.settings,
        }
      : patch;
    const nextPage = {
      ...page,
      ...safePatch,
      updatedAt: options.preserveUpdatedAt ? page.updatedAt : new Date().toISOString(),
    };
    const pageSaved = commitPages({ ...pagesRef.current, [pageId]: nextPage });

    if (pageId === ROOT_PAGE_ID && pageSaved) {
      try {
        if (patch.blocks) window.localStorage.setItem(CONTENT_STORAGE_KEY, JSON.stringify(patch.blocks));
        if (patch.title !== undefined) window.localStorage.setItem(TITLE_STORAGE_KEY, patch.title);
        if (patch.settings) window.localStorage.setItem(PAGE_SETTINGS_STORAGE_KEY, JSON.stringify(nextPage.settings));
        if (patch.archived !== undefined) window.localStorage.setItem(PAGE_ARCHIVED_STORAGE_KEY, String(patch.archived));
      } catch {
        // The canonical `nodi:pages` document is already saved above. These
        // legacy keys only keep older local workspaces compatible.
      }
    }
    return pageSaved ? nextPage : null;
  };

  finishDetachedUploadRef.current = (pageId, blockId, url) => {
    const source = pagesRef.current[pageId];
    if (!source || source.permission === "view" || source.settings.lockPage || source.archived) return;
    if (currentPageIdRef.current === pageId && editorPageIdRef.current === pageId) {
      const block = editor.getBlock(blockId);
      if (!block) return;
      if (url !== null) editor.updateBlock(blockId, { props: { url } } as never);
      else if (!(block.props as { url?: string }).url) editor.removeBlocks([blockId]);
    } else {
      const blocks = updateAttachmentBlock(source.blocks, blockId, url);
      if (!sameServerValue(blocks, source.blocks)) updatePage(pageId, { blocks });
    }
  };

  const syncPageImmediately = (
    pageId: string,
    options: { notify?: boolean } = {},
  ) => {
    if (!authUser || !serverWorkspaceReadyRef.current) {
      if (options.notify) setNotice("메모를 저장했어요");
      return;
    }
    if (serverPagesTimerRef.current) {
      window.clearTimeout(serverPagesTimerRef.current);
      serverPagesTimerRef.current = null;
    }
    if (localSaveStateTimerRef.current) {
      window.clearTimeout(localSaveStateTimerRef.current);
      localSaveStateTimerRef.current = null;
    }
    setLocalSaveState("saving");
    enqueueServerMutation(async () => {
      const page = pagesRef.current[pageId];
      const previous = serverPagesSnapshotRef.current[pageId];
      if (!previous || !page) return;

      if (pageId === ROOT_PAGE_ID) {
        const homePatch: Partial<Pick<StoredPage, "title" | "settings" | "blocks" | "revision">> = {};
        if (previous.title !== page.title) homePatch.title = page.title;
        if (!sameServerValue(previous.settings, page.settings)) homePatch.settings = page.settings;
        if (!sameServerValue(previous.blocks, page.blocks)) homePatch.blocks = page.blocks;
        if (!Object.keys(homePatch).length) {
          if (options.notify) setNotice("메모를 서버에 저장했어요");
          return;
        }
        homePatch.revision = previous.revision;
        const savedHome = await workspaceApi.updateHome(homePatch);
        acknowledgePageSave(storedHomeFromServer(savedHome));
        if (options.notify) setNotice("메모를 서버에 저장했어요");
        return;
      }

      const patch = getPageServerPatch(previous, page);
      const isCollaborative = (page.permission ?? "owner") !== "owner"
        || (pageSharesRef.current[page.id]?.members.length ?? 0) > 0
        || realtimeSocketIsReady(page.id);
      if (isCollaborative && realtimeSocketIsReady(page.id)) {
        flushRealtimeBlockPatch();
        delete patch.blocks;
      }
      if (!Object.keys(patch).length) {
        if (options.notify) setNotice("메모를 서버에 저장했어요");
        return;
      }
      if (!isCollaborative) patch.revision = previous.revision;
      const savedPage = await workspaceApi.updatePage(pageId, patch);
      acknowledgePageSave(storedPageFromServer(savedPage));
      if (options.notify) setNotice("메모를 서버에 저장했어요");
    });
  };

  useEffect(() => {
    const syncUserProfile = () => {
      const nextUserName = getStoredUserName();
      const nextHomeTitle = getHomePageTitle(nextUserName);
      const previousGeneratedHomeTitle = window.localStorage.getItem(HOME_PAGE_TITLE_STORAGE_KEY);
      const homePage = pagesRef.current[ROOT_PAGE_ID];

      setUserName(nextUserName);
      window.localStorage.setItem(HOME_PAGE_TITLE_STORAGE_KEY, nextHomeTitle);

      if (
        homePage
        && homePage.title !== nextHomeTitle
        && (
          !homePage.title
          || homePage.title === previousGeneratedHomeTitle
          || homePage.title === "내이름의 홈 공간입니다."
          || homePage.title === "나의 홈"
        )
      ) {
        updatePage(ROOT_PAGE_ID, { title: nextHomeTitle });
        if (currentPageIdRef.current === ROOT_PAGE_ID) setTitle(nextHomeTitle);
      }
    };

    window.addEventListener("storage", syncUserProfile);
    window.addEventListener(USER_PROFILE_CHANGED_EVENT, syncUserProfile);
    return () => {
      window.removeEventListener("storage", syncUserProfile);
      window.removeEventListener(USER_PROFILE_CHANGED_EVENT, syncUserProfile);
    };
  }, []);

  useEffect(() => {
    const syncRegistrationDirectory = () => {
      setRegistrationDirectoryRevision((current) => current + 1);
    };
    window.addEventListener("storage", syncRegistrationDirectory);
    window.addEventListener(REGISTRATION_REQUESTS_CHANGED_EVENT, syncRegistrationDirectory);
    return () => {
      window.removeEventListener("storage", syncRegistrationDirectory);
      window.removeEventListener(REGISTRATION_REQUESTS_CHANGED_EVENT, syncRegistrationDirectory);
    };
  }, []);

  const saveDocument = (options: { notify?: boolean } = {}) => {
    const pageId = currentPageId;
    if (loadingPageRef.current || pageId !== currentPageIdRef.current || pageId !== editorPageIdRef.current) return;
    const currentPage = pagesRef.current[pageId];
    const nextTitle = title.trim() || "제목 없음";
    const hasMetadataChanges = Boolean(
      currentPage
      && (
        currentPage.title !== nextTitle
        || !arePageSettingsEqual(currentPage.settings, pageSettings)
        || currentPage.archived !== isArchived
      )
    );
    const savedPage = updatePage(pageId, {
      blocks: editor.document as unknown as PartialBlock[],
      title: nextTitle,
      settings: pageSettings,
      archived: isArchived,
    }, { preserveUpdatedAt: !hasMetadataChanges });
    if (savedPage) syncPageImmediately(pageId, options);
  };

  const updateUserProfile = ({
    name: nextUserName,
    avatarColor,
    avatarIcon,
  }: {
    name: string;
    avatarColor: NodiAvatarColor;
    avatarIcon?: string;
  }) => {
    let storedProfile: Record<string, unknown> = {};
    try {
      const savedProfile = window.localStorage.getItem("nodi:user:profile");
      if (savedProfile) storedProfile = JSON.parse(savedProfile) as Record<string, unknown>;
    } catch {
      storedProfile = {};
    }
    window.localStorage.setItem(USER_NAME_STORAGE_KEY, nextUserName);
    window.localStorage.setItem("nodi:user:profile", JSON.stringify({
      ...storedProfile,
      name: nextUserName,
      avatarColor,
      avatarIcon,
    }));
    void updateLocalAccountProfile({
      name: nextUserName,
      avatarColor,
      avatarIcon,
    });
    setAuthUser((current) => current ? {
      ...current,
      name: nextUserName,
      avatarColor,
      avatarIcon,
    } : current);
    window.dispatchEvent(new CustomEvent(USER_PROFILE_CHANGED_EVENT));
    setNotice("계정 프로필을 변경했어요");
    if (authUser) {
      void authApi.updateProfile({ name: nextUserName, avatarColor, avatarIcon })
        .then((user) => setAuthUser(user))
        .catch((error) => setNotice(error instanceof Error ? error.message : "프로필을 서버에 저장하지 못했어요"));
    }
  };

  const logout = async () => {
    saveDocument();
    await serverMutationQueueRef.current;
    try {
      await authApi.logout();
    } catch {
      // The local session is still cleared when the server is temporarily unavailable.
    }
    await logoutLocalAccount();
    setWorkspaceSettingsOpen(false);
    setAuthDialogMode(null);
    window.location.reload();
  };

  const openWorkspaceSearch = () => {
    if (!authUser) {
      setAuthDialogMode("login");
      return;
    }
    saveDocument();
    setContextMenu(null);
    setSidebarContextMenu(null);
    setSidebarCreateMenuOpen(false);
    setBlockSelectionActionMenu(null);
    setWorkspaceSearchOpen(true);
  };

  useEffect(() => {
    const pageId = currentPageId;
    if (pageId !== currentPageIdRef.current) return;
    const currentPage = pagesRef.current[pageId];
    const nextTitle = title.trim() || "제목 없음";
    if (!currentPage || currentPage.title === nextTitle) return;
    const saveTimer = window.setTimeout(() => {
      if (pageId !== currentPageIdRef.current || pageId !== editorPageIdRef.current) return;
      updatePage(pageId, { title: nextTitle });
    }, 300);
    return () => window.clearTimeout(saveTimer);
  }, [title, currentPageId]);

  useEffect(() => {
    if (currentPageId !== currentPageIdRef.current) return;
    const currentPage = pagesRef.current[currentPageId];
    if (!currentPage || arePageSettingsEqual(currentPage.settings, pageSettings)) return;
    updatePage(currentPageId, { settings: pageSettings });
  }, [pageSettings, currentPageId]);

  useEffect(() => {
    if (currentPageId !== currentPageIdRef.current) return;
    const currentPage = pagesRef.current[currentPageId];
    if (!currentPage || currentPage.archived === isArchived) return;
    updatePage(currentPageId, { archived: isArchived });
  }, [isArchived, currentPageId]);

  const openPage = (pageId: string, options: PageNavigationOptions = {}) => {
    setStarterDockPageId(null);
    setSelectedStarterPreset(null);
    const isCurrentPage = pageId === currentPageIdRef.current;
    const existingPage = pagesRef.current[pageId];
    const targetSection: WorkspaceSection = pageId !== ROOT_PAGE_ID && (existingPage?.permission ?? "owner") !== "owner"
      ? "shared-page"
      : "pages";
    if (isCurrentPage && workspaceSection === targetSection) {
      setWorkspaceSection(targetSection);
      setInboxOpen(false);
      setRightPanel(null);
      setActiveCommentBlockId(null);
      editorStageRef.current?.scrollTo({ top: 0 });
      return;
    }

    // When returning from the shared-pages workspace, `refreshSharedPages`
    // may already hold a newer server copy of the currently selected page.
    // Saving the stale editor again here would overwrite that remote change.
    if (!isCurrentPage && !options.skipCurrentPageSave) saveDocument();
    // Flush while the socket and document still belong to the page we leave.
    flushRealtimeBlockPatch();

    const targetPage = pagesRef.current[pageId];
    if (!targetPage) {
      setNotice("페이지를 찾을 수 없어요");
      return;
    }

    loadingPageRef.current = true;
    const historyMode = options.historyMode ?? "push";
    if (!publicPageId && historyMode !== "none") {
      const url = new URL(window.location.href);
      url.searchParams.delete("publicPage");
      if (pageId === ROOT_PAGE_ID) url.searchParams.delete("page");
      else url.searchParams.set("page", pageId);
      const previousState = window.history.state;
      const nextState = {
        ...(previousState && typeof previousState === "object" ? previousState : {}),
        nodiPageId: pageId,
      };
      if (historyMode === "replace") window.history.replaceState(nextState, "", url);
      else window.history.pushState(nextState, "", url);
    }
    currentPageIdRef.current = pageId;
    setWorkspaceSection(targetSection);
    setCurrentPageId(pageId);
    setTitle(targetPage.title);
    setPageSettings(targetPage.settings);
    setIsArchived(targetPage.archived);
    setPageSettingsOpen(false);
    setDrawerPageId(null);
    setRightPanel(null);
    setActiveCommentBlockId(null);
    setContextMenu(null);
    blockSelectionModeRef.current = false;
    blockSelectionAnchorRef.current = null;
    selectedBlockIdsRef.current = [];
    setIsBlockSelectionMode(false);
    setSelectedBlockIds([]);
    setBlockSelectionActionMenu(null);
    setBlockSelectionMarquee(null);
    loadEditorPage(pageId, targetPage.blocks, true);
    editorStageRef.current?.scrollTo({ top: 0 });
  };
  openPageRef.current = openPage;

  useEffect(() => {
    if (publicPageId) return;

    const currentState = window.history.state;
    window.history.replaceState({
      ...(currentState && typeof currentState === "object" ? currentState : {}),
      nodiPageId: currentPageIdRef.current,
    }, "", window.location.href);

    const handleHistoryNavigation = () => {
      const requestedPageId = new URLSearchParams(window.location.search).get("page") ?? ROOT_PAGE_ID;
      if (requestedPageId === currentPageIdRef.current) return;

      if (!pagesRef.current[requestedPageId]) {
        const currentUrl = new URL(window.location.href);
        if (currentPageIdRef.current === ROOT_PAGE_ID) currentUrl.searchParams.delete("page");
        else currentUrl.searchParams.set("page", currentPageIdRef.current);
        window.history.replaceState({ nodiPageId: currentPageIdRef.current }, "", currentUrl);
        setNotice("이동하려는 페이지를 찾을 수 없어요");
        return;
      }

      openPageRef.current(requestedPageId, { historyMode: "none" });
    };

    window.addEventListener("popstate", handleHistoryNavigation);
    return () => window.removeEventListener("popstate", handleHistoryNavigation);
  }, [publicPageId]);

  useEffect(() => {
    if (!authUser || publicPageId) return;
    let active = true;
    let refreshing = false;

    const refreshCurrentPage = async () => {
      const pageId = currentPageIdRef.current;
      if (
        refreshing
        || !serverWorkspaceReadyRef.current
        || pageId === ROOT_PAGE_ID
        || serverPagesTimerRef.current
      ) return;

      refreshing = true;
      try {
        await serverMutationQueueRef.current;
        if (!active || pageId !== currentPageIdRef.current || serverPagesTimerRef.current) return;

        const previous = serverPagesSnapshotRef.current[pageId];
        const localPage = pagesRef.current[pageId];
        if (
          previous
          && localPage
          && !sameServerValue(getPageEditableSnapshot(previous), getPageEditableSnapshot(localPage))
        ) return;

        const serverPage = await workspaceApi.getPage(pageId);
        if (!active || pageId !== currentPageIdRef.current) return;
        // Editing can resume while the GET is in flight. Recheck against the
        // latest local state instead of overwriting it with that response.
        const latestSnapshot = serverPagesSnapshotRef.current[pageId];
        const latestLocal = pagesRef.current[pageId];
        if (serverPagesTimerRef.current || (latestSnapshot && latestLocal
          && !sameServerValue(getPageEditableSnapshot(latestSnapshot), getPageEditableSnapshot(latestLocal)))) return;
        if (latestSnapshot?.revision !== undefined && serverPage.revision <= latestSnapshot.revision) return;

        const latestPage = storedPageFromServer(serverPage);
        const nextPages = { ...pagesRef.current, [pageId]: latestPage };
        serverPagesSnapshotRef.current = {
          ...serverPagesSnapshotRef.current,
          [pageId]: latestPage,
        };
        pagesRef.current = nextPages;
        persistStoredPages(nextPages);
        setPages(nextPages);

        loadingPageRef.current = true;
        setTitle(latestPage.title);
        setPageSettings(latestPage.settings);
        setIsArchived(latestPage.archived);
        loadEditorPage(pageId, latestPage.blocks);
        setNotice("다른 위치의 최신 변경 내용을 불러왔어요");
      } catch {
        // Background revalidation should not interrupt the editor. Explicit
        // saves still surface their server error through the mutation queue.
      } finally {
        refreshing = false;
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshCurrentPage();
    };
    const initialTimer = window.setTimeout(() => void refreshCurrentPage(), 900);
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("pageshow", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.clearTimeout(initialTimer);
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("pageshow", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [authUser?.id, currentPageId, editor, publicPageId]);

  const currentPageHasShares = (pageShares[currentPageId]?.members.length ?? 0) > 0;

  useEffect(() => {
    flushRealtimeBlockPatch();
    if (realtimeReconnectTimerRef.current) {
      window.clearTimeout(realtimeReconnectTimerRef.current);
      realtimeReconnectTimerRef.current = null;
    }
    realtimeSocketRef.current?.close();
    realtimeSocketRef.current = null;
    realtimeConnectedPageIdRef.current = null;
    realtimePresenceBlockRef.current = null;
    realtimePendingBlocksRef.current = null;
    realtimeProtectedBlockIdsRef.current.clear();
    realtimeProtectedDeletedBlockIdsRef.current.clear();
    setRealtimeParticipants([]);

    const pageId = currentPageIdRef.current;
    const localPage = pagesRef.current[pageId];
    const isCollaborative = Boolean(
      authUser
      && !publicPageId
      && pageId !== ROOT_PAGE_ID
      && (workspaceSection === "pages" || workspaceSection === "shared-page")
      && (
        (localPage?.permission ?? "owner") !== "owner"
        || (pageSharesRef.current[pageId]?.members.length ?? 0) > 0
      ),
    );
    if (!isCollaborative || !authUser || !localPage) return;

    realtimeLocalBlocksRef.current = cloneRealtimeBlocks(localPage.blocks);

    let disposed = false;
    let reconnectAttempt = 0;
    let heartbeatTimer: number | null = null;

    const replaceCurrentPage = (nextPage: StoredPage, preservePendingBlocks = false) => {
      if (disposed || currentPageIdRef.current !== pageId) return;
      let editorBlocks = nextPage.blocks;
      if (preservePendingBlocks && (
        realtimeProtectedBlockIdsRef.current.size > 0
        || realtimeProtectedDeletedBlockIdsRef.current.size > 0
      )) {
        const liveBlocks = editor.document as unknown as PartialBlock[];
        const liveById = new Map(liveBlocks.map((block) => [realtimeBlockId(block), block]));
        const included = new Set<string>();
        editorBlocks = nextPage.blocks
          .filter((block) => !realtimeProtectedDeletedBlockIdsRef.current.has(realtimeBlockId(block)))
          .map((block) => {
            const id = realtimeBlockId(block);
            included.add(id);
            return realtimeProtectedBlockIdsRef.current.has(id) ? liveById.get(id) ?? block : block;
          });
        liveBlocks.forEach((block) => {
          const id = realtimeBlockId(block);
          if (realtimeProtectedBlockIdsRef.current.has(id) && !included.has(id)) editorBlocks.push(block);
        });
      }
      const localNextPage = { ...nextPage, blocks: editorBlocks };
      const nextPages = { ...pagesRef.current, [pageId]: localNextPage };
      serverPagesSnapshotRef.current = {
        ...serverPagesSnapshotRef.current,
        [pageId]: nextPage,
      };
      pagesRef.current = nextPages;
      persistStoredPages(nextPages);
      setPages(nextPages);

      loadingPageRef.current = true;
      setTitle(nextPage.title);
      setPageSettings(nextPage.settings);
      setIsArchived(nextPage.archived);
      loadEditorPage(pageId, editorBlocks);
      realtimeLocalBlocksRef.current = cloneRealtimeBlocks(editorBlocks);
    };

    const applyServerPage = (serverPage: ServerPage, message: ServerPageRealtimeEvent) => {
      if (disposed || serverPage.id !== pageId || currentPageIdRef.current !== pageId) return;
      const currentLocalPage = pagesRef.current[pageId];
      const currentSnapshot = serverPagesSnapshotRef.current[pageId];
      if (!currentLocalPage) return;

      // A no-op patch can legitimately echo the same revision (for example,
      // when the canonical block already contains the submitted value). Clear
      // the optimistic protection before the revision guard so later remote
      // edits are not hidden behind a stale local protection marker.
      if (message.actorId === authUser.id) {
        (message.changedBlockIds ?? []).forEach((id) => realtimeProtectedBlockIdsRef.current.delete(id));
        (message.deletedBlockIds ?? []).forEach((id) => realtimeProtectedDeletedBlockIdsRef.current.delete(id));
        if ((currentSnapshot?.revision ?? 0) >= serverPage.revision) {
          setLocalSaveState("saved");
          return;
        }
      } else if ((currentSnapshot?.revision ?? 0) >= serverPage.revision) {
        return;
      }

      const nextPage = storedPageFromServer({
        ...serverPage,
        permission: currentLocalPage.permission ?? serverPage.permission,
        favoritedAt: currentLocalPage.favoritedAt,
      });

      // Own echoes confirm persistence without replacing the editor selection.
      // The canonical snapshot still advances so later metadata saves never
      // submit a stale revision.
      if (message.actorId === authUser.id) {
        serverPagesSnapshotRef.current = {
          ...serverPagesSnapshotRef.current,
          [pageId]: nextPage,
        };
        const localBlocks = editor.document as unknown as PartialBlock[];
        const localPage = {
          ...currentLocalPage,
          revision: nextPage.revision,
          updatedAt: nextPage.updatedAt,
          blocks: localBlocks,
        };
        const nextPages = { ...pagesRef.current, [pageId]: localPage };
        pagesRef.current = nextPages;
        persistStoredPages(nextPages);
        setPages(nextPages);
        realtimeLocalBlocksRef.current = cloneRealtimeBlocks(localBlocks);
        setLocalSaveState("saved");
        return;
      }

      if (message.type === "page.updated" && message.changedBlockIds?.length && !message.structural) {
        // Apply remote text/property edits one top-level block at a time. This
        // preserves the local caret and any unsent work in all other blocks.
        loadingPageRef.current = true;
        const loadVersion = ++editorLoadVersionRef.current;
        const nextById = new Map(nextPage.blocks.map((block) => [realtimeBlockId(block), block]));
        const liveIds = new Set(editor.document.map((block) => block.id));
        try {
          editor.transact((transaction) => {
            // Remote edits are not this user's undoable actions.
            transaction.setMeta("addToHistory", false);
            const removable = (message.deletedBlockIds ?? []).filter((id) => (
              liveIds.has(id) && !realtimeProtectedBlockIdsRef.current.has(id)
            ));
            if (removable.length) editor.removeBlocks(removable);
            (message.changedBlockIds ?? []).forEach((blockId) => {
              if (realtimeProtectedBlockIdsRef.current.has(blockId)) return;
              const block = nextById.get(blockId);
              if (block && liveIds.has(blockId)) editor.updateBlock(blockId, block as never);
            });
          });
        } catch {
          loadEditorPage(pageId, nextPage.blocks);
        }
        const localBlocks = editor.document as unknown as PartialBlock[];
        realtimeLocalBlocksRef.current = cloneRealtimeBlocks(localBlocks);
        const mergedLocalPage = { ...nextPage, blocks: localBlocks };
        const nextPages = { ...pagesRef.current, [pageId]: mergedLocalPage };
        serverPagesSnapshotRef.current = { ...serverPagesSnapshotRef.current, [pageId]: nextPage };
        pagesRef.current = nextPages;
        persistStoredPages(nextPages);
        setPages(nextPages);
        setTitle(nextPage.title);
        setPageSettings(nextPage.settings);
        setIsArchived(nextPage.archived);
        window.requestAnimationFrame(() => {
          if (loadVersion === editorLoadVersionRef.current) loadingPageRef.current = false;
        });
        return;
      }

      const blocksChanged = !currentSnapshot || !sameServerValue(currentSnapshot.blocks, nextPage.blocks);
      if (message.type === "page.snapshot" || message.structural || blocksChanged) {
        replaceCurrentPage(nextPage, message.type === "page.updated");
        return;
      }

      // Metadata-only updates should not disturb the current editing surface.
      const localPage = { ...nextPage, blocks: currentLocalPage.blocks };
      const nextPages = { ...pagesRef.current, [pageId]: localPage };
      serverPagesSnapshotRef.current = { ...serverPagesSnapshotRef.current, [pageId]: nextPage };
      pagesRef.current = nextPages;
      persistStoredPages(nextPages);
      setPages(nextPages);
      setTitle(nextPage.title);
      setPageSettings(nextPage.settings);
      setIsArchived(nextPage.archived);
    };

    const leaveUnavailablePage = (message: string) => {
      const current = pagesRef.current[pageId];
      if ((current?.permission ?? "owner") !== "owner") {
        const nextPages = { ...pagesRef.current };
        const nextSnapshot = { ...serverPagesSnapshotRef.current };
        delete nextPages[pageId];
        delete nextSnapshot[pageId];
        pagesRef.current = nextPages;
        serverPagesSnapshotRef.current = nextSnapshot;
        persistStoredPages(nextPages);
        setPages(nextPages);
      }
      const homePage = pagesRef.current[ROOT_PAGE_ID];
      currentPageIdRef.current = ROOT_PAGE_ID;
      setCurrentPageId(ROOT_PAGE_ID);
      setWorkspaceSection("shared");
      if (homePage) {
        setTitle(homePage.title);
        setPageSettings(homePage.settings);
        setIsArchived(homePage.archived);
      }
      loadEditorPage(ROOT_PAGE_ID, homePage?.blocks ?? []);
      const url = new URL(window.location.href);
      url.searchParams.delete("page");
      window.history.replaceState(null, "", url);
      setNotice(message);
    };

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(workspaceApi.pageRealtimeURL(pageId));
      realtimeSocketRef.current = socket;
      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        realtimeConnectedPageIdRef.current = pageId;
        realtimeLocalBlocksRef.current = cloneRealtimeBlocks(
          editor.document as unknown as PartialBlock[],
        );
        let activeBlockId = realtimePresenceBlockRef.current;
        try {
          activeBlockId = editor.getTextCursorPosition().block.id;
        } catch {
          activeBlockId = null;
        }
        realtimePresenceBlockRef.current = activeBlockId;
        socket.send(JSON.stringify({
          type: "presence.update",
          activeBlockId: activeBlockId ?? "",
        }));
        heartbeatTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, 25_000);
      });
      socket.addEventListener("message", (event) => {
        if (disposed || currentPageIdRef.current !== pageId) return;
        let message: ServerPageRealtimeEvent;
        try {
          message = JSON.parse(String(event.data)) as ServerPageRealtimeEvent;
        } catch {
          return;
        }
        if ((message.type === "page.snapshot" || message.type === "page.updated") && message.page) {
          if (message.actorId && message.actorId !== authUser.id) flushRealtimeBlockPatch();
          applyServerPage(message.page, message);
          return;
        }
        if (message.type === "presence.updated") {
          setRealtimeParticipants(message.participants ?? []);
          return;
        }
        if (message.type === "page.error") {
          setLocalSaveState("error");
          setNotice(message.message || "실시간 변경을 저장하지 못했어요");
          return;
        }
        if (message.type === "database.updated" && message.database && message.actorId !== authUser.id) {
          window.dispatchEvent(new CustomEvent(INLINE_DATABASE_REALTIME_EVENT, { detail: message.database }));
          return;
        }
        if (message.type === "permission.updated" && message.permission) {
          const current = pagesRef.current[pageId];
          if (!current || (current.permission ?? "owner") === "owner") return;
          const nextPage = { ...current, permission: message.permission };
          const nextPages = { ...pagesRef.current, [pageId]: nextPage };
          pagesRef.current = nextPages;
          serverPagesSnapshotRef.current = {
            ...serverPagesSnapshotRef.current,
            [pageId]: nextPage,
          };
          persistStoredPages(nextPages);
          setPages(nextPages);
          setNotice(message.permission === "edit" ? "이 페이지를 편집할 수 있어요" : "이 페이지가 보기 전용으로 변경되었습니다.");
          return;
        }
        if (message.type === "access.revoked") {
          leaveUnavailablePage(message.message || "이 페이지의 공유 권한이 해제되었습니다.");
          socket.close();
          return;
        }
        if (message.type === "page.archived" || message.type === "page.deleted") {
          leaveUnavailablePage(message.type === "page.deleted" ? "공유 페이지가 삭제되었습니다." : "공유 페이지가 휴지통으로 이동되었습니다.");
          socket.close();
        }
      });
      socket.addEventListener("close", () => {
        if (heartbeatTimer) window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (realtimeSocketRef.current === socket) {
          realtimeConnectedPageIdRef.current = null;
          setRealtimeParticipants([]);
        }
        if (disposed || currentPageIdRef.current !== pageId) return;
        const delay = Math.min(8_000, 1_000 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        realtimeReconnectTimerRef.current = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      flushRealtimeBlockPatch();
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      if (realtimeReconnectTimerRef.current) window.clearTimeout(realtimeReconnectTimerRef.current);
      realtimeReconnectTimerRef.current = null;
      realtimeSocketRef.current?.close();
      realtimeSocketRef.current = null;
      realtimeConnectedPageIdRef.current = null;
      realtimePresenceBlockRef.current = null;
      realtimePendingBlocksRef.current = null;
      realtimeProtectedBlockIdsRef.current.clear();
      realtimeProtectedDeletedBlockIdsRef.current.clear();
      setRealtimeParticipants([]);
    };
  }, [authUser?.id, currentPageId, editor, currentPageHasShares, publicPageId, workspaceSection]);

  const refreshSharedPages = async () => {
    if (!authUser) return;
    const requestedSnapshot = serverPagesSnapshotRef.current;
    try {
      const [serverPages, serverShares, serverComments] = await Promise.all([
        workspaceApi.listPages(true, true),
        workspaceApi.listAllShares(),
        workspaceApi.listAllComments(),
      ]);
      const currentPages = pagesRef.current;
      const nextPages: StoredPages = {};
      const nextSnapshot: StoredPages = { ...serverPagesSnapshotRef.current };
      if (currentPages[ROOT_PAGE_ID]) nextPages[ROOT_PAGE_ID] = currentPages[ROOT_PAGE_ID];
      serverPages.forEach((page) => {
        const local = currentPages[page.id];
        const snapshot = serverPagesSnapshotRef.current[page.id];
        const dirty = local && (!snapshot || !sameServerValue(getPageEditableSnapshot(local), getPageEditableSnapshot(snapshot)));
        const newerSnapshot = (snapshot?.revision ?? 0) > page.revision;
        const nextPage = storedPageFromServer(page);
        nextPages[page.id] = local && (dirty || newerSnapshot) ? local : nextPage;
        if (!newerSnapshot) nextSnapshot[page.id] = nextPage;
      });
      Object.values(currentPages).forEach((page) => {
        if (nextPages[page.id]) return;
        const snapshot = serverPagesSnapshotRef.current[page.id];
        if (!requestedSnapshot[page.id] || snapshot !== requestedSnapshot[page.id]
          || !sameServerValue(getPageEditableSnapshot(page), getPageEditableSnapshot(snapshot ?? page))) {
          nextPages[page.id] = page;
        } else {
          delete nextSnapshot[page.id];
        }
      });
      const nextPageShares = Object.fromEntries(serverShares.map((share) => [
        share.pageId,
        storedShareFromServer(share),
      ])) as StoredPageShares;
      const nextBlockComments = Object.fromEntries(serverComments.map((thread) => [
        thread.id,
        storedCommentFromServer(thread),
      ])) as StoredBlockComments;

      serverPagesSnapshotRef.current = nextSnapshot;
      pagesRef.current = nextPages;
      persistStoredPages(nextPages);
      persistStoredPageShares(nextPageShares);
      persistStoredBlockComments(nextBlockComments);
      setPages(nextPages);
      setPageShares(nextPageShares);
      setBlockComments(nextBlockComments);
      setLocalSaveState("saved");
    } catch (error) {
      setLocalSaveState("error");
      setNotice(error instanceof Error ? error.message : "공유 페이지 목록을 불러오지 못했어요");
    }
  };

  const openSharedPages = () => {
    if (!authUser) {
      setAuthDialogMode("login");
      return;
    }
    saveDocument();
    setWorkspaceSection("shared");
    setInboxOpen(false);
    setPageSettingsOpen(false);
    setDrawerPageId(null);
    setRightPanel(null);
    setActiveCommentBlockId(null);
    setContextMenu(null);
    setSidebarContextMenu(null);
    editorStageRef.current?.scrollTo({ top: 0 });
    void serverMutationQueueRef.current.then(refreshSharedPages);
  };

  const openTrash = () => {
    if (!authUser) return;
    saveDocument();
    setWorkspaceSection("trash");
    setInboxOpen(false);
    setPageSettingsOpen(false);
    setDrawerPageId(null);
    setRightPanel(null);
    setActiveCommentBlockId(null);
    setContextMenu(null);
    setSidebarContextMenu(null);
    editorStageRef.current?.scrollTo({ top: 0 });
  };

  const restoreTrashPage = async (pageId: string) => {
    const page = pagesRef.current[pageId];
    if (!authUser || !page?.archived || (page.permission ?? "owner") !== "owner" || trashBusyPageId) return;
    setTrashBusyPageId(pageId);
    setLocalSaveState("saving");
    try {
      await serverMutationQueueRef.current;
      const parentIsAvailable = !page.parentId || (pagesRef.current[page.parentId] && !pagesRef.current[page.parentId].archived);
      const folderIsAvailable = !page.folderId || Boolean(foldersRef.current[page.folderId]);
      const patch: Partial<Pick<StoredPage, "parentId" | "folderId" | "archived" | "revision">> = {
        archived: false,
        revision: serverPagesSnapshotRef.current[pageId]?.revision ?? page.revision,
      };
      if (!parentIsAvailable) patch.parentId = null;
      if (!folderIsAvailable) patch.folderId = null;
      const savedPage = storedPageFromServer(await workspaceApi.updatePage(pageId, patch));
      const nextPages = { ...pagesRef.current, [pageId]: savedPage };
      serverPagesSnapshotRef.current = { ...serverPagesSnapshotRef.current, [pageId]: savedPage };
      pagesRef.current = nextPages;
      persistStoredPages(nextPages);
      setPages(nextPages);
      setLocalSaveState("saved");
      setNotice(`“${savedPage.title || "제목 없음"}” 페이지를 복원했어요`);
    } catch (error) {
      setLocalSaveState("error");
      setNotice(error instanceof Error ? error.message : "페이지를 복원하지 못했어요");
    } finally {
      setTrashBusyPageId(null);
    }
  };

  const permanentlyDeleteTrashPages = async (target: string | "all") => {
    if (!authUser || trashBusyPageId) return;
    const pageIds = target === "all"
      ? Object.values(pagesRef.current)
        .filter((page) => page.archived && (page.permission ?? "owner") === "owner")
        .map((page) => page.id)
      : [target];
    if (pageIds.length === 0) {
      setPendingPermanentPageDeletion(null);
      return;
    }

    setPendingPermanentPageDeletion(null);
    setTrashBusyPageId(target);
    setLocalSaveState("saving");
    try {
      await serverMutationQueueRef.current;
      for (const pageId of pageIds) await workspaceApi.archivePage(pageId, true);
      const deletedPageIds = new Set(pageIds);
      const nextPages = Object.fromEntries(Object.entries(pagesRef.current)
        .filter(([pageId]) => !deletedPageIds.has(pageId))) as StoredPages;
      const nextSnapshot = Object.fromEntries(Object.entries(serverPagesSnapshotRef.current)
        .filter(([pageId]) => !deletedPageIds.has(pageId))) as StoredPages;
      serverPagesSnapshotRef.current = nextSnapshot;
      pagesRef.current = nextPages;
      persistStoredPages(nextPages);
      setPages(nextPages);
      commitPageShares((current) => Object.fromEntries(Object.entries(current)
        .filter(([pageId]) => !deletedPageIds.has(pageId))) as StoredPageShares);
      commitBlockComments((current) => Object.fromEntries(Object.entries(current)
        .filter(([, thread]) => !deletedPageIds.has(thread.pageId))));
      setLocalSaveState("saved");
      setNotice(pageIds.length > 1 ? `${pageIds.length}개 페이지를 영구 삭제했어요` : "페이지를 영구 삭제했어요");
    } catch (error) {
      setLocalSaveState("error");
      setNotice(error instanceof Error ? error.message : "페이지를 영구 삭제하지 못했어요");
    } finally {
      setTrashBusyPageId(null);
    }
  };

  const openPageSettingsPanel = () => {
    if (!authUser) {
      setAuthDialogMode("login");
      return;
    }
    if (publicPageId || pagesRef.current[currentPageIdRef.current]?.permission === "view") return;
    setRightPanel(null);
    setActiveCommentBlockId(null);
    setPageSettingsOpen(true);
  };

  const openSharePanel = () => {
    if (!authUser) {
      setAuthDialogMode("login");
      return;
    }
    if ((pagesRef.current[currentPageIdRef.current]?.permission ?? "owner") !== "owner") {
      setNotice("페이지 소유자만 공유 설정을 변경할 수 있어요");
      return;
    }
    setPageSettingsOpen(false);
    setActiveCommentBlockId(null);
    setRightPanel("share");
  };

  const sharePageWithMember = (pageId: string, userId: string, permission: SharePermission) => {
    if (!authUser) return;
    if (pageId === ROOT_PAGE_ID) {
      setRightPanel(null);
      setNotice("개인 홈은 다른 사용자와 공유할 수 없어요");
      return;
    }
    const targetUser = registeredNodiUsers.find((user) => user.id === userId);
    const targetPage = pagesRef.current[pageId];
    if (!targetUser || !targetPage) return;
    void (async () => {
      try {
        await workspaceApi.setShare(pageId, userId, permission);
        const refreshed = await workspaceApi.listShares(pageId);
        commitPageShares((current) => ({
          ...current,
          [pageId]: storedShareFromServer(refreshed),
        }));
        setLocalSaveState("saved");
        setNotice(`${targetUser.name}님에게 “${targetPage.title || "제목 없음"}” 페이지를 공유했어요`);
      } catch (error) {
        setLocalSaveState("error");
        setNotice(error instanceof Error ? error.message : "페이지를 공유하지 못했어요");
      }
    })();
  };

  const updatePageSharePermission = (pageId: string, userId: string, permission: SharePermission) => {
    if (pageId === ROOT_PAGE_ID || !authUser) return;
    void (async () => {
      try {
        await workspaceApi.setShare(pageId, userId, permission);
        const refreshed = await workspaceApi.listShares(pageId);
        commitPageShares((current) => ({
          ...current,
          [pageId]: storedShareFromServer(refreshed),
        }));
        setLocalSaveState("saved");
      } catch (error) {
        setLocalSaveState("error");
        setNotice(error instanceof Error ? error.message : "공유 권한을 변경하지 못했어요");
      }
    })();
  };

  const removePageShareMember = (pageId: string, userId: string) => {
    const targetUser = registeredNodiUsers.find((user) => user.id === userId);
    if (!authUser) return;
    void (async () => {
      try {
        await workspaceApi.removeShare(pageId, userId);
        const refreshed = await workspaceApi.listShares(pageId);
        commitPageShares((current) => {
          const next = { ...current };
          if (refreshed.members.length === 0) delete next[pageId];
          else next[pageId] = storedShareFromServer(refreshed);
          return next;
        });
        setLocalSaveState("saved");
        if (targetUser) setNotice(`${targetUser.name}님의 페이지 접근 권한을 제거했어요`);
      } catch (error) {
        setLocalSaveState("error");
        setNotice(error instanceof Error ? error.message : "공유 권한을 제거하지 못했어요");
      }
    })();
  };

  const createPage = (source: "slash" | "sidebar" = "slash", requestedFolderId?: string | null) => {
    const createsChildPageBlock = source === "slash";
    if (createsChildPageBlock && pageSettings.lockPage) {
      setNotice("페이지 잠금을 해제한 뒤 하위 페이지를 만들 수 있어요");
      return;
    }

    const pageId = makeId("page");
    const pageTitle = "제목 없음";
    if (createsChildPageBlock) {
      const pageBlock = {
        type: "childPage",
        props: { pageId, title: pageTitle },
      } as unknown as PartialBlock;
      insertOrUpdateBlockForSlashMenu(editor as unknown as BlockNoteEditor<any, any, any>, pageBlock);
    }

    const now = new Date().toISOString();
    const parentId = createsChildPageBlock ? currentPageIdRef.current : null;
    const parent = parentId ? pagesRef.current[parentId] : null;
    const folderId = requestedFolderId !== undefined
      ? requestedFolderId
      : createsChildPageBlock
        ? parent?.folderId ?? null
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
      favoritedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const nextPages = { ...pagesRef.current };
    if (createsChildPageBlock && parentId && parent) {
      nextPages[parentId] = {
        ...parent,
        blocks: editor.document as unknown as PartialBlock[],
        updatedAt: now,
      };
    }
    commitPages({
      ...nextPages,
      [pageId]: nextPage,
    });
    setRightPanel(null);
    setSidebarCreateMenuOpen(false);
    if (source === "sidebar") {
      openPage(pageId);
      setStarterDockPageId(pageId);
      setSelectedStarterPreset(null);
    } else {
      setDrawerPageId(pageId);
    }
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
      if (isComposingKey(event)) return;
      const hasPrimaryModifier = event.metaKey || event.ctrlKey;
      if (hasPrimaryModifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        openWorkspaceSearch();
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".workspace-search-input")?.focus();
        });
        return;
      }
      if (hasPrimaryModifier && !event.shiftKey && !event.altKey && event.key === "\\") {
        event.preventDefault();
        event.stopPropagation();
        setSidebarOpen((open) => !open);
        return;
      }
      if (hasPrimaryModifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveDocument({ notify: true });
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  useEffect(() => {
    if (!notice) {
      setNoticeClosing(false);
      return;
    }
    setNoticeClosing(false);
    const timer = window.setTimeout(() => setNoticeClosing(true), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!notice || !noticeClosing) return;
    const timer = window.setTimeout(() => setNotice(null), 220);
    return () => window.clearTimeout(timer);
  }, [notice, noticeClosing]);

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
      if (isComposingKey(event)) return;
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
      if (isComposingKey(event)) return;
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

  useEffect(() => {
    if (!inboxOpen) return;
    const closeInbox = (event: PointerEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest(".sidebar-inbox-wrap")) return;
      setInboxOpen(false);
    };
    const closeInboxOnEscape = (event: KeyboardEvent) => {
      if (isComposingKey(event)) return;
      if (event.key === "Escape") setInboxOpen(false);
    };
    document.addEventListener("pointerdown", closeInbox, true);
    window.addEventListener("keydown", closeInboxOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeInbox, true);
      window.removeEventListener("keydown", closeInboxOnEscape);
    };
  }, [inboxOpen]);

  const dismissStarterDock = () => {
    setStarterDockPageId(null);
    setSelectedStarterPreset(null);
  };

  const dismissStarterDockForCurrentPage = () => {
    if (starterDockPageId === currentPageIdRef.current) dismissStarterDock();
  };

  const startWithSelectedPreset = async () => {
    if (!selectedStarterPreset) return;
    const preset = starterPresets.find((item) => item.id === selectedStarterPreset);
    if (!preset) return;

    const requestVersion = ++presetApplyVersionRef.current;
    const pageId = currentPageIdRef.current;
    const loadVersion = editorLoadVersionRef.current;
    const initialBlocks = editor.document;
    const initialTitle = titleInputRef.current?.value;
    const isCurrentRequest = () => requestVersion === presetApplyVersionRef.current
      && currentPageIdRef.current === pageId && readLocalAuthUser()?.id === authUser?.id;
    try {
      const sourceBlocks = JSON.parse(JSON.stringify(
        preset.blocks.length > 0 ? preset.blocks : [{ type: "paragraph", content: "" }],
      )) as PartialBlock[];
      const snapshots = collectDatabaseSnapshots(sourceBlocks);
      const missing = new Set<string>();
      const collectMissing = (blocks: PartialBlock[]) => blocks.forEach((value) => {
        const block = value as { id?: string; type?: string; props?: { databaseId?: string }; children?: PartialBlock[] };
        if (block.type === "database") {
          const id = block.props?.databaseId || `database-${block.id}`;
          if (!snapshots[id]) missing.add(id);
        }
        if (block.children) collectMissing(block.children);
      });
      collectMissing(sourceBlocks);
      if (missing.size) await Promise.all([...missing].map(async (id) => {
        snapshots[id] = (await workspaceApi.getDatabase<DatabaseState>(id)).state;
      }));
      // A slow resource lookup cannot replace edits made while it was pending,
      // nor apply to another page/account or supersede a newer preset request.
      if (!isCurrentRequest() || loadVersion !== editorLoadVersionRef.current
        || !currentPageIsEditable() || initialTitle !== titleInputRef.current?.value
        || !sameServerValue(initialBlocks, editor.document)) return;
      const blocks = copyDatabaseReferences(sourceBlocks, snapshots);
      editor.replaceBlocks(editor.document, blocks);
      setTitle(preset.pageTitle.trim() || "제목 없음");
      setNotice(`“${preset.name}” 프리셋을 적용했어요`);
      dismissStarterDock();
      window.requestAnimationFrame(() => editor.focus());
    } catch (error) {
      if (isCurrentRequest()) setNotice(error instanceof Error ? error.message : "프리셋의 표 내용을 불러오지 못했어요");
    }
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
    if (currentPageIdRef.current === ROOT_PAGE_ID) {
      setRightPanel(null);
      setNotice("개인 홈은 외부에 공유할 수 없어요");
      return;
    }
    try {
      const page = pagesRef.current[currentPageIdRef.current];
      await navigator.clipboard.writeText(getPageLink(currentPageIdRef.current, Boolean(page?.settings.publicAccess)));
      setNotice("이 페이지의 링크를 복사했어요");
    } catch {
      setNotice("링크 복사를 지원하지 않는 환경입니다");
    }
  };

  const toggleArchive = () => {
    setIsArchived((archived) => !archived);
    setNotice(isArchived ? "페이지를 보관함에서 복원했어요" : "페이지를 보관함으로 옮겼어요");
  };

  const toggleFavorite = () => {
    if (!authUser) {
      setAuthDialogMode("login");
      return;
    }
    const pageId = currentPageIdRef.current;
    if (pageId === ROOT_PAGE_ID) {
      setNotice("개인 홈은 즐겨찾기 대상에 포함되지 않아요");
      return;
    }
    const page = pagesRef.current[pageId];
    if (!page) return;
    const favoritedAt = page.favoritedAt ? null : new Date().toISOString();
    commitPages({
      ...pagesRef.current,
      [pageId]: {
        ...page,
        favoritedAt,
      },
    });
    setNotice(favoritedAt ? "즐겨찾기에 추가했어요" : "즐겨찾기에서 제거했어요");
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
      : target.kind === "folder" && (target.placement === "start" || target.placement === "inside")
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
    } else if (target.kind === "folder" && target.placement === "start") {
      insertionIndex = 0;
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
    const folderStartDropTarget = Array.from(
      document.querySelectorAll<HTMLElement>("[data-sidebar-folder-id]"),
    )
      .filter((folderElement) => {
        const folderRow = folderElement.querySelector<HTMLElement>(":scope > [data-sidebar-folder-row-id]");
        const childList = folderElement.querySelector<HTMLElement>(":scope > .sidebar-folder-pages");
        if (!folderRow || !childList) return false;
        const folderRowRect = folderRow.getBoundingClientRect();
        const childListRect = childList.getBoundingClientRect();
        const firstChildRect = childList.firstElementChild?.getBoundingClientRect();
        const folderRect = folderElement.getBoundingClientRect();
        const startCorridorTop = folderRowRect.bottom;
        const startCorridorBottom = firstChildRect
          ? firstChildRect.top + firstChildRect.height / 2
          : childListRect.top + Math.min(14, childListRect.height);
        return clientY >= startCorridorTop
          && clientY <= startCorridorBottom
          && clientX >= folderRect.left
          && clientX <= folderRect.right;
      })
      .sort((first, second) => (
        Number(second.dataset.sidebarFolderDepth ?? 0) - Number(first.dataset.sidebarFolderDepth ?? 0)
      ))[0];
    const folderStartDropTargetId = folderStartDropTarget?.dataset.sidebarFolderId;
    if (folderStartDropTargetId) {
      setSidebarDropTarget({
        kind: "folder",
        folderId: folderStartDropTargetId,
        placement: "start",
      });
      return;
    }
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
      setSidebarDropTarget({
        kind: "folder",
        folderId: targetFolderId,
        placement: "inside",
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
    if (hitElement?.closest(".sidebar-unfiled-pages")) {
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
      commitBlockComments((current) => Object.fromEntries(
        Object.entries(current).filter(([, thread]) => thread.pageId !== pageId),
      ));
      setActiveCommentBlockId(null);
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

    const deletedAt = new Date().toISOString();
    const nextPages: StoredPages = {};
    Object.values(pagesRef.current).forEach((candidate) => {
      if (pageIdsToDelete.has(candidate.id)) {
        nextPages[candidate.id] = {
          ...candidate,
          archived: true,
          favoritedAt: null,
          updatedAt: deletedAt,
        };
        return;
      }
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
    const fallbackPageId = page.parentId && nextPages[page.parentId] && !nextPages[page.parentId].archived
      ? page.parentId
      : ROOT_PAGE_ID;
    commitPages(nextPages);
    commitPageShares((current) => {
      const nextPageShares = { ...current };
      pageIdsToDelete.forEach((deletedPageId) => delete nextPageShares[deletedPageId]);
      return nextPageShares;
    });
    commitBlockComments((current) => Object.fromEntries(
      Object.entries(current).filter(([, thread]) => !pageIdsToDelete.has(thread.pageId)),
    ));
    if (drawerPageId && pageIdsToDelete.has(drawerPageId)) setDrawerPageId(null);
    if (currentPageWasDeleted) setActiveCommentBlockId(null);
    setPendingPageDeletion(null);
    setSidebarContextMenu(null);
    // `commitPages` has already archived the current page. Saving the still
    // mounted editor once more while navigating would write the stale
    // `isArchived === false` view state back and make the deleted page reappear
    // in the sidebar.
    if (currentPageWasDeleted) openPage(fallbackPageId, {
      skipCurrentPageSave: true,
      historyMode: "replace",
    });
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
    const previousIds = selectedBlockIdsRef.current;
    const selectionChanged = previousIds.length !== uniqueIds.length
      || previousIds.some((blockId, index) => blockId !== uniqueIds[index]);
    if (selectionChanged) {
      selectedBlockIdsRef.current = uniqueIds;
      setSelectedBlockIds(uniqueIds);
    }
    if (anchorId) blockSelectionAnchorRef.current = anchorId;
  };

  const clearBlockSelection = () => {
    blockSelectionModeRef.current = false;
    blockSelectionAnchorRef.current = null;
    setIsBlockSelectionMode(false);
    if (selectedBlockIdsRef.current.length > 0) {
      selectedBlockIdsRef.current = [];
      setSelectedBlockIds([]);
    }
    setBlockSelectionActionMenu(null);
  };

  useEffect(() => {
    const cancelSelectionForColumnResize = () => {
      marqueeSelectionRef.current = null;
      marginSelectionRef.current = null;
      if (marqueeApplyFrameRef.current !== null) {
        window.cancelAnimationFrame(marqueeApplyFrameRef.current);
        marqueeApplyFrameRef.current = null;
      }
      if (marqueeAutoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(marqueeAutoScrollFrameRef.current);
        marqueeAutoScrollFrameRef.current = null;
      }
      setBlockSelectionMarquee(null);
      clearBlockSelection();
    };
    window.addEventListener(DATABASE_COLUMN_RESIZE_START_EVENT, cancelSelectionForColumnResize);
    return () => window.removeEventListener(DATABASE_COLUMN_RESIZE_START_EVENT, cancelSelectionForColumnResize);
  }, []);

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
    const scrollArea = editorStageRef.current;
    const scrollRect = scrollArea?.getBoundingClientRect();
    const editorRect = editorContextRef.current?.getBoundingClientRect();
    const eventTarget = event.target as HTMLElement;
    const spansEditorWidth = Boolean(
      eventTarget.closest(".block-selection-gutter")
      || (editorRect && (event.clientX < editorRect.left || event.clientX > editorRect.right)),
    );
    marqueeSelectionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startContentY: scrollArea && scrollRect
        ? event.clientY - scrollRect.top + scrollArea.scrollTop
        : event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      dragging: false,
      clickedBlockId,
      initialBlockIds,
      additiveSelection: isAdditiveSelection,
      preserveClick,
      spansEditorWidth,
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

  const applyMarqueeSelection = (
    marqueeState: NonNullable<typeof marqueeSelectionRef.current>,
    clientX: number,
    clientY: number,
  ) => {
    marqueeState.lastClientX = clientX;
    marqueeState.lastClientY = clientY;

    const scrollArea = editorStageRef.current;
    const scrollRect = scrollArea?.getBoundingClientRect();
    const anchoredStartY = scrollArea && scrollRect
      ? scrollRect.top + marqueeState.startContentY - scrollArea.scrollTop
      : marqueeState.startY;
    const editorRect = editorContextRef.current?.getBoundingClientRect();
    const marqueeLeft = Math.min(marqueeState.startX, clientX);
    const marqueeRight = Math.max(marqueeState.startX, clientX);
    const hitLeft = marqueeState.spansEditorWidth && editorRect
      ? editorRect.left
      : marqueeLeft;
    const top = Math.min(anchoredStartY, clientY);
    const hitRight = marqueeState.spansEditorWidth && editorRect
      ? editorRect.right
      : marqueeRight;
    const bottom = Math.max(anchoredStartY, clientY);
    const marquee = {
      left: marqueeLeft,
      top,
      width: marqueeRight - marqueeLeft,
      height: bottom - top,
    };
    setBlockSelectionMarquee((current) => (
      current
      && current.left === marquee.left
      && current.top === marquee.top
      && current.width === marquee.width
      && current.height === marquee.height
        ? current
        : marquee
    ));

    const root = editorContextRef.current;
    if (!root) return;
    const hitIds = [...root.querySelectorAll<HTMLElement>("[data-node-type='blockContainer']")]
      .filter((element) => {
        const content = element.querySelector<HTMLElement>(":scope > .bn-block-content")
          ?? element.querySelector<HTMLElement>(".bn-block-content");
        if (!content) return false;
        const rect = content.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return hitLeft <= rect.right
          && hitRight >= rect.left
          && top <= rect.bottom
          && bottom >= rect.top;
      })
      .map((element) => element.dataset.id)
      .filter((blockId): blockId is string => Boolean(blockId));
    const nextSelection = [...new Set([...marqueeState.initialBlockIds, ...hitIds])];
    const orderedIds = getOrderedBlockIds();
    const orderIndex = new Map(orderedIds.map((blockId, index) => [blockId, index]));
    nextSelection.sort((first, second) => (
      (orderIndex.get(first) ?? Number.MAX_SAFE_INTEGER)
      - (orderIndex.get(second) ?? Number.MAX_SAFE_INTEGER)
    ));
    if (nextSelection.length > 0) {
      setBlockSelectionState(nextSelection, nextSelection[0]);
      setFocusedBlockId(nextSelection.at(-1) ?? nextSelection[0]);
    } else {
      clearBlockSelection();
    }
  };

  const scheduleMarqueeSelection = (
    marqueeState: NonNullable<typeof marqueeSelectionRef.current>,
    clientX: number,
    clientY: number,
  ) => {
    marqueeState.lastClientX = clientX;
    marqueeState.lastClientY = clientY;
    if (marqueeApplyFrameRef.current !== null) return;
    marqueeApplyFrameRef.current = window.requestAnimationFrame(() => {
      marqueeApplyFrameRef.current = null;
      const current = marqueeSelectionRef.current;
      if (!current?.dragging) return;
      applyMarqueeSelection(current, current.lastClientX, current.lastClientY);
    });
  };

  const stopMarqueeAutoScroll = () => {
    if (marqueeAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(marqueeAutoScrollFrameRef.current);
      marqueeAutoScrollFrameRef.current = null;
    }
  };

  const startMarqueeAutoScroll = () => {
    if (marqueeAutoScrollFrameRef.current !== null) return;
    const step = () => {
      marqueeAutoScrollFrameRef.current = null;
      const marqueeState = marqueeSelectionRef.current;
      const scrollArea = editorStageRef.current;
      if (!marqueeState?.dragging || !scrollArea) return;
      const scrollRect = scrollArea.getBoundingClientRect();
      const edgeSize = 64;
      const topDistance = marqueeState.lastClientY - scrollRect.top;
      const bottomDistance = scrollRect.bottom - marqueeState.lastClientY;
      const speed = topDistance < edgeSize
        ? -Math.ceil((edgeSize - Math.max(0, topDistance)) / 3)
        : bottomDistance < edgeSize
          ? Math.ceil((edgeSize - Math.max(0, bottomDistance)) / 3)
          : 0;
      if (speed !== 0) {
        const previousScrollTop = scrollArea.scrollTop;
        scrollArea.scrollTop += speed;
        if (scrollArea.scrollTop !== previousScrollTop) {
          scheduleMarqueeSelection(marqueeState, marqueeState.lastClientX, marqueeState.lastClientY);
          marqueeAutoScrollFrameRef.current = window.requestAnimationFrame(step);
        }
      }
    };
    marqueeAutoScrollFrameRef.current = window.requestAnimationFrame(step);
  };

  refreshMarqueeSelectionRef.current = () => {
    const marqueeState = marqueeSelectionRef.current;
    if (!marqueeState?.dragging) return;
    scheduleMarqueeSelection(
      marqueeState,
      marqueeState.lastClientX,
      marqueeState.lastClientY,
    );
  };

  useEffect(() => {
    const scrollArea = editorStageRef.current;
    if (!scrollArea) return;
    let frame = 0;
    const handleScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        refreshMarqueeSelectionRef.current?.();
      });
    };
    scrollArea.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      scrollArea.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const updateMarqueeSelection = (
    event: ReactPointerEvent<HTMLDivElement>,
    marqueeState: NonNullable<typeof marqueeSelectionRef.current>,
  ) => {
    marqueeState.lastClientX = event.clientX;
    marqueeState.lastClientY = event.clientY;
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

    scheduleMarqueeSelection(marqueeState, event.clientX, event.clientY);
    startMarqueeAutoScroll();
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
    if (marqueeApplyFrameRef.current !== null) {
      window.cancelAnimationFrame(marqueeApplyFrameRef.current);
      marqueeApplyFrameRef.current = null;
      if (marqueeState.dragging) {
        applyMarqueeSelection(marqueeState, marqueeState.lastClientX, marqueeState.lastClientY);
      }
    }
    marqueeSelectionRef.current = null;
    stopMarqueeAutoScroll();
    setBlockSelectionMarquee(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    return true;
  };

  const moveBlocksToDropTarget = (
    blockIds: string[],
    targetBlockId: string,
    placement: "before" | "after" | "nested",
  ) => {
    if (!currentPageIsEditable()) return;
    const selected = new Set(normalizeBlockIds(blockIds));
    if (selected.size === 0 || selected.has(targetBlockId)) return;

    type EditorBlock = NonNullable<ReturnType<typeof editor.getBlock>>;
    const movingBlocks: EditorBlock[] = [];
    const collectMovingBlocks = (blocks: readonly EditorBlock[]) => {
      blocks.forEach((block) => {
        if (selected.has(block.id)) movingBlocks.push(block);
        else collectMovingBlocks(block.children as readonly EditorBlock[]);
      });
    };
    collectMovingBlocks(editor.document as readonly EditorBlock[]);
    if (movingBlocks.length === 0) return;

    const removeSelected = (blocks: readonly EditorBlock[]): EditorBlock[] => blocks
      .filter((block) => !selected.has(block.id))
      .map((block) => ({
        ...block,
        children: removeSelected(block.children as readonly EditorBlock[]),
      })) as EditorBlock[];
    let inserted = false;
    const insertAtTarget = (blocks: readonly EditorBlock[]): EditorBlock[] => {
      const next: EditorBlock[] = [];
      blocks.forEach((block) => {
        if (block.id === targetBlockId && placement === "before") {
          next.push(...movingBlocks);
          inserted = true;
        }
        const children = insertAtTarget(block.children as readonly EditorBlock[]);
        const nextBlock = block.id === targetBlockId && placement === "nested"
          ? ({ ...block, children: [...children, ...movingBlocks] } as EditorBlock)
          : ({ ...block, children } as EditorBlock);
        if (block.id === targetBlockId && placement === "nested") inserted = true;
        next.push(nextBlock);
        if (block.id === targetBlockId && placement === "after") {
          next.push(...movingBlocks);
          inserted = true;
        }
      });
      return next;
    };
    const nextDocument = insertAtTarget(removeSelected(editor.document as readonly EditorBlock[]));
    if (!inserted) return;
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
    if (!currentPageIsEditable() || event.button !== 0) return;
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
    if (target.closest("[data-nodi-block-selection-ignore='true'], [data-content-type='table'], .database-block, .bn-side-menu, button, input, textarea, select, [role='button'], [role='menu'], .database-scrollbar")) return;
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
    const inlineTextContent = target.closest<HTMLElement>(".bn-inline-content");
    const startsInsideWrittenText = Boolean(
      !isBlockMargin
      && inlineTextContent
      && !target.closest("[contenteditable='false']")
      && inlineTextContent.textContent?.trim(),
    );
    if (startsInsideWrittenText) {
      // 여러 줄의 텍스트를 선택하는 동안 세로 이동이 커지더라도
      // 블록 marquee 선택으로 전환하지 않고 네이티브 텍스트 선택을 유지한다.
      if (blockSelectionModeRef.current) clearBlockSelection();
      return;
    }
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
      const targetContent = targetElement.querySelector<HTMLElement>(":scope > .bn-block-content")
        ?? targetElement.querySelector<HTMLElement>(".bn-block-content");
      const targetRect = (targetContent ?? targetElement).getBoundingClientRect();
      const targetBlock = editor.getBlock(targetBlockId);
      const canNest = targetBlock?.type === "toggleListItem"
        || (targetBlock?.type === "heading" && Boolean((targetBlock.props as { isToggleable?: boolean }).isToggleable));
      const placement: "before" | "after" | "nested" = canNest
        && event.clientX > targetRect.left + 28
        && event.clientY >= targetRect.top + targetRect.height * .38
          ? "nested"
          : event.clientY < targetRect.top + targetRect.height / 2
            ? "before"
            : "after";
      const nextTarget = { blockId: targetBlockId, placement };
      dragState.dropTarget = nextTarget;
      const horizontalPadding = 7;
      const nestedIndent = placement === "nested" ? 26 : 0;
      const nextIndicator = {
        left: targetRect.left - horizontalPadding + nestedIndent,
        top: placement === "before" ? targetRect.top : targetRect.bottom,
        width: Math.max(40, targetRect.width + horizontalPadding * 2 - nestedIndent),
        nested: placement === "nested",
      };
      setBlockDropIndicator((current) => (
        current
        && current.left === nextIndicator.left
        && current.top === nextIndicator.top
        && current.width === nextIndicator.width
        && current.nested === nextIndicator.nested
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
      sendRealtimePresence(blockId);
      if (!blockSelectionModeRef.current) blockSelectionAnchorRef.current = blockId;
    }
  };

  const handleEditorBlur = () => {
    window.requestAnimationFrame(() => {
      if (!editorContextRef.current?.contains(document.activeElement)) {
        sendRealtimePresence(null);
      }
    });
  };

  const handleEditorClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressEditorClickRef.current) {
      suppressEditorClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest(".block-selection-toolbar, .block-comment-marker")) return;
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
    if (cursorBlockId) {
      setFocusedBlockId(cursorBlockId);
      sendRealtimePresence(cursorBlockId);
    }

    const selection = editor.getSelection();
    const selectionType = editor.prosemirrorView.state.selection.constructor.name;
    const isNodeSelection = selectionType === "NodeSelection" || selectionType === "MultipleNodeSelection";
    // Marquee/handle selection is managed independently from ProseMirror's transient
    // pointer selection. Syncing that transient selection here collapses a multi-block
    // marquee back to the single block below the pointer on pointer-up.
    if (blockSelectionModeRef.current) return;
    if (isNodeSelection) {
      const ids = selection?.blocks.map((block) => block.id)
        ?? (cursorBlockId ? [cursorBlockId] : []);
      if (ids.length > 0) {
        setBlockSelectionState(ids, blockSelectionAnchorRef.current ?? ids[0]);
      }
    } else {
      selectedBlockIdsRef.current = [];
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
        ? { ...block.props, databaseId: copyDatabase(block.props.databaseId || `database-${block.id}`) }
        : block.props,
      content: block.content,
      children: block.children.map((child) => cloneBlock(child as EditorBlock)),
    } as unknown as PartialBlock);
    let copiedBlocks: PartialBlock[];
    try {
      copiedBlocks = blocks.map((block) => cloneBlock(block));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "블록을 복제하지 못했어요");
      return;
    }
    const insertedBlocks = editor.insertBlocks(copiedBlocks, referenceBlock.id, "after");
    if (insertedBlocks.length > 0) {
      const insertedIds = insertedBlocks.map((block) => block.id);
      setBlockSelectionState(insertedIds, insertedIds[0]);
      setFocusedBlockId(insertedIds[0]);
    }
    setContextMenu(null);
    setNotice(`${blocks.length}개 블록을 복제했어요`);
  };

  const copySelectedBlocks = () => {
    if (!blockSelectionModeRef.current || selectedBlockIdsRef.current.length === 0) return;

    // Keep the native copy event inside the editor context so the existing
    // block clipboard serializer can include Nodi, BlockNote, HTML and plain
    // text formats. This preserves full block structure when pasting into a
    // different page while still working as a direct toolbar action.
    editorContextRef.current?.focus({ preventScroll: true });
    if (!document.execCommand("copy")) {
      setNotice("블록을 클립보드에 복사하지 못했어요");
    }
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
    commitBlockComments((current) => Object.fromEntries(
      Object.entries(current).filter(([, thread]) => (
        thread.pageId !== currentPageIdRef.current || !normalizedIds.includes(thread.blockId)
      )),
    ));
    if (activeCommentBlockId && normalizedIds.includes(activeCommentBlockId)) {
      setActiveCommentBlockId(null);
    }
    clearBlockSelection();
    setPendingBlockDeletion(null);
    setContextMenu(null);
    setNotice(`${normalizedIds.length}개 블록을 삭제했어요 · ⌘/Ctrl+Z로 되돌릴 수 있어요`);
    window.requestAnimationFrame(() => editor.focus());
  };

  const hasNativeEditorTextSelection = () => {
    const selection = window.getSelection();
    const editorRoot = editorContextRef.current;
    if (
      !selection
      || !editorRoot
      || selection.rangeCount === 0
      || selection.isCollapsed
      || selection.toString().length === 0
      || !selection.anchorNode
      || !selection.focusNode
    ) {
      return false;
    }

    return editorRoot.contains(selection.anchorNode)
      && editorRoot.contains(selection.focusNode);
  };

  const writeBlocksToClipboard = (
    event: ReactClipboardEvent<HTMLDivElement>,
    blockIds: string[],
  ) => {
    type EditorBlock = NonNullable<ReturnType<typeof editor.getBlock>>;
    const blocks = normalizeBlockIds(blockIds)
      .map((blockId) => editor.getBlock(blockId))
      .filter((block): block is EditorBlock => block !== undefined);
    if (blocks.length === 0) return [];
    writeEditorBlocksToClipboard(event.clipboardData, editor, blocks as unknown as PartialBlock[]);
    return blocks;
  };

  const handleEditorCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
    // Marquee/whole-block selection must win over a stale native text range.
    // Browsers can keep the previous DOM selection even after the user starts a
    // block selection, which otherwise makes Ctrl/Cmd+C serialize only that
    // old text range instead of the selected blocks.
    if (blockSelectionModeRef.current && selectedBlockIdsRef.current.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      try {
        const copiedBlocks = writeBlocksToClipboard(event, selectedBlockIdsRef.current);
        if (copiedBlocks.length > 0) setNotice(`${copiedBlocks.length}개 블록을 복사했어요`);
      } catch {
        setNotice("블록을 클립보드에 복사하지 못했어요");
      }
      return;
    }

    if (copySelectedDatabaseBlocks(event, editor)) return;
    const { state } = editor.prosemirrorView;
    const { selection } = state;
    if (!selection.empty) {
      let codeDepth: number | undefined;
      for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
        if (selection.$from.node(depth).type.spec.code === true) {
          codeDepth = depth;
          break;
        }
      }
      if (codeDepth !== undefined) {
        const codeNode = selection.$from.node(codeDepth);
        const codeStart = selection.$from.start(codeDepth);
        const codeEnd = codeStart + codeNode.content.size;
        if (selection.from >= codeStart && selection.to <= codeEnd) {
          event.preventDefault();
          event.stopPropagation();
          event.clipboardData.clearData();
          event.clipboardData.setData(
            "text/plain",
            state.doc.textBetween(selection.from, selection.to, "\n", "\n"),
          );
          return;
        }
      }
    }
    if (hasNativeEditorTextSelection()) {
      const nativeSelection = window.getSelection();
      if (!nativeSelection || nativeSelection.rangeCount === 0) return;

      // Browser/BlockNote clipboard serialization can flatten hard breaks or
      // express them as Markdown's trailing backslash. ProseMirror already
      // knows the exact selected range, so write real newline characters to
      // text/plain while keeping a rich HTML representation for styled paste.
      const selectedText = state.doc.textBetween(selection.from, selection.to, "\n", "\n");
      const htmlContainer = document.createElement("div");
      htmlContainer.append(nativeSelection.getRangeAt(0).cloneContents());
      event.preventDefault();
      event.stopPropagation();
      event.clipboardData.clearData();
      event.clipboardData.setData("text/plain", selectedText);
      event.clipboardData.setData("text/html", htmlContainer.innerHTML);
      return;
    }
  };

  const handleWorkspacePasteCapture = (event: ReactClipboardEvent<HTMLElement>) => {
    if (!event.clipboardData.types.includes(NODI_BLOCK_CLIPBOARD_MIME)) return;
    const target = event.target as HTMLElement;
    if (editorContextRef.current?.contains(target)) return;
    if (!currentPageIsEditable()) return;

    const isTitleInput = target === titleInputRef.current;
    if (!isTitleInput && target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (!pasteNodiClipboardBlocks(editor, event.clipboardData)) return;

    event.preventDefault();
    event.stopPropagation();
    clearBlockSelection();
    setNotice("복사한 블록을 붙여넣었어요");
  };

  const handleEditorCut = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!currentPageIsEditable()) return;
    if (!blockSelectionModeRef.current && copySelectedDatabaseBlocks(event, editor, true)) return;
    // 텍스트를 드래그해 선택한 상태에서는 BlockNote/브라우저의 기본
    // 잘라내기를 그대로 사용한다. 이전 블록 선택 상태가 남아 있더라도
    // 네이티브 텍스트 선택을 우선해야 현재 문장만 정확히 잘린다.
    if (hasNativeEditorTextSelection()) {
      if (blockSelectionModeRef.current) {
        window.setTimeout(clearBlockSelection, 0);
      }
      return;
    }

    const eventTarget = event.target as HTMLElement;
    const activeElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const isNativeFormControl = Boolean(
      eventTarget.closest("input, textarea, select")
      || activeElement?.closest("input, textarea, select"),
    );
    if (isNativeFormControl) return;

    if (!blockSelectionModeRef.current) {
      const selection = editor.prosemirrorView.state.selection;
      if (selection.empty && selection.$from.parent.type.spec.code === true) {
        const text = selection.$from.parent.textContent;
        const cursorOffset = selection.$from.parentOffset;
        const lineStart = text.lastIndexOf("\n", Math.max(0, cursorOffset - 1)) + 1;
        const nextNewline = text.indexOf("\n", cursorOffset);
        const lineEnd = nextNewline < 0 ? text.length : nextNewline + 1;
        const cutText = text.slice(lineStart, nextNewline < 0 ? text.length : lineEnd);
        let deleteStart = lineStart;
        let deleteEnd = lineEnd;
        if (nextNewline < 0 && lineStart > 0) deleteStart -= 1;
        event.preventDefault();
        event.stopPropagation();
        event.clipboardData.clearData();
        event.clipboardData.setData("text/plain", cutText);
        const transaction = editor.prosemirrorView.state.tr
          .delete(selection.$from.start() + deleteStart, selection.$from.start() + deleteEnd)
          .scrollIntoView();
        editor.prosemirrorView.dispatch(transaction);
        setNotice("현재 코드 줄을 잘라냈어요");
        return;
      }
    }

    let blockIds = selectedBlockIdsRef.current;
    if (!blockSelectionModeRef.current || blockIds.length === 0) {
      try {
        // 선택 범위 없이 텍스트 커서만 있는 상태에서는 현재 작성 중인
        // 블록 하나를 잘라낸다. 블록을 먼저 선택할 필요가 없다.
        blockIds = [editor.getTextCursorPosition().block.id];
      } catch {
        return;
      }
    }

    event.preventDefault();
    event.stopPropagation();
    if (pageSettings.lockPage) {
      setNotice("잠긴 페이지에서는 블록을 잘라낼 수 없어요");
      return;
    }

    try {
      const normalizedIds = normalizeBlockIds(blockIds);
      const blocks = writeBlocksToClipboard(event, normalizedIds);
      if (blocks.length === 0) return;
      removeBlocks(normalizedIds);
      setNotice(`${blocks.length}개 블록을 잘라냈어요`);
    } catch {
      setNotice("블록을 클립보드에 복사하지 못했어요");
    }
  };

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isComposingKey(event.nativeEvent)) return;
    if (!currentPageIsEditable()) return;
    const target = event.target as HTMLElement;
    const isEditorEvent = Boolean(target.closest(".bn-editor"));
    if (pageSettings.lockPage || (!isEditorEvent && !blockSelectionModeRef.current)) return;
    const hasPrimaryModifier = event.metaKey || event.ctrlKey;
    const isNativeTextControl = Boolean(target.closest("input, textarea, select"));
    let cursorBlockId: string | undefined;
    try {
      cursorBlockId = editor.getTextCursorPosition().block.id;
    } catch {
      cursorBlockId = undefined;
    }
    const blockId = getEventBlockId(event.target) ?? cursorBlockId ?? focusedBlockId ?? undefined;
    const currentBlock = blockId ? editor.getBlock(blockId) : undefined;
    const prosemirrorSelection = editor.prosemirrorView.state.selection;
    let codeBlockSelectionDepth: number | undefined;
    for (let depth = prosemirrorSelection.$from.depth; depth > 0; depth -= 1) {
      if (prosemirrorSelection.$from.node(depth).type.spec.code === true) {
        codeBlockSelectionDepth = depth;
        break;
      }
    }
    const isCodeBlockEvent = currentBlock?.type === "codeBlock"
      || codeBlockSelectionDepth !== undefined;

    if (
      event.key === "`"
      && !hasPrimaryModifier
      && !event.altKey
      && !event.shiftKey
      && currentBlock?.type === "paragraph"
      && blockPlainText(currentBlock).trim() === "``"
    ) {
      event.preventDefault();
      event.stopPropagation();
      editor.updateBlock(currentBlock.id, { type: "codeBlock", props: { language: "text" }, content: "" });
      window.requestAnimationFrame(() => {
        editor.setTextCursorPosition(currentBlock.id, "start");
        editor.focus();
      });
      return;
    }

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
    if (
      hasPrimaryModifier
      && event.key.toLowerCase() === "a"
      && !event.shiftKey
      && !event.altKey
      && !isNativeTextControl
    ) {
      if (isCodeBlockEvent && codeBlockSelectionDepth !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        const { state, dispatch } = editor.prosemirrorView;
        const codeBlockNode = state.selection.$from.node(codeBlockSelectionDepth);
        const codeStart = state.selection.$from.start(codeBlockSelectionDepth);
        const codeEnd = codeStart + codeBlockNode.content.size;
        if (blockSelectionModeRef.current) clearBlockSelection();
        dispatch(state.tr.setSelection(TextSelection.create(state.doc, codeStart, codeEnd)));
        editor.focus();
        return;
      }
      const orderedBlockIds = getOrderedBlockIds();
      if (orderedBlockIds.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      // Keep a real DOM range after Cmd/Ctrl+A. Chrome can skip the following
      // native `copy` event when only Nodi's visual block selection exists and
      // the browser selection is empty. The copy handler still serializes the
      // selected blocks first, so this range is only the browser-level trigger.
      const nativeSelection = window.getSelection();
      const editorRoot = editorContextRef.current?.querySelector<HTMLElement>(".bn-editor");
      nativeSelection?.removeAllRanges();
      if (nativeSelection && editorRoot) {
        const editorRange = document.createRange();
        editorRange.selectNodeContents(editorRoot);
        nativeSelection.addRange(editorRange);
      }
      setBlockSelectionState(orderedBlockIds, orderedBlockIds[0]);
      setFocusedBlockId(orderedBlockIds[orderedBlockIds.length - 1]);
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
    const editorRoot = root?.querySelector<HTMLElement>(".bn-editor");
    if (!root || !editorRoot || selectedBlockIds.length === 0) return;
    let frame = 0;
    const updateOverlays = () => {
      const rootRect = root.getBoundingClientRect();
      selectedBlockIds.forEach((blockId) => {
        const overlay = blockSelectionOverlayRefs.current.get(blockId);
        const element = root.querySelector<HTMLElement>(
          `[data-node-type='blockContainer'][data-id="${CSS.escape(blockId)}"]`,
        );
        if (!overlay || !element) {
          overlay?.removeAttribute("data-positioned");
          return;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          overlay.removeAttribute("data-positioned");
          return;
        }
        const horizontalInset = currentPageId === ROOT_PAGE_ID ? 0 : 7;
        const verticalGap = Math.min(1, rect.height / 4);
        overlay.style.left = `${rect.left - rootRect.left - horizontalInset}px`;
        overlay.style.top = `${rect.top - rootRect.top + verticalGap}px`;
        overlay.style.width = `${rect.width + horizontalInset * 2}px`;
        overlay.style.height = `${Math.max(2, rect.height - verticalGap * 2)}px`;
        overlay.dataset.positioned = "true";
      });
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateOverlays);
    };
    schedule();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(root);
    resizeObserver.observe(editorRoot);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(editorRoot, { subtree: true, childList: true });
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [currentPageId, selectedBlockIds]);

  useLayoutEffect(() => {
    const root = editorContextRef.current;
    if (!root) return;
    const editorRoot = root.querySelector<HTMLElement>(".bn-editor");
    const scrollArea = editorStageRef.current;
    let frame = 0;

    const updatePosition = () => {
      const positionIds = selectedBlockIds.length > 1
        ? [selectedBlockIds[0], selectedBlockIds[selectedBlockIds.length - 1]]
        : selectedBlockIds;
      const rects = positionIds
        .map((blockId) => {
          const element = root.querySelector<HTMLElement>(
            `[data-node-type='blockContainer'][data-id="${CSS.escape(blockId)}"]`,
          );
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          const selectionHorizontalInset = currentPageId === ROOT_PAGE_ID ? 0 : 7;
          return {
            left: rect.left - selectionHorizontalInset,
            top: rect.top,
            width: rect.width + selectionHorizontalInset * 2,
            height: rect.height,
          };
        })
        .filter((rect): rect is BlockSelectionMarquee => Boolean(rect));

      const toolbar = blockSelectionToolbarRef.current;
      const activeRealtimeParticipants = realtimeParticipants.filter((participant) => (
        participant.activeBlockId && participant.user.id !== authUser?.id
      ));
      Object.values(blockComments)
        .filter((thread) => (
          thread.pageId === currentPageId
          && !thread.resolvedAt
          && thread.messages.length > 0
        ))
        .forEach((thread) => {
          const marker = blockCommentMarkerRefs.current.get(thread.blockId);
          const element = root.querySelector<HTMLElement>(
            `[data-node-type='blockContainer'][data-id="${CSS.escape(thread.blockId)}"]`,
          );
          const content = element?.querySelector<HTMLElement>(":scope > .bn-block-content")
            ?? element?.querySelector<HTMLElement>(".bn-block-content");
          if (!marker || !content) {
            marker?.removeAttribute("data-positioned");
            return;
          }
          const rect = content.getBoundingClientRect();
          const scrollRect = scrollArea?.getBoundingClientRect();
          const topbarBottom = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect().bottom ?? 0;
          const visibleTop = Math.max(0, scrollRect?.top ?? 0, topbarBottom);
          const visibleBottom = Math.min(window.innerHeight, scrollRect?.bottom ?? window.innerHeight);
          if (
            rect.width <= 0
            || rect.height <= 0
            || rect.bottom <= visibleTop
            || rect.top >= visibleBottom
          ) {
            marker.removeAttribute("data-positioned");
            return;
          }
          const markerWidth = marker.offsetWidth || 36;
          const markerCenter = rect.top + Math.min(rect.height / 2, 18);
          const markerOffset = 13;
          const activeEditorCount = activeRealtimeParticipants
            .filter((participant) => participant.activeBlockId === thread.blockId)
            .length;
          const presenceWidth = activeEditorCount > 0 ? 26 + (activeEditorCount - 1) * 17 + 5 : 0;
          marker.style.left = `${Math.min(window.innerWidth - markerWidth - 10, rect.right + markerOffset + presenceWidth)}px`;
          marker.style.top = `${Math.max(visibleTop + 16, Math.min(visibleBottom - 16, markerCenter))}px`;
          marker.dataset.positioned = "true";
        });

      activeRealtimeParticipants.forEach((participant) => {
        const marker = blockPresenceMarkerRefs.current.get(participant.user.id);
        const blockId = participant.activeBlockId;
        const element = blockId
          ? root.querySelector<HTMLElement>(
            `[data-node-type='blockContainer'][data-id="${CSS.escape(blockId)}"]`,
          )
          : null;
        const content = element?.querySelector<HTMLElement>(":scope > .bn-block-content")
          ?? element?.querySelector<HTMLElement>(".bn-block-content");
        if (!marker || !content) {
          marker?.removeAttribute("data-positioned");
          return;
        }
        const rect = content.getBoundingClientRect();
        const scrollRect = scrollArea?.getBoundingClientRect();
        const topbarBottom = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect().bottom ?? 0;
        const visibleTop = Math.max(0, scrollRect?.top ?? 0, topbarBottom);
        const visibleBottom = Math.min(window.innerHeight, scrollRect?.bottom ?? window.innerHeight);
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= visibleTop || rect.top >= visibleBottom) {
          marker.removeAttribute("data-positioned");
          return;
        }
        const sameBlock = activeRealtimeParticipants.filter((candidate) => candidate.activeBlockId === blockId);
        const participantIndex = Math.max(0, sameBlock.findIndex((candidate) => candidate.user.id === participant.user.id));
        const markerCenter = rect.top + Math.min(rect.height / 2, 18);
        marker.style.left = `${Math.min(window.innerWidth - 30, rect.right + 13 + participantIndex * 17)}px`;
        marker.style.top = `${Math.max(visibleTop + 16, Math.min(visibleBottom - 16, markerCenter))}px`;
        marker.style.zIndex = String(76 + sameBlock.length - participantIndex);
        marker.dataset.positioned = "true";
      });

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
  }, [
    authUser?.id,
    blockComments,
    currentPageId,
    realtimeParticipants,
    selectedBlockIds,
    isBlockSelectionMode,
    isBlockDragging,
    blockSelectionMarquee === null,
  ]);

  useLayoutEffect(() => {
    const menuState = blockSelectionActionMenu;
    const menu = blockSelectionActionMenuRef.current;
    if (!menuState || !menu) return;

    const viewportPadding = 12;
    const triggerGap = 6;
    const availableBelow = Math.max(
      0,
      window.innerHeight - viewportPadding - menuState.anchor.bottom - triggerGap,
    );
    const availableAbove = Math.max(
      0,
      menuState.anchor.top - triggerGap - viewportPadding,
    );
    // Measure the untransformed layout size. getBoundingClientRect() includes
    // the opening scale animation and feeding that value back into max-height
    // causes a shrinking render loop while the menu is opening.
    const desiredHeight = menu.scrollHeight;
    const placement = desiredHeight <= availableBelow
      ? "bottom"
      : desiredHeight <= availableAbove
        ? "top"
        : availableAbove > availableBelow
          ? "top"
          : "bottom";
    const maxHeight = desiredHeight;
    const menuWidth = menu.offsetWidth;
    const x = Math.max(
      viewportPadding,
      Math.min(
        menuState.anchor.right - menuWidth,
        window.innerWidth - viewportPadding - menuWidth,
      ),
    );
    const desiredY = placement === "top"
      ? menuState.anchor.top - triggerGap - maxHeight
      : menuState.anchor.bottom + triggerGap;
    const y = Math.max(
      viewportPadding,
      Math.min(desiredY, window.innerHeight - viewportPadding - maxHeight),
    );

    setBlockSelectionActionMenu((current) => {
      if (!current || current.kind !== menuState.kind) return current;
      if (
        Math.abs(current.x - x) < .5
        && Math.abs(current.y - y) < .5
        && Math.abs(current.maxHeight - maxHeight) < .5
        && current.placement === placement
      ) {
        return current;
      }
      return { ...current, x, y, maxHeight, placement };
    });
  }, [blockSelectionActionMenuPositionKey]);

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
      if (isComposingKey(event)) return;
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

    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setBlockSelectionActionMenu(null);
    setRightPanel(null);
    window.getSelection()?.removeAllRanges();

    const clickedInsideSelection = blockSelectionModeRef.current && selectedBlockIds.includes(blockId);
    if (!clickedInsideSelection) {
      selectSingleBlock(blockId);
    } else {
      setFocusedBlockId(blockId);
    }
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
  const canEditCurrentPage = currentPage.permission !== "view" && !pageSettings.lockPage && !publicPageId;

  useLayoutEffect(() => {
    // BlockNoteView normally mirrors the `editable` prop into the editor, but
    // permission changes can arrive while the same editor instance is already
    // mounted. Apply it synchronously as well so a viewer never gets a brief
    // editable window before React remounts the contentEditable surface.
    editor.isEditable = canEditCurrentPage;
    if (canEditCurrentPage) return;
    if (realtimeBlocksTimerRef.current) {
      window.clearTimeout(realtimeBlocksTimerRef.current);
      realtimeBlocksTimerRef.current = null;
    }
    realtimePendingBlocksRef.current = null;
    realtimeProtectedBlockIdsRef.current.clear();
    realtimeProtectedDeletedBlockIdsRef.current.clear();
    clearBlockSelection();
    setContextMenu(null);
    setBlockSelectionActionMenu(null);
    setFocusedBlockId(null);
    sendRealtimePresence(null);
  }, [canEditCurrentPage, currentPageId, editor]);

  const currentPageLink = getPageLink(currentPageId, Boolean(pageSettings.publicAccess));
  const localSaveLabel = localSaveState === "saving"
    ? "저장 중"
    : localSaveState === "error"
      ? "저장 실패"
      : "저장됨";
  const LocalSaveIcon = localSaveState === "saving" ? LoaderCircle : HardDrive;
  const isAuthenticated = Boolean(authUser);
  const currentNodiUser = useMemo(() => authUser ? {
    ...authUser,
    avatarColor: authUser.avatarColor as NodiAvatarColor,
  } : {
    id: "guest:local",
    name: "게스트",
    email: "guest@nodi.local",
    avatarColor: "gray" as const,
    role: "member" as const,
  }, [authUser]);
  const registeredNodiUsers = useMemo(() => {
    if (authUser) {
      return serverDirectoryUsers.map((user) => ({
        ...user,
        avatarColor: user.avatarColor as NodiAvatarColor,
      }));
    }
    const approvedUsers = readRegistrationRequests()
      .filter((request) => request.status === "approved")
      .map((request) => ({
        id: request.id,
        name: request.name,
        email: request.email,
        avatarColor: "gray" as const,
        role: "member" as const,
      }));
    const localUsers = readApprovedLocalUsers().map((user) => ({
      ...user,
      avatarColor: user.avatarColor as NodiAvatarColor,
    }));
    const knownIds = new Set(REGISTERED_NODI_USERS.map((user) => user.id));
    const knownEmails = new Set(REGISTERED_NODI_USERS.map((user) => user.email.toLocaleLowerCase()));
    const requestUsers = approvedUsers.filter((user) => (
      !knownIds.has(user.id) && !knownEmails.has(user.email.toLocaleLowerCase())
    ));
    const combinedUsers = [
      ...REGISTERED_NODI_USERS,
      ...localUsers,
      ...requestUsers,
    ];
    return combinedUsers.filter((user, index) => (
      combinedUsers.findIndex((candidate) => (
        candidate.id === user.id
        || candidate.email.toLocaleLowerCase() === user.email.toLocaleLowerCase()
      )) === index
    ));
  }, [authUser, registrationDirectoryRevision, serverDirectoryUsers]);
  const searchRegisteredNodiUsers = useCallback(async (query: string) => {
    if (!authUser) return [];
    const users = await authApi.searchUsers(query);
    return users.map((user) => ({
      ...user,
      avatarColor: user.avatarColor as NodiAvatarColor,
    }));
  }, [authUser?.id]);
  const currentPageShare = pageShares[currentPageId];
  const isCurrentPageOwner = !currentPageShare || currentPageShare.ownerId === currentNodiUser.id;
  const isInvitedNodiMember = Boolean(currentPageShare?.members.some((member) => (
    member.userId === currentNodiUser.id
    && registeredNodiUsers.some((user) => user.id === member.userId)
  )));
  const isSharedWithNodiMember = Boolean(currentPageShare?.members.length);
  const canCommentOnCurrentPage = Boolean(
    isAuthenticated
    &&
    currentPageShare
    && ((isCurrentPageOwner && isSharedWithNodiMember) || isInvitedNodiMember),
  );
  const commentDisabledReason = isCurrentPageOwner
    ? "Nodi 회원에게 페이지를 공유하면 댓글을 작성할 수 있어요."
    : "이 페이지에 초대된 Nodi 회원만 댓글을 작성할 수 있어요.";
  const currentPageCommentThreads = Object.values(blockComments).filter((thread) => thread.pageId === currentPageId);
  const pageCommentCounts = Object.values(blockComments).reduce<Record<string, number>>((counts, thread) => {
    if (thread.resolvedAt) return counts;
    counts[thread.pageId] = (counts[thread.pageId] ?? 0) + thread.messages.length;
    return counts;
  }, {});
  const activeCommentThread = activeCommentBlockId
    ? currentPageCommentThreads.find((thread) => thread.blockId === activeCommentBlockId)
    : undefined;
  const activeCommentBlock = activeCommentBlockId ? editor.getBlock(activeCommentBlockId) : undefined;
  const activeCommentBlockPreview = activeCommentThread?.blockPreview || getBlockPreview(activeCommentBlock);

  const openBlockComments = (blockId: string) => {
    if (!editor.getBlock(blockId)) {
      setNotice("댓글을 연결할 블록을 찾을 수 없어요");
      return;
    }
    setActiveCommentBlockId(blockId);
    setRightPanel(null);
    setPageSettingsOpen(false);
    setContextMenu(null);
    setBlockSelectionActionMenu(null);
  };

  const addBlockComment = (blockId: string, body: string, parentId: string | null) => {
    if (!canCommentOnCurrentPage) {
      setNotice(commentDisabledReason);
      return;
    }
    const block = editor.getBlock(blockId);
    if (!block) {
      setActiveCommentBlockId(null);
      setNotice("댓글을 연결한 블록이 삭제되었어요");
      return;
    }
    const now = new Date().toISOString();
    const previous = Object.values(blockComments).find((thread) => (
      thread.pageId === currentPageId && thread.blockId === blockId
    ));
    const requestedParent = parentId
      ? previous?.messages.find((message) => message.id === parentId)
      : undefined;
    const normalizedParentId = requestedParent
      ? requestedParent.parentId ?? requestedParent.id
      : null;
    const messageId = makeId("comment");
    const threadId = previous?.id ?? makeId("comment-thread");
    const message = {
      id: messageId,
      parentId: normalizedParentId,
      authorId: currentNodiUser.id,
      authorName: currentNodiUser.name,
      authorEmail: currentNodiUser.email,
      body,
      createdAt: now,
    };
    const commitLocalComment = () => commitBlockComments((current) => {
      if (previous) {
        return {
          ...current,
          [previous.id]: {
            ...previous,
            blockPreview: getBlockPreview(block),
            messages: [...previous.messages, message],
            resolvedAt: null,
            resolvedBy: null,
            updatedAt: now,
          },
        };
      }
      return {
        ...current,
        [threadId]: {
          id: threadId,
          pageId: currentPageId,
          blockId,
          blockPreview: getBlockPreview(block),
          messages: [message],
          resolvedAt: null,
          resolvedBy: null,
          updatedAt: now,
        },
      };
    });
    if (authUser) {
      void (async () => {
        try {
          const serverThread = previous
            ? await workspaceApi.addCommentMessage(threadId, {
                id: messageId,
                parentId: normalizedParentId,
                body,
              })
            : await workspaceApi.createComment(currentPageId, {
                id: threadId,
                blockId,
                blockPreview: getBlockPreview(block),
                body,
              });
          commitBlockComments((current) => ({
            ...current,
            [serverThread.id]: storedCommentFromServer(serverThread),
          }));
          setLocalSaveState("saved");
          setNotice("블록에 댓글을 남겼어요");
        } catch (error) {
          setLocalSaveState("error");
          setNotice(error instanceof Error ? error.message : "댓글을 서버에 저장하지 못했어요");
        }
      })();
    } else {
      commitLocalComment();
      setNotice("블록에 댓글을 남겼어요");
    }
  };

  const deleteBlockComment = (threadId: string, commentId: string) => {
    const thread = blockComments[threadId];
    const targetComment = thread?.messages.find((message) => message.id === commentId);
    if (!thread || !targetComment || targetComment.authorId !== currentNodiUser.id) return;
    const commitLocalDelete = () => commitBlockComments((current) => {
      const thread = current[threadId];
      if (!thread) return current;
      const targetComment = thread.messages.find((message) => message.id === commentId);
      if (!targetComment || targetComment.authorId !== currentNodiUser.id) return current;
      const messages = thread.messages.filter((message) => (
        message.id !== commentId
        && (targetComment.parentId || message.parentId !== commentId)
      ));
      if (messages.length === 0) {
        const next = { ...current };
        delete next[threadId];
        return next;
      }
      return {
        ...current,
        [threadId]: {
          ...thread,
          messages,
          updatedAt: new Date().toISOString(),
        },
      };
    });
    if (authUser) {
      void (async () => {
        try {
          await workspaceApi.deleteCommentMessage(threadId, commentId);
          commitLocalDelete();
          setLocalSaveState("saved");
          setNotice("댓글을 삭제했어요");
        } catch (error) {
          setLocalSaveState("error");
          setNotice(error instanceof Error ? error.message : "댓글을 삭제하지 못했어요");
        }
      })();
    } else {
      commitLocalDelete();
      setNotice("댓글을 삭제했어요");
    }
  };

  const setBlockCommentResolved = (threadId: string, resolved: boolean) => {
    if (authUser) {
      void workspaceApi.resolveComment(threadId, resolved)
        .then((serverThread) => {
          commitBlockComments((current) => ({
            ...current,
            [threadId]: storedCommentFromServer(serverThread),
          }));
          setLocalSaveState("saved");
          setNotice(resolved ? "댓글을 해결로 표시했어요" : "댓글을 다시 열었어요");
        })
        .catch((error: unknown) => {
          setLocalSaveState("error");
          setNotice(error instanceof Error ? error.message : "댓글 상태를 저장하지 못했어요");
        });
      return;
    }
    commitBlockComments((current) => {
      const thread = current[threadId];
      if (!thread) return current;
      return {
        ...current,
        [threadId]: {
          ...thread,
          resolvedAt: resolved ? new Date().toISOString() : null,
          resolvedBy: resolved ? currentNodiUser.id : null,
          updatedAt: new Date().toISOString(),
        },
      };
    });
    setNotice(resolved ? "댓글을 해결로 표시했어요" : "댓글을 다시 열었어요");
  };

  const isHomePage = isAuthenticated && currentPageId === ROOT_PAGE_ID;
  const isFavorite = !isHomePage && Boolean(currentPage.favoritedAt);
  const canManageCurrentPageShares = !isHomePage && (currentPage.permission ?? "owner") === "owner";
  const unreadInboxCount = inboxNotifications.filter((notification) => notification.unread).length;
  const markAllInboxNotificationsRead = () => {
    setInboxNotifications((notifications) => notifications.map((notification) => ({ ...notification, unread: false })));
    if (authUser) {
      void workspaceApi.readAllNotifications().catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : "알림 읽음 상태를 저장하지 못했어요");
      });
    }
  };
  const openInboxNotification = (notification: InboxNotification) => {
    setInboxNotifications((notifications) => notifications.map((candidate) => (
      candidate.id === notification.id ? { ...candidate, unread: false } : candidate
    )));
    if (authUser && notification.unread) {
      void workspaceApi.readNotification(notification.id).catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : "알림 읽음 상태를 저장하지 못했어요");
      });
    }
    if (!notification.pageId) return;
    const openNotificationPage = async () => {
      if (!pagesRef.current[notification.pageId!]) {
        if (!authUser) return;
        try {
          const serverPage = await workspaceApi.getPage(notification.pageId!);
          const sharedPage = storedPageFromServer(serverPage);
          const nextPages = { ...pagesRef.current, [sharedPage.id]: sharedPage };
          pagesRef.current = nextPages;
          serverPagesSnapshotRef.current = {
            ...serverPagesSnapshotRef.current,
            [sharedPage.id]: sharedPage,
          };
          persistStoredPages(nextPages);
          setPages(nextPages);
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "공유 페이지를 불러오지 못했어요");
          return;
        }
      }
      setInboxOpen(false);
      openPage(notification.pageId!);
    };
    void openNotificationPage();
  };
  const sharedPageCount = Object.values(pageShares).filter((record) => (
    (
      (record.ownerId === currentNodiUser.id && record.members.length > 0)
      || (
        record.ownerId !== currentNodiUser.id
        && record.members.some((member) => member.userId === currentNodiUser.id)
      )
    )
    // Share metadata can arrive before the heavier page bootstrap. An absent
    // local page must not hide the badge; only an explicitly archived page is
    // excluded.
    && pages[record.pageId]?.archived !== true
  )).length;
  const favoritePages = Object.values(pages)
    .filter((page) => page.id !== ROOT_PAGE_ID && !page.archived && (page.permission ?? "owner") === "owner" && Boolean(page.favoritedAt))
    .sort((first, second) => (second.favoritedAt ?? "").localeCompare(first.favoritedAt ?? ""));
  const homeRecentPages = Object.values(pages)
    .filter((page) => page.id !== ROOT_PAGE_ID && !page.archived && (page.permission ?? "owner") === "owner")
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
    .slice(0, 4);
  const homeFavoritePages = favoritePages
    .filter((page) => page.id !== ROOT_PAGE_ID && !page.archived)
    .slice(0, 4);
  const parentPage = currentPage.parentId ? pages[currentPage.parentId] : null;
  const breadcrumbPages = (() => {
    const pageChain: StoredPage[] = [];
    const visitedPageIds = new Set<string>();
    let page: StoredPage | undefined = currentPage;

    while (page && !visitedPageIds.has(page.id)) {
      visitedPageIds.add(page.id);
      pageChain.unshift(page);
      page = page.parentId ? pages[page.parentId] : undefined;
    }

    return pageChain;
  })();
  const folderChildren = (parentId: string | null) => Object.values(folders)
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  const folderPages = (folderId: string) => Object.values(pages)
    .filter((page) => page.id !== ROOT_PAGE_ID && !page.archived && (page.permission ?? "owner") === "owner" && page.folderId === folderId)
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
  const personalPageCount = Object.values(pages)
    .filter((page) => page.id !== ROOT_PAGE_ID && !page.archived && (page.permission ?? "owner") === "owner").length;
  const trashPageCount = Object.values(pages)
    .filter((page) => page.id !== ROOT_PAGE_ID && page.archived && (page.permission ?? "owner") === "owner").length;
  const liveSelectedBlockIds = getLiveSelectedBlockIds();
  const selectedCommentThread = liveSelectedBlockIds.length === 1
    ? currentPageCommentThreads.find((thread) => thread.blockId === liveSelectedBlockIds[0])
    : undefined;
  const selectedCommentCount = selectedCommentThread?.messages.length ?? 0;
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
    const menuWidth = kind === "transform" ? 232 : 187;
    const estimatedHeight = kind === "transform" ? 326 : 340;
    const viewportPadding = 12;
    const triggerGap = 6;
    const availableBelow = Math.max(
      0,
      window.innerHeight - viewportPadding - rect.bottom - triggerGap,
    );
    const availableAbove = Math.max(0, rect.top - triggerGap - viewportPadding);
    const placement = estimatedHeight <= availableBelow
      ? "bottom"
      : estimatedHeight <= availableAbove
        ? "top"
        : availableAbove > availableBelow
          ? "top"
          : "bottom";
    const maxHeight = estimatedHeight;
    const x = Math.max(
      viewportPadding,
      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportPadding),
    );
    const desiredY = placement === "top"
      ? rect.top - maxHeight - triggerGap
      : rect.bottom + triggerGap;
    const y = Math.max(
      viewportPadding,
      Math.min(desiredY, window.innerHeight - viewportPadding - maxHeight),
    );
    const anchor = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
    setBlockSelectionActionMenu((current) => (
      current?.kind === kind
        ? null
        : { kind, x, y, placement, maxHeight, anchor }
    ));
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
        active={workspaceSection === "pages" && currentPageId === page.id}
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
            if (isComposingKey(event.nativeEvent)) return;
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
              <button className="empty-folder-action" type="button" onClick={() => createPage("sidebar", folder.id)}>
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
      <aside
        className={`sidebar ${sidebarOpen ? "is-open" : ""}`}
        aria-label="워크스페이스 메뉴"
        aria-hidden={!sidebarOpen}
        inert={sidebarOpen ? undefined : true}
      >
        <div className="workspace-head">
          <div className="workspace-brand" aria-label="Nodi">
            <span className="workspace-mark">N</span>
            <strong className="workspace-name">Nodi</strong>
          </div>
          <button
            className="icon-button quiet"
            type="button"
            aria-label="사이드바 닫기"
            aria-expanded={sidebarOpen}
            data-nodi-tooltip={`사이드바 닫기 (${primaryShortcutLabel} + \\)`}
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>

        {isAuthenticated && <>
          <button
            className="search-trigger"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={workspaceSearchOpen}
            onClick={openWorkspaceSearch}
          >
            <Search size={16} />
            <span>검색</span>
            <kbd>{primaryShortcutLabel} K</kbd>
          </button>

          <nav className="main-nav">
          <NavItem
            icon={<Home size={17} />}
            label="홈"
            active={workspaceSection === "pages" && currentPageId === ROOT_PAGE_ID}
            onClick={() => {
              setInboxOpen(false);
              openPage(ROOT_PAGE_ID);
            }}
          />
          <div className="sidebar-inbox-wrap">
            <NavItem
              icon={<Inbox size={17} />}
              label="받은 편지함"
              count={unreadInboxCount > 0 ? String(unreadInboxCount) : undefined}
              active={inboxOpen}
              ariaHasPopup="dialog"
              ariaExpanded={inboxOpen}
              controls="sidebar-inbox-popover"
              onClick={() => {
                setSidebarContextMenu(null);
                setSidebarCreateMenuOpen(false);
                const nextOpen = !inboxOpen;
                setInboxOpen(nextOpen);
                if (nextOpen) void refreshInbox({ force: true, reportError: true });
              }}
            />
            {inboxOpen && (
              <section
                id="sidebar-inbox-popover"
                className="sidebar-inbox-popover"
                role="dialog"
                aria-label="받은 편지함 알림"
              >
                <header>
                  <div>
                    <strong>받은 편지함</strong>
                    {unreadInboxCount > 0 && <span>{unreadInboxCount}개의 새 알림</span>}
                  </div>
                  {unreadInboxCount > 0 && (
                    <button
                      type="button"
                      onClick={markAllInboxNotificationsRead}
                    >
                      모두 읽음
                    </button>
                  )}
                </header>
                <ul className="sidebar-inbox-list">
                  {inboxNotifications.length === 0
                    ? (
                      <li className="sidebar-inbox-empty">
                        <span><Inbox size={18} /></span>
                        <strong>새 알림이 없습니다.</strong>
                        <small>공유와 댓글 알림이 도착하면 여기에 표시됩니다.</small>
                      </li>
                    )
                    : inboxNotifications.map((notification) => (
                      <li key={notification.id}>
                        <button
                          className={`sidebar-inbox-notification ${notification.unread ? "is-unread" : ""}`}
                          type="button"
                          onClick={() => openInboxNotification(notification)}
                        >
                          <span className={`sidebar-inbox-icon is-${notification.kind}`}>
                            {notification.kind === "share" && <UserPlus size={16} />}
                            {notification.kind === "comment" && <MessageCircle size={16} />}
                            {notification.kind === "mention" && <Bell size={16} />}
                          </span>
                          <span className="sidebar-inbox-copy">
                            <strong>{notification.title}</strong>
                            <span>{notification.description}</span>
                            <small>{notification.time}</small>
                          </span>
                          {notification.unread && <i aria-label="읽지 않음" />}
                        </button>
                      </li>
                    ))}
                </ul>
                <footer>공유, 댓글, 멘션 알림이 이곳에 모입니다.</footer>
              </section>
            )}
          </div>
          <NavItem
            icon={<Share2 size={17} />}
            label="공유 페이지"
            count={sharedPageCount > 0 ? String(sharedPageCount) : undefined}
            active={workspaceSection === "shared" || workspaceSection === "shared-page"}
            onClick={openSharedPages}
          />
          </nav>

          <div className="nav-section favorites-section">
            <div className="section-label"><span>즐겨찾기</span></div>
            {favoritePages.length > 0 && (
              <div className="sidebar-scroll-shell favorites-scroll-shell">
                <div ref={favoritesScrollRef} className="favorites-list sidebar-native-scroll" aria-label="즐겨찾기 페이지">
                  {favoritePages.map((page) => (
                    <NavItem
                      key={page.id}
                      icon={<span className="nav-emoji">{page.settings.icon || "📄"}</span>}
                      label={page.title || "제목 없음"}
                      active={workspaceSection === "pages" && currentPageId === page.id}
                      onClick={() => openPage(page.id)}
                    />
                  ))}
                </div>
                <SidebarScrollOverlay targetRef={favoritesScrollRef} edgeFades />
              </div>
            )}
          </div>
        </>}

        <div className="sidebar-scroll-shell pages-section-scroll-shell">
          <div ref={pagesScrollRef} className={`nav-section pages-section sidebar-native-scroll ${sidebarFolderDropTarget?.kind === "root" ? "is-folder-root-drop-target" : ""}`}>
            <div className="section-label">
              <span>페이지</span>
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
                    <button type="button" role="menuitem" onClick={() => createPage("sidebar", null)}>
                      <FileText size={15} />
                      <span><strong>페이지</strong><small>페이지 목록에 독립적으로 추가</small></span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => createFolder(null)}>
                      <FolderPlus size={15} />
                      <span><strong>폴더</strong><small>페이지를 묶어 정리</small></span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {isAuthenticated && personalPageCount === 0 && Object.keys(folders).length === 0
              ? <span className="empty-page-nav">+ 버튼이나 /페이지로 시작해보세요</span>
              : (
                <div
                  className={`sidebar-unfiled-pages ${sidebarDraggedPageId ? "is-drag-active" : ""} ${sidebarPageDropTarget?.kind === "unfiled" ? "is-drop-target" : ""}`}
                >
                  {!isAuthenticated && (
                    <NavItem
                      icon={<span className="nav-emoji">{rootPage.settings.icon || "📄"}</span>}
                      label={rootPage.title || "로컬 메모"}
                      active={currentPageId === ROOT_PAGE_ID}
                      onClick={() => openPage(ROOT_PAGE_ID)}
                    />
                  )}
                  {rootSidebarItems.map((item) => (
                    item.kind === "folder"
                      ? renderSidebarFolder(item.folder)
                      : renderSidebarPage(item.page)
                  ))}
                </div>
              )}
          </div>
          <SidebarScrollOverlay targetRef={pagesScrollRef} edgeFades />
        </div>

        <div className={`sidebar-footer ${isAuthenticated ? "" : "is-guest"}`}>
          {isAuthenticated ? <>
            <button
              type="button"
              className={`footer-nav trash-nav ${workspaceSection === "trash" ? "is-active" : ""}`}
              aria-current={workspaceSection === "trash" ? "page" : undefined}
              onClick={openTrash}
            >
              <Trash2 size={16} />
              <span>휴지통</span>
              {trashPageCount > 0 && <em className="nav-count-badge">{trashPageCount}</em>}
            </button>
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
              <NodiUserAvatar user={currentNodiUser} className="sidebar-profile-avatar" />
              <div><strong>{userName}</strong></div>
              <button
                type="button"
                className="profile-settings-trigger"
                aria-label="프로필 설정 열기"
                aria-haspopup="dialog"
                aria-expanded={workspaceSettingsOpen}
                onClick={() => setWorkspaceSettingsOpen(true)}
              >
                <MoreHorizontal size={17} />
              </button>
            </div>
          </> : (
            <section className="guest-auth-card" aria-label="게스트 계정">
              <span className="guest-auth-icon"><HardDrive size={16} /></span>
              <div>
                <strong>게스트로 사용 중</strong>
                <small>메모는 이 브라우저에 저장됩니다.</small>
              </div>
            </section>
          )}
        </div>
      </aside>

      <main className="main-area" onPasteCapture={handleWorkspacePasteCapture}>
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && !publicPageId && (
              <button
                className="icon-button sidebar-reopen-button"
                type="button"
                aria-label="사이드바 열기"
                aria-expanded={sidebarOpen}
                data-nodi-tooltip={`사이드바 열기 (${primaryShortcutLabel} + \\)`}
                onClick={() => setSidebarOpen(true)}
              >
                <PanelLeftOpen size={19} />
              </button>
            )}
            {workspaceSection === "pages" && parentPage && (
              <button className="crumb-back" type="button" aria-label={`${parentPage.title} 페이지로 돌아가기`} onClick={() => openPage(parentPage.id)}>
                <ChevronLeft size={17} />
              </button>
            )}
            <div className="crumb">
              {publicPageId ? (
                <span className="crumb-root" aria-current="page">공개 페이지</span>
              ) : workspaceSection === "shared" ? (
                <span className="crumb-root" aria-current="page">공유 페이지</span>
              ) : workspaceSection === "shared-page" ? (
                <>
                  <button className="crumb-page" type="button" onClick={openSharedPages}>공유 페이지</button>
                  <span className="crumb-segment">
                    <span className="crumb-divider" aria-hidden="true">/</span>
                    <span className="crumb-current" aria-current="page">{currentPage.title || "제목 없음"}</span>
                  </span>
                </>
              ) : workspaceSection === "trash" ? (
                <span className="crumb-root" aria-current="page">휴지통</span>
              ) : isHomePage ? (
                <span className="crumb-root" aria-current="page">홈</span>
              ) : (
                <>
                  <span className="crumb-root">{isAuthenticated ? "개인 페이지" : "로컬 페이지"}</span>
                  {breadcrumbPages.map((page, index) => {
                    const isCurrentPage = index === breadcrumbPages.length - 1;
                    return (
                      <span className="crumb-segment" key={page.id}>
                        <span className="crumb-divider" aria-hidden="true">/</span>
                        {isCurrentPage ? (
                          <span className="crumb-current" aria-current="page">{page.title || "제목 없음"}</span>
                        ) : (
                          <button className="crumb-page" type="button" onClick={() => openPage(page.id)}>
                            {page.title || "제목 없음"}
                          </button>
                        )}
                      </span>
                    );
                  })}
                </>
              )}
            </div>
          </div>
          <div className="topbar-actions">
            {workspaceSection === "shared" ? (
              <span className="shared-topbar-status"><Users size={15} /> Nodi 회원 공유 관리</span>
            ) : workspaceSection === "trash" ? (
              <span className="trash-topbar-status"><Trash2 size={15} /> 삭제된 페이지 관리</span>
            ) : isHomePage ? (
              <span className="home-topbar-status"><Home size={15} /> 프라이빗 페이지</span>
            ) : (
              <>
                {realtimeParticipants.length > 0 && (
                  <div
                    className="realtime-participants"
                    aria-label={`${realtimeParticipants.length}명 접속 중`}
                    data-nodi-tooltip={`${realtimeParticipants.length}명 접속 중`}
                  >
                    {realtimeParticipants.slice(0, 4).map((participant) => (
                      <span key={participant.user.id} title={`${participant.user.name}${participant.user.id === authUser?.id ? " (나)" : ""}`}>
                        <NodiUserAvatar
                          user={{
                            ...participant.user,
                            avatarColor: participant.user.avatarColor as NodiAvatarColor,
                          }}
                        />
                      </span>
                    ))}
                    {realtimeParticipants.length > 4 && <em>+{realtimeParticipants.length - 4}</em>}
                  </div>
                )}
                <span
                  className={`save-state is-${localSaveState}`}
                  role="status"
                  aria-live="polite"
                  title={localSaveState === "error" ? "이 브라우저에 저장하지 못했습니다." : "이 브라우저에 저장됩니다."}
                >
                  <LocalSaveIcon size={15} /> {localSaveLabel}
                </span>
                {publicPageId ? (
                  <span className="shared-topbar-status"><Globe2 size={15} /> 읽기 전용 공개 페이지</span>
                ) : isAuthenticated ? <>
                  {currentPage.permission === "view" && (
                    <span className="shared-topbar-status"><Eye size={15} /> 보기 전용</span>
                  )}
                  {(currentPage.permission ?? "owner") === "owner" && (
                    <button
                      className={`icon-button ${isFavorite ? "is-favorite" : ""}`}
                      type="button"
                      aria-label={isFavorite ? "즐겨찾기에서 제거" : "즐겨찾기에 추가"}
                      aria-pressed={isFavorite}
                      data-nodi-tooltip={isFavorite ? "즐겨찾기에서 제거" : "즐겨찾기에 추가"}
                      onClick={toggleFavorite}
                    >
                      <Star size={18} fill={isFavorite ? "currentColor" : "none"} />
                    </button>
                  )}
                  {canManageCurrentPageShares && (
                    <button
                      className="icon-button"
                      type="button"
                      aria-label="공유"
                      data-nodi-tooltip="공유"
                      onClick={openSharePanel}
                    >
                      <Share2 size={18} />
                    </button>
                  )}
                  {currentPage.permission !== "view" && <button className="page-settings-trigger" type="button" aria-label="페이지 설정" onClick={openPageSettingsPanel}><Settings2 size={16} /> 설정</button>}
                  <button className="more-button" type="button" aria-label="더 보기" onClick={exportJson}><Download size={16} /> 내보내기</button>
                </> : (
                  <button className="guest-topbar-login" type="button" onClick={() => setAuthDialogMode("login")}>
                    <LogIn size={15} /> 로그인
                  </button>
                )}
              </>
            )}
          </div>
        </header>

        <div className="editor-scroll-area">
        {workspaceSection === "shared" ? (
          <SharedPagesView
            pages={pages}
            pageShares={pageShares}
            registeredUsers={registeredNodiUsers}
            currentUser={currentNodiUser}
            commentCounts={pageCommentCounts}
            onOpenPage={openPage}
            onManageShare={(pageId) => {
              openPage(pageId);
              openSharePanel();
            }}
          />
        ) : workspaceSection === "trash" ? (
          <TrashView
            pages={pages}
            folders={folders}
            busyPageId={trashBusyPageId}
            onRestore={(pageId) => void restoreTrashPage(pageId)}
            onDeletePermanently={(pageId) => setPendingPermanentPageDeletion(pageId)}
            onEmptyTrash={() => setPendingPermanentPageDeletion("all")}
          />
        ) : (
        <>
        <section ref={editorStageRef} className={`editor-stage ${isHomePage ? "is-home" : ""} ${pageSettings.fullWidth ? "is-wide" : ""} ${pageSettings.smallText ? "uses-small-text" : ""}`} onPointerDownCapture={handleEditorStagePointerDown}>
          {isArchived && <div className="archive-banner"><Archive size={15} /> 이 페이지는 보관됨 상태입니다.<button type="button" onClick={toggleArchive}>복원</button></div>}
          {!isHomePage && <div className={`cover cover--${pageSettings.cover}`} aria-hidden="true"><div className="cover-orb orb-one" /><div className="cover-orb orb-two" /><div className="cover-grid" /></div>}
          <article className={`note-page ${isHomePage ? "home-note-page" : ""} ${pageSettings.fullWidth ? "page-wide" : ""}`} onContextMenu={canEditCurrentPage ? (event) => openContextMenu(event, "page") : undefined}>
            {isHomePage ? (
              <div className="home-dashboard">
                <section className="home-welcome-card" aria-labelledby="home-title">
                  <div className="home-welcome-main">
                    <span className="home-kicker">나만의 홈</span>
                    <input
                      id="home-title"
                      ref={titleInputRef}
                      className="home-title-input"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      aria-label="홈 제목"
                      disabled={!canEditCurrentPage}
                    />
                    <p>중요한 페이지를 한눈에 살펴보고, 오늘 필요한 생각을 바로 이어서 기록해보세요.</p>
                    <div className="home-welcome-actions">
                      <button type="button" className="is-primary" onClick={() => createPage("sidebar", null)}>
                        <Plus size={15} /> 새 페이지
                      </button>
                      <button type="button" onClick={openWorkspaceSearch}>
                        <Search size={15} /> 내 공간 검색
                        <kbd>{primaryShortcutLabel} K</kbd>
                      </button>
                    </div>
                  </div>
                  <div className="home-summary" aria-label="홈 요약">
                    <span><strong>{personalPageCount}</strong><small>전체 페이지</small></span>
                    <i aria-hidden="true" />
                    <span><strong>{homeFavoritePages.length}</strong><small>즐겨찾기</small></span>
                  </div>
                </section>

                <div className="home-overview-grid">
                  <section className="home-overview-panel" aria-labelledby="home-recent-title">
                    <header>
                      <span><Clock3 size={15} /></span>
                      <div><strong id="home-recent-title">최근 페이지</strong><small>이어서 작성해보세요</small></div>
                    </header>
                    <div className="home-page-list">
                      {homeRecentPages.length > 0 ? homeRecentPages.map((page) => (
                        <button type="button" key={page.id} onClick={() => openPage(page.id)}>
                          <span className="home-page-icon">{page.settings.icon || "✦"}</span>
                          <span className="home-page-copy">
                            <strong>{page.title || "제목 없음"}</strong>
                            <small>{formatHomePageUpdatedAt(page.updatedAt)} 수정</small>
                          </span>
                          <ArrowUpRight size={14} />
                        </button>
                      )) : (
                        <div className="home-empty-panel">
                          <FileText size={18} />
                          <span>아직 작성한 페이지가 없어요.</span>
                          <button type="button" onClick={() => createPage("sidebar", null)}>첫 페이지 만들기</button>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="home-overview-panel" aria-labelledby="home-favorite-title">
                    <header>
                      <span><Star size={15} /></span>
                      <div><strong id="home-favorite-title">즐겨찾기</strong><small>중요한 페이지를 빠르게 열어요</small></div>
                    </header>
                    <div className="home-page-list">
                      {homeFavoritePages.length > 0 ? homeFavoritePages.map((page) => (
                        <button type="button" key={page.id} onClick={() => openPage(page.id)}>
                          <span className="home-page-icon">{page.settings.icon || "✦"}</span>
                          <span className="home-page-copy">
                            <strong>{page.title || "제목 없음"}</strong>
                            <small>{formatHomePageUpdatedAt(page.updatedAt)} 수정</small>
                          </span>
                          <ArrowUpRight size={14} />
                        </button>
                      )) : (
                        <div className="home-empty-panel">
                          <Star size={18} />
                          <span>별표를 누른 페이지가 여기에 모여요.</span>
                        </div>
                      )}
                    </div>
                  </section>
                </div>

                <div className="home-note-heading">
                  <span className="home-note-heading-icon"><FileText size={16} /></span>
                  <div className="home-note-heading-copy">
                    <strong>홈 메모</strong>
                    <small>오늘 떠오른 생각을 편하게 기록해보세요.</small>
                  </div>
                  <div className="home-note-heading-actions">
                    <span className="home-note-date"><Clock3 size={13} /> {formatHomeMemoDate()}</span>
                    <button
                      type="button"
                      disabled={!canEditCurrentPage}
                      onClick={() => {
                        editorContextRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                        window.requestAnimationFrame(() => editor.focus());
                      }}
                    >
                      <Pencil size={13} /> 메모 시작
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {isAuthenticated && canEditCurrentPage
                  ? <button className="page-emoji" type="button" aria-label="페이지 아이콘 설정" onClick={openPageSettingsPanel}>{pageSettings.icon}</button>
                  : <span className="page-emoji" aria-hidden="true">{pageSettings.icon}</span>}
                <input
                  ref={titleInputRef}
                  className="title-input"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    dismissStarterDockForCurrentPage();
                  }}
                  aria-label="페이지 제목"
                  placeholder="제목 없음"
                  disabled={!canEditCurrentPage}
                />
                {isAuthenticated && pageSettings.showProperties && <div className="page-properties" aria-label="페이지 속성">
                  <div className="property property-updated"><Clock3 size={14} /><span>수정</span><RelativeUpdatedAt value={currentPage.updatedAt} /></div>
                  <div className="property property-status"><Hash size={14} /><span>상태</span><Select disabled={!canEditCurrentPage} value={pageSettings.status} onValueChange={(value) => setPageSettings({ ...pageSettings, status: value as PageSettings["status"] })} options={pageStatusOptions} ariaLabel="페이지 상태" className={`status-select ${pageSettings.status === "초안" ? "status-waiting" : pageSettings.status === "진행 중" ? "status-progress" : "status-done"}`} /></div>
                  <div className="property property-tags"><Hash size={14} /><span>태그</span><TagPicker value={pageSettings.tags} options={tagOptions} disabled={!canEditCurrentPage} compact onChange={(tags) => setPageSettings({ ...pageSettings, tags })} /></div>
                  <div className="property property-date"><Clock3 size={14} /><span>날짜</span><DatePicker compact disabled={!canEditCurrentPage} value={pageSettings.date} onChange={(date) => setPageSettings({ ...pageSettings, date })} ariaLabel="페이지 날짜" /></div>
                  <span className="page-property-separator" aria-hidden="true" />
                  <button className="add-property" type="button" disabled={!canEditCurrentPage} onClick={openPageSettingsPanel}><Plus size={14} /> 속성 설정</button>
                </div>}
              </>
            )}
            <div className={isHomePage ? "home-note-divider" : "divider"} />
            <div
              ref={editorContextRef}
              tabIndex={-1}
              className={`block-editor-context-target ${canEditCurrentPage ? "" : "is-readonly"} ${isBlockSelectionMode ? "has-block-selection" : ""} ${isBlockDragging ? "is-block-dragging" : ""} ${blockSelectionMarquee ? "is-block-marquee-selecting" : ""}`}
              aria-readonly={!canEditCurrentPage}
              onContextMenu={canEditCurrentPage ? openEditorContextMenu : undefined}
              onFocusCapture={handleEditorFocus}
              onBlurCapture={handleEditorBlur}
              onClickCapture={handleEditorClick}
              onPointerDownCapture={handleEditorPointerDown}
              onPointerMoveCapture={handleEditorPointerMove}
              onPointerUpCapture={finishEditorPointerInteraction}
              onPointerCancelCapture={finishEditorPointerInteraction}
              onKeyDownCapture={handleEditorKeyDown}
              onDropCapture={(event) => { if (canEditCurrentPage) insertAttachmentFiles(event.nativeEvent, editor); }}
              onCopyCapture={handleEditorCopy}
              onCutCapture={handleEditorCut}
              onInputCapture={dismissStarterDockForCurrentPage}
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
              {isAuthenticated && currentPageCommentThreads
                .filter((thread) => !thread.resolvedAt && thread.messages.length > 0)
                .map((thread) => (
                  <button
                    key={thread.blockId}
                    ref={(element) => {
                      if (element) blockCommentMarkerRefs.current.set(thread.blockId, element);
                      else blockCommentMarkerRefs.current.delete(thread.blockId);
                    }}
                    className="block-comment-marker"
                    type="button"
                    aria-label={`댓글 ${thread.messages.length}개 열기`}
                    title={`댓글 ${thread.messages.length}개`}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openBlockComments(thread.blockId);
                    }}
                  >
                    <MessageCircle size={13} />
                    <span>{thread.messages.length}</span>
                  </button>
                ))}
              {realtimeParticipants
                .filter((participant) => participant.activeBlockId && participant.user.id !== authUser?.id)
                .map((participant) => (
                  <span
                    key={participant.user.id}
                    ref={(element) => {
                      if (element) blockPresenceMarkerRefs.current.set(participant.user.id, element);
                      else blockPresenceMarkerRefs.current.delete(participant.user.id);
                    }}
                    className="block-presence-marker"
                    title={`${participant.user.name}님이 이 블록을 편집 중입니다`}
                    aria-label={`${participant.user.name}님이 편집 중`}
                  >
                    <NodiUserAvatar
                      user={{
                        ...participant.user,
                        avatarColor: participant.user.avatarColor as NodiAvatarColor,
                      }}
                    />
                  </span>
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
              {canEditCurrentPage && isBlockSelectionMode
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
                    aria-label="선택한 블록 복사"
                    title="복사 (⌘/Ctrl+C)"
                    onPointerDown={(event) => runSelectionToolbarPointerAction(event, copySelectedBlocks)}
                    onClick={(event) => runSelectionToolbarKeyboardAction(event, copySelectedBlocks)}
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label="선택한 블록 복제"
                    title="복제 (⌘/Ctrl+D)"
                    onPointerDown={(event) => runSelectionToolbarPointerAction(event, () => duplicateBlocks(liveSelectedBlockIds))}
                    onClick={(event) => runSelectionToolbarKeyboardAction(event, () => duplicateBlocks(liveSelectedBlockIds))}
                  >
                    <CopyPlus size={15} />
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
                  {isAuthenticated && <button
                    className="block-comment-toolbar-button"
                    type="button"
                    aria-label={selectedCommentCount > 0 ? `댓글 ${selectedCommentCount}개 열기` : "블록에 댓글 달기"}
                    title={liveSelectedBlockIds.length === 1
                      ? canCommentOnCurrentPage
                        ? "블록 댓글"
                        : "페이지를 공유하면 댓글을 작성할 수 있어요"
                      : "댓글은 한 번에 하나의 블록에 연결할 수 있어요"}
                    disabled={liveSelectedBlockIds.length !== 1}
                    onPointerDown={(event) => runSelectionToolbarPointerAction(
                      event,
                      () => openBlockComments(liveSelectedBlockIds[0]),
                    )}
                    onClick={(event) => runSelectionToolbarKeyboardAction(
                      event,
                      () => openBlockComments(liveSelectedBlockIds[0]),
                    )}
                  >
                    <MessageCircle size={15} />
                    <span>댓글</span>
                    {selectedCommentCount > 0 && <em>{selectedCommentCount}</em>}
                  </button>}
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
              <InlineDatabaseSyncProvider
                enabled={isAuthenticated && !publicPageId}
                pageId={isHomePage ? null : currentPageId}
                readOnly={!canEditCurrentPage}
                initialStates={publicPageId ? publicDatabaseStates : undefined}
                collaborative={!isHomePage && (
                  (currentPage.permission ?? "owner") !== "owner"
                  || (pageShares[currentPageId]?.members.length ?? 0) > 0
                )}
              >
              <BlockNoteView
                editor={editor}
                onChange={() => {
                  if (!canEditCurrentPage || loadingPageRef.current
                    || currentPageId !== currentPageIdRef.current || currentPageId !== editorPageIdRef.current) return;
                  dismissStarterDockForCurrentPage();
                  const nextBlocks = editor.document as unknown as PartialBlock[];
                  updatePage(currentPageId, {
                    blocks: nextBlocks,
                  });
                  try {
                    sendRealtimePresence(editor.getTextCursorPosition().block.id);
                  } catch {
                    // Non-text blocks can change without an active text cursor.
                  }
                  queueRealtimeBlockPatch(nextBlocks);
                }}
                onSelectionChange={syncEditorSelection}
                theme={appTheme}
                editable={canEditCurrentPage}
                formattingToolbar={!isBlockSelectionMode}
                linkToolbar={!isBlockSelectionMode}
                slashMenu={false}
                data-theming-css-variables-demo
              >
                {canEditCurrentPage && <SuggestionMenuController
                  triggerCharacter="/"
                  getItems={async (query) => filterSuggestionItems(
                    getNodiSlashMenuItems(editor, () => createPage("slash")),
                    query,
                  )}
                />}
              </BlockNoteView>
              </InlineDatabaseSyncProvider>
            </div>

            <div className="editor-hint">
              <Command size={14} />
              <span>
                빈 여백을 드래그해 여러 블록 선택 • <strong>Shift+↑↓</strong> 범위 확장 •{" "}
                <span className="editor-hint-grip" aria-label="드래그 핸들"><GripVertical size={13} /></span>로 함께 이동
              </span>
            </div>
          </article>
        </section>
        <EditorScrollOverlay targetRef={editorStageRef} />
        </>
        )}
        </div>

      </main>

      {isAuthenticated && activeCommentBlockId && (
        <BlockCommentPanel
          key={`${currentPageId}:${activeCommentBlockId}`}
          pageTitle={title}
          blockPreview={activeCommentBlockPreview}
          thread={activeCommentThread}
          currentUser={currentNodiUser}
          registeredUsers={registeredNodiUsers}
          canComment={canCommentOnCurrentPage}
          disabledReason={commentDisabledReason}
          onAddComment={(body, parentId) => addBlockComment(activeCommentBlockId, body, parentId)}
          onDeleteComment={(commentId) => {
            if (activeCommentThread) deleteBlockComment(activeCommentThread.id, commentId);
          }}
          onReopen={() => {
            if (activeCommentThread) setBlockCommentResolved(activeCommentThread.id, false);
          }}
          onClose={() => setActiveCommentBlockId(null)}
        />
      )}
      {isAuthenticated && (rightPanel === "share" ? (
        !isHomePage ? (
          <PageSharePanel
            pageTitle={title}
            pageLink={currentPageLink}
            isPublic={pageSettings.publicAccess}
            members={pageShares[currentPageId]?.members ?? []}
            registeredUsers={registeredNodiUsers}
            onSearchUsers={searchRegisteredNodiUsers}
            onPublicChange={(publicAccess) => setPageSettings({ ...pageSettings, publicAccess })}
            onShare={(userId, permission) => sharePageWithMember(currentPageId, userId, permission)}
            onPermissionChange={(userId, permission) => updatePageSharePermission(currentPageId, userId, permission)}
            onRemoveMember={(userId) => removePageShareMember(currentPageId, userId)}
            onClose={() => setRightPanel(null)}
            onCopy={copyPageLink}
          />
        ) : null
      ) : rightPanel ? (
        <QuickActionPanel
          type={rightPanel}
          pageLink={currentPageLink}
          onClose={() => setRightPanel(null)}
          onCopy={copyPageLink}
          onDraft={addDraft}
        />
      ) : null)}
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
            createPage("sidebar", folderId);
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
          serverEnabled={isAuthenticated}
          onAttachmentComplete={(blockId, url) => finishDetachedUploadRef.current(drawerPageId, blockId, url)}
          onClose={() => setDrawerPageId(null)}
          onOpenPage={() => openPage(drawerPageId)}
          onChange={(patch) => {
            updatePage(drawerPageId, patch);
            if (drawerPageId !== currentPageIdRef.current) return;
            // Two editor surfaces can show the same document. Keep the main
            // surface current before any shortcut or navigation saves it.
            if (patch.title !== undefined) setTitle(patch.title);
            if (patch.blocks) {
              loadEditorPage(drawerPageId, patch.blocks);
              queueRealtimeBlockPatch(patch.blocks);
            }
          }}
        />
      )}

      {contextMenu && <NodiContextMenu
        menu={contextMenu}
        archived={isArchived}
        locked={pageSettings.lockPage}
        selectedBlockCount={contextMenu.kind === "block" && selectedBlockIds.includes(contextMenu.blockId)
          ? selectedBlockIds.length
          : 1}
        commentCount={contextMenu.kind === "block"
          ? currentPageCommentThreads.find((thread) => thread.blockId === contextMenu.blockId)?.messages.length ?? 0
          : 0}
        commentsAvailable={isAuthenticated && contextMenu.kind === "block"
          && (!selectedBlockIds.includes(contextMenu.blockId) || selectedBlockIds.length === 1)}
        memberFeaturesAvailable={isAuthenticated}
        onAddBlock={addBlockAfter}
        onMoveBlock={moveContextBlock}
        onDuplicateBlock={duplicateBlock}
        onDeleteBlock={requestBlockDeletion}
        onComment={() => {
          if (contextMenu.kind === "block") openBlockComments(contextMenu.blockId);
        }}
        shareAvailable={isAuthenticated && !isHomePage}
        onOpenSettings={() => { setContextMenu(null); openPageSettingsPanel(); }}
        onCopyLink={() => { setContextMenu(null); void copyPageLink(); }}
        onToggleArchive={() => { setContextMenu(null); toggleArchive(); }}
        onExport={() => { setContextMenu(null); exportJson(); }}
        onDeletePage={() => { setContextMenu(null); setPendingPageDeletion(currentPageId); }}
      />}

      {blockSelectionActionMenu && (
        <div
          ref={blockSelectionActionMenuRef}
          className={`block-selection-action-menu is-${blockSelectionActionMenu.kind}`}
          data-placement={blockSelectionActionMenu.placement}
          role="menu"
          aria-label={blockSelectionActionMenu.kind === "transform" ? "블록 전환" : "블록 색상"}
          style={{
            left: blockSelectionActionMenu.x,
            top: blockSelectionActionMenu.y,
            maxHeight: blockSelectionActionMenu.maxHeight,
          }}
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

      {isAuthenticated && workspaceSection === "pages" && !isHomePage && starterDockPageId === currentPageId && starterPresets.length > 0 && (
        <div className="template-dock" role="group" aria-label="새 페이지 시작 프리셋">
          <button
            className="dock-start-button"
            type="button"
            disabled={!selectedStarterPreset}
            onClick={startWithSelectedPreset}
          >
            시작하기
          </button>
          <span className="dock-separator" aria-hidden="true" />
          {starterPresets.map((preset) => (
            <button
              className="dock-preset-button"
              type="button"
              key={preset.id}
              aria-pressed={selectedStarterPreset === preset.id}
              onClick={() => setSelectedStarterPreset(preset.id)}
            >
              <span>{preset.icon || "✨"}</span>
              {preset.name}
            </button>
          ))}
        </div>
      )}

      <BlockNotePopoverScrollOverlays />
      <NodiTooltipLayer />
      {isAuthenticated && workspaceSearchOpen && (
        <WorkspaceSearchDialog
          pages={pages}
          folders={folders}
          currentPageId={currentPageId}
          primaryShortcutLabel={primaryShortcutLabel}
          onClose={() => setWorkspaceSearchOpen(false)}
          onOpenPage={(pageId) => {
            setWorkspaceSearchOpen(false);
            openPage(pageId);
          }}
        />
      )}
      {notice && (
        <div className={`toast ${sidebarOpen ? "is-sidebar-open" : "is-sidebar-closed"} ${noticeClosing ? "is-leaving" : ""}`}>
          <Bell size={16} />
          {notice}
          <button type="button" onClick={() => setNoticeClosing(true)} aria-label="알림 닫기"><X size={14} /></button>
        </div>
      )}
      {isAuthenticated && pageSettingsOpen && <PageSettingsPanel settings={pageSettings} tagOptions={tagOptions} onChange={setPageSettings} onClose={() => setPageSettingsOpen(false)} />}
      {isAuthenticated && workspaceSettingsOpen && (
        <WorkspaceSettingsDialog
          user={currentNodiUser}
          theme={appTheme}
          starterPresets={starterPresets}
          onThemeChange={setAppTheme}
          onStarterPresetsChange={(presets) => {
            setStarterPresets(presets);
            persistStarterPresets(presets);
            if (authUser) {
              enqueueServerMutation(async () => {
                const before = serverPresetsSnapshotRef.current;
                for (const preset of before) {
                  if (!presets.some((item) => item.id === preset.id)) await workspaceApi.deletePreset(preset.id);
                }
                for (let index = 0; index < presets.length; index += 1) {
                  const preset = presets[index];
                  const previous = before.find((item) => item.id === preset.id);
                  if (!previous) await workspaceApi.createPreset(preset, index);
                  else if (!sameServerValue(previous, preset) || before.indexOf(previous) !== index) {
                    await workspaceApi.updatePreset(preset, index);
                  }
                }
                serverPresetsSnapshotRef.current = presets;
              });
            }
            if (selectedStarterPreset && !presets.some((preset) => preset.id === selectedStarterPreset)) {
              setSelectedStarterPreset(null);
            }
            setNotice("시작 프리셋을 저장했어요");
          }}
          onProfileChange={updateUserProfile}
          onLogout={logout}
          onClose={() => setWorkspaceSettingsOpen(false)}
        />
      )}
      {authDialogMode && (
        <AuthDialog
          initialMode={authDialogMode}
          onAuthenticated={() => window.location.reload()}
          onClose={() => setAuthDialogMode(null)}
        />
      )}
      {pendingPageDeletion && pages[pendingPageDeletion] && (
        <PageDeleteConfirm
          title={pages[pendingPageDeletion].title}
          onCancel={() => setPendingPageDeletion(null)}
          onConfirm={() => deletePage(pendingPageDeletion)}
        />
      )}
      {pendingPermanentPageDeletion && (pendingPermanentPageDeletion === "all" || pages[pendingPermanentPageDeletion]) && (
        <ConfirmDialog
          ariaLabel={pendingPermanentPageDeletion === "all" ? "휴지통 비우기" : "페이지 영구 삭제"}
          title={pendingPermanentPageDeletion === "all" ? "휴지통을 비울까요?" : "페이지를 영구 삭제할까요?"}
          description={pendingPermanentPageDeletion === "all"
            ? `휴지통의 ${trashPageCount}개 페이지와 첨부 파일이 모두 삭제되며 복구할 수 없습니다.`
            : `“${pages[pendingPermanentPageDeletion]?.title || "제목 없음"}” 페이지와 첨부 파일이 삭제되며 복구할 수 없습니다.`}
          confirmLabel={pendingPermanentPageDeletion === "all" ? "휴지통 비우기" : "영구 삭제"}
          onCancel={() => setPendingPermanentPageDeletion(null)}
          onConfirm={() => void permanentlyDeleteTrashPages(pendingPermanentPageDeletion)}
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
const NODI_TOOLTIP_MANAGED_EXTERNALLY_SELECTOR = [
  ".bn-toolbar",
  ".bn-formatting-toolbar",
  ".bn-side-menu",
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
    let suppressHoverAfterPointerDown = false;
    let pointerDownPosition: { x: number; y: number } | null = null;

    const prepareElement = (element: Element) => {
      if (element.closest(NODI_TOOLTIP_MANAGED_EXTERNALLY_SELECTOR)) return;
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

    const resolveTrigger = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const trigger = target.closest<HTMLElement>(NODI_TOOLTIP_TRIGGER_SELECTOR);
      if (!trigger || trigger.closest(NODI_TOOLTIP_MANAGED_EXTERNALLY_SELECTOR)) return null;
      return trigger;
    };
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
      if (suppressHoverAfterPointerDown) return;
      const target = resolveTrigger(event.target);
      if (!target || target === activeTarget) return;
      scheduleShow(target, 320);
    };
    const handleMouseMove = (event: MouseEvent) => {
      if (suppressHoverAfterPointerDown && pointerDownPosition) {
        const distance = Math.hypot(
          event.clientX - pointerDownPosition.x,
          event.clientY - pointerDownPosition.y,
        );
        if (distance <= 4) return;
        suppressHoverAfterPointerDown = false;
        pointerDownPosition = null;
      }
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
      if (suppressHoverAfterPointerDown) return;
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
      if (isComposingKey(event)) return;
      suppressHoverAfterPointerDown = false;
      pointerDownPosition = null;
      if (event.key === "Escape") hideNow();
    };
    const handlePointerDown = (event: PointerEvent) => {
      suppressHoverAfterPointerDown = true;
      pointerDownPosition = { x: event.clientX, y: event.clientY };
      hideNow();
    };

    document.addEventListener("mouseover", handleMouseOver, true);
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("mouseout", handleMouseOut, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
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
      document.removeEventListener("pointerdown", handlePointerDown, true);
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
        if (isComposingKey(event.nativeEvent)) return;
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
  ariaHasPopup,
  ariaExpanded,
  controls,
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
  ariaHasPopup?: "dialog" | "menu";
  ariaExpanded?: boolean;
  controls?: string;
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
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      aria-controls={controls}
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
      {count && <em className="nav-count-badge">{count}</em>}
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
  const menuRef = useRef<HTMLDivElement>(null);
  const folderTargetsScrollRef = useRef<HTMLDivElement>(null);
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
  const [menuPosition, setMenuPosition] = useState({ left: menu.x, top: menu.y });

  useLayoutEffect(() => {
    const constrainToViewport = () => {
      const menuElement = menuRef.current;
      if (!menuElement) return;
      const viewportMargin = 10;
      const maxLeft = Math.max(viewportMargin, window.innerWidth - menuElement.offsetWidth - viewportMargin);
      const maxTop = Math.max(viewportMargin, window.innerHeight - menuElement.offsetHeight - viewportMargin);
      const left = Math.round(Math.min(Math.max(menu.x, viewportMargin), maxLeft));
      const top = Math.round(Math.min(Math.max(menu.y, viewportMargin), maxTop));
      setMenuPosition((current) => current.left === left && current.top === top ? current : { left, top });
    };

    constrainToViewport();
    window.addEventListener("resize", constrainToViewport);
    return () => window.removeEventListener("resize", constrainToViewport);
  }, [menu.kind, menu.x, menu.y, orderedFolderEntries.length]);

  if (menu.kind === "page" && page) {
    const siblings = getSidebarOrderedItems(pages, folders, getPageSidebarParentId(page, folders));
    const pageIndex = siblings.findIndex((candidate) => candidate.kind === "page" && candidate.id === page.id);
    return (
      <div
        ref={menuRef}
        className="sidebar-item-context sidebar-floating-menu"
        role="menu"
        aria-label={`${page.title} 페이지 메뉴`}
        style={{ left: menuPosition.left, top: menuPosition.top }}
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
        <div className="sidebar-scroll-shell sidebar-folder-targets-shell">
          <div ref={folderTargetsScrollRef} className="sidebar-folder-targets sidebar-native-scroll">
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
          <SidebarScrollOverlay targetRef={folderTargetsScrollRef} compact />
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
        ref={menuRef}
        className="sidebar-item-context sidebar-floating-menu"
        role="menu"
        aria-label={`${folder.title} 폴더 메뉴`}
        style={{ left: menuPosition.left, top: menuPosition.top }}
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
  serverEnabled,
  onClose,
  onOpenPage,
  onChange,
  onAttachmentComplete,
}: {
  page: StoredPage;
  parentTitle?: string;
  theme: AppTheme;
  serverEnabled: boolean;
  onClose: () => void;
  onOpenPage: () => void;
  onChange: (patch: Partial<StoredPage>) => void;
  onAttachmentComplete: (blockId: string, url: string | null) => void;
}) {
  const mountedRef = useRef(true);
  const attachmentCompleteRef = useRef(onAttachmentComplete);
  attachmentCompleteRef.current = onAttachmentComplete;
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const previewEditor = useCreateBlockNote({
    schema: editorSchema,
    initialContent: (page.blocks.length ? page.blocks : [{ type: "paragraph", content: "" }]) as never,
    dictionary: ko,
    pasteHandler: ({ event, editor, defaultPasteHandler }) => {
      if (insertAttachmentFiles(event, editor)) return true;
      const isCodeBlock = editor.transact((transaction) => (
        transaction.selection.$from.parent.type.spec.code === true
        && transaction.selection.$to.parent.type.spec.code === true
      ));
      return (!event.clipboardData?.files.length && !isCodeBlock && pasteNodiClipboardBlocks(editor, event.clipboardData))
        || defaultPasteHandler();
    },
    uploadFile: async (file, blockId) => {
      let url: string;
      try { url = await uploadNodiAttachment(file, { authenticated: serverEnabled, pageId: page.id }); }
      catch (error) {
        if (blockId) attachmentCompleteRef.current(blockId, null);
        throw error;
      }
      if (!mountedRef.current || !blockId || !previewEditor.getBlock(blockId)) {
        if (blockId) attachmentCompleteRef.current(blockId, url);
        throw new Error("첨부를 원래 페이지에 반영했습니다.");
      }
      if (!previewEditor.isEditable) throw new Error("페이지를 편집할 수 없습니다.");
      return url;
    },
  });
  const canEditPreviewPage = page.permission !== "view" && !page.settings.lockPage;
  useEffect(() => {
    const handleClipboard = (event: ClipboardEvent) => {
      const root = previewEditor.prosemirrorView.dom;
      const selection = window.getSelection();
      if (!selection?.anchorNode || !selection.focusNode
        || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
      // Read-only native selections can dispatch copy on the body or the
      // previously focused editor. The selected range identifies its owner.
      copySelectedDatabaseBlocks(event, previewEditor, event.type === "cut" && canEditPreviewPage);
    };
    document.addEventListener("copy", handleClipboard, true);
    document.addEventListener("cut", handleClipboard, true);
    return () => {
      document.removeEventListener("copy", handleClipboard, true);
      document.removeEventListener("cut", handleClipboard, true);
    };
  }, [canEditPreviewPage, previewEditor]);
  const [previewTitle, setPreviewTitle] = useState(page.title);
  const previewDocumentRef = useRef(page.blocks);
  const previewLoadingRef = useRef(false);
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

  useLayoutEffect(() => {
    previewEditor.isEditable = canEditPreviewPage;
  }, [canEditPreviewPage, previewEditor]);

  useEffect(() => { setPreviewTitle(page.title); }, [page.title]);

  useEffect(() => {
    if (sameServerValue(previewDocumentRef.current, page.blocks)) return;
    previewDocumentRef.current = page.blocks;
    previewLoadingRef.current = true;
    replacePageDocument(previewEditor, page.blocks);
    const frame = window.requestAnimationFrame(() => { previewLoadingRef.current = false; });
    return () => {
      window.cancelAnimationFrame(frame);
      previewLoadingRef.current = false;
    };
  }, [page.blocks, previewEditor]);

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
      if (isComposingKey(event)) return;
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
            if (isComposingKey(event.nativeEvent)) return;
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
                if (!canEditPreviewPage) return;
                const nextTitle = event.target.value;
                setPreviewTitle(nextTitle);
                onChange({ title: nextTitle.trim() || "제목 없음" });
              }}
              onBlur={() => {
                if (!previewTitle.trim()) setPreviewTitle("제목 없음");
              }}
              placeholder="제목 없음"
              aria-label="미리보기 페이지 제목"
              disabled={!canEditPreviewPage}
            />

            {page.settings.showProperties && (
              <div className="page-preview-properties">
                <span><Hash size={14} /> 상태 <strong>{page.settings.status}</strong></span>
                {page.settings.tags.length > 0 && <span><Hash size={14} /> 태그 <strong>{page.settings.tags.join(", ")}</strong></span>}
                <span><Clock3 size={14} /> 날짜 <strong>{page.settings.date}</strong></span>
              </div>
            )}

            <div className="page-preview-divider" />
            <InlineDatabaseSyncProvider
              enabled={serverEnabled}
              pageId={page.id}
              collaborative={(page.permission ?? "owner") !== "owner"}
              readOnly={!canEditPreviewPage}
            >
            <BlockNoteView
              editor={previewEditor}
              onDropCapture={(event) => { if (canEditPreviewPage) insertAttachmentFiles(event.nativeEvent, previewEditor); }}
              theme={theme}
              editable={canEditPreviewPage}
              onChange={() => {
                if (!canEditPreviewPage || previewLoadingRef.current) return;
                const blocks = previewEditor.document as unknown as PartialBlock[];
                previewDocumentRef.current = blocks;
                onChange({ blocks });
              }}
              data-theming-css-variables-demo
            />
            </InlineDatabaseSyncProvider>
          </div>
        </div>
      </aside>
    </div>
  );
}

function QuickActionPanel({
  type,
  pageLink,
  onClose,
  onCopy,
  onDraft,
}: {
  type: "draft" | "link";
  pageLink: string;
  onClose: () => void;
  onCopy: () => void;
  onDraft: (kind: "plan" | "meeting") => void;
}) {
  return (
    <aside className="quick-action-panel" aria-label={type === "draft" ? "초안 도구" : "링크 도구"}>
      <header>
        <span>{type === "draft" ? <><Sparkles size={17} /> 초안 도구</> : <><Link size={17} /> 페이지 링크</>}</span>
        <button type="button" aria-label="패널 닫기" onClick={onClose}><X size={17} /></button>
      </header>
      {type === "draft" ? (
        <div className="quick-panel-body">
          <p>API 연결 전에도 바로 쓸 수 있는 구조 초안을 추가합니다.</p>
          <button type="button" onClick={() => onDraft("plan")}><Sparkles size={15} /><span><strong>실행 계획</strong><small>다음 행동 체크리스트 추가</small></span></button>
          <button type="button" onClick={() => onDraft("meeting")}><FileText size={15} /><span><strong>회의록</strong><small>요약과 결정 사항 추가</small></span></button>
        </div>
      ) : (
        <div className="quick-panel-body">
          <p>현재 페이지 주소입니다.</p>
          <div className="quick-link"><span>{pageLink}</span></div>
          <button className="copy-action" type="button" onClick={onCopy}><Copy size={15} /> 페이지 링크 복사</button>
        </div>
      )}
    </aside>
  );
}

function NodiContextMenu({ menu, archived, locked, selectedBlockCount, commentCount, commentsAvailable, memberFeaturesAvailable, shareAvailable, onAddBlock, onMoveBlock, onDuplicateBlock, onDeleteBlock, onComment, onOpenSettings, onCopyLink, onToggleArchive, onExport, onDeletePage }: { menu: ContextMenuState; archived: boolean; locked: boolean; selectedBlockCount: number; commentCount: number; commentsAvailable: boolean; memberFeaturesAvailable: boolean; shareAvailable: boolean; onAddBlock: () => void; onMoveBlock: (direction: "up" | "down") => void; onDuplicateBlock: () => void; onDeleteBlock: () => void; onComment: () => void; onOpenSettings: () => void; onCopyLink: () => void; onToggleArchive: () => void; onExport: () => void; onDeletePage: () => void }) {
  return <div className="nodi-context-menu" role="menu" aria-label={menu.kind === "block" ? "블록 메뉴" : "페이지 메뉴"} style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
    {menu.kind === "block" ? <>
      <span className="context-menu-heading">{selectedBlockCount > 1 ? `${selectedBlockCount}개 블록` : "블록"}</span>
      {memberFeaturesAvailable && <><button type="button" role="menuitem" disabled={!commentsAvailable} onClick={onComment}>
        <MessageCircle size={15} />
        <span>{commentCount > 0 ? `댓글 ${commentCount}개` : "댓글 달기"}</span>
      </button>
      <div className="context-menu-divider" /></>}
      <button type="button" role="menuitem" disabled={locked} onClick={onAddBlock}><Plus size={15} /> 아래에 새 블록</button>
      <button type="button" role="menuitem" disabled={locked} onClick={() => onMoveBlock("up")}><ArrowUp size={15} /><span>위로 이동</span><kbd>⌘⇧↑</kbd></button>
      <button type="button" role="menuitem" disabled={locked} onClick={() => onMoveBlock("down")}><ArrowDown size={15} /><span>아래로 이동</span><kbd>⌘⇧↓</kbd></button>
      <button type="button" role="menuitem" disabled={locked} onClick={onDuplicateBlock}><Copy size={15} /><span>{selectedBlockCount > 1 ? "선택한 블록 복제" : "블록 복제"}</span><kbd>⌘D</kbd></button>
      <div className="context-menu-divider" />
      <button type="button" role="menuitem" className="context-menu-danger" disabled={locked} onClick={onDeleteBlock}><Trash2 size={15} /><span>{selectedBlockCount > 1 ? "선택한 블록 삭제" : "블록 삭제"}</span><kbd>Del</kbd></button>
    </> : <>
      <span className="context-menu-heading">페이지</span>
      {memberFeaturesAvailable && <>
        <button type="button" role="menuitem" onClick={onOpenSettings}><Settings2 size={15} /> 페이지 설정</button>
        {shareAvailable && <button type="button" role="menuitem" onClick={onCopyLink}><Link size={15} /> 페이지 링크 복사</button>}
        <button type="button" role="menuitem" onClick={onToggleArchive}><Archive size={15} /> {archived ? "페이지 복원" : "페이지 보관"}</button>
        <button type="button" role="menuitem" onClick={onExport}><Download size={15} /> JSON 내보내기</button>
        <div className="context-menu-divider" />
      </>}
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
