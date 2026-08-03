import { NodiApiError } from "./api-client";
import { authApi } from "./server-api";

export const REGISTRATION_REQUESTS_STORAGE_KEY = "nodi:registration-requests";
export const REGISTRATION_REQUESTS_CHANGED_EVENT = "nodi:registration-requests-changed";
export const LOCAL_AUTH_CHANGED_EVENT = "nodi:local-auth-changed";

const LOCAL_ACCOUNTS_STORAGE_KEY = "nodi:auth:accounts";
const LOCAL_AUTH_SESSION_STORAGE_KEY = "nodi:auth:session";
const LOCAL_AUTH_INITIALIZED_STORAGE_KEY = "nodi:auth:initialized";
const LOCAL_AUTH_LAST_EMAIL_STORAGE_KEY = "nodi:auth:last-email";
const LEGACY_USER_NAME_STORAGE_KEY = "nodi:user:name";
const LEGACY_USER_PROFILE_STORAGE_KEY = "nodi:user:profile";

export type RegistrationRequestStatus = "pending" | "approved" | "rejected";
export type LocalAccountRole = "admin" | "member";
export type LocalAccountStatus = "pending" | "approved" | "rejected";
export type LocalAvatarColor = "purple" | "blue" | "green" | "orange" | "pink" | "gray";

export type RegistrationRequest = {
  id: string;
  name: string;
  email: string;
  requestedAt: string;
  status: RegistrationRequestStatus;
  decidedAt: string | null;
};

export type LocalAuthUser = {
  id: string;
  name: string;
  email: string;
  avatarColor: LocalAvatarColor;
  avatarIcon?: string;
  role: LocalAccountRole;
};

type StoredPassword = {
  salt: string;
  hash: string;
};

type LocalAccount = LocalAuthUser & {
  status: LocalAccountStatus;
  password: StoredPassword | null;
  createdAt: string;
};

type LocalAuthSession = {
  userId: string;
  signedInAt: string;
};

export type LocalLoginResult = {
  ok: boolean;
  message: string;
  user?: LocalAuthUser;
};

export type LocalRegistrationResult = LocalLoginResult & {
  status?: "approved" | "pending";
};

export function readRegistrationRequests(): RegistrationRequest[] {
  try {
    const saved = window.localStorage.getItem(REGISTRATION_REQUESTS_STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((request): request is RegistrationRequest => (
      Boolean(request)
      && typeof request.id === "string"
      && typeof request.name === "string"
      && typeof request.email === "string"
      && typeof request.requestedAt === "string"
      && ["pending", "approved", "rejected"].includes(request.status)
    ));
  } catch {
    return [];
  }
}

export function persistRegistrationRequests(requests: RegistrationRequest[]) {
  window.localStorage.setItem(REGISTRATION_REQUESTS_STORAGE_KEY, JSON.stringify(requests));
  window.dispatchEvent(new CustomEvent(REGISTRATION_REQUESTS_CHANGED_EVENT));
}

export function bootstrapLocalAuth(): LocalAuthUser | null {
  const sessionUser = readLocalAuthUser();
  if (sessionUser) {
    syncLegacyProfile(sessionUser);
    return sessionUser;
  }

  window.localStorage.setItem(LOCAL_AUTH_INITIALIZED_STORAGE_KEY, "true");
  return null;
}

export async function restoreServerAuth(): Promise<LocalAuthUser | null> {
  const cachedUser = readLocalAuthUser();
  try {
    const user = await authApi.me();
    return cacheServerSession(user);
  } catch (error) {
    if (error instanceof NodiApiError && error.status === 401) {
      clearCachedSession();
      return null;
    }

    // A temporary server, network, or rate-limit failure is not proof that the
    // HttpOnly session cookie is invalid. Keep rendering the last verified user
    // until /auth/me explicitly answers with 401.
    return cachedUser;
  }
}

export function readLocalAuthUser(): LocalAuthUser | null {
  try {
    const rawSession = window.localStorage.getItem(LOCAL_AUTH_SESSION_STORAGE_KEY);
    if (!rawSession) return null;
    const session = JSON.parse(rawSession) as Partial<LocalAuthSession>;
    if (typeof session.userId !== "string") return null;
    if (session.userId.startsWith("local:")) return null;
    const account = readLocalAccounts().find((candidate) => (
      candidate.id === session.userId && candidate.status === "approved"
    ));
    return account ? toAuthUser(account) : null;
  } catch {
    return null;
  }
}

export function readLastLocalAuthEmail() {
  return window.localStorage.getItem(LOCAL_AUTH_LAST_EMAIL_STORAGE_KEY) ?? "";
}

export function readApprovedLocalUsers(): LocalAuthUser[] {
  return readLocalAccounts()
    .filter((account) => account.status === "approved" && !account.id.startsWith("local:"))
    .map(toAuthUser);
}

export async function loginLocalAccount(email: string, password: string): Promise<LocalLoginResult> {
  try {
    const { user } = await authApi.login(normalizeEmail(email), password);
    return { ok: true, message: "로그인했습니다.", user: cacheServerSession(user) };
  } catch (error) {
    return { ok: false, message: apiMessage(error, "이메일 또는 비밀번호가 일치하지 않습니다.") };
  }
}

export async function registerLocalAccount({
  name,
  email,
  password,
}: {
  name: string;
  email: string;
  password: string;
}): Promise<LocalRegistrationResult> {
  const normalizedName = name.trim();
  const normalizedEmail = normalizeEmail(email);
  if (normalizedName.length < 2) {
    return { ok: false, message: "이름을 2자 이상 입력해 주세요." };
  }
  if (!isValidEmail(normalizedEmail)) {
    return { ok: false, message: "올바른 이메일 주소를 입력해 주세요." };
  }
  if (password.length < 8) {
    return { ok: false, message: "비밀번호를 8자 이상 입력해 주세요." };
  }

  try {
    const result = await authApi.register(normalizedName, normalizedEmail, password);
    window.localStorage.setItem(LOCAL_AUTH_LAST_EMAIL_STORAGE_KEY, normalizedEmail);
    const user = result.user ? cacheServerSession(result.user) : undefined;
    return {
      ok: true,
      status: result.status,
      message: result.status === "approved"
        ? "계정이 생성되었습니다."
        : "회원가입 요청을 보냈습니다. 관리자 승인 후 로그인할 수 있습니다.",
      user,
    };
  } catch (error) {
    return { ok: false, message: apiMessage(error, "회원가입 요청을 처리하지 못했습니다.") };
  }
}

export async function logoutLocalAccount() {
  try {
    await authApi.logout();
  } catch {
    // The local session must still be cleared when the remote session expired.
  }
  clearCachedSession();
}

function clearCachedSession() {
  window.localStorage.setItem(LOCAL_AUTH_INITIALIZED_STORAGE_KEY, "true");
  window.localStorage.removeItem(LOCAL_AUTH_SESSION_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(LOCAL_AUTH_CHANGED_EVENT));
}

export function updateLocalAccountRegistrationStatus(
  email: string,
  status: Exclude<LocalAccountStatus, "pending">,
) {
  const normalizedEmail = normalizeEmail(email);
  const accounts = readLocalAccounts();
  const nextAccounts = accounts.map((account) => (
    account.email === normalizedEmail ? { ...account, status } : account
  ));
  persistLocalAccounts(nextAccounts);
}

export async function updateLocalAccountProfile({
  name,
  avatarColor,
  avatarIcon,
}: {
  name: string;
  avatarColor: LocalAvatarColor;
  avatarIcon?: string;
}) {
  try {
    const user = await authApi.updateProfile({ name, avatarColor, avatarIcon });
    cacheServerSession(user);
    return { ok: true, user };
  } catch (error) {
    return { ok: false, message: apiMessage(error, "프로필을 변경하지 못했습니다.") };
  }
}

export async function changeLocalPassword(currentPassword: string, nextPassword: string) {
  try {
    await authApi.changePassword(currentPassword, nextPassword);
    clearCachedSession();
    return { ok: true, message: "비밀번호를 변경했습니다. 다시 로그인해 주세요." };
  } catch (error) {
    return { ok: false, message: apiMessage(error, "비밀번호를 변경하지 못했습니다.") };
  }
}

function cacheServerSession(user: LocalAuthUser): LocalAuthUser {
  const accounts = readLocalAccounts();
  const cached: LocalAccount = {
    ...user,
    status: "approved",
    password: null,
    createdAt: accounts.find((account) => account.id === user.id)?.createdAt || new Date().toISOString(),
  };
  persistLocalAccounts([cached, ...accounts.filter((account) => account.id !== user.id && !account.id.startsWith("local:"))]);
  return createSession(cached);
}

function apiMessage(error: unknown, fallback: string) {
  return error instanceof NodiApiError ? error.message : fallback;
}

function readLocalAccounts(): LocalAccount[] {
  try {
    const rawAccounts = window.localStorage.getItem(LOCAL_ACCOUNTS_STORAGE_KEY);
    if (!rawAccounts) return [];
    const parsed = JSON.parse(rawAccounts) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((account): account is LocalAccount => (
      Boolean(account)
      && typeof account.id === "string"
      && typeof account.name === "string"
      && typeof account.email === "string"
      && ["admin", "member"].includes(account.role)
      && ["pending", "approved", "rejected"].includes(account.status)
    )).map((account) => ({
      ...account,
      email: normalizeEmail(account.email),
      avatarColor: isAvatarColor(account.avatarColor) ? account.avatarColor : "purple",
      password: isStoredPassword(account.password) ? account.password : null,
    }));
  } catch {
    return [];
  }
}

function persistLocalAccounts(accounts: LocalAccount[]) {
  window.localStorage.setItem(LOCAL_ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts));
}

function createSession(account: LocalAccount): LocalAuthUser {
  const user = toAuthUser(account);
  const session: LocalAuthSession = {
    userId: account.id,
    signedInAt: new Date().toISOString(),
  };
  window.localStorage.setItem(LOCAL_AUTH_SESSION_STORAGE_KEY, JSON.stringify(session));
  window.localStorage.setItem(LOCAL_AUTH_LAST_EMAIL_STORAGE_KEY, account.email);
  window.localStorage.setItem(LOCAL_AUTH_INITIALIZED_STORAGE_KEY, "true");
  syncLegacyProfile(user);
  window.dispatchEvent(new CustomEvent(LOCAL_AUTH_CHANGED_EVENT));
  return user;
}

function syncLegacyProfile(user: LocalAuthUser) {
  window.localStorage.setItem(LEGACY_USER_NAME_STORAGE_KEY, user.name);
  window.localStorage.setItem(LEGACY_USER_PROFILE_STORAGE_KEY, JSON.stringify(user));
  window.localStorage.setItem("nodi:auth:user", JSON.stringify(user));
}

function toAuthUser(account: LocalAccount): LocalAuthUser {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    avatarColor: account.avatarColor,
    avatarIcon: account.avatarIcon,
    role: account.role,
  };
}

function normalizeEmail(email: string) {
  return email.trim().toLocaleLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAvatarColor(value: unknown): value is LocalAvatarColor {
  return typeof value === "string"
    && ["purple", "blue", "green", "orange", "pink", "gray"].includes(value);
}

function isStoredPassword(value: unknown): value is StoredPassword {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as StoredPassword).salt === "string"
    && typeof (value as StoredPassword).hash === "string",
  );
}
