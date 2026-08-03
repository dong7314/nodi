import type { PartialBlock } from "@blocknote/core";
import { apiRequest, apiWebSocketURL } from "./api-client";
import type { PageSettings } from "./PageSettings";
import type { LocalAuthUser, LocalAvatarColor, RegistrationRequest } from "./account-store";
import type { StoredFolder, StoredPage } from "./page-store";
import type { SharePermission } from "./sharing-store";
import type { StarterPreset } from "./starter-presets";
import type { TagOption } from "./types";

export type ServerPermission = "owner" | SharePermission;

export type ServerPage = Omit<StoredPage, "revision" | "ownerId" | "permission"> & {
  ownerId: string;
  revision: number;
  permission: ServerPermission;
  blocks?: PartialBlock[];
};

export type ServerRealtimeParticipant = {
  user: LocalAuthUser;
  activeBlockId?: string;
};

export type ServerPageRealtimeEvent = {
  type: "page.snapshot" | "page.updated" | "page.archived" | "page.deleted" | "page.error" | "presence.updated" | "database.updated" | "database.deleted" | "permission.updated" | "access.revoked" | "pong";
  page?: ServerPage;
  database?: ServerInlineDatabase;
  databaseId?: string;
  permission?: SharePermission;
  actorId?: string;
  message?: string;
  code?: string;
  participants?: ServerRealtimeParticipant[];
  changedBlockIds?: string[];
  deletedBlockIds?: string[];
  structural?: boolean;
};

export type ServerFolder = StoredFolder & { updatedAt: string };

export type ServerHome = {
  id: string;
  ownerId: string;
  title: string;
  settings: PageSettings;
  blocks: PartialBlock[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ServerShareMember = {
  user: LocalAuthUser;
  permission: SharePermission;
  sharedAt: string;
};

export type ServerShare = {
  pageId: string;
  owner: LocalAuthUser;
  permission: ServerPermission;
  members: ServerShareMember[];
  updatedAt: string;
};

export type ServerCommentMessage = {
  id: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  authorEmail: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type ServerCommentThread = {
  id: string;
  pageId: string;
  blockId: string;
  blockPreview: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ServerCommentMessage[];
};

export type ServerNotification = {
  id: string;
  kind: "share" | "comment" | "mention";
  pageId: string | null;
  threadId: string | null;
  actorId: string | null;
  actorName?: string;
  actorEmail?: string;
  avatarColor?: LocalAvatarColor;
  avatarIcon?: string;
  title: string;
  description: string;
  readAt: string | null;
  createdAt: string;
};

export type ServerNotificationReadState = {
  id: string;
  readAt: string | null;
};

export type ServerInlineDatabase<TState = Record<string, unknown>> = {
  id: string;
  ownerId: string;
  pageId: string | null;
  state: TState;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ServerPreferences<TPreferences = Record<string, unknown>> = {
  preferences: TPreferences;
  revision: number;
  updatedAt: string;
};

export type ServerStarterPreset = StarterPreset & {
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
};

export type ServerTag = TagOption & {
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
};

export const authApi = {
  me: () => apiRequest<LocalAuthUser>("/auth/me"),
  login: (email: string, password: string) => apiRequest<{ user: LocalAuthUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  }),
  register: (name: string, email: string, password: string) => apiRequest<{ user?: LocalAuthUser; status: "approved" | "pending" }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  }),
  logout: () => apiRequest<void>("/auth/logout", { method: "POST" }),
  updateProfile: (input: { name: string; avatarColor: LocalAvatarColor; avatarIcon?: string }) => apiRequest<LocalAuthUser>("/auth/me", {
    method: "PATCH",
    body: JSON.stringify(input),
  }),
  changePassword: (currentPassword: string, nextPassword: string) => apiRequest<void>("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, nextPassword }),
  }),
  searchUsers: (query = "") => apiRequest<LocalAuthUser[]>(`/auth/users?q=${encodeURIComponent(query)}&limit=50`),
  registrationRequests: () => apiRequest<RegistrationRequest[]>("/auth/registration-requests"),
  decideRegistration: (userId: string, status: "approved" | "rejected") => apiRequest<{ id: string; status: string; decidedAt: string }>(`/auth/registration-requests/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  }),
};

export const workspaceApi = {
  getPublicPage: (pageId: string) => apiRequest<ServerPage>(`/public/pages/${encodeURIComponent(pageId)}`),
  listPages: (includeArchived = true, includeBlocks = false) => apiRequest<ServerPage[]>(`/pages?includeArchived=${includeArchived}&includeBlocks=${includeBlocks}&limit=500`),
  getPage: (pageId: string) => apiRequest<ServerPage>(`/pages/${encodeURIComponent(pageId)}`),
  pageRealtimeURL: (pageId: string) => apiWebSocketURL(`/pages/${encodeURIComponent(pageId)}/realtime`),
  createPage: (page: StoredPage) => apiRequest<ServerPage>("/pages", {
    method: "POST",
    body: JSON.stringify({
      id: page.id,
      parentId: page.parentId,
      folderId: page.folderId,
      order: page.order,
      title: page.title,
      settings: page.settings,
      blocks: page.blocks,
      archived: page.archived,
      favorited: Boolean(page.favoritedAt),
    }),
  }),
  updatePage: (pageId: string, patch: Partial<Pick<StoredPage, "parentId" | "folderId" | "order" | "title" | "settings" | "blocks" | "archived" | "revision">>) => apiRequest<ServerPage>(`/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }),
  archivePage: (pageId: string, hard = false) => apiRequest<void>(`/pages/${encodeURIComponent(pageId)}${hard ? "?hard=true" : ""}`, { method: "DELETE" }),
  favoritePage: (pageId: string, favorited: boolean) => apiRequest<{ favoritedAt: string | null }>(`/pages/${encodeURIComponent(pageId)}/favorite`, {
    method: "PUT",
    body: JSON.stringify({ favorite: favorited }),
  }),
  searchPages: (query: string) => apiRequest<ServerPage[]>(`/search?q=${encodeURIComponent(query)}&limit=50`),
  getHome: () => apiRequest<ServerHome>("/home"),
  updateHome: (patch: Partial<Pick<StoredPage, "title" | "settings" | "blocks" | "revision">>) => apiRequest<ServerHome>("/home", {
    method: "PUT",
    body: JSON.stringify(patch),
  }),
  listFolders: () => apiRequest<ServerFolder[]>("/folders"),
  createFolder: (folder: StoredFolder) => apiRequest<ServerFolder>("/folders", {
    method: "POST",
    body: JSON.stringify({
      id: folder.id,
      parentId: folder.parentId,
      title: folder.title,
      order: folder.order,
      collapsed: folder.collapsed,
    }),
  }),
  updateFolder: (folder: StoredFolder) => apiRequest<ServerFolder>(`/folders/${encodeURIComponent(folder.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      parentId: folder.parentId,
      title: folder.title,
      order: folder.order,
      collapsed: folder.collapsed,
    }),
  }),
  deleteFolder: (folderId: string) => apiRequest<void>(`/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" }),
  listShares: (pageId: string) => apiRequest<ServerShare>(`/pages/${encodeURIComponent(pageId)}/shares`),
  listAllShares: () => apiRequest<ServerShare[]>("/shares"),
  setShare: (pageId: string, userId: string, permission: SharePermission) => apiRequest<{ userId: string; permission: SharePermission; sharedAt: string }>(`/pages/${encodeURIComponent(pageId)}/shares/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: JSON.stringify({ permission }),
  }),
  removeShare: (pageId: string, userId: string) => apiRequest<void>(`/pages/${encodeURIComponent(pageId)}/shares/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  listComments: (pageId: string) => apiRequest<ServerCommentThread[]>(`/pages/${encodeURIComponent(pageId)}/comments`),
  listAllComments: () => apiRequest<ServerCommentThread[]>("/comments?includeResolved=true&limit=2000"),
  createComment: (pageId: string, input: { id: string; blockId: string; blockPreview: string; body: string }) => apiRequest<ServerCommentThread>(`/pages/${encodeURIComponent(pageId)}/comments`, {
    method: "POST",
    body: JSON.stringify(input),
  }),
  addCommentMessage: (threadId: string, input: { id: string; parentId?: string | null; body: string }) => apiRequest<ServerCommentThread>(`/comments/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  }),
  resolveComment: (threadId: string, resolved: boolean) => apiRequest<ServerCommentThread>(`/comments/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    body: JSON.stringify({ resolved }),
  }),
  deleteCommentThread: (threadId: string) => apiRequest<void>(`/comments/${encodeURIComponent(threadId)}`, { method: "DELETE" }),
  deleteCommentMessage: (threadId: string, messageId: string) => apiRequest<void>(`/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" }),
  notifications: () => apiRequest<ServerNotification[]>("/notifications?limit=100"),
  readNotification: (notificationId: string) => apiRequest<ServerNotificationReadState>(`/notifications/${encodeURIComponent(notificationId)}`, {
    method: "PATCH",
    body: JSON.stringify({ read: true }),
  }),
  readAllNotifications: () => apiRequest<void>("/notifications/read-all", { method: "POST" }),
  deleteNotification: (notificationId: string) => apiRequest<void>(`/notifications/${encodeURIComponent(notificationId)}`, { method: "DELETE" }),
  getDatabase: <TState = Record<string, unknown>>(databaseId: string) => apiRequest<ServerInlineDatabase<TState>>(`/databases/${encodeURIComponent(databaseId)}`),
  putDatabase: <TState>(databaseId: string, input: { pageId?: string | null; state: TState; revision?: number }) => apiRequest<ServerInlineDatabase<TState>>(`/databases/${encodeURIComponent(databaseId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }),
  deleteDatabase: (databaseId: string) => apiRequest<void>(`/databases/${encodeURIComponent(databaseId)}`, { method: "DELETE" }),
  getPreferences: <TPreferences = Record<string, unknown>>() => apiRequest<ServerPreferences<TPreferences>>("/preferences"),
  updatePreferences: <TPreferences>(preferences: TPreferences, revision?: number) => apiRequest<ServerPreferences<TPreferences>>("/preferences", {
    method: "PUT",
    body: JSON.stringify({ preferences, revision }),
  }),
  listPresets: () => apiRequest<ServerStarterPreset[]>("/presets"),
  createPreset: (preset: StarterPreset, orderIndex: number) => apiRequest<ServerStarterPreset>("/presets", {
    method: "POST",
    body: JSON.stringify({ ...preset, sourceFileName: preset.sourceFileName ?? null, orderIndex }),
  }),
  updatePreset: (preset: StarterPreset, orderIndex: number) => apiRequest<ServerStarterPreset>(`/presets/${encodeURIComponent(preset.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...preset, sourceFileName: preset.sourceFileName ?? null, orderIndex }),
  }),
  deletePreset: (presetId: string) => apiRequest<void>(`/presets/${encodeURIComponent(presetId)}`, { method: "DELETE" }),
  listTags: () => apiRequest<ServerTag[]>("/tags"),
  createTag: (tag: TagOption, orderIndex: number) => apiRequest<ServerTag>("/tags", {
    method: "POST",
    body: JSON.stringify({ ...tag, orderIndex }),
  }),
  updateTag: (tag: TagOption, orderIndex: number) => apiRequest<ServerTag>(`/tags/${encodeURIComponent(tag.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...tag, orderIndex }),
  }),
  deleteTag: (tagId: string) => apiRequest<void>(`/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" }),
};
