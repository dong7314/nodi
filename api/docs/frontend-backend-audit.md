# 프론트엔드 ↔ 백엔드 기능 감사

2026-08-03 기준 `ui/src`의 실제 상태 저장 경로와 화면 동작을 기준으로 API를 대조했다.

## 기능별 계약

| 프론트엔드 기능 | 프론트엔드의 현재 저장 방식 | 대응 API | 백엔드 상태 |
| --- | --- | --- | --- |
| 게스트 메모 | 브라우저 `localStorage` | 없음(의도된 오프라인 모드) | 게스트 데이터는 서버로 전송하지 않음 |
| 가입·로그인·로그아웃 | API + 쿠키 세션, 프로필만 로컬 캐시 | `/v1/auth/*` | 세션 쿠키, bcrypt, 최초 관리자, 가입 승인 연결 |
| 프로필·비밀번호 | API + 로컬 표시 캐시 | `/v1/auth/me`, `/v1/auth/change-password` | 연결 |
| 테마 등 사용자 설정 | API 원본 + `localStorage` 캐시 | `/v1/preferences` | revision 기반 저장 연결 |
| 개인 홈 | API 원본 + 로컬 캐시 | `/v1/home` | 사용자별 저장, 공유·공개·즐겨찾기 금지 연결 |
| 페이지·블록·휴지통 | API 원본 + `nodi:pages` 캐시 | `/v1/pages*` | 초기 bulk hydration, revision 충돌, archive/hard delete 연결 |
| 폴더·3단계 트리 | API 원본 + 로컬 캐시 | `/v1/folders*` | 순환 방지와 최대 3단계 검증 연결 |
| 즐겨찾기·검색 | API | `/v1/pages/{id}/favorite`, `/v1/search` | 한글/부분 문자열 fallback 포함 연결 |
| 회원 공유·공개 링크 | API 원본 + 로컬 캐시 | `/v1/pages/{id}/shares*`, `/v1/shares`, `/v1/pages/{id}/realtime`, `/v1/public/pages/{id}` | 받은 페이지는 공유 화면에만 노출하고 동일한 원본 ID를 열며, 보기/편집 권한·실시간 변경·`?page=`·`?publicPage=` 직접 진입·공개 페이지 읽기 전용 렌더링·홈 비공개 강제 연결 |
| 받은편지함 | API(게스트만 로컬 샘플) | `/v1/notifications*` | 공유·댓글 이벤트, 읽음·전체 읽음·삭제 연결 |
| 블록 댓글·답글 | API 원본 + 로컬 캐시 | `/v1/pages/{id}/comments*`, `/v1/comments` | 2단계 답글 평탄화, 삭제·해결 상태 연결 |
| 인라인 DB | API 원본 + 블록별 로컬 캐시 | `/v1/databases/{id}` | 페이지 ACL과 revision 충돌 검사 연결 |
| 시작 프리셋·태그 | API 원본 + 로컬 캐시 | `/v1/presets*`, `/v1/tags*` | 프리셋 최대 5개 포함 연결 |
| 이미지·파일 | MinIO presigned 업로드 + 안정 asset URL | `/v1/attachments*` | 크기·MIME·소유권 검증, 미완료 업로드 정리 연결 |

## 첨부파일 흐름

1. 인증 사용자가 `/v1/attachments/presign`으로 파일 메타데이터를 보낸다.
2. API는 DB에 `pending` 메타데이터를 저장하고 MinIO presigned PUT 주소를 반환한다.
3. 브라우저가 파일 바이트를 MinIO로 직접 전송한다. MinIO 키는 브라우저에 노출돼도 자격 증명은 노출되지 않는다.
4. 브라우저가 `/v1/attachments/{id}/complete`를 호출한다.
5. API가 MinIO의 실제 객체 크기와 MIME을 확인한 뒤 업로드를 완료 처리한다.
6. 블록에는 만료되는 MinIO URL 대신 토큰이 포함된 Nodi asset URL을 저장한다. API가 토큰 검증 후 private MinIO 객체를 스트리밍하므로 문서 링크가 만료되지 않는다.
7. 페이지를 영구 삭제하면 연관 객체도 삭제하며, 완료되지 않은 업로드는 24시간 뒤 서버 시작 또는 presign 요청 시 정리한다.

## 동기화 정책

- 로그인 사용자의 서버 데이터가 원본이며 `localStorage`는 빠른 렌더링과 실패 복구를 위한 캐시다.
- 로그인 직후 페이지 본문·폴더·공유·댓글·알림·프리셋·태그·환경설정을 한 번에 hydration한다. 페이지·공유·댓글은 bulk 목록 경로를 사용해 N+1 요청을 피한다.
- 게스트는 로컬 전용이다. 로그인 직후 게스트 데이터가 있으면 사용자가 명시적으로 가져오거나 건너뛴다.
- 공유와 댓글 상태는 서버 성공 응답 뒤 화면에 반영해 실패한 요청이 성공한 것처럼 남지 않게 한다.
- 공유 페이지는 수신자 개인 페이지 트리에 복제하지 않는다. 소유자와 수신자는 같은 페이지 ID를 사용하며, 저장 성공 뒤 WebSocket으로 페이지·인라인 DB 스냅샷과 권한 변경을 전달한다.
- `quick-note`는 일반 페이지 API가 아니라 `/v1/home`에만 저장한다.

## 검증 결과

- Go 포맷, 전체 단위 테스트와 `go vet`을 Go 1.24 환경에서 통과했다.
- 프론트엔드는 React 19·pnpm 환경의 production build를 통과했다.
- 실제 PostgreSQL·MinIO·API 컨테이너를 사용해 폴더, 페이지, 즐겨찾기, 검색, 회원 공유, 권한, 댓글·답글·해결, 알림, 인라인 DB, 프리셋, 태그, 환경설정, 홈 비공개 강제, revision 충돌을 연속 검증했다.
- MinIO는 presign → PUT → complete → private asset 조회 → 페이지 영구 삭제 후 객체 제거까지 검증했다. 익명 MinIO 접근은 거부됨을 확인했다.
- 브라우저에서 공개 링크로 직접 진입했을 때 사이드바 없이 읽기 전용 에디터가 표시되는 것을 확인했다.
- 분리된 두 사용자 세션으로 같은 공유 페이지 WebSocket에 연결한 뒤, 수신자의 편집이 양쪽 세션에 전달되고 소유자의 단건 조회에서도 동일한 revision과 본문으로 저장되는 것을 확인했다. 인라인 DB 변경과 편집→보기 권한 전환도 함께 검증했다.

## 현재 확장성 경계

- 초기 hydration은 N+1 요청을 제거했지만 페이지 목록은 현재 최대 500개, 댓글 bulk 목록은 최대 2,000개를 한 번에 읽는다. 데이터가 이 범위를 넘는 운영 단계에서는 cursor pagination과 점진적 hydration을 추가해야 한다.
- 프론트 production build는 통과하지만 BlockNote·Shiki를 포함한 초기 JavaScript 청크가 Vite의 500 kB 권고치를 넘는다. 단순 vendor 분리는 초기 전송량을 오히려 늘려 되돌렸으며, 이후 에디터/구문 강조를 실제 lazy route로 분리하는 작업이 필요하다.
