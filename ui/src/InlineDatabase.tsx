import { isComposingKey } from "./ime";
import { createContext, useContext, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDownAZ, ArrowUpAZ, CalendarDays, Check, ChevronLeft, ChevronRight, Columns3, Copy, Eye, EyeOff, Filter, Link2, Mail, MoreHorizontal, Phone, Plus, RotateCcw, Search, SlidersHorizontal, Table2, Tags, Timeline, Trash2, X } from "lucide-react";
import { DatePicker } from "./components/ui/date-picker";
import { Select } from "./components/ui/select";
import { ConfirmDialog } from "./components/ui/confirm-dialog";
import { makeId, TAG_COLORS, toDateInput, type TagColor } from "./types";
import { enqueueDatabaseSync, useDatabaseSync } from "./use-database-sync";
import { conflictLabel, type ConflictChoices, type DatabaseConflict } from "./database-merge";
import { NodiApiError } from "./api-client";
import { workspaceApi } from "./server-api";

export const INLINE_DATABASE_REALTIME_EVENT = "nodi:inline-database-realtime";
export const DATABASE_COLUMN_RESIZE_START_EVENT = "nodi:database-column-resize-start";

type PropertyType = "text" | "select" | "multi_select" | "status" | "date" | "number" | "checkbox" | "url" | "email" | "phone";
type ViewType = "table" | "timeline";
type CellValue = string | boolean;
type FilterOperator = "contains" | "equals" | "not_equals" | "empty" | "not_empty";
type SortDirection = "asc" | "desc";

type DatabaseOption = { id: string; name: string; color: TagColor };
type DatabaseProperty = { id: string; name: string; type: PropertyType; options: DatabaseOption[] };
type DatabaseRecord = { id: string; values: Record<string, CellValue> };
type TimelineScale = "fortnight" | "month";
type DatabaseFilter = { propertyId: string; operator: FilterOperator; value: string };
type DatabaseSort = { propertyId: string; direction: SortDirection };
type DatabaseView = {
  id: string;
  name: string;
  type: ViewType;
  datePropertyId?: string;
  timelineContentPropertyId?: string;
  timelineCardContentPropertyId?: string;
  timelineScale?: TimelineScale;
  timelineShowTable?: boolean;
  columnWidths?: Record<string, number>;
  hiddenPropertyIds?: string[];
  filter?: DatabaseFilter;
  sort?: DatabaseSort;
};
export type DatabaseState = {
  name: string;
  properties: DatabaseProperty[];
  records: DatabaseRecord[];
  trash: DatabaseRecord[];
  views: DatabaseView[];
  activeViewId: string | null;
};

type InlineDatabaseSyncContextValue = {
  enabled: boolean;
  pageId: string | null;
  collaborative?: boolean;
  readOnly?: boolean;
  initialStates?: Record<string, DatabaseState>;
};

const InlineDatabaseSyncContext = createContext<InlineDatabaseSyncContextValue>({ enabled: false, pageId: null, collaborative: false, readOnly: false });

export function InlineDatabaseSyncProvider({
  enabled,
  pageId,
  collaborative = false,
  readOnly = false,
  initialStates,
  children,
}: InlineDatabaseSyncContextValue & { children: ReactNode }) {
  return <InlineDatabaseSyncContext.Provider value={{ enabled, pageId, collaborative, readOnly, initialStates }}>{children}</InlineDatabaseSyncContext.Provider>;
}

type DatabasePopoverController = { openPopoverId: string | null; setOpenPopoverId: Dispatch<SetStateAction<string | null>> };
const DatabasePopoverContext = createContext<DatabasePopoverController | null>(null);

function useDatabasePopover(id: string) {
  const controller = useContext(DatabasePopoverContext);
  if (!controller) throw new Error("Database popovers must be rendered inside DatabasePopoverContext.");
  return {
    open: controller.openPopoverId === id,
    onOpenChange: (nextOpen: boolean) => controller.setOpenPopoverId((current) => nextOpen ? id : current === id ? null : current),
  };
}

function pointIsInsideElement(element: Element, clientX: number, clientY: number) {
  const rect = element.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function keepParentPopoverOpenForNestedSelect(event: {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  detail?: { originalEvent?: Event };
  preventDefault: () => void;
}) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".database-rule-popover, .database-settings-popover, .timeline-fields-popover, .shadcn-select-content")) {
    event.preventDefault();
    return;
  }

  const parentPopover = event.currentTarget instanceof Element ? event.currentTarget : null;
  const originalEvent = event.detail?.originalEvent;
  if (
    parentPopover
    && originalEvent
    && "clientX" in originalEvent
    && "clientY" in originalEvent
    && typeof originalEvent.clientX === "number"
    && typeof originalEvent.clientY === "number"
    && pointIsInsideElement(parentPopover, originalEvent.clientX, originalEvent.clientY)
  ) {
    event.preventDefault();
  }
}

type LegacyRecord = { id: string; name?: string; status?: string; tags?: string[]; date?: string; endDate?: string; progress?: number; customValues?: Record<string, string> };

const LEGACY_DATABASE_ID = "legacy-project-database";
const LEGACY_DATABASE_STORAGE_KEY = "nodi:quick-note:project-database";
const databaseStorageKey = (databaseId: string) => `nodi:database:${databaseId}`;
const propertyTypeOptions: Array<{ value: PropertyType; label: string; glyph: ReactNode }> = [
  { value: "text", label: "텍스트", glyph: "Aa" },
  { value: "select", label: "선택", glyph: "☰" },
  { value: "multi_select", label: "다중 선택", glyph: <Tags size={13} /> },
  { value: "status", label: "상태", glyph: "◉" },
  { value: "date", label: "날짜", glyph: <CalendarDays size={13} /> },
  { value: "number", label: "숫자", glyph: "#" },
  { value: "checkbox", label: "체크박스", glyph: "✓" },
  { value: "url", label: "URL", glyph: <Link2 size={13} /> },
  { value: "email", label: "이메일", glyph: <Mail size={13} /> },
  { value: "phone", label: "전화번호", glyph: <Phone size={13} /> },
];

function emptyDatabase(): DatabaseState {
  return { name: "새 데이터베이스", properties: [], records: [], trash: [], views: [], activeViewId: null };
}

function migrateLegacyDatabase(value: { records?: LegacyRecord[]; trash?: LegacyRecord[]; customProperties?: Array<{ id: string; name: string; type: PropertyType }>; tagOptions?: DatabaseOption[] }): DatabaseState {
  const legacyProperties: DatabaseProperty[] = [
    { id: "legacy-name", name: "이름", type: "text", options: [] },
    { id: "legacy-status", name: "상태", type: "select", options: ["대기", "진행 중", "완료"].map((name, index) => ({ id: `legacy-status-${index}`, name, color: TAG_COLORS[index] })) },
    { id: "legacy-tags", name: "태그", type: "text", options: [] },
    { id: "legacy-date", name: "날짜", type: "date", options: [] },
    { id: "legacy-progress", name: "진행률", type: "number", options: [] },
    ...(value.customProperties ?? []).map((property) => ({ ...property, options: [] })),
  ];
  const convert = (record: LegacyRecord): DatabaseRecord => ({
    id: record.id,
    values: {
      "legacy-name": record.name ?? "",
      "legacy-status": record.status ?? "",
      "legacy-tags": record.tags?.join(", ") ?? "",
      "legacy-date": record.date ? `${record.date}${record.endDate ? `..${record.endDate}` : ""}` : "",
      "legacy-progress": String(record.progress ?? ""),
      ...(record.customValues ?? {}),
    },
  });
  return {
    name: "프로젝트 계획",
    properties: legacyProperties,
    records: (value.records ?? []).map(convert),
    trash: (value.trash ?? []).map(convert),
    views: [{ id: "legacy-table", name: "테이블", type: "table" }],
    activeViewId: "legacy-table",
  };
}

function loadDatabase(databaseId: string): DatabaseState {
  try {
    const stored = window.localStorage.getItem(databaseStorageKey(databaseId))
      ?? (databaseId === LEGACY_DATABASE_ID ? window.localStorage.getItem(LEGACY_DATABASE_STORAGE_KEY) : null);
    if (!stored) return emptyDatabase();
    const parsed = JSON.parse(stored) as Partial<DatabaseState> & { customProperties?: Array<{ id: string; name: string; type: PropertyType }>; tagOptions?: DatabaseOption[] };
    if (!parsed.views) return migrateLegacyDatabase(parsed);
    return {
      name: parsed.name?.trim() || "새 데이터베이스",
      properties: parsed.properties ?? [],
      records: parsed.records ?? [],
      trash: parsed.trash ?? [],
      views: parsed.views ?? [],
      activeViewId: parsed.activeViewId ?? parsed.views?.[0]?.id ?? null,
    };
  } catch {
    return emptyDatabase();
  }
}

function recordLabel(record: DatabaseRecord, properties: DatabaseProperty[], index = 0) {
  const textProperty = properties.find((property) => property.type === "text") ?? properties[0];
  const value = textProperty ? record.values[textProperty.id] : "";
  const label = textProperty ? cellDisplayValue(value, textProperty).trim() : "";
  return label || `항목 ${index + 1}`;
}

function dateAt(value: CellValue | undefined) {
  return dateRangeAt(value).from;
}

function dateRangeAt(value: CellValue | undefined) {
  if (typeof value !== "string" || !value) return { from: undefined, to: undefined };
  const [fromValue, toValue] = value.split("..");
  const from = new Date(`${fromValue}T00:00:00`);
  const to = toValue ? new Date(`${toValue}T00:00:00`) : undefined;
  return { from: Number.isNaN(from.getTime()) ? undefined : from, to: to && !Number.isNaN(to.getTime()) ? to : undefined };
}

function beginningOfWeek(date: Date) {
  const next = new Date(date);
  next.setDate(next.getDate() - next.getDay());
  next.setHours(0, 0, 0, 0);
  return next;
}

function dayDistance(from: Date, to: Date) {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

function cellDisplayValue(value: CellValue | undefined, property: DatabaseProperty) {
  if (typeof value === "boolean") return value ? "체크됨 완료 예" : "체크 안 됨 미완료 아니오";
  if (!value) return "";
  if (property.type === "select" || property.type === "status") return property.options.find((option) => option.id === value)?.name ?? value;
  if (property.type === "multi_select") {
    const selectedIds = value.split(",").filter(Boolean);
    return selectedIds.map((id) => property.options.find((option) => option.id === id)?.name ?? id).join(" ");
  }
  return value.replace("..", " ");
}

function timelineContentLabel(record: DatabaseRecord, property: DatabaseProperty | undefined, fallback: string) {
  if (!property) return fallback;
  const value = record.values[property.id];
  if (typeof value === "boolean") return value ? "체크됨" : "체크 안 됨";
  if (!value) return fallback;
  if (property.type === "select" || property.type === "status") return property.options.find((option) => option.id === value)?.name ?? value;
  if (property.type === "multi_select") return value.split(",").filter(Boolean).map((id) => property.options.find((option) => option.id === id)?.name ?? id).join(", ") || fallback;
  if (property.type === "date") return value.replace("..", " → ");
  return value;
}

function recordsForView(records: DatabaseRecord[], properties: DatabaseProperty[], view: DatabaseView, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  let next = records.filter((record) => !normalizedQuery || properties.some((property) => cellDisplayValue(record.values[property.id], property).toLocaleLowerCase("ko-KR").includes(normalizedQuery)));
  if (view.filter) {
    const filter = view.filter;
    const property = properties.find((item) => item.id === filter.propertyId);
    if (property) {
      const expected = filter.value.toLocaleLowerCase("ko-KR");
      next = next.filter((record) => {
        const rawValue = record.values[property.id];
        const actual = cellDisplayValue(rawValue, property).toLocaleLowerCase("ko-KR");
        if (filter.operator === "empty") return rawValue === undefined || rawValue === "" || rawValue === false;
        if (filter.operator === "not_empty") return rawValue !== undefined && rawValue !== "" && rawValue !== false;
        const rawParts = String(rawValue ?? "").split(",").filter(Boolean);
        if (filter.operator === "equals") return actual === expected || rawParts.includes(filter.value);
        if (filter.operator === "not_equals") return actual !== expected && !rawParts.includes(filter.value);
        return actual.includes(expected) || rawParts.includes(filter.value);
      });
    }
  }
  if (view.sort) {
    const property = properties.find((item) => item.id === view.sort?.propertyId);
    if (property) {
      const direction = view.sort.direction === "desc" ? -1 : 1;
      next = [...next].sort((left, right) => {
        const leftValue = left.values[property.id];
        const rightValue = right.values[property.id];
        if (property.type === "number") return ((Number(leftValue) || 0) - (Number(rightValue) || 0)) * direction;
        if (property.type === "checkbox") return (Number(leftValue === true) - Number(rightValue === true)) * direction;
        if (property.type === "date") return ((dateAt(leftValue)?.getTime() ?? 0) - (dateAt(rightValue)?.getTime() ?? 0)) * direction;
        return cellDisplayValue(leftValue, property).localeCompare(cellDisplayValue(rightValue, property), "ko-KR", { numeric: true }) * direction;
      });
    }
  }
  return next;
}

export function InlineDatabase({ databaseId, locked: editorLocked, onNotice, onRemove }: { databaseId: string; locked: boolean; onNotice: (message: string) => void; onRemove: () => void }) {
  const serverSync = useContext(InlineDatabaseSyncContext);
  const [database, setDatabase] = useState<DatabaseState>(() => serverSync.initialStates?.[databaseId] ?? loadDatabase(databaseId));
  const [pendingDeletion, setPendingDeletion] = useState<DatabaseRecord | null>(null);
  const [pendingDatabaseRemoval, setPendingDatabaseRemoval] = useState(false);
  const [timelineStart, setTimelineStart] = useState(() => beginningOfWeek(new Date()));
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null);
  const [searchQueries, setSearchQueries] = useState<Record<string, string>>({});
  const sync = useDatabaseSync({
    databaseId,
    database,
    onLoad: setDatabase,
    onNotice,
    enabled: serverSync.enabled,
    pageId: serverSync.pageId,
    readOnly: editorLocked || Boolean(serverSync.readOnly),
    realtimeEvent: INLINE_DATABASE_REALTIME_EVENT,
  });
  const flushDatabase = sync.flush;
  const locked = editorLocked || Boolean(serverSync.readOnly) || sync.loading || Boolean(sync.conflict);

  useEffect(() => {
    if (serverSync.enabled) return;
    const initialState = serverSync.initialStates?.[databaseId];
    if (initialState) setDatabase(initialState);
  }, [databaseId, serverSync.enabled, serverSync.initialStates]);

  useEffect(() => {
    if (!locked) return;
    setOpenPopoverId(null);
    setPendingDeletion(null);
    setPendingDatabaseRemoval(false);
  }, [locked]);

  useEffect(() => {
    if (!openPopoverId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const nestedSelectOpen = document.querySelector('.shadcn-select-content[data-state="open"]');
      if (nestedSelectOpen) {
        const parentPopovers = document.querySelectorAll('.database-rule-popover[data-state="open"], .database-settings-popover[data-state="open"], .timeline-fields-popover[data-state="open"]');
        if (Array.from(parentPopovers).some((popover) => pointIsInsideElement(popover, event.clientX, event.clientY))) return;
      }
      if (target.closest("[data-radix-popper-content-wrapper]")) return;
      if (target.closest(".add-view-trigger, .database-toolbar-icon, .database-toolbar-button, .timeline-fields-trigger, .database-add-property-trigger, .database-property-heading, .database-multi-select-trigger, .record-actions-trigger")) return;
      setOpenPopoverId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [openPopoverId]);

  const activeView = database.views.find((view) => view.id === database.activeViewId) ?? database.views[0];
  const updateDatabase = (updater: (current: DatabaseState) => DatabaseState) => {
    if (locked) return;
    setDatabase(updater);
  };

  const addView = (type: ViewType) => {
    const baseName = type === "table" ? "테이블" : "타임라인";
    const matchingCount = database.views.filter((view) => view.name.startsWith(baseName)).length;
    const view: DatabaseView = { id: makeId("view"), name: matchingCount ? `${baseName} ${matchingCount + 1}` : baseName, type };
    updateDatabase((current) => ({ ...current, views: [...current.views, view], activeViewId: view.id }));
    onNotice(`${view.name} 탭을 추가했어요`);
  };

  const updateView = (viewId: string, patch: Partial<DatabaseView>) => updateDatabase((current) => ({ ...current, views: current.views.map((view) => view.id === viewId ? { ...view, ...patch } : view) }));

  const duplicateView = (viewId: string) => {
    updateDatabase((current) => {
      const source = current.views.find((view) => view.id === viewId);
      if (!source) return current;
      const duplicate: DatabaseView = {
        ...source,
        id: makeId("view"),
        name: `${source.name} 복사본`,
        columnWidths: source.columnWidths ? { ...source.columnWidths } : undefined,
        hiddenPropertyIds: source.hiddenPropertyIds ? [...source.hiddenPropertyIds] : undefined,
        filter: source.filter ? { ...source.filter } : undefined,
        sort: source.sort ? { ...source.sort } : undefined,
      };
      return { ...current, views: [...current.views, duplicate], activeViewId: duplicate.id };
    });
    onNotice("뷰를 복제했어요");
  };

  const deleteView = (viewId: string) => {
    updateDatabase((current) => {
      const views = current.views.filter((view) => view.id !== viewId);
      return { ...current, views, activeViewId: current.activeViewId === viewId ? views[0]?.id ?? null : current.activeViewId };
    });
    onNotice("탭을 삭제했어요");
  };

  const addProperty = (name: string, type: PropertyType) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const options = type === "status" ? ["시작 전", "진행 중", "완료"].map((optionName, index) => ({ id: makeId("option"), name: optionName, color: TAG_COLORS[index] })) : [];
    const property: DatabaseProperty = { id: makeId("property"), name: trimmedName, type, options };
    updateDatabase((current) => ({ ...current, properties: [...current.properties, property] }));
    onNotice(`“${property.name}” 속성을 추가했어요`);
  };

  const updateProperty = (propertyId: string, patch: Partial<DatabaseProperty>) => updateDatabase((current) => ({ ...current, properties: current.properties.map((property) => property.id === propertyId ? { ...property, ...patch } : property) }));

  const removeProperty = (propertyId: string) => {
    updateDatabase((current) => ({
      ...current,
      properties: current.properties.filter((property) => property.id !== propertyId),
      records: current.records.map((record) => { const values = { ...record.values }; delete values[propertyId]; return { ...record, values }; }),
      trash: current.trash.map((record) => { const values = { ...record.values }; delete values[propertyId]; return { ...record, values }; }),
      views: current.views.map((view) => {
        const columnWidths = view.columnWidths ? { ...view.columnWidths } : undefined;
        if (columnWidths) delete columnWidths[propertyId];
        return {
          ...view,
          columnWidths,
          datePropertyId: view.datePropertyId === propertyId ? undefined : view.datePropertyId,
          timelineContentPropertyId: view.timelineContentPropertyId === propertyId ? undefined : view.timelineContentPropertyId,
          timelineCardContentPropertyId: view.timelineCardContentPropertyId === propertyId ? undefined : view.timelineCardContentPropertyId,
          hiddenPropertyIds: view.hiddenPropertyIds?.filter((id) => id !== propertyId),
          filter: view.filter?.propertyId === propertyId ? undefined : view.filter,
          sort: view.sort?.propertyId === propertyId ? undefined : view.sort,
        };
      }),
    }));
    onNotice("속성을 삭제했어요");
  };

  const addSelectOption = (propertyId: string, name: string) => {
    const option: DatabaseOption = { id: makeId("option"), name: name.trim(), color: TAG_COLORS[(database.properties.find((property) => property.id === propertyId)?.options.length ?? 0) % TAG_COLORS.length] };
    if (!option.name) return;
    updateDatabase((current) => ({ ...current, properties: current.properties.map((property) => property.id === propertyId ? { ...property, options: [...property.options, option] } : property) }));
  };

  const removeSelectOption = (propertyId: string, optionId: string) => updateDatabase((current) => {
    const property = current.properties.find((item) => item.id === propertyId);
    const cleanRecord = (record: DatabaseRecord) => {
      const currentValue = record.values[propertyId];
      if (typeof currentValue !== "string") return record;
      const nextValue = property?.type === "multi_select" ? currentValue.split(",").filter((id) => id && id !== optionId).join(",") : currentValue === optionId ? "" : currentValue;
      return nextValue === currentValue ? record : { ...record, values: { ...record.values, [propertyId]: nextValue } };
    };
    return {
      ...current,
      properties: current.properties.map((item) => item.id === propertyId ? { ...item, options: item.options.filter((option) => option.id !== optionId) } : item),
      records: current.records.map(cleanRecord),
      trash: current.trash.map(cleanRecord),
    };
  });

  const addRecord = () => {
    const record: DatabaseRecord = { id: makeId("record"), values: {} };
    updateDatabase((current) => ({ ...current, records: [...current.records, record] }));
    onNotice("새 항목을 추가했어요");
  };

  const updateRecord = (recordId: string, propertyId: string, value: CellValue) => updateDatabase((current) => ({ ...current, records: current.records.map((record) => record.id === recordId ? { ...record, values: { ...record.values, [propertyId]: value } } : record) }));

  const duplicateRecord = (record: DatabaseRecord) => {
    updateDatabase((current) => ({ ...current, records: [...current.records, { id: makeId("record"), values: { ...record.values } }] }));
    onNotice("항목을 복제했어요");
  };

  const moveToTrash = () => {
    if (!pendingDeletion) return;
    updateDatabase((current) => ({ ...current, records: current.records.filter((record) => record.id !== pendingDeletion.id), trash: [...current.trash, pendingDeletion] }));
    setPendingDeletion(null);
    onNotice("항목을 휴지통으로 옮겼어요");
  };

  const restoreRecord = (recordId: string) => {
    updateDatabase((current) => {
      const record = current.trash.find((item) => item.id === recordId);
      return record ? { ...current, records: [...current.records, record], trash: current.trash.filter((item) => item.id !== recordId) } : current;
    });
    onNotice("항목을 복원했어요");
  };

  const addDateProperty = (name: string) => addProperty(name || "날짜", "date");
  const activeSearchQuery = activeView ? searchQueries[activeView.id] ?? "" : "";
  const visibleProperties = activeView ? database.properties.filter((property) => !activeView.hiddenPropertyIds?.includes(property.id)) : database.properties;
  const visibleRecords = activeView ? recordsForView(database.records, database.properties, activeView, activeSearchQuery) : database.records;

  return <DatabasePopoverContext.Provider value={{ openPopoverId, setOpenPopoverId }}><section
    className="inline-database database-block"
    aria-label={`${database.name} 데이터베이스`}
    contentEditable={false}
    onMouseMove={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()}
    onMouseUp={(event) => event.stopPropagation()}
  >
    <header className="database-block-head">
      <div><span className="database-icon"><Columns3 size={15} /></span><input aria-label="데이터베이스 이름" disabled={locked} value={database.name} onChange={(event) => updateDatabase((current) => ({ ...current, name: event.target.value }))} /></div>
    </header>

    {sync.error && <p className="database-sync-status" role="status">표를 서버에 저장하지 못했어요. <button type="button" onClick={sync.retry}>다시 시도</button></p>}
    {sync.conflict && <DatabaseConflictPanel key={sync.conflict.remote.revision} items={sync.conflict.items} database={sync.conflict.local} disabled={editorLocked || Boolean(serverSync.readOnly)} onResolve={sync.resolve} />}
    <div className={`database-view-bar ${activeView ? "" : "is-empty"}`}>
      <DatabaseViewTabs views={database.views} activeViewId={activeView?.id ?? null} disabled={locked} onSelect={(viewId) => updateDatabase((current) => ({ ...current, activeViewId: viewId }))} onRename={(viewId, name) => updateView(viewId, { name })} onDeleteView={deleteView} onAddView={addView} />
      {activeView && <DatabaseViewToolbar view={activeView} properties={database.properties} trash={database.trash} disabled={locked} searchQuery={activeSearchQuery} resultCount={visibleRecords.length} totalCount={database.records.length} onSearchQueryChange={(query) => setSearchQueries((current) => ({ ...current, [activeView.id]: query }))} onAddRecord={addRecord} onAddDateProperty={addDateProperty} onUpdateView={(patch) => updateView(activeView.id, patch)} onDuplicateView={() => duplicateView(activeView.id)} onDeleteView={() => deleteView(activeView.id)} onRestoreRecord={restoreRecord} onRequestDatabaseRemoval={() => setPendingDatabaseRemoval(true)} />}
    </div>
    {!activeView ? <BlankDatabase disabled={locked} onAddView={addView} /> : <>
      {activeView.type === "table" ? <DatabaseTable records={visibleRecords} properties={visibleProperties} disabled={locked} hasHiddenProperties={(activeView.hiddenPropertyIds?.length ?? 0) > 0} isFiltered={Boolean(activeSearchQuery || activeView.filter)} columnWidths={activeView.columnWidths ?? {}} onColumnWidthsChange={(columnWidths) => updateView(activeView.id, { columnWidths })} onAddRecord={addRecord} onAddProperty={addProperty} onUpdateProperty={updateProperty} onRemoveProperty={removeProperty} onAddSelectOption={addSelectOption} onRemoveSelectOption={removeSelectOption} onUpdate={updateRecord} onDuplicate={duplicateRecord} onDelete={setPendingDeletion} /> : <DatabaseTimeline view={activeView} records={visibleRecords} properties={database.properties} disabled={locked} start={timelineStart} onAddDateProperty={addDateProperty} onChangeView={(patch) => updateView(activeView.id, patch)} onUpdateRecord={updateRecord} onPrevious={(days) => setTimelineStart((date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - days))} onNext={(days) => setTimelineStart((date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days))} onToday={() => setTimelineStart(beginningOfWeek(new Date()))} />}
    </>}
    {pendingDeletion && <RecordDeleteConfirm recordName={recordLabel(pendingDeletion, database.properties, Math.max(0, database.records.findIndex((record) => record.id === pendingDeletion.id)))} onCancel={() => setPendingDeletion(null)} onConfirm={moveToTrash} />}
    {pendingDatabaseRemoval && <DatabaseDeleteConfirm databaseName={database.name} onCancel={() => setPendingDatabaseRemoval(false)} onConfirm={() => {
      if (serverSync.enabled) {
        flushDatabase();
        void enqueueDatabaseSync(databaseId, () => workspaceApi.deleteDatabase(databaseId)).catch((error) => {
          if (!(error instanceof NodiApiError && error.status === 404)) {
            onNotice(error instanceof Error ? error.message : "데이터베이스를 서버에서 삭제하지 못했어요");
          }
        });
      }
      onNotice("데이터베이스를 삭제했어요");
      onRemove();
    }} />}
  </section></DatabasePopoverContext.Provider>;
}

function DatabaseConflictPanel({ items, database, disabled, onResolve }: { items: DatabaseConflict[]; database: DatabaseState; disabled: boolean; onResolve: (choices: ConflictChoices) => void }) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<ConflictChoices>({});
  const value = (input: unknown) => input === undefined ? "삭제됨" : typeof input === "string" ? input || "빈 값" : JSON.stringify(input, null, 2);
  return <section className="database-sync-conflict" aria-label="표 변경 충돌">
    <p role="status">동시에 변경한 내용이 있어요. 선택한 내용을 저장하기 전까지 초안을 보관합니다.</p>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "비교 접기" : "변경 비교"}</button>
    {open && <form onSubmit={(event) => { event.preventDefault(); onResolve(choices); }}>
      {items.map((item, index) => <fieldset key={item.key} disabled={disabled}>
        <legend>{conflictLabel(item, database)}</legend>
        {(["local", "remote"] as const).map((side) => <label key={side}>
          <input type="radio" name={`conflict-${index}`} checked={choices[item.key] === side} onChange={() => setChoices((current) => ({ ...current, [item.key]: side }))} />
          {side === "local" ? "내 변경" : "서버 변경"}<pre>{value(item[side])}</pre>
        </label>)}
      </fieldset>)}
      <button type="submit" disabled={disabled || items.some((item) => !choices[item.key])}>선택한 내용 저장</button>
    </form>}
  </section>;
}

function DatabaseViewTabs({ views, activeViewId, disabled, onSelect, onRename, onDeleteView, onAddView }: { views: DatabaseView[]; activeViewId: string | null; disabled: boolean; onSelect: (viewId: string) => void; onRename: (viewId: string, name: string) => void; onDeleteView: (viewId: string) => void; onAddView: (type: ViewType) => void }) {
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const startRenaming = (view: DatabaseView) => { if (disabled) return; setEditingViewId(view.id); setEditingName(view.name); };
  const finishRenaming = (view: DatabaseView) => { if (editingViewId !== view.id) return; const name = editingName.trim(); if (name && name !== view.name) onRename(view.id, name); setEditingViewId(null); };
  return <div className={`database-view-tabs ${views.length === 0 ? "is-empty" : ""}`}><div className="database-tabs" role="tablist">{views.map((view) => <div key={view.id} className={`database-tab-item ${view.id === activeViewId ? "is-active" : ""} ${editingViewId === view.id ? "is-editing" : ""}`}>{editingViewId === view.id ? <input className="database-tab-name-input" aria-label={`${view.name} 탭 이름`} autoFocus value={editingName} onFocus={(event) => { const cursor = event.currentTarget.value.length; event.currentTarget.setSelectionRange(cursor, cursor); }} onChange={(event) => setEditingName(event.target.value)} onBlur={() => finishRenaming(view)} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === "Enter") { event.preventDefault(); finishRenaming(view); } if (event.key === "Escape") { event.preventDefault(); setEditingViewId(null); } }} /> : <button className="database-tab-select" type="button" role="tab" aria-selected={view.id === activeViewId} disabled={disabled} onClick={() => onSelect(view.id)} onDoubleClick={(event) => { event.preventDefault(); startRenaming(view); }}>{view.type === "table" ? <Table2 size={14} /> : <Timeline size={14} />}<span>{view.name}</span></button>}<button className="database-tab-close" type="button" disabled={disabled} aria-label={`${view.name} 탭 삭제`} onClick={(event) => { event.stopPropagation(); onDeleteView(view.id); }}><X size={12} /></button></div>)}</div><ViewAddPopover disabled={disabled} onAddView={onAddView} /></div>;
}

function ViewAddPopover({ disabled, onAddView, label = "새 탭 추가", className = "", showLabel = false }: { disabled: boolean; onAddView: (type: ViewType) => void; label?: string; className?: string; showLabel?: boolean }) {
  const { open, onOpenChange } = useDatabasePopover("view-add");
  const addView = (type: ViewType) => { onAddView(type); onOpenChange(false); };
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className={`add-view-trigger ${className}`} type="button" disabled={disabled} aria-label={label}><Plus size={17} />{showLabel && <span>{label}</span>}</button></Popover.Trigger><Popover.Portal><Popover.Content className="add-view-menu" side="bottom" align="start" sideOffset={6} onCloseAutoFocus={(event) => event.preventDefault()}><span>새 뷰</span><button type="button" role="menuitem" onClick={() => addView("table")}><Table2 size={16} /><span><strong>테이블</strong><small>속성과 행을 표로 정리</small></span></button><button type="button" role="menuitem" onClick={() => addView("timeline")}><Timeline size={16} /><span><strong>타임라인</strong><small>날짜 속성으로 일정 표시</small></span></button></Popover.Content></Popover.Portal></Popover.Root>;
}

function BlankDatabase({ disabled, onAddView }: { disabled: boolean; onAddView: (type: ViewType) => void }) {
  return <div className="database-blank"><span><Columns3 size={18} /></span><div><strong>아직 뷰가 없습니다.</strong><p>위의 + 버튼을 눌러 테이블 또는 타임라인을 추가하세요.</p></div></div>;
}

function DatabaseViewToolbar({ view, properties, trash, disabled, searchQuery, resultCount, totalCount, onSearchQueryChange, onAddRecord, onAddDateProperty, onUpdateView, onDuplicateView, onDeleteView, onRestoreRecord, onRequestDatabaseRemoval }: { view: DatabaseView; properties: DatabaseProperty[]; trash: DatabaseRecord[]; disabled: boolean; searchQuery: string; resultCount: number; totalCount: number; onSearchQueryChange: (query: string) => void; onAddRecord: () => void; onAddDateProperty: (name: string) => void; onUpdateView: (patch: Partial<DatabaseView>) => void; onDuplicateView: () => void; onDeleteView: () => void; onRestoreRecord: (recordId: string) => void; onRequestDatabaseRemoval: () => void }) {
  return <div className="database-view-toolbar"><div className="database-result-summary">{(searchQuery || view.filter) && <span>{resultCount} / {totalCount}</span>}</div><div className="database-view-controls"><DatabaseSearchPopover query={searchQuery} resultCount={resultCount} onQueryChange={onSearchQueryChange} /><DatabaseFilterPopover view={view} properties={properties} disabled={disabled} onUpdateView={onUpdateView} /><DatabaseSortPopover view={view} properties={properties} disabled={disabled} onUpdateView={onUpdateView} /><ViewSettingsPopover view={view} properties={properties} trash={trash} disabled={disabled} onAddDateProperty={onAddDateProperty} onUpdateView={onUpdateView} onDuplicateView={onDuplicateView} onDeleteView={onDeleteView} onRestoreRecord={onRestoreRecord} /><button type="button" className="database-toolbar-button database-delete-trigger" disabled={disabled} aria-label="데이터베이스 삭제" title="데이터베이스 삭제" onClick={onRequestDatabaseRemoval}><Trash2 size={14} /><span>삭제</span></button><button type="button" className="database-add" disabled={disabled || properties.length === 0} onClick={onAddRecord}><Plus size={15} /> {view.type === "table" ? "새 행" : "새 항목"}</button></div></div>;
}

function DatabaseSearchPopover({ query, resultCount, onQueryChange }: { query: string; resultCount: number; onQueryChange: (query: string) => void }) {
  const { open, onOpenChange } = useDatabasePopover("database-search");
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className={`database-toolbar-icon ${query ? "is-active" : ""}`} type="button" aria-label="데이터베이스 검색"><Search size={15} /></button></Popover.Trigger><Popover.Portal><Popover.Content className="database-search-popover" side="bottom" align="end" sideOffset={7} onCloseAutoFocus={(event) => event.preventDefault()}><div><Search size={15} /><input autoFocus value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === "Escape") onOpenChange(false); }} placeholder="이 뷰에서 검색" aria-label="데이터베이스 검색어" />{query && <button type="button" aria-label="검색어 지우기" onClick={() => onQueryChange("")}><X size={14} /></button>}</div><small>{query ? `${resultCount}개의 항목을 찾았습니다.` : "제목과 모든 속성을 검색합니다."}</small></Popover.Content></Popover.Portal></Popover.Root>;
}

function DatabaseFilterPopover({ view, properties, disabled, onUpdateView }: { view: DatabaseView; properties: DatabaseProperty[]; disabled: boolean; onUpdateView: (patch: Partial<DatabaseView>) => void }) {
  const { open, onOpenChange } = useDatabasePopover(`filter:${view.id}`);
  const filter = view.filter;
  const property = properties.find((item) => item.id === filter?.propertyId);
  const operatorOptions = [{ value: "contains", label: "포함" }, { value: "equals", label: "같음" }, { value: "not_equals", label: "같지 않음" }, { value: "empty", label: "비어 있음" }, { value: "not_empty", label: "비어 있지 않음" }];
  const addFilter = () => { const first = properties[0]; if (first) onUpdateView({ filter: { propertyId: first.id, operator: first.type === "checkbox" ? "equals" : "contains", value: first.type === "checkbox" ? "true" : "" } }); };
  const updateFilter = (patch: Partial<DatabaseFilter>) => filter && onUpdateView({ filter: { ...filter, ...patch } });
  const needsValue = filter && !["empty", "not_empty"].includes(filter.operator);
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className={`database-toolbar-button ${filter ? "is-active" : ""}`} type="button" disabled={disabled} aria-label="필터"><Filter size={14} /><span>필터</span>{filter && <em>1</em>}</button></Popover.Trigger><Popover.Portal><Popover.Content className="database-rule-popover" side="bottom" align="end" sideOffset={7} onInteractOutside={keepParentPopoverOpenForNestedSelect} onCloseAutoFocus={(event) => event.preventDefault()}><header><strong>필터</strong>{filter && <button type="button" aria-label="필터 제거" onClick={() => onUpdateView({ filter: undefined })}><Trash2 size={14} /></button>}</header>{properties.length === 0 ? <p>먼저 속성을 추가해 주세요.</p> : !filter ? <button className="database-rule-add" type="button" onClick={addFilter}><Plus size={14} /> 필터 추가</button> : <div className="database-rule-fields"><Select ariaLabel="필터 속성" value={filter.propertyId} onValueChange={(propertyId) => { const nextProperty = properties.find((item) => item.id === propertyId); updateFilter({ propertyId, operator: nextProperty?.type === "checkbox" ? "equals" : "contains", value: nextProperty?.type === "checkbox" ? "true" : "" }); }} options={properties.map((item) => ({ value: item.id, label: item.name || "이름 없음" }))} /><Select ariaLabel="필터 조건" value={filter.operator} onValueChange={(operator) => updateFilter({ operator: operator as FilterOperator })} options={operatorOptions} />{needsValue && (property?.type === "select" || property?.type === "status" || property?.type === "multi_select" ? <Select ariaLabel="필터 값" value={filter.value} onValueChange={(value) => updateFilter({ value })} options={property.options.map((option) => ({ value: option.id, label: option.name, className: `tag-${option.color}` }))} placeholder="옵션 선택" /> : property?.type === "checkbox" ? <Select ariaLabel="필터 값" value={filter.value} onValueChange={(value) => updateFilter({ value })} options={[{ value: "true", label: "체크됨" }, { value: "false", label: "체크 안 됨" }]} /> : <input value={filter.value} onChange={(event) => updateFilter({ value: event.target.value })} placeholder="필터 값" aria-label="필터 값" />)}</div>}</Popover.Content></Popover.Portal></Popover.Root>;
}

function DatabaseSortPopover({ view, properties, disabled, onUpdateView }: { view: DatabaseView; properties: DatabaseProperty[]; disabled: boolean; onUpdateView: (patch: Partial<DatabaseView>) => void }) {
  const { open, onOpenChange } = useDatabasePopover(`sort:${view.id}`);
  const sort = view.sort;
  const addSort = () => { const first = properties[0]; if (first) onUpdateView({ sort: { propertyId: first.id, direction: "asc" } }); };
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className={`database-toolbar-button ${sort ? "is-active" : ""}`} type="button" disabled={disabled} aria-label="정렬">{sort?.direction === "desc" ? <ArrowDownAZ size={14} /> : <ArrowUpAZ size={14} />}<span>정렬</span>{sort && <em>1</em>}</button></Popover.Trigger><Popover.Portal><Popover.Content className="database-rule-popover" side="bottom" align="end" sideOffset={7} onInteractOutside={keepParentPopoverOpenForNestedSelect} onCloseAutoFocus={(event) => event.preventDefault()}><header><strong>정렬</strong>{sort && <button type="button" aria-label="정렬 제거" onClick={() => onUpdateView({ sort: undefined })}><Trash2 size={14} /></button>}</header>{properties.length === 0 ? <p>먼저 속성을 추가해 주세요.</p> : !sort ? <button className="database-rule-add" type="button" onClick={addSort}><Plus size={14} /> 정렬 추가</button> : <div className="database-rule-fields"><Select ariaLabel="정렬 속성" value={sort.propertyId} onValueChange={(propertyId) => onUpdateView({ sort: { ...sort, propertyId } })} options={properties.map((property) => ({ value: property.id, label: property.name || "이름 없음" }))} /><Select ariaLabel="정렬 방향" value={sort.direction} onValueChange={(direction) => onUpdateView({ sort: { ...sort, direction: direction as SortDirection } })} options={[{ value: "asc", label: "오름차순" }, { value: "desc", label: "내림차순" }]} /></div>}</Popover.Content></Popover.Portal></Popover.Root>;
}

function ViewSettingsPopover({ view, properties, trash, disabled, onAddDateProperty, onUpdateView, onDuplicateView, onDeleteView, onRestoreRecord }: { view: DatabaseView; properties: DatabaseProperty[]; trash: DatabaseRecord[]; disabled: boolean; onAddDateProperty: (name: string) => void; onUpdateView: (patch: Partial<DatabaseView>) => void; onDuplicateView: () => void; onDeleteView: () => void; onRestoreRecord: (recordId: string) => void }) {
  const dateProperties = properties.filter((property) => property.type === "date");
  const titleProperty = properties.find((property) => property.id === view.timelineContentPropertyId) ?? properties.find((property) => property.type === "text") ?? properties[0];
  const cardContentProperty = properties.find((property) => property.id === view.timelineCardContentPropertyId);
  const { open, onOpenChange } = useDatabasePopover(`view-settings:${view.id}`);
  const toggleProperty = (propertyId: string) => {
    const hidden = view.hiddenPropertyIds ?? [];
    onUpdateView({ hiddenPropertyIds: hidden.includes(propertyId) ? hidden.filter((id) => id !== propertyId) : [...hidden, propertyId] });
  };
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className="database-toolbar-button" type="button" disabled={disabled} aria-label="뷰 설정"><SlidersHorizontal size={14} /><span>뷰 설정</span></button></Popover.Trigger><Popover.Portal><Popover.Content className="database-settings-popover" side="bottom" align="end" sideOffset={7} onInteractOutside={keepParentPopoverOpenForNestedSelect} onCloseAutoFocus={(event) => event.preventDefault()}><strong>뷰 설정</strong><label>뷰 이름<input disabled={disabled} value={view.name} onChange={(event) => onUpdateView({ name: event.target.value })} /></label>{view.type === "timeline" && <div className="timeline-property-setting"><span>날짜 속성</span>{dateProperties.length > 0 ? <Select ariaLabel="타임라인 날짜 속성" disabled={disabled} value={view.datePropertyId ?? dateProperties[0].id} onValueChange={(datePropertyId) => onUpdateView({ datePropertyId })} options={dateProperties.map((property) => ({ value: property.id, label: property.name || "이름 없음" }))} /> : <DatePropertyCreator disabled={disabled} onAdd={onAddDateProperty} compact />}{titleProperty && <><span>제목 속성</span><Select ariaLabel="타임라인 제목 속성" disabled={disabled} value={titleProperty.id} onValueChange={(timelineContentPropertyId) => onUpdateView({ timelineContentPropertyId })} options={properties.map((property) => ({ value: property.id, label: property.name || "이름 없음" }))} /><span>내용 속성</span><Select ariaLabel="타임라인 내용 속성" disabled={disabled} value={cardContentProperty?.id ?? "__title__"} onValueChange={(timelineCardContentPropertyId) => onUpdateView({ timelineCardContentPropertyId: timelineCardContentPropertyId === "__title__" ? undefined : timelineCardContentPropertyId })} options={[{ value: "__title__", label: "제목과 동일" }, ...properties.map((property) => ({ value: property.id, label: property.name || "이름 없음" }))]} /></>}</div>}<div className="database-property-visibility"><span>속성 표시</span>{properties.length === 0 ? <small>표시할 속성이 없습니다.</small> : properties.map((property) => { const visible = !view.hiddenPropertyIds?.includes(property.id); return <button type="button" key={property.id} disabled={disabled} onClick={() => toggleProperty(property.id)}><span>{visible ? <Eye size={14} /> : <EyeOff size={14} />}{property.name || "이름 없음"}</span><Check size={14} className={visible ? "is-visible" : ""} /></button>; })}</div>{trash.length > 0 && <DatabaseTrash records={trash} properties={properties} disabled={disabled} onRestore={onRestoreRecord} />}<div className="database-view-danger-zone"><button type="button" disabled={disabled} onClick={() => { onDuplicateView(); onOpenChange(false); }}><Copy size={14} /> 이 뷰 복제</button><button className="delete-view-button" type="button" disabled={disabled} onClick={() => { onDeleteView(); onOpenChange(false); }}><Trash2 size={14} /> 이 뷰 삭제</button></div></Popover.Content></Popover.Portal></Popover.Root>;
}

function DatePropertyCreator({ disabled, onAdd, compact = false }: { disabled: boolean; onAdd: (name: string) => void; compact?: boolean }) {
  const [name, setName] = useState("날짜");
  return <form className={`timeline-date-creator ${compact ? "is-compact" : ""}`} onSubmit={(event) => { event.preventDefault(); onAdd(name.trim() || "날짜"); }}><input disabled={disabled} value={name} onChange={(event) => setName(event.target.value)} aria-label="새 날짜 속성 이름" placeholder="날짜 속성 이름" /><button type="submit" disabled={disabled}><Plus size={14} /> 날짜 속성 만들기</button></form>;
}


function DatabaseTable({ records, properties, disabled, hasHiddenProperties, isFiltered, columnWidths, onColumnWidthsChange, onAddRecord, onAddProperty, onUpdateProperty, onRemoveProperty, onAddSelectOption, onRemoveSelectOption, onUpdate, onDuplicate, onDelete }: { records: DatabaseRecord[]; properties: DatabaseProperty[]; disabled: boolean; hasHiddenProperties: boolean; isFiltered: boolean; columnWidths: Record<string, number>; onColumnWidthsChange: (columnWidths: Record<string, number>) => void; onAddRecord: () => void; onAddProperty: (name: string, type: PropertyType) => void; onUpdateProperty: (propertyId: string, patch: Partial<DatabaseProperty>) => void; onRemoveProperty: (propertyId: string) => void; onAddSelectOption: (propertyId: string, name: string) => void; onRemoveSelectOption: (propertyId: string, optionId: string) => void; onUpdate: (recordId: string, propertyId: string, value: CellValue) => void; onDuplicate: (record: DatabaseRecord) => void; onDelete: (record: DatabaseRecord) => void }) {
  const [contextMenu, setContextMenu] = useState<{ record: DatabaseRecord; label: string; x: number; y: number } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const resolvedColumnWidths = properties.reduce<Record<string, number>>((widths, property) => ({ ...widths, [property.id]: columnWidths[property.id] ?? 180 }), {});
  const tableWidth = properties.reduce((width, property) => width + resolvedColumnWidths[property.id], 0);
  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => { window.removeEventListener("mousedown", closeMenu); window.removeEventListener("blur", closeMenu); };
  }, []);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  const startColumnResize = (event: ReactPointerEvent<HTMLSpanElement>, propertyId: string) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent(DATABASE_COLUMN_RESIZE_START_EVENT));
    resizeCleanupRef.current?.();
    const measuredWidths = Object.fromEntries(Array.from(tableRef.current?.querySelectorAll<HTMLTableCellElement>("th[data-property-id]") ?? []).map((header) => [header.dataset.propertyId ?? "", Math.round(header.getBoundingClientRect().width)]));
    const startingWidths = properties.reduce<Record<string, number>>((widths, property) => ({ ...widths, [property.id]: measuredWidths[property.id] ?? columnWidths[property.id] ?? 180 }), {});
    const startingWidth = startingWidths[propertyId];
    const startingX = event.clientX;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    onColumnWidthsChange(startingWidths);
    const move = (moveEvent: PointerEvent) => {
      const rawDelta = Math.round(moveEvent.clientX - startingX);
      onColumnWidthsChange({ ...startingWidths, [propertyId]: Math.max(100, startingWidth + rawDelta) });
    };
    const finish = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (resizeCleanupRef.current === finish) resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  return <div className="database-table-section" data-nodi-block-selection-ignore="true">
    <div className="database-table-frame">
      <DatabaseHorizontalScrollArea className="database-table-wrap">
        <div className="database-table-scroll-content" style={properties.length > 0 ? { width: `${tableWidth + 48}px` } : undefined}>
          <table ref={tableRef} className={`database-table dynamic-table is-resizable ${properties.length === 0 ? "is-empty-properties" : ""}`} style={properties.length > 0 ? { width: `${tableWidth}px` } : undefined}>
            <colgroup>
              {properties.map((property) => <col key={property.id} style={{ width: `${resolvedColumnWidths[property.id]}px` }} />)}
              {properties.length > 0 && <col className="database-table-filler-col" />}
              {properties.length === 0 && <col />}
            </colgroup>
            <thead>
              <tr>
                {properties.map((property) => <th key={property.id} className="database-property-column" data-property-id={property.id}><PropertyHeaderPopover property={property} disabled={disabled} onUpdate={onUpdateProperty} onRemove={onRemoveProperty} onAddOption={onAddSelectOption} onRemoveOption={onRemoveSelectOption} />{!disabled && <span className="database-column-resize-handle" data-nodi-block-selection-ignore="true" role="separator" aria-orientation="vertical" aria-label={`${property.name} 열 너비 조절`} onPointerDown={(event) => startColumnResize(event, property.id)} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} />}</th>)}
                {properties.length > 0 && <th className="database-table-filler-column" aria-hidden="true" />}
                {properties.length === 0 && <th className="database-empty-table-spacer"><span className="sr-only">속성 영역</span></th>}
              </tr>
            </thead>
            <tbody>
              {records.map((record, index) => {
                const label = recordLabel(record, properties, index);
                return <tr key={record.id} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (!disabled) setContextMenu({ record, label, x: event.clientX, y: event.clientY }); }}>{properties.map((property) => <DatabaseCell key={property.id} record={record} property={property} disabled={disabled} onChange={(value) => onUpdate(record.id, property.id, value)} />)}{properties.length > 0 && <td className="database-table-filler-cell" aria-hidden="true" />}</tr>;
              })}
            </tbody>
          </table>
        </div>
      </DatabaseHorizontalScrollArea>
      <div className="database-table-actions-rail">
        <div className="database-table-actions-rail-header"><PropertyCreatorPopover disabled={disabled} onAdd={onAddProperty} /></div>
        {records.map((record, index) => {
          const label = recordLabel(record, properties, index);
          return <div className="database-table-actions-rail-row" key={record.id} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (!disabled) setContextMenu({ record, label, x: event.clientX, y: event.clientY }); }}><RecordActions record={record} label={label} disabled={disabled} onDuplicate={() => onDuplicate(record)} onDelete={() => onDelete(record)} /></div>;
        })}
      </div>
    </div>
    {properties.length === 0 ? <div className="database-empty"><strong>{hasHiddenProperties ? "이 뷰의 속성이 모두 숨겨져 있습니다." : "첫 속성을 추가해 보세요."}</strong><span>{hasHiddenProperties ? "뷰 설정의 속성 표시에서 필요한 열을 다시 켜세요." : "테이블 헤더의 + 버튼을 눌러 이름과 유형을 정할 수 있습니다."}</span></div> : records.length === 0 && <div className="database-empty"><strong>{isFiltered ? "조건에 맞는 항목이 없습니다." : "첫 항목을 추가해 보세요."}</strong><span>{isFiltered ? "검색어나 필터 조건을 변경해 보세요." : "우측 상단 또는 아래의 새 행 버튼으로 행을 만들 수 있습니다."}</span></div>}
    {properties.length > 0 && <button type="button" className="database-bottom-add" disabled={disabled} onClick={onAddRecord}><Plus size={15} /> 새 행</button>}
    {contextMenu && <div className="record-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onMouseDown={(event) => event.stopPropagation()}><span>{contextMenu.label}</span><button type="button" role="menuitem" onClick={() => { onDuplicate(contextMenu.record); setContextMenu(null); }}><Plus size={14} /> 행 복제</button><button type="button" className="record-context-danger" role="menuitem" onClick={() => { onDelete(contextMenu.record); setContextMenu(null); }}><Trash2 size={14} /> 휴지통으로 이동</button></div>}
  </div>;
}

function DatabaseHorizontalScrollArea({ className, children }: { className: string; children: ReactNode }) {
  const targetRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ canScroll: false, width: 0, left: 0 });
  const [isScrolling, setIsScrolling] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const visibilityTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ startX: number; startScrollLeft: number } | null>(null);
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let frame = 0;
    const reveal = () => { setIsScrolling(true); if (visibilityTimerRef.current) window.clearTimeout(visibilityTimerRef.current); visibilityTimerRef.current = window.setTimeout(() => setIsScrolling(false), 700); };
    const refresh = () => {
      const maxScroll = target.scrollWidth - target.clientWidth;
      const canScroll = maxScroll > 1;
      const width = canScroll ? Math.max(44, (target.clientWidth * target.clientWidth) / target.scrollWidth) : 0;
      const left = canScroll ? (target.scrollLeft / maxScroll) * (target.clientWidth - width) : 0;
      setMetrics((current) => current.canScroll === canScroll && Math.abs(current.width - width) < .5 && Math.abs(current.left - left) < .5 ? current : { canScroll, width, left });
    };
    const scheduleRefresh = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(refresh); };
    const onScroll = () => { scheduleRefresh(); reveal(); };
    const resizeObserver = new ResizeObserver(scheduleRefresh);
    const mutationObserver = new MutationObserver(scheduleRefresh);
    resizeObserver.observe(target);
    if (target.firstElementChild) resizeObserver.observe(target.firstElementChild);
    mutationObserver.observe(target, { childList: true, subtree: true, characterData: true });
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", scheduleRefresh);
    scheduleRefresh();
    return () => { window.cancelAnimationFrame(frame); if (visibilityTimerRef.current) window.clearTimeout(visibilityTimerRef.current); target.removeEventListener("scroll", onScroll); window.removeEventListener("resize", scheduleRefresh); resizeObserver.disconnect(); mutationObserver.disconnect(); };
  }, []);
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => { const target = targetRef.current; if (!target) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { startX: event.clientX, startScrollLeft: target.scrollLeft }; setIsDragging(true); };
  const drag = (event: React.PointerEvent<HTMLDivElement>) => { const target = targetRef.current; const start = dragRef.current; if (!target || !start) return; target.scrollLeft = start.startScrollLeft + (event.clientX - start.startX) * (target.scrollWidth / Math.max(target.clientWidth, 1)); };
  const endDrag = () => { dragRef.current = null; setIsDragging(false); };
  return <div className={`database-scroll-shell ${metrics.canScroll ? "has-overflow" : ""}`}><div ref={targetRef} className={`${className} database-native-scroll`}>{children}</div>{metrics.canScroll && <div className={`database-scrollbar ${isScrolling ? "is-scrolling" : ""} ${isDragging ? "is-dragging" : ""}`} aria-hidden="true"><div className="database-scrollbar-thumb" style={{ width: metrics.width, transform: `translateX(${metrics.left}px)` }} onPointerDown={beginDrag} onPointerMove={drag} onPointerUp={endDrag} onLostPointerCapture={endDrag} /></div>}</div>;
}

function PropertyCreatorPopover({ disabled, onAdd, label, className = "" }: { disabled: boolean; onAdd: (name: string, type: PropertyType) => void; label?: string; className?: string }) {
  const { open, onOpenChange } = useDatabasePopover(label ? "toolbar-property-add" : "table-property-add");
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>("text");
  const creatingRef = useRef(false);
  const createProperty = () => {
    if (!name.trim() || creatingRef.current) return;
    creatingRef.current = true;
    onAdd(name, type);
    setName("");
    setType("text");
    onOpenChange(false);
    window.setTimeout(() => { creatingRef.current = false; }, 0);
  };
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className={`database-add-property-trigger ${className}`} type="button" disabled={disabled} aria-label="새 속성 추가"><Plus size={16} />{label && <span>{label}</span>}</button></Popover.Trigger><Popover.Portal><Popover.Content className="database-property-popover" side="bottom" align="start" sideOffset={7} onCloseAutoFocus={(event) => event.preventDefault()}><label>속성 이름<input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); createProperty(); } }} placeholder="예: 마감일" /></label><div><span>유형 선택</span><div className="property-type-grid">{propertyTypeOptions.map((option) => <button key={option.value} type="button" className={option.value === type ? "active" : ""} onClick={() => setType(option.value)}><b>{option.glyph}</b>{option.label}</button>)}</div></div><button className="create-property-button" type="button" disabled={!name.trim()} onClick={createProperty}>속성 만들기</button></Popover.Content></Popover.Portal></Popover.Root>;
}

function PropertyHeaderPopover({ property, disabled, onUpdate, onRemove, onAddOption, onRemoveOption }: { property: DatabaseProperty; disabled: boolean; onUpdate: (propertyId: string, patch: Partial<DatabaseProperty>) => void; onRemove: (propertyId: string) => void; onAddOption: (propertyId: string, name: string) => void; onRemoveOption: (propertyId: string, optionId: string) => void }) {
  const { open, onOpenChange } = useDatabasePopover(`property:${property.id}`);
  const [optionName, setOptionName] = useState("");
  const type = propertyTypeOptions.find((option) => option.value === property.type);
  const hasOptions = property.type === "select" || property.type === "multi_select" || property.type === "status";
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className="database-property-heading" type="button" disabled={disabled} aria-label={`${property.name || "이름 없음"} 속성 설정`}><span className="database-property-glyph">{type?.glyph}</span>{property.name || "이름 없음"}</button></Popover.Trigger><Popover.Portal><Popover.Content className="database-property-popover property-editor-popover" side="bottom" align="start" sideOffset={7} onCloseAutoFocus={(event) => event.preventDefault()}><label>속성 이름<input value={property.name} disabled={disabled} onChange={(event) => onUpdate(property.id, { name: event.target.value })} placeholder="속성 이름" /></label><div><span>유형 선택</span><div className="property-type-grid">{propertyTypeOptions.map((option) => <button key={option.value} type="button" disabled={disabled} className={option.value === property.type ? "active" : ""} onClick={() => onUpdate(property.id, { type: option.value })}><b>{option.glyph}</b>{option.label}</button>)}</div></div>{hasOptions && <div className="property-option-editor"><span>선택 옵션</span><div>{property.options.map((option) => <span className={`tag-chip tag-${option.color}`} key={option.id}>{option.name}<button type="button" disabled={disabled} aria-label={`${option.name} 옵션 삭제`} onClick={() => onRemoveOption(property.id, option.id)}><X size={12} /></button></span>)}</div><form onSubmit={(event) => { event.preventDefault(); if (!optionName.trim()) return; onAddOption(property.id, optionName); setOptionName(""); }}><input disabled={disabled} value={optionName} onChange={(event) => setOptionName(event.target.value)} placeholder="옵션 이름" /><button type="submit" disabled={disabled || !optionName.trim()}><Plus size={13} /> 옵션 추가</button></form></div>}<button className="delete-property-button" type="button" disabled={disabled} onClick={() => { onRemove(property.id); onOpenChange(false); }}><Trash2 size={14} /> 속성 삭제</button></Popover.Content></Popover.Portal></Popover.Root>;
}

function DatabaseCell({ record, property, disabled, onChange }: { record: DatabaseRecord; property: DatabaseProperty; disabled: boolean; onChange: (value: CellValue) => void }) {
  const value = record.values[property.id];
  if (property.type === "date") return <td><DatePicker compact allowRange ariaLabel={`${property.name} 날짜`} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={onChange} /></td>;
  if (property.type === "checkbox") return <td><label className="database-checkbox"><input aria-label={`${property.name} 체크`} disabled={disabled} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /><Check size={13} /></label></td>;
  if (property.type === "multi_select") return <MultiSelectCell recordId={record.id} property={property} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={onChange} />;
  if (property.type === "select" || property.type === "status") {
    const options = [{ value: "__none__", label: "선택 안 함" }, ...property.options.map((option) => ({ value: option.id, label: option.name, className: `tag-${option.color}` }))];
    const selectedValue = typeof value === "string" && value ? value : "__none__";
    return <td><Select ariaLabel={`${property.name} 선택`} disabled={disabled || property.options.length === 0} value={selectedValue} onValueChange={(nextValue) => onChange(nextValue === "__none__" ? "" : nextValue)} options={options} placeholder={property.options.length ? "선택" : "옵션 설정 필요"} /></td>;
  }
  const inputType = property.type === "number" ? "number" : property.type === "email" ? "email" : property.type === "phone" ? "tel" : property.type === "url" ? "url" : "text";
  return <td><input className="database-cell-input" aria-label={`${property.name} 값`} disabled={disabled} type={inputType} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} /></td>;
}

function MultiSelectCell({ recordId, property, disabled, value, onChange }: { recordId: string; property: DatabaseProperty; disabled: boolean; value: string; onChange: (value: CellValue) => void }) {
  const { open, onOpenChange } = useDatabasePopover(`multi:${recordId}:${property.id}`);
  const selectedIds = value.split(",").filter(Boolean);
  const toggle = (optionId: string) => onChange(selectedIds.includes(optionId) ? selectedIds.filter((id) => id !== optionId).join(",") : [...selectedIds, optionId].join(","));
  return <td><Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className="database-multi-select-trigger" type="button" disabled={disabled || property.options.length === 0} aria-label={`${property.name} 다중 선택`}>{selectedIds.length === 0 ? <span>선택</span> : selectedIds.slice(0, 2).map((id) => { const option = property.options.find((item) => item.id === id); return option ? <em className={`tag-chip tag-${option.color}`} key={id}>{option.name}</em> : null; })}{selectedIds.length > 2 && <small>+{selectedIds.length - 2}</small>}</button></Popover.Trigger><Popover.Portal><Popover.Content className="database-multi-select-popover" side="bottom" align="start" sideOffset={4} onCloseAutoFocus={(event) => event.preventDefault()}><strong>{property.name}</strong>{property.options.map((option) => <button key={option.id} type="button" onClick={() => toggle(option.id)}><span className={`tag-chip tag-${option.color}`}>{option.name}</span><Check size={14} className={selectedIds.includes(option.id) ? "is-selected" : ""} /></button>)}</Popover.Content></Popover.Portal></Popover.Root></td>;
}

function RecordActions({ record, label, disabled, onDuplicate, onDelete }: { record: DatabaseRecord; label: string; disabled: boolean; onDuplicate: () => void; onDelete: () => void }) {
  const { open, onOpenChange } = useDatabasePopover(`record-actions:${record.id}`);
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className="record-actions-trigger" disabled={disabled} type="button" aria-label={`${label} 더 보기`}><MoreHorizontal size={16} /></button></Popover.Trigger><Popover.Portal><Popover.Content className="record-actions-menu" side="bottom" align="end" sideOffset={4} onCloseAutoFocus={(event) => event.preventDefault()}><button type="button" disabled={disabled} onClick={() => { onDuplicate(); onOpenChange(false); }}><Plus size={13} /> 행 복제</button><button type="button" disabled={disabled} onClick={() => { onDelete(); onOpenChange(false); }}><Trash2 size={13} /> 휴지통으로 이동</button></Popover.Content></Popover.Portal></Popover.Root>;
}

function TimelineFieldsPopover({ view, properties, dateProperty, titleProperty, cardContentProperty, disabled, onChangeView }: { view: DatabaseView; properties: DatabaseProperty[]; dateProperty: DatabaseProperty; titleProperty: DatabaseProperty | undefined; cardContentProperty: DatabaseProperty | undefined; disabled: boolean; onChangeView: (patch: Partial<DatabaseView>) => void }) {
  const { open, onOpenChange } = useDatabasePopover(`timeline-fields:${view.id}`);
  const dateProperties = properties.filter((property) => property.type === "date");
  const propertyOptions = properties.map((property) => ({ value: property.id, label: property.name || "이름 없음" }));
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button className="timeline-fields-trigger" type="button" disabled={disabled} aria-label="타임라인 표시 설정"><SlidersHorizontal size={14} /><span>표시 설정</span></button></Popover.Trigger><Popover.Portal><Popover.Content className="timeline-fields-popover" side="bottom" align="end" sideOffset={7} onInteractOutside={keepParentPopoverOpenForNestedSelect} onCloseAutoFocus={(event) => event.preventDefault()}><header><strong>타임라인 표시</strong><small>항목의 제목, 카드 내용과 기간을 정합니다.</small></header>{titleProperty && <><label><span><strong>제목 속성</strong><small>왼쪽 항목에 표시</small></span><Select ariaLabel="타임라인 제목 속성" disabled={disabled} value={titleProperty.id} onValueChange={(timelineContentPropertyId) => onChangeView({ timelineContentPropertyId })} options={propertyOptions} /></label><label><span><strong>내용 속성</strong><small>타임라인 카드 안에 표시</small></span><Select ariaLabel="타임라인 내용 속성" disabled={disabled} value={cardContentProperty?.id ?? "__title__"} onValueChange={(timelineCardContentPropertyId) => onChangeView({ timelineCardContentPropertyId: timelineCardContentPropertyId === "__title__" ? undefined : timelineCardContentPropertyId })} options={[{ value: "__title__", label: "제목과 동일" }, ...propertyOptions]} /></label></>}<label><span><strong>날짜 속성</strong><small>카드의 시작일과 종료일 기준</small></span><Select ariaLabel="타임라인 날짜 속성" disabled={disabled} value={dateProperty.id} onValueChange={(datePropertyId) => onChangeView({ datePropertyId })} options={dateProperties.map((property) => ({ value: property.id, label: property.name || "이름 없음" }))} /></label></Popover.Content></Popover.Portal></Popover.Root>;
}

function DatabaseTimeline({ view, records, properties, disabled, start, onAddDateProperty, onChangeView, onUpdateRecord, onPrevious, onNext, onToday }: { view: DatabaseView; records: DatabaseRecord[]; properties: DatabaseProperty[]; disabled: boolean; start: Date; onAddDateProperty: (name: string) => void; onChangeView: (patch: Partial<DatabaseView>) => void; onUpdateRecord: (recordId: string, propertyId: string, value: CellValue) => void; onPrevious: (days: number) => void; onNext: (days: number) => void; onToday: () => void }) {
  const dateProperties = properties.filter((property) => property.type === "date");
  const dateProperty = dateProperties.find((property) => property.id === view.datePropertyId) ?? dateProperties[0];
  const titleProperty = properties.find((property) => property.id === view.timelineContentPropertyId) ?? properties.find((property) => property.type === "text") ?? properties[0];
  const configuredCardContentProperty = properties.find((property) => property.id === view.timelineCardContentPropertyId);
  const cardContentProperty = configuredCardContentProperty ?? titleProperty;
  const scale = view.timelineScale ?? "fortnight";
  const periodDays = scale === "month" ? 31 : 14;
  const showTable = view.timelineShowTable !== false;
  const timelineFrameWidth = periodDays * 42 + (showTable ? 188 : 0);
  const days = Array.from({ length: periodDays }, (_, index) => { const date = new Date(start); date.setDate(date.getDate() + index); return date; });
  const monthFormatter = new Intl.DateTimeFormat("ko-KR", { month: "short" });
  const weekdayFormatter = new Intl.DateTimeFormat("ko-KR", { weekday: "short" });
  if (!dateProperty) return <div className="database-empty timeline-empty-state"><strong>타임라인에 쓸 날짜 속성이 없습니다.</strong><span>날짜 속성을 만든 뒤 이 뷰에서 기준 속성으로 선택할 수 있습니다.</span><DatePropertyCreator disabled={disabled} onAdd={onAddDateProperty} /></div>;
  return <div className="timeline-view"><div className="timeline-controls"><div className="timeline-navigation"><div className="timeline-arrow-group"><button type="button" aria-label="이전 기간" onClick={() => onPrevious(periodDays)}><ChevronLeft size={17} /></button><button type="button" aria-label="다음 기간" onClick={() => onNext(periodDays)}><ChevronRight size={17} /></button></div><strong>{new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long" }).format(start)}</strong><span>{scale === "month" ? "31일 보기" : "2주 보기"}</span></div><div className="timeline-controls-actions"><button type="button" className={`timeline-table-toggle ${showTable ? "active" : ""}`} title={showTable ? "항목 표 숨기기" : "항목 표 표시"} aria-label={showTable ? "항목 표 숨기기" : "항목 표 표시"} onClick={() => onChangeView({ timelineShowTable: !showTable })}><Columns3 size={15} /></button><Select ariaLabel="타임라인 기간" disabled={disabled} value={scale} onValueChange={(timelineScale) => onChangeView({ timelineScale: timelineScale as TimelineScale })} options={[{ value: "fortnight", label: "2주" }, { value: "month", label: "한 달" }]} /><TimelineFieldsPopover view={view} properties={properties} dateProperty={dateProperty} titleProperty={titleProperty} cardContentProperty={configuredCardContentProperty} disabled={disabled} onChangeView={onChangeView} /><button type="button" className="timeline-today-button" onClick={onToday}>오늘</button></div></div><DatabaseHorizontalScrollArea className="timeline-scroll"><div className={`timeline-frame ${showTable ? "shows-table" : "hides-table"}`} style={{ minWidth: `${timelineFrameWidth}px` }}><div className="timeline-header">{showTable && <div className="timeline-row-label timeline-heading-label"><Columns3 size={14} /> 항목</div>}<div className="timeline-ruler" style={{ gridTemplateColumns: `repeat(${periodDays}, minmax(42px, 1fr))` }}>{days.map((date, index) => { const isSunday = date.getDay() === 0; const isToday = date.toDateString() === new Date().toDateString(); return <div className={`${isToday ? "is-today " : ""}${isSunday ? "is-sunday" : ""}`} key={toDateInput(date)}><small>{index === 0 || date.getDate() === 1 ? monthFormatter.format(date) : ""}</small><span>{weekdayFormatter.format(date)}</span><b>{date.getDate()}</b></div>; })}</div></div>{records.map((record, index) => <TimelineRow key={record.id} titleLabel={timelineContentLabel(record, titleProperty, `항목 ${index + 1}`)} contentLabel={timelineContentLabel(record, cardContentProperty, "내용 없음")} range={dateRangeAt(record.values[dateProperty.id])} start={start} days={periodDays} showTable={showTable} colorIndex={index % 4} disabled={disabled} onChangeRange={(from, to) => onUpdateRecord(record.id, dateProperty.id, `${toDateInput(from)}${to ? `..${toDateInput(to)}` : ""}`)} />)}{records.length === 0 && <div className="timeline-empty">조건에 맞는 항목이 없습니다. 검색이나 필터를 조정해 보세요.</div>}</div></DatabaseHorizontalScrollArea></div>;
}

function TimelineRow({ titleLabel, contentLabel, range, start, days, showTable, colorIndex, disabled, onChangeRange }: { titleLabel: string; contentLabel: string; range: { from?: Date; to?: Date }; start: Date; days: number; showTable: boolean; colorIndex: number; disabled: boolean; onChangeRange: (from: Date, to?: Date) => void }) {
  const fromIndex = range.from ? dayDistance(start, range.from) : -1;
  const toIndex = range.to ? dayDistance(start, range.to) : fromIndex;
  const first = Math.max(0, fromIndex);
  const last = Math.min(days - 1, toIndex);
  const visible = Boolean(range.from) && toIndex >= 0 && fromIndex < days;
  const continuesBefore = visible && fromIndex < 0;
  const continuesAfter = visible && toIndex >= days;
  const dayFormatter = new Intl.DateTimeFormat("ko-KR", { day: "numeric" });
  const fullDateFormatter = new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" });
  const rangeLength = range.from && range.to ? dayDistance(range.from, range.to) + 1 : 1;
  const rangeLabel = !range.from
    ? "날짜 없음"
    : !range.to || rangeLength <= 1
      ? dayFormatter.format(range.from)
      : rangeLength <= 2
        ? `${dayFormatter.format(range.from)} → ${dayFormatter.format(range.to)}`
        : `${fullDateFormatter.format(range.from)} → ${fullDateFormatter.format(range.to)}`;
  const beginResize = (event: ReactPointerEvent<HTMLSpanElement>, edge: "start" | "end") => {
    if (disabled || !range.from) return;
    event.preventDefault();
    event.stopPropagation();
    const track = event.currentTarget.closest<HTMLElement>(".timeline-track");
    if (!track) return;
    const pixelsPerDay = track.getBoundingClientRect().width / days;
    const startingX = event.clientX;
    const initialFrom = new Date(range.from);
    const initialTo = new Date(range.to ?? range.from);
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "ew-resize";
    const move = (moveEvent: PointerEvent) => {
      const delta = Math.round((moveEvent.clientX - startingX) / Math.max(pixelsPerDay, 1));
      if (edge === "start") {
        const from = new Date(initialFrom);
        from.setDate(from.getDate() + delta);
        onChangeRange(from > initialTo ? initialTo : from, initialTo);
      } else {
        const to = new Date(initialTo);
        to.setDate(to.getDate() + delta);
        onChangeRange(initialFrom, to < initialFrom ? initialFrom : to);
      }
    };
    const finish = () => {
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  return <div className="timeline-row">{showTable && <div className="timeline-row-label"><span className={`timeline-status-dot tone-${colorIndex}`} /><span><strong>{titleLabel}</strong><small>{rangeLabel}</small></span></div>}<div className="timeline-track" style={{ backgroundSize: `calc(100% / ${days}) 100%` }}>{continuesBefore && <span className="timeline-edge-marker is-before" aria-hidden="true"><ChevronLeft size={14} strokeWidth={2.25} /></span>}{visible && <div className={`timeline-bar tone-${colorIndex}${continuesBefore ? " continues-before" : ""}${continuesAfter ? " continues-after" : ""}`} style={{ left: `${(first / days) * 100}%`, width: `${((last - first + 1) / days) * 100}%` }} title={`${titleLabel}: ${contentLabel} · ${rangeLabel}`}>{!disabled && <span className="timeline-resize-handle is-start" role="separator" aria-label={`${titleLabel} 시작일 조절`} onPointerDown={(event) => beginResize(event, "start")} />}<span>{contentLabel}</span>{range.to && rangeLength > 3 && <small>{rangeLabel}</small>}{!disabled && <span className="timeline-resize-handle is-end" role="separator" aria-label={`${titleLabel} 종료일 조절`} onPointerDown={(event) => beginResize(event, "end")} />}</div>}{continuesAfter && <span className="timeline-edge-marker is-after" aria-hidden="true"><ChevronRight size={14} strokeWidth={2.25} /></span>}</div></div>;
}

function DatabaseTrash({ records, properties, disabled, onRestore }: { records: DatabaseRecord[]; properties: DatabaseProperty[]; disabled: boolean; onRestore: (recordId: string) => void }) {
  return <div className="database-trash"><div><Trash2 size={15} /><strong>휴지통</strong><span>삭제한 항목</span></div><ul>{records.map((record, index) => <li key={record.id}><span>{recordLabel(record, properties, index)}</span><button type="button" disabled={disabled} onClick={() => onRestore(record.id)}><RotateCcw size={14} /> 복원</button></li>)}</ul></div>;
}

function RecordDeleteConfirm({ recordName, onCancel, onConfirm }: { recordName: string; onCancel: () => void; onConfirm: () => void }) {
  return <ConfirmDialog ariaLabel="데이터베이스 항목 삭제" title="이 항목을 휴지통으로 옮길까요?" description={`“${recordName}” 항목은 나중에 이 데이터베이스의 휴지통에서 다시 복원할 수 있어요.`} confirmLabel="휴지통으로 이동" onCancel={onCancel} onConfirm={onConfirm} />;
}

function DatabaseDeleteConfirm({ databaseName, onCancel, onConfirm }: { databaseName: string; onCancel: () => void; onConfirm: () => void }) {
  return <ConfirmDialog ariaLabel="데이터베이스 삭제" title="데이터베이스를 삭제할까요?" description={`“${databaseName || "새 데이터베이스"}” 데이터베이스 블록과 안에 작성한 모든 항목이 현재 메모에서 제거됩니다.`} confirmLabel="데이터베이스 삭제" onCancel={onCancel} onConfirm={onConfirm} />;
}
