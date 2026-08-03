# Nodi k3s manifests

이 디렉터리는 이미 운영 중인 PostgreSQL과 MinIO를 사용하고, Nodi UI와 백엔드만 k3s에 배포합니다. Kustomize는 사용하지 않으며 각 리소스를 순수 Kubernetes YAML로 분리했습니다.

## 디렉터리 구성

```text
deploy/
├─ ui/
│  ├─ configmap.yaml
│  ├─ deployment.yaml
│  ├─ service.yaml
│  └─ ingress.yaml
└─ backend/
   ├─ configmap.yaml
   ├─ secret.example.yaml
   ├─ deployment.yaml
   ├─ service.yaml
   └─ ingress.yaml
```

UI는 Secret이 필요하지 않습니다. 브라우저에 공개되어도 되는 런타임 값만 ConfigMap의 `runtime-config.js`로 전달합니다.

## 배포 전에 변경할 값

1. 두 `ingress.yaml`과 두 `configmap.yaml`의 `nodi.example.com`을 실제 UI 도메인으로 바꿉니다.
2. `backend/configmap.yaml`의 `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_BUCKET`, `MINIO_USE_SSL`을 기존 MinIO 값으로 바꿉니다. `MINIO_ENDPOINT`에는 `https://`를 붙이지 않습니다.
3. 현재처럼 같은 외부 MinIO 주소를 API 연결과 presigned URL에 모두 사용한다면 `MINIO_PUBLIC_*` 설정은 필요하지 않습니다. 내부 접속 주소와 브라우저 접속 주소가 다를 때만 `MINIO_PUBLIC_ENDPOINT`, `MINIO_PUBLIC_PORT`, `MINIO_PUBLIC_USE_SSL`을 추가합니다.
4. 기존 MinIO의 대상 버킷을 비공개로 유지하고 UI origin을 CORS에 허용합니다.
5. `backend/secret.example.yaml`을 `backend/secret.yaml`로 복사하고 기존 `DB_URL`, `DB_USERNAME`, `DB_PASSWORD`와 MinIO 자격 증명을 입력합니다.
6. 현재 두 Deployment는 Harbor의 `test` 태그와 `imagePullPolicy: Always`를 사용합니다. 운영 배포에서는 커밋 SHA 같은 불변 태그와 `IfNotPresent`로 변경합니다.
7. `nodi-tls` TLS Secret을 미리 생성하거나 cert-manager로 발급합니다.

MinIO 자격 증명은 root 계정 대신 대상 버킷에 `ListBucket`, `GetObject`, `PutObject`, `DeleteObject`만 허용한 애플리케이션 계정을 사용합니다.

기존에 사용하던 다음 형식은 백엔드에서 그대로 지원합니다.

```yaml
MINIO_ENDPOINT: "api-minio.ldy-studio.com"
MINIO_PORT: "443"
MINIO_BUCKET: "nodi"
MINIO_USE_SSL: "true"
```

`MINIO_ACCESS_KEY`와 `MINIO_SECRET_KEY`만 `backend/secret.yaml`에 둡니다. 백엔드는 endpoint와 port를 `api-minio.ldy-studio.com:443`으로 조합하고, 별도의 `MINIO_PUBLIC_ENDPOINT`가 없으면 동일한 주소로 presigned URL을 생성합니다.

`MINIO_REGION`과 `MINIO_PRESIGN_MINUTES`는 외부 환경변수 항목에서 제거했습니다. MinIO 호환 region과 presigned URL 만료시간은 백엔드 내부값인 `us-east-1`, `15분`을 사용합니다. DB 풀, 타임아웃, 파일 용량 제한, 세션 기간 등도 기본값을 사용하므로 ConfigMap에 반복해서 적지 않습니다.

### TRUSTED_PROXY_CIDRS

CIDR은 Kubernetes 배포나 MinIO 연결에 필수값이 아닙니다. Traefik을 통과한 실제 사용자 IP를 신뢰해 백엔드에서 사용자별 rate limit을 적용할 때만 필요합니다. 현재 배포는 `RATE_LIMIT_ENABLED: "false"`로 설정했으므로 `TRUSTED_PROXY_CIDRS`를 제거했습니다. 추후 백엔드 rate limit을 활성화할 때만 실제 Traefik 네트워크 범위를 함께 설정하면 됩니다.

### AUTO_MIGRATE

백엔드 시작 시 필요한 PostgreSQL 테이블과 인덱스를 자동으로 준비할지 결정합니다. 배포 YAML에서는 제거했지만 백엔드 기본값은 `true`이므로 현재 동작은 그대로입니다. 추후 운영에서 DB migration을 별도 Job이나 CI/CD 단계로 분리한 경우에만 `AUTO_MIGRATE: "false"`를 명시하면 됩니다.

## 이미지 빌드

저장소 루트에서 실행합니다.

```bash
docker build -t harbor.ldy-studio.com/nodi/frontend:test ./ui
docker build -t harbor.ldy-studio.com/nodi/backend:test ./api
docker push harbor.ldy-studio.com/nodi/frontend:test
docker push harbor.ldy-studio.com/nodi/backend:test
```

## Secret 준비

```bash
cp deploy/backend/secret.example.yaml deploy/backend/secret.yaml
```

`secret.yaml`의 다섯 값을 실제 값으로 교체합니다.

- `DB_URL`: 기존 JDBC 형식 PostgreSQL 주소
- `DB_USERNAME`: 기존 PostgreSQL 사용자명
- `DB_PASSWORD`: 기존 PostgreSQL 비밀번호
- `MINIO_ACCESS_KEY`: 기존 MinIO 애플리케이션 access key
- `MINIO_SECRET_KEY`: 기존 MinIO 애플리케이션 secret key

백엔드가 `jdbc:postgresql://...` 주소를 Go PostgreSQL 형식으로 변환하고 계정 정보를 안전하게 조합하므로 비밀번호를 직접 URL 인코딩할 필요가 없습니다. 기존 `DATABASE_URL` 방식도 하위 호환을 위해 계속 지원합니다. 실제 `secret.yaml`은 Git에 저장하지 않습니다.

## 순수 YAML 배포 순서

네임스페이스가 없다면 한 번만 생성합니다.

```bash
kubectl create namespace nodi
```

백엔드부터 적용합니다.

```bash
kubectl apply -f deploy/backend/configmap.yaml
kubectl apply -f deploy/backend/secret.yaml
kubectl apply -f deploy/backend/deployment.yaml
kubectl apply -f deploy/backend/service.yaml
kubectl apply -f deploy/backend/ingress.yaml
```

UI를 적용합니다.

```bash
kubectl apply -f deploy/ui/configmap.yaml
kubectl apply -f deploy/ui/deployment.yaml
kubectl apply -f deploy/ui/service.yaml
kubectl apply -f deploy/ui/ingress.yaml
```

## 확인

```bash
kubectl -n nodi rollout status deployment/nodi-backend
kubectl -n nodi rollout status deployment/nodi-ui
kubectl -n nodi get pods,svc,ingress
curl -fsS https://nodi.example.com/v1/live
curl -fsS https://nodi.example.com/v1/ready
```

Ingress는 `/v1`을 rewrite하지 않고 그대로 백엔드에 전달합니다. WebSocket 실시간 경로도 `/v1/pages/<PAGE_ID>/realtime`로 전달됩니다.

ConfigMap이나 Secret을 바꾼 뒤에는 Deployment를 다시 시작합니다.

```bash
kubectl -n nodi rollout restart deployment/nodi-backend
kubectl -n nodi rollout restart deployment/nodi-ui
```

현재 실시간 편집 room이 백엔드 프로세스 메모리에 있으므로 백엔드는 1 replica로 유지해야 합니다. Redis나 NATS 기반 공용 Pub/Sub을 추가한 뒤에 여러 replica로 확장할 수 있습니다.
