# Nodi API

Nodi 프론트엔드의 로컬 저장 기능을 서버 데이터로 전환하기 위한 Go REST API입니다. 구조화된 데이터는 PostgreSQL에, 이미지와 파일 객체는 private MinIO 버킷에 저장하며 SQLite나 Node.js 런타임은 필요하지 않습니다.

## 기술 구성

- Go 1.24, `net/http`, Chi
- PostgreSQL 16+, pgx 연결 풀과 직접 작성한 SQL
- 내장 SQL 마이그레이션
- HTTP-only 세션 쿠키
- bcrypt 비밀번호 해시, SHA-256 세션·파일 토큰 해시
- private MinIO 버킷과 presigned PUT 업로드. 개발용 로컬 디스크 저장도 선택할 수 있습니다.

## 빠른 실행

Docker가 실행 중이면 아래 명령 하나로 PostgreSQL, MinIO와 API를 시작할 수 있습니다.

```bash
cd api
docker compose up --build
```

상태 확인 주소는 `GET http://localhost:8787/health`입니다. Kubernetes probe는 프로세스 liveness용 `/live`와 PostgreSQL readiness용 `/ready`를 구분해서 사용할 수 있습니다. MinIO 콘솔은 `http://localhost:9001`입니다. 개발 중 Go 서버를 직접 실행하려면 PostgreSQL과 MinIO를 먼저 시작한 뒤 환경 변수를 설정합니다.

PowerShell에서는 다음처럼 실행할 수 있습니다.

```powershell
cd api
$env:DATABASE_URL="postgres://nodi:nodi@localhost:5432/nodi?sslmode=disable"
go run ./cmd/server
```

Go 프로그램은 `.env` 파일을 자동으로 읽지 않습니다. 셸이나 실행 구성에서 `.env.example`의 값을 환경 변수로 전달해야 합니다. `DATABASE_URL`은 필수입니다. `AUTO_MIGRATE=true`이면 시작할 때 아직 적용되지 않은 마이그레이션만 실행합니다.

## 부하를 낮추는 설계

- DB 연결 수는 기본적으로 CPU 수의 2배, 최소 4개·최대 20개이며 운영 환경에서는 `DB_MAX_CONNS`로 더 작게 제한할 수 있습니다.
- `MAX_IN_FLIGHT`를 넘는 요청은 대기열을 무한히 늘리지 않고 즉시 `503`으로 응답합니다.
- IP별 요청 제한은 기본 1분 300회, 초기 burst 120회이며 `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST`로 조절할 수 있습니다. Docker Compose 개발 환경은 새로고침과 HMR 요청을 고려해 각각 600회, 240회를 사용합니다. 신뢰하지 않은 `X-Forwarded-For`는 사용하지 않습니다.
- 페이지 목록은 기본적으로 본문 블록을 제외하고 keyset pagination으로 조회합니다. 초기 동기화처럼 왕복 횟수를 줄여야 할 때만 `includeBlocks=true`를 사용합니다.
- 검색은 PostgreSQL `tsvector`와 GIN 인덱스를 사용합니다.
- 첨부파일 업로드와 다운로드는 파일 전체를 메모리에 올리지 않고 스트리밍합니다. 24시간 이상 완료되지 않은 업로드 메타데이터와 객체는 주기적으로 정리합니다.
- 서버 종료 시 새 요청을 중단하고 처리 중인 요청과 DB 연결을 정리합니다.

## 인증 정책

최초 가입자는 PostgreSQL advisory lock으로 단 한 명만 관리자 승인을 받습니다. 이후 가입자는 `pending` 상태가 되고 관리자가 승인하거나 거절합니다. 로그인 성공 시 세션은 `HttpOnly`, `SameSite=Lax` 쿠키로만 전달하며 응답 본문이나 브라우저 저장소에 원본 세션 토큰을 노출하지 않습니다.

## API 범위

모든 일반 성공 응답은 `{ "data": ... }`, 오류는 `{ "error": { "code", "message", "details?" } }` 형태입니다. 첨부파일 presign/complete 응답은 기존 프론트엔드 업로드 계약에 맞게 필드를 최상위에 둡니다.

- 계정: 가입, 로그인·로그아웃, 내 프로필, 비밀번호 변경, 가입 승인, 공유 대상 검색
- 개인 홈: 사용자별 전용 저장, revision 충돌 검사, 서버 수준 비공개 보장
- 페이지: 목록·단건·생성·수정·삭제, 블록 저장, 즐겨찾기, 전체 검색, 공개 페이지
- 폴더: 트리 목록·생성·수정·삭제, 순환 구조 방지
- 공유: 페이지별 보기·편집 권한, 동일 원본 페이지의 WebSocket 실시간 변경 전달
- 댓글: 블록 스레드, 2단계 답글, 해결 상태, 개별 댓글·스레드 삭제 권한
- 받은편지함: 공유·댓글 알림, 읽음 상태, 전체 읽음, 삭제
- 인라인 데이터베이스: 상태 JSON과 revision 충돌 검사
- 워크스페이스: 시작 프리셋 최대 5개, 태그 CRUD
- 사용자 설정: 테마 등 계정별 환경 설정 JSON과 revision
- 첨부파일: MinIO 서명 URL, 크기·MIME 완료 검증, 안정적인 토큰 조회 URL, 삭제

프론트엔드 기능과 API의 상세 대조 결과는 [기능 감사 문서](./docs/frontend-backend-audit.md)에 정리되어 있습니다.

자세한 경로는 [라우터](./internal/api/server.go)를 기준으로 관리합니다.

## 검증

```bash
go test ./...
go vet ./...
```

Docker Compose는 개발 기본값을 사용합니다. 운영에서는 반드시 DB 비밀번호, `DATABASE_URL`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, 볼륨 백업 정책을 별도로 설정하고 TLS를 적용해야 합니다.
