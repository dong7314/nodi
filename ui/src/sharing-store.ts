import { ROOT_PAGE_ID } from "./page-store";

export const PAGE_SHARES_STORAGE_KEY = "nodi:page-shares";
export const PAGE_SHARES_CHANGED_EVENT = "nodi:page-shares-changed";

export type SharePermission = "view" | "edit";
export type NodiUserRole = "admin" | "member";
export type NodiAvatarColor = "purple" | "blue" | "green" | "orange" | "pink" | "gray";

export type NodiUser = {
  id: string;
  name: string;
  email: string;
  avatarColor: NodiAvatarColor;
  avatarIcon?: string;
  role?: NodiUserRole;
};

export type PageShareMember = {
  inheritedFromPageId?: string;
  inheritedFromTitle?: string;
  directPermission?: SharePermission;
  userId: string;
  permission: SharePermission;
  sharedAt: string;
};

export type PageShareRecord = {
  pageId: string;
  ownerId: string;
  ownerName: string;
  members: PageShareMember[];
  updatedAt: string;
};

export type StoredPageShares = Record<string, PageShareRecord>;

// This local directory mirrors the shape expected from a future authenticated
// `/users` search endpoint. Arbitrary e-mail addresses are intentionally not
// accepted, so only known Nodi accounts can be invited.
export const REGISTERED_NODI_USERS: NodiUser[] = [
  { id: "nodi-minji", name: "김민지", email: "minji@nodi.app", avatarColor: "purple", role: "member" },
  { id: "nodi-seojun", name: "박서준", email: "seojun@nodi.app", avatarColor: "blue", role: "member" },
  { id: "nodi-jiwoo", name: "최지우", email: "jiwoo@nodi.app", avatarColor: "green", role: "member" },
  { id: "nodi-haneul", name: "윤하늘", email: "haneul@nodi.app", avatarColor: "orange", role: "member" },
  { id: "nodi-doyun", name: "한도윤", email: "doyun@nodi.app", avatarColor: "pink", role: "member" },
  { id: "nodi-sua", name: "정수아", email: "sua@nodi.app", avatarColor: "gray", role: "member" },
];

export function getCurrentNodiUser(userName: string): NodiUser {
  const normalizedName = userName.trim() || "사용자";
  let storedId = "";
  let storedEmail = "";
  let storedAvatarColor: NodiAvatarColor | "" = "";
  let storedAvatarIcon = "";
  let storedRole: NodiUserRole | "" = "";

  try {
    for (const storageKey of ["nodi:user:profile", "nodi:auth:user"]) {
      const rawProfile = window.localStorage.getItem(storageKey);
      if (!rawProfile) continue;
      const profile = JSON.parse(rawProfile) as {
        id?: unknown;
        userId?: unknown;
        email?: unknown;
        avatarColor?: unknown;
        avatarIcon?: unknown;
        role?: unknown;
      };
      const candidateId = [profile.id, profile.userId]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
      if (candidateId) storedId = candidateId.trim();
      if (typeof profile.email === "string" && profile.email.trim()) storedEmail = profile.email.trim();
      if (
        typeof profile.avatarColor === "string"
        && ["purple", "blue", "green", "orange", "pink", "gray"].includes(profile.avatarColor)
      ) storedAvatarColor = profile.avatarColor as NodiAvatarColor;
      if (typeof profile.avatarIcon === "string") storedAvatarIcon = profile.avatarIcon;
      if (profile.role === "admin" || profile.role === "member") storedRole = profile.role;
      if (storedId || storedEmail || storedAvatarColor || storedAvatarIcon || storedRole) break;
    }
  } catch {
    // The local identity remains usable until the authentication provider is connected.
  }

  const safeName = normalizedName.toLocaleLowerCase().replace(/\s+/g, "-");
  return {
    id: storedId || (storedEmail ? `email:${storedEmail.toLocaleLowerCase()}` : `local:${safeName}`),
    name: normalizedName,
    email: storedEmail || `${safeName || "user"}@nodi.local`,
    avatarColor: storedAvatarColor || "purple",
    avatarIcon: storedAvatarIcon || undefined,
    role: storedRole || (!storedId && !storedEmail ? "admin" : "member"),
  };
}
export function readStoredPageShares(): StoredPageShares {
  try {
    const saved = window.localStorage.getItem(PAGE_SHARES_STORAGE_KEY);
    if (!saved) return {};
    const parsed = JSON.parse(saved) as StoredPageShares;
    const sanitizedPageShares = Object.fromEntries(
      Object.entries(parsed).filter(([, record]) => (
        record
        && typeof record.pageId === "string"
        && record.pageId !== ROOT_PAGE_ID
        && typeof record.ownerId === "string"
        && Array.isArray(record.members)
      )),
    );
    if (Object.prototype.hasOwnProperty.call(parsed, ROOT_PAGE_ID)) {
      window.localStorage.setItem(PAGE_SHARES_STORAGE_KEY, JSON.stringify(sanitizedPageShares));
    }
    return sanitizedPageShares;
  } catch {
    return {};
  }
}

export function persistStoredPageShares(pageShares: StoredPageShares) {
  const sanitizedPageShares = { ...pageShares };
  delete sanitizedPageShares[ROOT_PAGE_ID];
  window.localStorage.setItem(PAGE_SHARES_STORAGE_KEY, JSON.stringify(sanitizedPageShares));
  window.dispatchEvent(new CustomEvent(PAGE_SHARES_CHANGED_EVENT));
}
