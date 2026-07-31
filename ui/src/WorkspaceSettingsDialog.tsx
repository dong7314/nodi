import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  CheckCircle2,
  Clock3,
  FileJson2,
  FileText,
  KeyRound,
  LogOut,
  Moon,
  Plus,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import type { PartialBlock } from "@blocknote/core";
import {
  changeLocalPassword,
  persistRegistrationRequests,
  readRegistrationRequests,
  REGISTRATION_REQUESTS_CHANGED_EVENT,
  updateLocalAccountRegistrationStatus,
  type RegistrationRequest,
  type RegistrationRequestStatus,
} from "./account-store";
import { ConfirmDialog } from "./components/ui/confirm-dialog";
import { NODI_INITIAL_AVATAR_ICON, NodiUserAvatar } from "./NodiUserAvatar";
import { isPageIcon, PAGE_ICONS } from "./page-icons";
import type { NodiAvatarColor, NodiUser } from "./sharing-store";
import {
  cloneStarterPresets,
  createStarterPreset,
  MAX_STARTER_PRESETS,
  type StarterPreset,
} from "./starter-presets";

type SettingsTab = "account" | "theme" | "presets" | "registration";

type WorkspaceSettingsDialogProps = {
  user: NodiUser;
  theme: "light" | "dark";
  starterPresets: StarterPreset[];
  onThemeChange: (theme: "light" | "dark") => void;
  onStarterPresetsChange: (presets: StarterPreset[]) => void;
  onProfileChange: (profile: {
    name: string;
    avatarColor: NodiAvatarColor;
    avatarIcon?: string;
  }) => void;
  onLogout: () => void;
  onClose: () => void;
};

const avatarColors: NodiAvatarColor[] = ["purple", "blue", "green", "orange", "pink", "gray"];
const avatarIcons = ["", NODI_INITIAL_AVATAR_ICON, "✨", "🌿", "🌙", "📚", "🎯", "☕", "🪴", "🧩", "🚀"];
const MAX_PRESET_JSON_FILE_SIZE = 5 * 1024 * 1024;

type ImportedPresetJson = {
  title: string;
  blocks: PartialBlock[];
};

function parsePresetJson(value: unknown, fileName: string): ImportedPresetJson {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Nodi에서 내보낸 JSON 파일을 선택해 주세요.");
  }

  const payload = value as {
    title?: unknown;
    blocks?: unknown;
  };
  if (!Array.isArray(payload.blocks)) {
    throw new Error("페이지 블록 정보가 없는 JSON 파일입니다.");
  }
  if (payload.blocks.some((block) => !block || typeof block !== "object" || Array.isArray(block))) {
    throw new Error("페이지 블록 형식을 확인할 수 없습니다.");
  }

  const fileTitle = fileName.replace(/\.json$/i, "").trim();
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim().slice(0, 80)
    : fileTitle || "제목 없음";

  return {
    title,
    blocks: payload.blocks.length > 0
      ? payload.blocks as PartialBlock[]
      : [{ type: "paragraph", content: "" }],
  };
}

export function WorkspaceSettingsDialog({
  user,
  theme,
  starterPresets,
  onThemeChange,
  onStarterPresetsChange,
  onProfileChange,
  onLogout,
  onClose,
}: WorkspaceSettingsDialogProps) {
  const isAdmin = user.role === "admin";
  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const [draftName, setDraftName] = useState(user.name);
  const [avatarColor, setAvatarColor] = useState<NodiAvatarColor>(user.avatarColor);
  const [avatarIcon, setAvatarIcon] = useState(user.avatarIcon ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [passwordFeedback, setPasswordFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [registrationRequests, setRegistrationRequests] = useState(readRegistrationRequests);
  const [draftStarterPresets, setDraftStarterPresets] = useState(() => cloneStarterPresets(starterPresets));
  const [selectedStarterPresetId, setSelectedStarterPresetId] = useState<string | null>(
    starterPresets[0]?.id ?? null,
  );
  const [starterPresetsSaved, setStarterPresetsSaved] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [logoutConfirmationOpen, setLogoutConfirmationOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const closeWithAnimation = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    window.setTimeout(onClose, 150);
  }, [isClosing, onClose]);

  const pendingRequests = useMemo(
    () => registrationRequests
      .filter((request) => request.status === "pending")
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    [registrationRequests],
  );
  const decidedRequests = useMemo(
    () => registrationRequests
      .filter((request) => request.status !== "pending")
      .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
      .slice(0, 5),
    [registrationRequests],
  );

  const saveProfile = () => {
    const nextName = draftName.trim();
    if (!nextName) {
      nameInputRef.current?.focus();
      return;
    }
    onProfileChange({
      name: nextName,
      avatarColor,
      avatarIcon: avatarIcon || undefined,
    });
    closeWithAnimation();
  };

  const savePassword = async () => {
    setPasswordFeedback(null);
    if (nextPassword.length < 8) {
      setPasswordFeedback({ kind: "error", text: "새 비밀번호는 8자 이상 입력해 주세요." });
      return;
    }
    if (nextPassword !== passwordConfirmation) {
      setPasswordFeedback({ kind: "error", text: "새 비밀번호 확인이 일치하지 않습니다." });
      return;
    }
    setPasswordSaving(true);
    const result = await changeLocalPassword(currentPassword, nextPassword);
    setPasswordSaving(false);
    setPasswordFeedback({ kind: result.ok ? "success" : "error", text: result.message });
    if (result.ok) {
      setCurrentPassword("");
      setNextPassword("");
      setPasswordConfirmation("");
    }
  };

  const decideRegistration = (requestId: string, status: Exclude<RegistrationRequestStatus, "pending">) => {
    const decidedAt = new Date().toISOString();
    const targetRequest = registrationRequests.find((request) => request.id === requestId);
    const nextRequests = registrationRequests.map((request) => (
      request.id === requestId ? { ...request, status, decidedAt } : request
    ));
    setRegistrationRequests(nextRequests);
    persistRegistrationRequests(nextRequests);
    if (targetRequest) updateLocalAccountRegistrationStatus(targetRequest.email, status);
  };

  const saveStarterPresets = () => {
    const normalizedPresets: StarterPreset[] = draftStarterPresets.map((preset, index) => ({
      ...preset,
      name: preset.name.trim() || `프리셋 ${index + 1}`,
      icon: isPageIcon(preset.icon) ? preset.icon : "✨",
      pageTitle: preset.pageTitle.trim() || "제목 없음",
      blocks: preset.blocks.length > 0
        ? preset.blocks
        : [{ type: "paragraph", content: "" }] as PartialBlock[],
    }));
    setDraftStarterPresets(normalizedPresets);
    onStarterPresetsChange(normalizedPresets);
    setStarterPresetsSaved(true);
    window.setTimeout(() => setStarterPresetsSaved(false), 1400);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWithAnimation();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeWithAnimation]);

  useEffect(() => {
    const syncRegistrationRequests = () => setRegistrationRequests(readRegistrationRequests());
    window.addEventListener("storage", syncRegistrationRequests);
    window.addEventListener(REGISTRATION_REQUESTS_CHANGED_EVENT, syncRegistrationRequests);
    return () => {
      window.removeEventListener("storage", syncRegistrationRequests);
      window.removeEventListener(REGISTRATION_REQUESTS_CHANGED_EVENT, syncRegistrationRequests);
    };
  }, []);

  return createPortal(
    <div
      className={`workspace-settings-layer ${isClosing ? "is-closing" : ""}`}
      role="presentation"
    >
      <button
        type="button"
        className="workspace-settings-backdrop"
        aria-label="설정 바깥 영역 닫기"
        onClick={closeWithAnimation}
      />
      <section
        className={`workspace-settings-dialog ${isClosing ? "is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-settings-title"
      >
        <header>
          <div>
            <strong id="workspace-settings-title">설정</strong>
            <small>계정과 Nodi 사용 환경을 관리하세요.</small>
          </div>
          <button type="button" aria-label="설정 닫기" onClick={closeWithAnimation}><X size={17} /></button>
        </header>

        <div className="workspace-settings-layout">
          <nav className="workspace-settings-tabs" aria-label="설정 메뉴" role="tablist" aria-orientation="vertical">
            <section className="workspace-settings-profile">
              <NodiUserAvatar user={{ ...user, avatarColor, avatarIcon }} className="workspace-settings-avatar" />
              <span>
                <strong>{draftName.trim() || user.name}</strong>
                <small>{user.email}</small>
              </span>
            </section>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "account"}
              className={activeTab === "account" ? "is-active" : ""}
              onClick={() => setActiveTab("account")}
            >
              <UserRound size={16} />
              <span><strong>계정</strong><small>프로필과 비밀번호</small></span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "theme"}
              className={activeTab === "theme" ? "is-active" : ""}
              onClick={() => setActiveTab("theme")}
            >
              {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
              <span><strong>테마</strong><small>화면 모드 설정</small></span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "presets"}
              className={activeTab === "presets" ? "is-active" : ""}
              onClick={() => setActiveTab("presets")}
            >
              <Sparkles size={16} />
              <span><strong>시작 프리셋</strong><small>새 페이지 구성</small></span>
              <em>{draftStarterPresets.length}</em>
            </button>
            {isAdmin && (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "registration"}
                className={activeTab === "registration" ? "is-active" : ""}
                onClick={() => setActiveTab("registration")}
              >
                <ShieldCheck size={16} />
                <span><strong>회원가입 관리</strong><small>신규 사용자 승인</small></span>
                {pendingRequests.length > 0 && <em>{pendingRequests.length}</em>}
              </button>
            )}
          </nav>

          <main className="workspace-settings-content">
            {activeTab === "account" && (
              <AccountSettings
                user={user}
                draftName={draftName}
                avatarColor={avatarColor}
                avatarIcon={avatarIcon}
                nameInputRef={nameInputRef}
                currentPassword={currentPassword}
                nextPassword={nextPassword}
                passwordConfirmation={passwordConfirmation}
                passwordFeedback={passwordFeedback}
                passwordSaving={passwordSaving}
                onNameChange={setDraftName}
                onAvatarColorChange={setAvatarColor}
                onAvatarIconChange={setAvatarIcon}
                onCurrentPasswordChange={setCurrentPassword}
                onNextPasswordChange={setNextPassword}
                onPasswordConfirmationChange={setPasswordConfirmation}
                onSavePassword={savePassword}
                onSaveProfile={saveProfile}
              />
            )}
            {activeTab === "theme" && (
              <ThemeSettings theme={theme} onThemeChange={onThemeChange} />
            )}
            {activeTab === "presets" && (
              <StarterPresetSettings
                presets={draftStarterPresets}
                selectedPresetId={selectedStarterPresetId}
                onSelect={setSelectedStarterPresetId}
                onChange={(presetId, patch) => {
                  setStarterPresetsSaved(false);
                  setDraftStarterPresets((current) => current.map((preset) => (
                    preset.id === presetId ? { ...preset, ...patch } : preset
                  )));
                }}
                onAdd={() => {
                  if (draftStarterPresets.length >= MAX_STARTER_PRESETS) return;
                  const preset = createStarterPreset(draftStarterPresets.length + 1);
                  setDraftStarterPresets((current) => [...current, preset]);
                  setSelectedStarterPresetId(preset.id);
                  setStarterPresetsSaved(false);
                }}
                onDelete={(presetId) => {
                  const remainingPresets = draftStarterPresets.filter((preset) => preset.id !== presetId);
                  setDraftStarterPresets(remainingPresets);
                  if (selectedStarterPresetId === presetId) {
                    setSelectedStarterPresetId(remainingPresets[0]?.id ?? null);
                  }
                  setStarterPresetsSaved(false);
                }}
              />
            )}
            {activeTab === "registration" && isAdmin && (
              <RegistrationSettings
                pendingRequests={pendingRequests}
                decidedRequests={decidedRequests}
                onDecision={decideRegistration}
              />
            )}
          </main>
        </div>

        <footer>
          {activeTab === "account" && (
            <button
              type="button"
              className="workspace-settings-footer-logout"
              onClick={() => setLogoutConfirmationOpen(true)}
            >
              <LogOut size={14} /> 로그아웃
            </button>
          )}
          <button type="button" onClick={closeWithAnimation}>
            {activeTab === "account" ? "취소" : "닫기"}
          </button>
          {activeTab === "account" && (
            <button type="button" className="is-primary" onClick={saveProfile} disabled={!draftName.trim()}>
              프로필 저장
            </button>
          )}
          {activeTab === "presets" && (
            <button type="button" className="is-primary" onClick={saveStarterPresets}>
              {starterPresetsSaved ? "저장됨" : "프리셋 저장"}
            </button>
          )}
        </footer>
      </section>
      {logoutConfirmationOpen && (
        <ConfirmDialog
          ariaLabel="로그아웃"
          title="로그아웃할까요?"
          description="이 기기의 Nodi 계정 세션이 종료되고 게스트 모드로 전환됩니다. 로컬 메모는 그대로 유지됩니다."
          confirmLabel="로그아웃"
          onCancel={() => setLogoutConfirmationOpen(false)}
          onConfirm={() => {
            setLogoutConfirmationOpen(false);
            onLogout();
          }}
        />
      )}
    </div>,
    document.body,
  );
}

type AccountSettingsProps = {
  user: NodiUser;
  draftName: string;
  avatarColor: NodiAvatarColor;
  avatarIcon: string;
  nameInputRef: React.RefObject<HTMLInputElement | null>;
  currentPassword: string;
  nextPassword: string;
  passwordConfirmation: string;
  passwordFeedback: { kind: "success" | "error"; text: string } | null;
  passwordSaving: boolean;
  onNameChange: (value: string) => void;
  onAvatarColorChange: (value: NodiAvatarColor) => void;
  onAvatarIconChange: (value: string) => void;
  onCurrentPasswordChange: (value: string) => void;
  onNextPasswordChange: (value: string) => void;
  onPasswordConfirmationChange: (value: string) => void;
  onSavePassword: () => void;
  onSaveProfile: () => void;
};

function AccountSettings({
  user,
  draftName,
  avatarColor,
  avatarIcon,
  nameInputRef,
  currentPassword,
  nextPassword,
  passwordConfirmation,
  passwordFeedback,
  passwordSaving,
  onNameChange,
  onAvatarColorChange,
  onAvatarIconChange,
  onCurrentPasswordChange,
  onNextPasswordChange,
  onPasswordConfirmationChange,
  onSavePassword,
  onSaveProfile,
}: AccountSettingsProps) {
  return (
    <>
      <SettingsContentHeader
        icon={<UserRound size={18} />}
        title="계정 설정"
        description="다른 사용자에게 표시되는 프로필과 로그인 정보를 관리합니다."
      />
      <section className="workspace-settings-section">
        <div className="workspace-settings-section-heading">
          <span><strong>사용자 프로필</strong><small>페이지 공유와 댓글에 표시됩니다.</small></span>
        </div>
        <div className="workspace-avatar-editor">
          <NodiUserAvatar
            user={{ ...user, name: draftName || user.name, avatarColor, avatarIcon }}
            className="workspace-avatar-preview"
          />
          <div>
            <div className="workspace-avatar-icons" aria-label="사용자 프로필 선택">
              {avatarIcons.map((icon) => {
                const isAutomaticAvatar = icon === "";
                const isInitialAvatar = icon === NODI_INITIAL_AVATAR_ICON;

                return (
                  <button
                    type="button"
                    key={icon || "automatic"}
                    className={avatarIcon === icon ? "is-selected" : ""}
                    aria-label={
                      isAutomaticAvatar
                        ? "이름과 이메일로 자동 생성"
                        : isInitialAvatar
                          ? "이름 첫 글자 사용"
                          : `${icon} 아이콘`
                    }
                    aria-pressed={avatarIcon === icon}
                    onClick={() => onAvatarIconChange(icon)}
                  >
                    {isAutomaticAvatar || isInitialAvatar ? (
                      <NodiUserAvatar
                        user={{
                          ...user,
                          name: draftName || user.name,
                          avatarColor,
                          avatarIcon: isInitialAvatar ? NODI_INITIAL_AVATAR_ICON : undefined,
                        }}
                        className="workspace-avatar-auto-option"
                      />
                    ) : icon}
                  </button>
                );
              })}
            </div>
            <div className="workspace-avatar-colors" aria-label="사용자 프로필 색상">
              {avatarColors.map((color) => (
                <button
                  type="button"
                  key={color}
                  data-color={color}
                  className={avatarColor === color ? "is-selected" : ""}
                  aria-label={`${color} 색상`}
                  aria-pressed={avatarColor === color}
                  onClick={() => onAvatarColorChange(color)}
                >
                  {avatarColor === color && <Check size={11} />}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="workspace-settings-field">
          <span>이름</span>
          <input
            ref={nameInputRef}
            value={draftName}
            maxLength={40}
            onChange={(event) => onNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSaveProfile();
            }}
          />
        </label>
        <label className="workspace-settings-field">
          <span>이메일</span>
          <input value={user.email} readOnly disabled />
        </label>
      </section>

      <section className="workspace-settings-section">
        <div className="workspace-settings-section-heading">
          <KeyRound size={15} />
          <span><strong>비밀번호 변경</strong><small>처음 설정하는 경우 현재 비밀번호는 비워둘 수 있습니다.</small></span>
        </div>
        <div className="workspace-password-fields">
          <label className="workspace-settings-field">
            <span>현재 비밀번호</span>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => onCurrentPasswordChange(event.target.value)}
              placeholder="현재 비밀번호"
            />
          </label>
          <label className="workspace-settings-field">
            <span>새 비밀번호</span>
            <input
              type="password"
              autoComplete="new-password"
              value={nextPassword}
              onChange={(event) => onNextPasswordChange(event.target.value)}
              placeholder="8자 이상"
            />
          </label>
          <label className="workspace-settings-field">
            <span>비밀번호 확인</span>
            <input
              type="password"
              autoComplete="new-password"
              value={passwordConfirmation}
              onChange={(event) => onPasswordConfirmationChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSavePassword();
              }}
              placeholder="새 비밀번호 다시 입력"
            />
          </label>
        </div>
        <div className="workspace-password-actions">
          {passwordFeedback && (
            <span className={passwordFeedback.kind === "success" ? "is-success" : "is-error"}>
              {passwordFeedback.kind === "success" ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              {passwordFeedback.text}
            </span>
          )}
          <button
            type="button"
            onClick={onSavePassword}
            disabled={passwordSaving || !nextPassword || !passwordConfirmation}
          >
            {passwordSaving ? "변경 중…" : "비밀번호 변경"}
          </button>
        </div>
      </section>

    </>
  );
}

function ThemeSettings({
  theme,
  onThemeChange,
}: {
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
}) {
  return (
    <>
      <SettingsContentHeader
        icon={theme === "dark" ? <Moon size={18} /> : <Sun size={18} />}
        title="테마 설정"
        description="이 기기에서 사용할 Nodi의 화면 모드를 선택합니다."
      />
      <section className="workspace-settings-section">
        <div className="workspace-theme-options">
          <button
            type="button"
            className={theme === "light" ? "is-selected" : ""}
            aria-pressed={theme === "light"}
            onClick={() => onThemeChange("light")}
          >
            <span className="workspace-theme-preview is-light"><Sun size={18} /></span>
            <span><strong>라이트</strong><small>밝고 선명한 기본 화면</small></span>
            {theme === "light" && <Check size={14} />}
          </button>
          <button
            type="button"
            className={theme === "dark" ? "is-selected" : ""}
            aria-pressed={theme === "dark"}
            onClick={() => onThemeChange("dark")}
          >
            <span className="workspace-theme-preview is-dark"><Moon size={18} /></span>
            <span><strong>다크</strong><small>눈의 피로를 줄인 어두운 화면</small></span>
            {theme === "dark" && <Check size={14} />}
          </button>
        </div>
      </section>
    </>
  );
}

function StarterPresetSettings({
  presets,
  selectedPresetId,
  onSelect,
  onChange,
  onAdd,
  onDelete,
}: {
  presets: StarterPreset[];
  selectedPresetId: string | null;
  onSelect: (presetId: string) => void;
  onChange: (presetId: string, patch: Partial<StarterPreset>) => void;
  onAdd: () => void;
  onDelete: (presetId: string) => void;
}) {
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [importFeedback, setImportFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    setImportFeedback(null);
    setIsDraggingFile(false);
  }, [selectedPresetId]);

  const importJsonFile = async (file: File) => {
    if (!selectedPreset) return;
    setImportFeedback(null);
    if (!file.name.toLowerCase().endsWith(".json")) {
      setImportFeedback({ kind: "error", text: "JSON 파일만 업로드할 수 있습니다." });
      return;
    }
    if (file.size > MAX_PRESET_JSON_FILE_SIZE) {
      setImportFeedback({ kind: "error", text: "5MB 이하의 JSON 파일을 선택해 주세요." });
      return;
    }

    try {
      const parsed = parsePresetJson(JSON.parse(await file.text()) as unknown, file.name);
      const currentName = selectedPreset.name.trim();
      const currentPageTitle = selectedPreset.pageTitle.trim();
      const hasCustomName = Boolean(currentName) && !/^새 프리셋 \d+$/.test(currentName);
      const hasCustomPageTitle = Boolean(currentPageTitle) && currentPageTitle !== "제목 없음";
      onChange(selectedPreset.id, {
        name: hasCustomName ? currentName : parsed.title.slice(0, 24),
        pageTitle: hasCustomPageTitle ? currentPageTitle : parsed.title,
        blocks: parsed.blocks,
        sourceFileName: file.name,
      });
      setImportFeedback({
        kind: "success",
        text: `“${parsed.title}”의 블록 ${parsed.blocks.length}개를 불러왔습니다.`,
      });
    } catch (error) {
      setImportFeedback({
        kind: "error",
        text: error instanceof Error ? error.message : "JSON 파일을 불러오지 못했습니다.",
      });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <>
      <SettingsContentHeader
        icon={<Sparkles size={18} />}
        title="시작 프리셋"
        description="새 페이지에서 바로 사용할 구성과 블록 내용을 최대 5개까지 만들 수 있습니다."
      />
      <section className="workspace-settings-section workspace-preset-section">
        <div className="workspace-preset-toolbar">
          <span>
            <strong>내 프리셋</strong>
            <small>{presets.length}/{MAX_STARTER_PRESETS}</small>
          </span>
          <button
            type="button"
            onClick={onAdd}
            disabled={presets.length >= MAX_STARTER_PRESETS}
          >
            <Plus size={14} /> 프리셋 추가
          </button>
        </div>

        {presets.length > 0 ? (
          <div className="workspace-preset-layout">
            <div className="workspace-preset-list" role="tablist" aria-label="시작 프리셋 목록">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className={`workspace-preset-list-item ${selectedPreset?.id === preset.id ? "is-selected" : ""}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selectedPreset?.id === preset.id}
                    onClick={() => onSelect(preset.id)}
                  >
                    <span>{preset.icon || "✨"}</span>
                    <span>
                      <strong title={preset.name.trim() || "이름 없는 프리셋"}>
                        {preset.name.trim() || "이름 없는 프리셋"}
                      </strong>
                      <small title={preset.pageTitle.trim() || "제목 없음"}>
                        {preset.pageTitle.trim() || "제목 없음"}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`${preset.name || "프리셋"} 삭제`}
                    onClick={() => onDelete(preset.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>

            {selectedPreset && (
              <div className="workspace-preset-editor">
                <section className="workspace-preset-icon-section">
                  <span>
                    <strong>아이콘</strong>
                    <small>Nodi에서 제공하는 아이콘 중 하나를 선택하세요.</small>
                  </span>
                  <div className="workspace-preset-icon-grid" role="group" aria-label="프리셋 아이콘 선택">
                    {PAGE_ICONS.map((icon) => (
                      <button
                        type="button"
                        key={icon}
                        className={selectedPreset.icon === icon ? "is-selected" : ""}
                        aria-label={`${icon} 아이콘`}
                        aria-pressed={selectedPreset.icon === icon}
                        onClick={() => onChange(selectedPreset.id, { icon })}
                      >
                        {icon}
                        {selectedPreset.icon === icon && <Check size={10} />}
                      </button>
                    ))}
                  </div>
                </section>
                <div className="workspace-preset-meta">
                  <label>
                    <span>표시 이름</span>
                    <input
                      value={selectedPreset.name}
                      maxLength={24}
                      aria-label="프리셋 표시 이름"
                      onChange={(event) => onChange(selectedPreset.id, { name: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>적용할 페이지 제목</span>
                    <input
                      value={selectedPreset.pageTitle}
                      maxLength={80}
                      aria-label="프리셋 페이지 제목"
                      onChange={(event) => onChange(selectedPreset.id, { pageTitle: event.target.value })}
                    />
                  </label>
                </div>
                <div className="workspace-preset-content-heading">
                  <span>
                    <strong>페이지 내용</strong>
                    <small>Nodi 페이지의 ‘JSON 내보내기’ 파일을 업로드해 내용을 구성하세요.</small>
                  </span>
                </div>
                <div
                  className={`workspace-preset-json-dropzone ${isDraggingFile ? "is-dragging" : ""}`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setIsDraggingFile(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    setIsDraggingFile(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setIsDraggingFile(false);
                    const file = event.dataTransfer.files[0];
                    if (file) void importJsonFile(file);
                  }}
                >
                  <span className="workspace-preset-json-icon"><FileJson2 size={22} /></span>
                  <span className="workspace-preset-json-copy">
                    <strong>{selectedPreset.sourceFileName ?? "Nodi JSON 파일을 선택하세요"}</strong>
                    <small>
                      {selectedPreset.sourceFileName
                        ? `${selectedPreset.blocks.length}개 블록이 프리셋에 연결되어 있습니다.`
                        : `현재 기본 내용 ${selectedPreset.blocks.length}개 블록 · 최대 5MB`}
                    </small>
                  </span>
                  <button type="button" onClick={() => fileInputRef.current?.click()}>
                    <Upload size={14} />
                    {selectedPreset.sourceFileName ? "JSON 교체" : "JSON 업로드"}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    aria-label="프리셋 JSON 파일"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importJsonFile(file);
                    }}
                  />
                </div>
                {importFeedback && (
                  <p className={`workspace-preset-import-feedback is-${importFeedback.kind}`} role="status">
                    {importFeedback.kind === "success" ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                    {importFeedback.text}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="workspace-preset-empty">
            <FileText size={21} />
            <strong>아직 시작 프리셋이 없습니다.</strong>
            <small>프리셋을 추가하면 새 페이지 하단의 시작 바에서 선택할 수 있어요.</small>
            <button type="button" onClick={onAdd}><Plus size={14} /> 첫 프리셋 만들기</button>
          </div>
        )}
      </section>
    </>
  );
}

function RegistrationSettings({
  pendingRequests,
  decidedRequests,
  onDecision,
}: {
  pendingRequests: RegistrationRequest[];
  decidedRequests: RegistrationRequest[];
  onDecision: (requestId: string, status: "approved" | "rejected") => void;
}) {
  return (
    <>
      <SettingsContentHeader
        icon={<ShieldCheck size={18} />}
        title="회원가입 관리"
        description="관리자가 승인한 사용자만 Nodi 계정을 만들 수 있습니다."
      />
      <section className="workspace-registration-policy">
        <span><ShieldCheck size={17} /></span>
        <div><strong>관리자 승인 필수</strong><small>새로운 가입 요청은 승인 전까지 Nodi에 로그인할 수 없습니다.</small></div>
        <em>사용 중</em>
      </section>
      <section className="workspace-settings-section">
        <div className="workspace-settings-section-heading">
          <Clock3 size={15} />
          <span><strong>승인 대기</strong><small>{pendingRequests.length}개의 가입 요청이 기다리고 있습니다.</small></span>
        </div>
        {pendingRequests.length > 0 ? (
          <div className="workspace-registration-list">
            {pendingRequests.map((request) => (
              <article key={request.id}>
                <span>{request.name.trim().charAt(0) || "N"}</span>
                <div>
                  <strong>{request.name}</strong>
                  <small>{request.email} · {formatRequestDate(request.requestedAt)}</small>
                </div>
                <button type="button" onClick={() => onDecision(request.id, "rejected")}>거절</button>
                <button type="button" className="is-approve" onClick={() => onDecision(request.id, "approved")}>승인</button>
              </article>
            ))}
          </div>
        ) : (
          <div className="workspace-registration-empty">
            <CheckCircle2 size={20} />
            <strong>대기 중인 가입 요청이 없습니다.</strong>
            <small>새 요청이 들어오면 이곳에서 바로 승인하거나 거절할 수 있어요.</small>
          </div>
        )}
      </section>
      {decidedRequests.length > 0 && (
        <section className="workspace-settings-section">
          <div className="workspace-settings-section-heading">
            <span><strong>최근 처리 내역</strong><small>최근 승인 및 거절 결과입니다.</small></span>
          </div>
          <div className="workspace-registration-history">
            {decidedRequests.map((request) => (
              <div key={request.id}>
                <span>{request.name}<small>{request.email}</small></span>
                <em className={request.status === "approved" ? "is-approved" : "is-rejected"}>
                  {request.status === "approved" ? "승인됨" : "거절됨"}
                </em>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function SettingsContentHeader({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <header className="workspace-settings-content-header">
      <span>{icon}</span>
      <div><h2>{title}</h2><p>{description}</p></div>
    </header>
  );
}

function formatRequestDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "날짜 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
