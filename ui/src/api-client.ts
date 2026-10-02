import { runtimeConfigString } from "./runtime-config";

const configuredApiBase = runtimeConfigString("API_BASE_URL")
  ?? import.meta.env.VITE_API_BASE_URL?.trim();

export const API_BASE_URL = (configuredApiBase || "/api").replace(/\/$/, "");

export function apiWebSocketURL(path: string) {
  const base = new URL(API_BASE_URL, window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export type ApiEnvelope<T> = { data: T; meta?: { nextCursor?: string | null } };
type ApiErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

export class NodiApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "NodiApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequestEnvelope<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiEnvelope<T>> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  const response = await fetch(`${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers,
    credentials: "include",
  });

  if (response.status === 204) return { data: undefined as T };

  let payload: ApiEnvelope<T> | ApiErrorEnvelope | null = null;
  try {
    payload = await response.json() as ApiEnvelope<T> | ApiErrorEnvelope;
  } catch {
    if (!response.ok) {
      throw new NodiApiError(response.status, "INVALID_RESPONSE", "서버 응답을 확인하지 못했습니다.");
    }
  }

  if (!response.ok) {
    const error = (payload as ApiErrorEnvelope | null)?.error;
    throw new NodiApiError(
      response.status,
      error?.code || "REQUEST_FAILED",
      error?.message || "요청을 처리하지 못했습니다.",
      error?.details,
    );
  }

  if (payload && "data" in payload) return payload;
  return { data: payload as T };
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await apiRequestEnvelope<T>(path, init)).data;
}

export function isAuthenticationError(error: unknown) {
  return error instanceof NodiApiError && (error.status === 401 || error.status === 403);
}
