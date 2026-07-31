# 첨부 파일 저장소

Nodi의 BlockNote 업로드는 `src/attachment-storage.ts`를 통해 처리됩니다.

## 현재 모드

- `VITE_ATTACHMENT_STORAGE_MODE=local`
- 이미지와 파일을 data URL로 변환해 기존 로컬 페이지 데이터에 저장합니다.
- 로컬 모드는 개발용이며 이미지 1.25MB, 일반 파일 1MB 제한이 있습니다.

## MinIO 전환

운영 환경에서는 다음 값으로 변경합니다.

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
  "fileName": "photo.png",
  "contentType": "image/png",
  "size": 123456,
  "kind": "image",
  "lastModified": 1785481200000
}
```

### Presign 응답

```json
{
  "uploadUrl": "https://minio.example.com/nodi/...",
  "assetUrl": "/api/attachments/attachment-id",
  "method": "PUT",
  "headers": {
    "Content-Type": "image/png"
  },
  "objectKey": "users/user-id/attachments/uuid.png"
}
```

- `uploadUrl`: 짧게 만료되는 MinIO presigned PUT URL입니다.
- `assetUrl`: BlockNote 문서에 영구 저장할 안정적인 URL입니다. 비공개 파일이라면 같은 출처의 인증 프록시 URL을 권장합니다.
- `headers`: presigned 서명에 포함된 헤더를 그대로 반환합니다.
- `objectKey`: 서버의 자산 정리 및 페이지 연결에 사용할 수 있습니다.

업로드 후 서버 처리가 필요하면 응답에 `completeUrl`과 `uploadId`를 추가할 수 있습니다. 클라이언트는 업로드 성공 후 `completeUrl`에 메타데이터를 전송하고, 완료 응답의 `assetUrl`을 최종 저장합니다.

## MinIO CORS

MinIO 버킷은 Nodi 웹 origin의 `PUT` 요청과 `Content-Type` 및 presign 응답에서 지정한 헤더를 허용해야 합니다. 조회는 공개 버킷 URL보다 Nodi 백엔드의 안정적인 인증 URL을 사용해야 공유 권한 변경과 파일 삭제를 제어할 수 있습니다.
