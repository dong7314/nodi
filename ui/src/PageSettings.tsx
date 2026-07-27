import { useEffect, useRef, useState } from "react";
import { CalendarDays, Check, CircleDotDashed, Columns3, Eye, EyeOff, Globe2, Lock, Palette, Settings2, ShieldCheck, Tags, Type, Unlock, X } from "lucide-react";
import { DatePicker } from "./components/ui/date-picker";
import { Select } from "./components/ui/select";
import { TagPicker } from "./TagPicker";
import { DEFAULT_TAG_OPTIONS } from "./types";

export type CoverTheme = "aurora" | "sunset" | "ocean" | "paper";

export type PageSettings = {
  icon: string;
  cover: CoverTheme;
  fullWidth: boolean;
  smallText: boolean;
  lockPage: boolean;
  publicAccess: boolean;
  showProperties: boolean;
  status: "초안" | "진행 중" | "완료";
  tags: string[];
  date: string;
};

type PageSettingsPanelProps = {
  settings: PageSettings;
  onChange: (settings: PageSettings) => void;
  onClose: () => void;
};

const icons = [
  "✦", "📝", "🌿", "💡", "📚", "☀️", "🎯", "🪄",
  "📄", "📌", "🗂️", "✅", "📅", "🚀", "💬", "🔖",
  "🧭", "🧠", "🎨", "💻", "📊", "🏠", "❤️", "⭐",
];
const covers: { id: CoverTheme; label: string }[] = [
  { id: "aurora", label: "오로라" },
  { id: "sunset", label: "노을" },
  { id: "ocean", label: "파도" },
  { id: "paper", label: "종이" },
];
const pageStatusOptions = [
  { value: "초안", label: "초안", className: "status-waiting" },
  { value: "진행 중", label: "진행 중", className: "status-progress" },
  { value: "완료", label: "완료", className: "status-done" },
];

export function PageSettingsPanel({ settings, onChange, onClose }: PageSettingsPanelProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [openPropertyMenu, setOpenPropertyMenu] = useState<"status" | "tags" | "date" | null>(null);
  const isClosingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const update = <Key extends keyof PageSettings>(key: Key, value: PageSettings[Key]) => onChange({ ...settings, [key]: value });
  const changePropertyMenu = (menu: "status" | "tags" | "date", open: boolean) => {
    setOpenPropertyMenu((current) => open ? menu : current === menu ? null : current);
  };
  const closeWithAnimation = () => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setOpenPropertyMenu(null);
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, 180);
  };

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
    if (!openPropertyMenu) return;
    const closePropertyMenuOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) {
        setOpenPropertyMenu(null);
        return;
      }
      const activeContentSelector = openPropertyMenu === "status" ? ".shadcn-select-content" : openPropertyMenu === "tags" ? ".tag-picker-menu" : ".shadcn-date-content";
      const activeTrigger = target.closest(`[data-page-property-menu="${openPropertyMenu}"] button`);
      if (target.closest(activeContentSelector) || activeTrigger) return;
      setOpenPropertyMenu(null);
    };
    document.addEventListener("pointerdown", closePropertyMenuOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closePropertyMenuOnOutsidePointer, true);
  }, [openPropertyMenu]);

  return (
    <div className={`settings-layer ${isClosing ? "is-closing" : ""}`} role="presentation" onMouseDown={closeWithAnimation}>
      <aside className={`page-settings-panel ${isClosing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-label="페이지 설정" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-panel-head"><span><Settings2 size={18} /> 페이지 설정</span><button type="button" aria-label="페이지 설정 닫기" onClick={closeWithAnimation}><X size={18} /></button></header>

        <div className="page-settings-scroll">
          <section className="setting-section">
            <label>아이콘</label>
            <div className="icon-grid">{icons.map((icon) => <button type="button" key={icon} className={settings.icon === icon ? "selected" : ""} onClick={() => update("icon", icon)}>{icon}{settings.icon === icon && <Check size={12} />}</button>)}</div>
          </section>

          <section className="setting-section">
            <label><Palette size={15} /> 커버</label>
            <div className="cover-options">{covers.map((cover) => <button type="button" key={cover.id} className={`cover-choice cover-choice--${cover.id} ${settings.cover === cover.id ? "selected" : ""}`} onClick={() => update("cover", cover.id)}><span>{cover.label}</span>{settings.cover === cover.id && <Check size={13} />}</button>)}</div>
          </section>

          <section className="setting-section">
            <label>페이지 속성</label>
            <div className="page-setting-field" data-page-property-menu="status"><span><CircleDotDashed size={14} /> 상태</span><Select open={openPropertyMenu === "status"} onOpenChange={(open) => changePropertyMenu("status", open)} value={settings.status} onValueChange={(value) => update("status", value as PageSettings["status"])} options={pageStatusOptions} ariaLabel="페이지 상태" side="bottom" align="end" collisionPadding={16} contentClassName="page-settings-status-menu" className={`status-select page-settings-status-trigger ${settings.status === "초안" ? "status-waiting" : settings.status === "진행 중" ? "status-progress" : "status-done"}`} /></div>
            <div className="page-setting-field is-tags" data-page-property-menu="tags"><span><Tags size={14} /> 태그</span><TagPicker open={openPropertyMenu === "tags"} onOpenChange={(open) => changePropertyMenu("tags", open)} value={settings.tags} options={DEFAULT_TAG_OPTIONS} onChange={(tags) => update("tags", tags)} compact align="end" collisionPadding={16} /></div>
            <div className="page-setting-field" data-page-property-menu="date"><span><CalendarDays size={14} /> 날짜</span><DatePicker open={openPropertyMenu === "date"} onOpenChange={(open) => changePropertyMenu("date", open)} compact side="left" align="center" collisionPadding={16} value={settings.date} onChange={(date) => update("date", date)} ariaLabel="페이지 날짜" /></div>
          </section>

          <section className="setting-section setting-toggles">
            <Toggle label="전체 너비" detail="콘텐츠 영역을 넓게 표시" icon={<Columns3 size={16} />} checked={settings.fullWidth} onChange={(checked) => update("fullWidth", checked)} />
            <Toggle label="작은 텍스트" detail="본문 글자 크기를 조금 줄임" icon={<Type size={16} />} checked={settings.smallText} onChange={(checked) => update("smallText", checked)} />
            <Toggle label="속성 표시" detail="제목 아래의 페이지 속성" icon={settings.showProperties ? <Eye size={16} /> : <EyeOff size={16} />} checked={settings.showProperties} onChange={(checked) => update("showProperties", checked)} />
            <Toggle label="페이지 잠금" detail="본문과 데이터베이스 편집 방지" icon={settings.lockPage ? <Lock size={16} /> : <Unlock size={16} />} checked={settings.lockPage} onChange={(checked) => update("lockPage", checked)} />
            <Toggle label="페이지 공유" detail={settings.publicAccess ? "링크가 있는 사람에게 공개" : "나만 볼 수 있음"} icon={settings.publicAccess ? <Globe2 size={16} /> : <ShieldCheck size={16} />} checked={settings.publicAccess} onChange={(checked) => update("publicAccess", checked)} />
          </section>
        </div>
      </aside>
    </div>
  );
}

function Toggle({ label, detail, icon, checked, onChange }: { label: string; detail: string; icon: React.ReactNode; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="setting-toggle"><span className="setting-toggle-icon">{icon}</span><span className="setting-toggle-copy"><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="toggle-track" /></label>;
}
