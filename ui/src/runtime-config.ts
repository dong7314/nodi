export type NodiRuntimeConfig = {
  API_BASE_URL?: string;
  ATTACHMENT_STORAGE_MODE?: string;
  ATTACHMENT_PRESIGN_ENDPOINT?: string;
  ATTACHMENT_MAX_IMAGE_MB?: string | number;
  ATTACHMENT_MAX_FILE_MB?: string | number;
};

declare global {
  interface Window {
    __NODI_CONFIG__?: NodiRuntimeConfig;
  }
}

export function runtimeConfigString(key: keyof NodiRuntimeConfig) {
  const value = window.__NODI_CONFIG__?.[key];
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}
