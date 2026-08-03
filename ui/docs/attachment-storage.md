# 첨부 파일 저장소

Nodi의 BlockNote 업로드는 `src/attachment-storage.ts`를 통해 처리됩니다.

## 저장 모드

- `VITE_ATTACHMENT_STORAGE_MODE=minio`: 로그인 사용자의 기본 개발·운영 모드입니다. Nodi API가 presigned URL을 발급합니다.
- `VITE_ATTACHMENT_STORAGE_MODE=local`: API 없이 실행하는 게스트/단독 개발 모드입니다. 이미지와 파일을 data URL로 저장하며 이미지 1.25MB, 일반 파일 1MB 제한이 있습니다.

## MinIO 전환

MinIO 모드는 다음 값을 사용합니다.

```env
VITE_ATTACHMENT_STORAGE_MODE=minio
VITE_ATTACHMENT_PRESIGN_ENDPOINT=/api/attachments/presign
VITE_ATTACHMENT_MAX_IMAGE_MB=20
VITE_ATTACHMENT_MAX_FILE_MB=100
```

브라우저에 MinIO endpoint, access key, secret key를 노출하지 않습니다. Nodi 백엔드가 로그인 세션을 확인하고 presigned URL을 발급해야 합니다.

### Presign 요청

브라우저는 인증 쿠키와 함께 다음 JSON을 `POST`합니다.

```json
{
  "pageId": "page-id",
  "fileName": "photo.png",
  "contentType": "image/png",
  "size": 123456,
  "kind": "image",
  "lastModified": 1785481200000
}
```

`pageId`는 홈 메모처럼 페이지에 귀속되지 않는 첨부라면 `null`이고, 일반 페이지·미리보기 drawer에서 올린 파일은 해당 페이지 ID가 전달됩니다. 서버는 이 값을 이용해 공유 권한을 검사하고 페이지가 보관·삭제될 때 첨부파일의 수명주기를 추적합니다. 게스트는 MinIO 설정 여부와 관계없이 data URL 기반 로컬 저장을 사용합니다.

### Presign 응답

```json
{
  "uploadUrl": "https://minio.example.com/nodi/...",
  "assetUrl": "http://localhost:8787/v1/attachments/attachment-id/content?assetToken=...",
  "method": "PUT",
  "headers": {
    "Content-Type": "image/png"
  },
  "objectKey": "user-uuid/attachment-uuid",
  "uploadId": "attachment-uuid",
  "completeUrl": "http://localhost:8787/v1/attachments/attachment-uuid/complete"
}
```

- `uploadUrl`: 짧게 만료되는 MinIO presigned PUT URL입니다.
- `assetUrl`: BlockNote 문서에 영구 저장할 Nodi 토큰 URL입니다. MinIO presign 만료와 무관하게 유지됩니다.
- `headers`: presigned 서명에 포함된 헤더를 그대로 반환합니다.
- `objectKey`: 서버의 자산 정리 및 페이지 연결에 사용할 수 있습니다.

클라이언트는 MinIO PUT 성공 후 `completeUrl`에 메타데이터를 전송합니다. 서버는 MinIO 객체의 실제 크기와 MIME을 검증한 뒤 완료 상태로 전환합니다.

## MinIO CORS

MinIO 버킷은 Nodi 웹 origin의 `PUT` 요청과 `Content-Type` 및 presign 응답에서 지정한 헤더를 허용해야 합니다. 조회는 공개 버킷 URL보다 Nodi 백엔드의 안정적인 인증 URL을 사용해야 공유 권한 변경과 파일 삭제를 제어할 수 있습니다.
