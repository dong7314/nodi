import { ArrowRight, FileText, Settings2, Share2, UserPlus, Users } from "lucide-react";
import type { StoredPages } from "./page-store";
import type { NodiUser, StoredPageShares } from "./sharing-store";

type SharedPagesViewProps = {
  pages: StoredPages;
  pageShares: StoredPageShares;
  registeredUsers: NodiUser[];
  currentUser: NodiUser;
  onOpenPage: (pageId: string) => void;
  onManageShare: (pageId: string) => void;
};

export function SharedPagesView({
  pages,
  pageShares,
  registeredUsers,
  currentUser,
  onOpenPage,
  onManageShare,
}: SharedPagesViewProps) {
  const sharedRecords = Object.values(pageShares)
    .filter((record) => record.ownerId === currentUser.id && record.members.length > 0)
    .map((record) => ({ record, page: pages[record.pageId] }))
    .filter((entry) => entry.page && !entry.page.archived)
    .sort((first, second) => second.record.updatedAt.localeCompare(first.record.updatedAt));
  const sharedMemberIds = new Set(sharedRecords.flatMap(({ record }) => record.members.map((member) => member.userId)));

  return (
    <section className="shared-pages-view" aria-labelledby="shared-pages-title">
      <header className="shared-pages-hero">
        <span className="shared-pages-hero-icon"><Share2 size={21} /></span>
        <div>
          <span>Nodi 멤버 협업</span>
          <h1 id="shared-pages-title">공유 페이지</h1>
          <p>가입된 Nodi 회원에게 공유한 페이지와 권한을 한곳에서 관리하세요.</p>
        </div>
        <div className="shared-pages-summary" aria-label="공유 요약">
          <span><strong>{sharedRecords.length}</strong><small>공유 페이지</small></span>
          <i aria-hidden="true" />
          <span><strong>{sharedMemberIds.size}</strong><small>함께하는 회원</small></span>
        </div>
      </header>

      <div className="shared-pages-section-heading">
        <span><Users size={17} /></span>
        <div><strong>내가 공유한 페이지</strong><small>회원별 보기·편집 권한을 관리할 수 있어요.</small></div>
      </div>

      {sharedRecords.length > 0 ? (
        <div className="shared-page-grid">
          {sharedRecords.map(({ record, page }) => {
            const members = record.members
              .map((member) => ({
                ...member,
                user: registeredUsers.find((candidate) => candidate.id === member.userId),
              }))
              .filter((member) => Boolean(member.user));
            return (
              <article className="shared-page-card" key={record.pageId}>
                <button className="shared-page-open" type="button" onClick={() => onOpenPage(record.pageId)}>
                  <span className="shared-page-icon">{page.settings.icon || <FileText size={18} />}</span>
                  <span className="shared-page-copy">
                    <strong>{page.title || "제목 없음"}</strong>
                    <small>{members.length}명의 Nodi 회원과 공유 중</small>
                  </span>
                  <ArrowRight size={17} />
                </button>
                <div className="shared-page-members">
                  <div className="shared-page-avatars" aria-label={`공유 회원 ${members.length}명`}>
                    {members.slice(0, 4).map(({ user }) => user && (
                      <span key={user.id} data-color={user.avatarColor} title={`${user.name} · ${user.email}`}>
                        {user.name.charAt(0)}
                      </span>
                    ))}
                    {members.length > 4 && <em>+{members.length - 4}</em>}
                  </div>
                  <span>{members.some((member) => member.permission === "edit") ? "편집 권한 포함" : "보기 전용"}</span>
                  <button type="button" onClick={() => onManageShare(record.pageId)}>
                    <Settings2 size={14} /> 공유 관리
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="shared-pages-empty">
          <span><UserPlus size={22} /></span>
          <strong>아직 공유한 페이지가 없어요.</strong>
          <p>페이지 오른쪽 위의 공유 버튼에서 Nodi 회원을 초대하면 이곳에 표시됩니다.</p>
        </div>
      )}
    </section>
  );
}
