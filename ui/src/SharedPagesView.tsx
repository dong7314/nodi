import {
  ArrowUpRight,
  Eye,
  FileText,
  Inbox,
  MessageCircle,
  PencilLine,
  Settings2,
  UserPlus,
  Users,
} from "lucide-react";
import { NodiUserAvatar } from "./NodiUserAvatar";
import type { StoredPages } from "./page-store";
import type {
  NodiUser,
  PageShareRecord,
  SharePermission,
  StoredPageShares,
} from "./sharing-store";

type SharedPagesViewProps = {
  pages: StoredPages;
  pageShares: StoredPageShares;
  registeredUsers: NodiUser[];
  currentUser: NodiUser;
  commentCounts: Record<string, number>;
  onOpenPage: (pageId: string) => void;
  onManageShare: (pageId: string) => void;
};

export function SharedPagesView({
  pages,
  pageShares,
  registeredUsers,
  currentUser,
  commentCounts,
  onOpenPage,
  onManageShare,
}: SharedPagesViewProps) {
  const ownedSharedRecords = Object.values(pageShares)
    .filter((record) => record.ownerId === currentUser.id && record.members.length > 0)
    .map((record) => ({ record, page: pages[record.pageId] }))
    .filter((entry) => entry.page && !entry.page.archived)
    .sort((first, second) => second.record.updatedAt.localeCompare(first.record.updatedAt));
  const receivedSharedRecords = Object.values(pageShares)
    .filter((record) => (
      record.ownerId !== currentUser.id
      && record.members.some((member) => member.userId === currentUser.id)
    ))
    .map((record) => ({
      record,
      page: pages[record.pageId],
      permission: record.members.find((member) => member.userId === currentUser.id)?.permission ?? "view",
    }))
    .filter((entry) => entry.page && !entry.page.archived)
    .sort((first, second) => second.record.updatedAt.localeCompare(first.record.updatedAt));
  const totalSharedPageCount = ownedSharedRecords.length + receivedSharedRecords.length;

  const renderCommentCount = (pageId: string) => (
    (commentCounts[pageId] ?? 0) > 0 && (
      <span className="shared-page-comment-count">
        <MessageCircle size={13} /> 댓글 {commentCounts[pageId]}
      </span>
    )
  );

  return (
    <section className="shared-pages-view" aria-labelledby="shared-pages-title">
      <header className="shared-pages-hero">
        <div className="shared-pages-hero-copy">
          <span>Nodi 멤버 협업</span>
          <h1 id="shared-pages-title">공유 페이지</h1>
          <p>내가 공유한 페이지와 Nodi 회원에게 공유받은 페이지를 한곳에서 확인하세요.</p>
        </div>
        <div className="shared-pages-summary" aria-label="공유 요약">
          <span><strong>{totalSharedPageCount}</strong><small>전체 공유</small></span>
          <i aria-hidden="true" />
          <span><strong>{receivedSharedRecords.length}</strong><small>공유받음</small></span>
        </div>
      </header>

      <div className="shared-pages-section-heading">
        <span><Users size={17} /></span>
        <div><strong>내가 공유한 페이지</strong><small>회원별 보기·편집 권한을 관리할 수 있어요.</small></div>
      </div>

      {ownedSharedRecords.length > 0 ? (
        <div className="shared-page-grid">
          {ownedSharedRecords.map(({ record, page }) => {
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
                  <span className="shared-page-open-affordance" aria-hidden="true">
                    <span>열기</span><ArrowUpRight size={15} />
                  </span>
                </button>
                <div className="shared-page-members">
                  <div className="shared-page-avatars" aria-label={`공유 회원 ${members.length}명`}>
                    {members.slice(0, 4).map(({ user }) => user && (
                      <NodiUserAvatar
                        key={user.id}
                        user={user}
                        className="shared-page-avatar"
                      />
                    ))}
                    {members.length > 4 && <em>+{members.length - 4}</em>}
                  </div>
                  <span>{members.some((member) => member.permission === "edit") ? "편집 권한 포함" : "보기 전용"}</span>
                  {renderCommentCount(record.pageId)}
                  <button type="button" onClick={() => onManageShare(record.pageId)}>
                    <Settings2 size={14} /> 공유 관리
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="shared-pages-empty is-compact">
          <span><UserPlus size={22} /></span>
          <strong>아직 공유한 페이지가 없어요.</strong>
          <p>페이지 오른쪽 위의 공유 버튼에서 Nodi 회원을 초대하면 이곳에 표시됩니다.</p>
        </div>
      )}

      <div className="shared-pages-section-heading is-received">
        <span><Inbox size={17} /></span>
        <div><strong>나에게 공유된 페이지</strong><small>다른 Nodi 회원이 초대한 페이지를 확인할 수 있어요.</small></div>
      </div>

      {receivedSharedRecords.length > 0 ? (
        <div className="shared-page-grid">
          {receivedSharedRecords.map(({ record, page, permission }) => (
            <ReceivedSharedPageCard
              key={record.pageId}
              record={record}
              page={page}
              owner={registeredUsers.find((user) => user.id === record.ownerId)}
              permission={permission}
              commentCount={commentCounts[record.pageId] ?? 0}
              onOpenPage={onOpenPage}
            />
          ))}
        </div>
      ) : (
        <div className="shared-pages-empty is-compact is-received">
          <span><Inbox size={22} /></span>
          <strong>아직 공유받은 페이지가 없어요.</strong>
          <p>다른 Nodi 회원이 이 계정을 초대하면 공유받은 페이지가 이곳에 표시됩니다.</p>
        </div>
      )}
    </section>
  );
}

type ReceivedSharedPageCardProps = {
  record: PageShareRecord;
  page: StoredPages[string];
  owner?: NodiUser;
  permission: SharePermission;
  commentCount: number;
  onOpenPage: (pageId: string) => void;
};

function ReceivedSharedPageCard({
  record,
  page,
  owner,
  permission,
  commentCount,
  onOpenPage,
}: ReceivedSharedPageCardProps) {
  return (
    <article className="shared-page-card is-received">
      <button className="shared-page-open" type="button" onClick={() => onOpenPage(record.pageId)}>
        <span className="shared-page-icon">{page.settings.icon || <FileText size={18} />}</span>
        <span className="shared-page-copy">
          <strong>{page.title || "제목 없음"}</strong>
          <small>공유받은 페이지</small>
        </span>
        <span className="shared-page-open-affordance" aria-hidden="true">
          <span>열기</span><ArrowUpRight size={15} />
        </span>
      </button>
      <div className="shared-page-members">
        <span className="shared-page-owner">
          {owner ? (
            <NodiUserAvatar user={owner} className="shared-page-owner-avatar" />
          ) : (
            <i className="shared-page-owner-avatar is-fallback" aria-hidden="true">
              {(record.ownerName || "N").trim().slice(0, 1)}
            </i>
          )}
          <span>{record.ownerName || "Nodi 회원"}님이 공유</span>
        </span>
        <span className={`shared-page-permission is-${permission}`}>
          {permission === "edit" ? <PencilLine size={13} /> : <Eye size={13} />}
          {permission === "edit" ? "편집 가능" : "보기 전용"}
        </span>
        {commentCount > 0 && (
          <span className="shared-page-comment-count">
            <MessageCircle size={13} /> 댓글 {commentCount}
          </span>
        )}
      </div>
    </article>
  );
}
