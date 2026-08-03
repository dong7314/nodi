import { API_BASE_URL } from "./api-client";
import { runtimeConfigString } from "./runtime-config";

export const APP_NOTICE_EVENT = "nodi:notice";

const LOCAL_IMAGE_UPLOAD_LIMIT = 1_250_000;
const LOCAL_FILE_UPLOAD_LIMIT = 1_000_000;
const DEFAULT_REMOTE_IMAGE_LIMIT_MB = 20;
const DEFAULT_REMOTE_FILE_LIMIT_MB = 100;

type AttachmentKind = "image" | "file";
export type NodiAttachmentContext = {
  authenticated?: boolean;
  pageId?: string | null;
};

type PresignedUploadResponse = {
  uploadUrl: string;
  assetUrl?: string;
  fileUrl?: string;
  method?: "PUT";
  headers?: Record<string, string>;
  objectKey?: string;
  uploadId?: string;
  completeUrl?: string;
};

type CompleteUploadResponse = {
  assetUrl?: string;
  fileUrl?: string;
};

function notify(message: string) {
  window.dispatchEvent(new CustomEvent(APP_NOTICE_EVENT, { detail: message }));
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("파일을 읽지 못했습니다."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

function readPositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAttachmentKind(file: File): AttachmentKind {
  return file.type.startsWith("image/") ? "image" : "file";
}

function getRemoteSizeLimit(kind: AttachmentKind) {
  const imageLimit = readPositiveNumber(
    runtimeConfigString("ATTACHMENT_MAX_IMAGE_MB")
      ?? import.meta.env.VITE_ATTACHMENT_MAX_IMAGE_MB,
    DEFAULT_REMOTE_IMAGE_LIMIT_MB,
  );
  const fileLimit = readPositiveNumber(
    runtimeConfigString("ATTACHMENT_MAX_FILE_MB")
      ?? import.meta.env.VITE_ATTACHMENT_MAX_FILE_MB,
    DEFAULT_REMOTE_FILE_LIMIT_MB,
  );
  return (kind === "image" ? imageLimit : fileLimit) * 1024 * 1024;
}

async function parseJsonResponse<T>(response: Response, fallbackMessage: string) {
  if (!response.ok) {
    throw new Error(`${fallbackMessage} (${response.status})`);
  }

  try {
    return await response.json() as T;
  } catch {
    throw new Error(`${fallbackMessage} (invalid JSON)`);
  }
}

function getStableAssetUrl(payload: CompleteUploadResponse) {
  return payload.assetUrl ?? payload.fileUrl;
}

function getAuthenticatedApiUrl(value: string) {
  try {
    const url = new URL(value, window.location.href);
    if (url.pathname.startsWith("/v1/")) {
      return `${API_BASE_URL}${url.pathname.slice(3)}${url.search}`;
    }
  } catch {
    // Keep custom deployment URLs intact when they cannot be parsed here.
  }
  return value;
}

async function uploadToMinio(file: File, pageId?: string | null) {
  const kind = getAttachmentKind(file);
  const sizeLimit = getRemoteSizeLimit(kind);
  if (file.size > sizeLimit) {
    const limitLabel = `${Math.round(sizeLimit / 1024 / 1024)}MB`;
    throw new Error(`${limitLabel} 이하의 ${kind === "image" ? "이미지" : "파일"}만 첨부할 수 있습니다.`);
  }

  const presignEndpoint = (
    runtimeConfigString("ATTACHMENT_PRESIGN_ENDPOINT")
      ?? import.meta.env.VITE_ATTACHMENT_PRESIGN_ENDPOINT?.trim()
  ) || `${API_BASE_URL}/attachments/presign`;

  const contentType = file.type || "application/octet-stream";
  const presignResponse = await fetch(presignEndpoint, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pageId: pageId ?? null,
      fileName: file.name,
      contentType,
      size: file.size,
      kind,
      lastModified: file.lastModified,
    }),
  });
  const presigned = await parseJsonResponse<PresignedUploadResponse>(
    presignResponse,
    "업로드 주소를 발급받지 못했습니다.",
  );

  if (!presigned.uploadUrl) {
    throw new Error("업로드 주소 응답이 올바르지 않습니다.");
  }

  const uploadHeaders = new Headers(presigned.headers);
  if (!uploadHeaders.has("Content-Type")) uploadHeaders.set("Content-Type", contentType);
  const uploadResponse = await fetch(presigned.uploadUrl, {
    method: presigned.method ?? "PUT",
    headers: uploadHeaders,
    body: file,
  });
  if (!uploadResponse.ok) {
    throw new Error(`MinIO 업로드에 실패했습니다. (${uploadResponse.status})`);
  }

  let assetUrl = getStableAssetUrl(presigned);
  if (presigned.completeUrl) {
    const completeResponse = await fetch(getAuthenticatedApiUrl(presigned.completeUrl), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectKey: presigned.objectKey,
        uploadId: presigned.uploadId,
        fileName: file.name,
        contentType,
        size: file.size,
        kind,
      }),
    });
    const completed = await parseJsonResponse<CompleteUploadResponse>(
      completeResponse,
      "업로드 완료 처리를 하지 못했습니다.",
    );
    assetUrl = getStableAssetUrl(completed) ?? assetUrl;
  }

  if (!assetUrl) {
    throw new Error("파일을 다시 불러올 수 있는 주소가 없습니다.");
  }
  return getAuthenticatedApiUrl(assetUrl);
}

async function uploadToLocalStorage(file: File) {
  const kind = getAttachmentKind(file);
  const sizeLimit = kind === "image" ? LOCAL_IMAGE_UPLOAD_LIMIT : LOCAL_FILE_UPLOAD_LIMIT;
  if (file.size > sizeLimit) {
    const limitLabel = kind === "image" ? "1.25MB" : "1MB";
    throw new Error(`현재 로컬 저장에서는 ${limitLabel} 이하의 ${kind === "image" ? "이미지" : "파일"}만 첨부할 수 있습니다.`);
  }
  return readFileAsDataUrl(file);
}

export async function uploadNodiAttachment(file: File, context: NodiAttachmentContext = {}) {
  const configuredStorageMode = (
    runtimeConfigString("ATTACHMENT_STORAGE_MODE")
      ?? import.meta.env.VITE_ATTACHMENT_STORAGE_MODE?.trim()
  )?.toLowerCase();
  const storageMode = configuredStorageMode || (context.authenticated === true ? "minio" : "local");

  try {
    const assetUrl = storageMode === "minio" && context.authenticated === true
      ? await uploadToMinio(file, context.pageId)
      : await uploadToLocalStorage(file);
    notify(`${file.name}을(를) 첨부했어요`);
    return assetUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : "파일 업로드에 실패했습니다.";
    notify(message);
    throw error;
  }
}
