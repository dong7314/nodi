import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Globe2,
  Lock,
  Search,
  Share2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Select } from "./components/ui/select";
import { NodiUserAvatar } from "./NodiUserAvatar";
import { SidebarScrollOverlay } from "./SidebarScrollOverlay";
import type {
  NodiUser,
  PageShareMember,
  SharePermission,
} from "./sharing-store";

const permissionOptions = [
  { value: "edit", label: "편집 가능" },
  { value: "view", label: "보기만" },
];

type PageSharePanelProps = {
  pageTitle: string;
  pageLink: string;
  isPublic: boolean;
  members: PageShareMember[];
  registeredUsers: NodiUser[];
  onPublicChange: (isPublic: boolean) => void;
  onShare: (userId: string, permission: SharePermission) => void;
  onPermissionChange: (userId: string, permission: SharePermission) => void;
  onRemoveMember: (userId: string) => void;
  onCopy: () => void;
  onClose: () => void;
};

export function PageSharePanel({
  pageTitle,
  pageLink,
  isPublic,
  members,
  registeredUsers,
  onPublicChange,
  onShare,
  onPermissionChange,
  onRemoveMember,
  onCopy,
  onClose,
}: PageSharePanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const inviteRef = useRef<HTMLDivElement>(null);
  const sharedMemberListRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [permission, setPermission] = useState<SharePermission>("edit");
  const [openPermissionSelect, setOpenPermissionSelect] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const memberIds = useMemo(() => new Set(members.map((member) => member.userId)), [members]);
  const matchedUsers = useMemo(() => {
    if (!normalizedQuery) return [];
    return registeredUsers
      .filter((user) => !memberIds.has(user.id))
      .filter((user) => (
        user.name.toLocaleLowerCase().includes(normalizedQuery)
        || user.email.toLocaleLowerCase().includes(normalizedQuery)
      ))
      .slice(0, 5);
  }, [memberIds, normalizedQuery, registeredUsers]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest("[data-radix-popper-content-wrapper], .shadcn-select-content")) return;
      if (openPermissionSelect) {
        setOpenPermissionSelect(null);
        return;
      }
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (openPermissionSelect) {
        setOpenPermissionSelect(null);
        return;
      }
      if (normalizedQuery) {
        setQuery("");
        return;
      }
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [normalizedQuery, onClose, openPermissionSelect]);

  useEffect(() => {
    if (!normalizedQuery) return;
    const closeResultsOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || inviteRef.current?.contains(target)) return;
      if (target.closest("[data-radix-popper-content-wrapper], .shadcn-select-content")) return;
      setQuery("");
    };
    document.addEventListener("pointerdown", closeResultsOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeResultsOnOutsidePointer, true);
  }, [normalizedQuery]);

  return (
    <aside ref={panelRef} className="page-share-panel" role="dialog" aria-label="페이지 공유">
      <header>
        <span><Share2 size={17} /> 공유</span>
        <button type="button" aria-label="공유 닫기" onClick={onClose}><X size={17} /></button>
      </header>

      <div className="page-share-body">
        <section className="member-share-section" aria-labelledby="member-share-title">
          <div className="member-share-heading">
            <span>
              <strong id="member-share-title">Nodi 회원과 공유</strong>
              <small>가입된 사용자만 초대할 수 있어요.</small>
            </span>
            {members.length > 0 && <em>{members.length}명</em>}
          </div>

          <div ref={inviteRef} className="member-share-invite-wrap">
            <div className="member-share-invite">
              <label className="member-search-field">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="이름 또는 이메일 검색"
                  aria-label="Nodi 회원 검색"
                  aria-controls={normalizedQuery ? "member-search-results" : undefined}
                  aria-expanded={Boolean(normalizedQuery)}
                />
                {query && (
                  <button type="button" aria-label="검색어 지우기" onClick={() => setQuery("")}>
                    <X size={13} />
                  </button>
                )}
              </label>
              <Select
                value={permission}
                onValueChange={(value) => setPermission(value as SharePermission)}
                options={permissionOptions}
                ariaLabel="초대 권한"
                className="member-invite-permission"
                open={openPermissionSelect === "invite"}
                onOpenChange={(open) => setOpenPermissionSelect((current) => (
                  open ? "invite" : current === "invite" ? null : current
                ))}
              />
            </div>

            {normalizedQuery && (
              <div
                id="member-search-results"
                className="member-search-results"
                role="listbox"
                aria-label="검색된 Nodi 회원"
              >
                {matchedUsers.length > 0 ? matchedUsers.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => {
                      onShare(user.id, permission);
                      setQuery("");
                    }}
                  >
                    <NodiUserAvatar user={user} />
                    <span>
                      <strong>{user.name}</strong>
                      <small>{user.email}</small>
                    </span>
                    <UserPlus size={15} />
                  </button>
                )) : (
                  <p>일치하는 Nodi 회원이 없어요.</p>
                )}
              </div>
            )}
          </div>

          <div className="shared-member-scroll-shell sidebar-scroll-shell">
            <div
              ref={sharedMemberListRef}
              className={`shared-member-list sidebar-native-scroll ${members.length > 5 ? "is-scrollable" : ""}`}
            >
              {members.length > 0 ? members.map((member) => {
                const user = registeredUsers.find((candidate) => candidate.id === member.userId);
                if (!user) return null;
                return (
                  <div className="shared-member-row" key={member.userId}>
                    <NodiUserAvatar user={user} />
                    <span>
                      <strong>{user.name}</strong>
                      <small>{user.email}</small>
                    </span>
                    <Select
                      value={member.permission}
                      onValueChange={(value) => onPermissionChange(member.userId, value as SharePermission)}
                      options={permissionOptions}
                      ariaLabel={`${user.name} 공유 권한`}
                      className="shared-member-permission"
                      open={openPermissionSelect === `member:${member.userId}`}
                      onOpenChange={(open) => setOpenPermissionSelect((current) => {
                        const selectId = `member:${member.userId}`;
                        return open ? selectId : current === selectId ? null : current;
                      })}
                    />
                    <button
                      className="shared-member-remove"
                      type="button"
                      aria-label={`${user.name} 공유 해제`}
                      onClick={() => onRemoveMember(member.userId)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              }) : (
                <div className="shared-member-empty">
                  <Users size={17} />
                  <span><strong>아직 초대된 회원이 없어요.</strong><small>위 검색창에서 Nodi 회원을 찾아보세요.</small></span>
                </div>
              )}
            </div>
            <SidebarScrollOverlay targetRef={sharedMemberListRef} />
          </div>
        </section>

        <section className="link-share-section" aria-labelledby="link-share-title">
          <div className={`share-access-card ${isPublic ? "is-public" : ""}`}>
            <span className="share-access-icon">{isPublic ? <Globe2 size={17} /> : <Lock size={17} />}</span>
            <span className="share-access-copy">
              <strong id="link-share-title">{isPublic ? "웹 링크 공개" : "공개 링크 꺼짐"}</strong>
              <small>{isPublic ? "링크가 있는 모든 사람이 볼 수 있음" : members.length > 0 ? "초대한 Nodi 회원만 접근 가능" : "나만 볼 수 있음"}</small>
            </span>
            <button
              className="share-access-switch"
              type="button"
              role="switch"
              aria-label="페이지 공개 전환"
              aria-checked={isPublic}
              onClick={() => onPublicChange(!isPublic)}
            >
              <span />
            </button>
          </div>
          <p>“{pageTitle || "제목 없음"}” 페이지의 공개 링크입니다.</p>
          <div className="quick-link"><span>{pageLink}</span></div>
          <button className="copy-action" type="button" disabled={!isPublic} onClick={onCopy}>
            <Copy size={15} /> 공유 링크 복사
          </button>
          <small className="share-note">
            회원 공유는 현재 기기의 Nodi 공유 저장소에 반영됩니다. 인증 서버 연결 후 동일한 UI에서 실제 초대로 전환됩니다.
          </small>
        </section>
      </div>
    </aside>
  );
}
