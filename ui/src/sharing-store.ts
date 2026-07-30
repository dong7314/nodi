export const PAGE_SHARES_STORAGE_KEY = "nodi:page-shares";
export const PAGE_SHARES_CHANGED_EVENT = "nodi:page-shares-changed";

export type SharePermission = "view" | "edit";

export type NodiUser = {
  id: string;
  name: string;
  email: string;
  avatarColor: "purple" | "blue" | "green" | "orange" | "pink" | "gray";
};

export type PageShareMember = {
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
  { id: "nodi-minji", name: "김민지", email: "minji@nodi.app", avatarColor: "purple" },
  { id: "nodi-seojun", name: "박서준", email: "seojun@nodi.app", avatarColor: "blue" },
  { id: "nodi-jiwoo", name: "최지우", email: "jiwoo@nodi.app", avatarColor: "green" },
  { id: "nodi-haneul", name: "윤하늘", email: "haneul@nodi.app", avatarColor: "orange" },
  { id: "nodi-doyun", name: "한도윤", email: "doyun@nodi.app", avatarColor: "pink" },
  { id: "nodi-sua", name: "정수아", email: "sua@nodi.app", avatarColor: "gray" },
];

export function getCurrentNodiUser(userName: string): NodiUser {
  const normalizedName = userName.trim() || "사용자";
  let storedId = "";
  let storedEmail = "";

  try {
    for (const storageKey of ["nodi:user:profile", "nodi:auth:user"]) {
      const rawProfile = window.localStorage.getItem(storageKey);
      if (!rawProfile) continue;
      const profile = JSON.parse(rawProfile) as {
        id?: unknown;
        userId?: unknown;
        email?: unknown;
      };
      const candidateId = [profile.id, profile.userId]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
      if (candidateId) storedId = candidateId.trim();
      if (typeof profile.email === "string" && profile.email.trim()) storedEmail = profile.email.trim();
      if (storedId || storedEmail) break;
    }
  } catch {
    // The local identity remains usable until the authentication provider is connected.
  }

  const safeName = normalizedName.toLocaleLowerCase().replace(/\s+/g, "-");
  return {
    id: storedId || (storedEmail ? `email:${storedEmail.toLocaleLowerCase()}` : `local:${safeName}`),
    name: normalizedName,
    email: storedEmail || `${safeName || "user"}@nodi.local`,
    avatarColor: "purple",
  };
}
export function readStoredPageShares(): StoredPageShares {
  try {
    const saved = window.localStorage.getItem(PAGE_SHARES_STORAGE_KEY);
    if (!saved) return {};
    const parsed = JSON.parse(saved) as StoredPageShares;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, record]) => (
        record
        && typeof record.pageId === "string"
        && typeof record.ownerId === "string"
        && Array.isArray(record.members)
      )),
    );
  } catch {
    return {};
  }
}

export function persistStoredPageShares(pageShares: StoredPageShares) {
  window.localStorage.setItem(PAGE_SHARES_STORAGE_KEY, JSON.stringify(pageShares));
  window.dispatchEvent(new CustomEvent(PAGE_SHARES_CHANGED_EVENT));
}
