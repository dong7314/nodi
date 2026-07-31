export const REGISTRATION_REQUESTS_STORAGE_KEY = "nodi:registration-requests";
export const REGISTRATION_REQUESTS_CHANGED_EVENT = "nodi:registration-requests-changed";
export const LOCAL_AUTH_CHANGED_EVENT = "nodi:local-auth-changed";

const LOCAL_PASSWORD_STORAGE_KEY = "nodi:account:password";
const LOCAL_ACCOUNTS_STORAGE_KEY = "nodi:auth:accounts";
const LOCAL_AUTH_SESSION_STORAGE_KEY = "nodi:auth:session";
const LOCAL_AUTH_INITIALIZED_STORAGE_KEY = "nodi:auth:initialized";
const LOCAL_AUTH_LAST_EMAIL_STORAGE_KEY = "nodi:auth:last-email";
const LEGACY_PAGES_STORAGE_KEY = "nodi:pages";
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

  const initialized = window.localStorage.getItem(LOCAL_AUTH_INITIALIZED_STORAGE_KEY) === "true";
  if (initialized) return null;

  window.localStorage.setItem(LOCAL_AUTH_INITIALIZED_STORAGE_KEY, "true");
  const accounts = readLocalAccounts();
  const approvedAccount = accounts.find((account) => account.status === "approved");
  if (approvedAccount) return createSession(approvedAccount);

  const legacyProfile = readLegacyProfile();
  const legacyName = window.localStorage.getItem(LEGACY_USER_NAME_STORAGE_KEY)?.trim();
  const hasLegacyWorkspace = Boolean(
    legacyProfile
    || legacyName
    || window.localStorage.getItem(LEGACY_PAGES_STORAGE_KEY),
  );
  if (!hasLegacyWorkspace) return null;

  const name = legacyProfile?.name || legacyName || "Lee";
  const email = normalizeEmail(legacyProfile?.email || `${slugify(name) || "lee"}@nodi.local`);
  const account: LocalAccount = {
    id: legacyProfile?.id || `local:${slugify(name) || "admin"}`,
    name,
    email,
    avatarColor: legacyProfile?.avatarColor || "purple",
    avatarIcon: legacyProfile?.avatarIcon,
    role: "admin",
    status: "approved",
    password: readLegacyStoredPassword(),
    createdAt: new Date().toISOString(),
  };
  persistLocalAccounts([...accounts, account]);
  return createSession(account);
}

export function readLocalAuthUser(): LocalAuthUser | null {
  try {
    const rawSession = window.localStorage.getItem(LOCAL_AUTH_SESSION_STORAGE_KEY);
    if (!rawSession) return null;
    const session = JSON.parse(rawSession) as Partial<LocalAuthSession>;
    if (typeof session.userId !== "string") return null;
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
    .filter((account) => account.status === "approved")
    .map(toAuthUser);
}

export async function loginLocalAccount(email: string, password: string): Promise<LocalLoginResult> {
  const normalizedEmail = normalizeEmail(email);
  const accounts = readLocalAccounts();
  const accountIndex = accounts.findIndex((account) => account.email === normalizedEmail);
  if (accountIndex < 0) {
    return { ok: false, message: "이 이메일로 등록된 로컬 계정을 찾을 수 없습니다." };
  }

  const account = accounts[accountIndex];
  if (account.status === "pending") {
    return { ok: false, message: "관리자의 회원가입 승인을 기다리고 있습니다." };
  }
  if (account.status === "rejected") {
    return { ok: false, message: "승인되지 않은 계정입니다. 관리자에게 문의해 주세요." };
  }
  if (password.length < 8) {
    return { ok: false, message: "비밀번호를 8자 이상 입력해 주세요." };
  }

  if (account.password) {
    const passwordHash = await hashPassword(password, account.password.salt);
    if (passwordHash !== account.password.hash) {
      return { ok: false, message: "이메일 또는 비밀번호가 일치하지 않습니다." };
    }
  } else {
    const salt = createSalt();
    accounts[accountIndex] = {
      ...account,
      password: { salt, hash: await hashPassword(password, salt) },
    };
    persistLocalAccounts(accounts);
  }

  const user = createSession(accounts[accountIndex]);
  return { ok: true, message: "로그인했습니다.", user };
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

  const accounts = readLocalAccounts();
  const existingAccount = accounts.find((account) => account.email === normalizedEmail);
  if (existingAccount) {
    return {
      ok: false,
      message: existingAccount.status === "pending"
        ? "이미 승인 대기 중인 이메일입니다."
        : "이미 가입된 이메일입니다.",
    };
  }

  const isFirstAccount = !accounts.some((account) => (
    account.role === "admin" && account.status === "approved"
  ));
  const salt = createSalt();
  const createdAt = new Date().toISOString();
  const account: LocalAccount = {
    id: `local:${globalThis.crypto.randomUUID()}`,
    name: normalizedName,
    email: normalizedEmail,
    avatarColor: "purple",
    role: isFirstAccount ? "admin" : "member",
    status: isFirstAccount ? "approved" : "pending",
    password: { salt, hash: await hashPassword(password, salt) },
    createdAt,
  };
  persistLocalAccounts([...accounts, account]);

  if (isFirstAccount) {
    const user = createSession(account);
    return {
      ok: true,
      status: "approved",
      message: "첫 번째 로컬 관리자 계정이 생성되었습니다.",
      user,
    };
  }

  const requests = readRegistrationRequests();
  persistRegistrationRequests([
    {
      id: account.id,
      name: account.name,
      email: account.email,
      requestedAt: createdAt,
      status: "pending",
      decidedAt: null,
    },
    ...requests.filter((request) => normalizeEmail(request.email) !== normalizedEmail),
  ]);
  window.localStorage.setItem(LOCAL_AUTH_LAST_EMAIL_STORAGE_KEY, normalizedEmail);
  return {
    ok: true,
    status: "pending",
    message: "회원가입 요청을 보냈습니다. 관리자 승인 후 로그인할 수 있습니다.",
  };
}

export function logoutLocalAccount() {
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

export function updateLocalAccountProfile({
  name,
  avatarColor,
  avatarIcon,
}: {
  name: string;
  avatarColor: LocalAvatarColor;
  avatarIcon?: string;
}) {
  const user = readLocalAuthUser();
  if (!user) return;
  const accounts = readLocalAccounts();
  const nextAccounts = accounts.map((account) => (
    account.id === user.id
      ? { ...account, name, avatarColor, avatarIcon }
      : account
  ));
  persistLocalAccounts(nextAccounts);
  syncLegacyProfile({ ...user, name, avatarColor, avatarIcon });
}

export async function changeLocalPassword(currentPassword: string, nextPassword: string) {
  const user = readLocalAuthUser();
  if (!user) {
    return { ok: false, message: "로그인한 사용자만 비밀번호를 변경할 수 있습니다." };
  }

  const accounts = readLocalAccounts();
  const accountIndex = accounts.findIndex((account) => account.id === user.id);
  if (accountIndex < 0) {
    return { ok: false, message: "로컬 계정 정보를 찾을 수 없습니다." };
  }

  const account = accounts[accountIndex];
  if (account.password) {
    const currentHash = await hashPassword(currentPassword, account.password.salt);
    if (currentHash !== account.password.hash) {
      return { ok: false, message: "현재 비밀번호가 일치하지 않습니다." };
    }
  }

  const salt = createSalt();
  const password = { salt, hash: await hashPassword(nextPassword, salt) };
  accounts[accountIndex] = { ...account, password };
  persistLocalAccounts(accounts);
  window.localStorage.setItem(LOCAL_PASSWORD_STORAGE_KEY, JSON.stringify(password));
  return { ok: true, message: "비밀번호를 변경했습니다." };
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

function readLegacyProfile(): Partial<LocalAuthUser> | null {
  try {
    for (const key of [LEGACY_USER_PROFILE_STORAGE_KEY, "nodi:auth:user"]) {
      const rawProfile = window.localStorage.getItem(key);
      if (!rawProfile) continue;
      const profile = JSON.parse(rawProfile) as Partial<LocalAuthUser>;
      const name = typeof profile.name === "string" ? profile.name.trim() : "";
      if (!name && typeof profile.email !== "string") continue;
      return {
        id: typeof profile.id === "string" ? profile.id : undefined,
        name: name || undefined,
        email: typeof profile.email === "string" ? normalizeEmail(profile.email) : undefined,
        avatarColor: isAvatarColor(profile.avatarColor) ? profile.avatarColor : undefined,
        avatarIcon: typeof profile.avatarIcon === "string" ? profile.avatarIcon : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function readLegacyStoredPassword(): StoredPassword | null {
  try {
    const saved = window.localStorage.getItem(LOCAL_PASSWORD_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as unknown;
    return isStoredPassword(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

function slugify(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "");
}

function createSalt() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string, salt: string) {
  const payload = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
