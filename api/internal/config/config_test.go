package config

import (
	"net/url"
	"testing"
)

func TestLoadRejectsIncompleteMinIOConfiguration(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("ATTACHMENT_STORAGE", "minio")
	t.Setenv("MINIO_ACCESS_KEY", "")
	t.Setenv("MINIO_SECRET_KEY", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected missing MinIO credentials to fail")
	}
}

func TestLoadSupportsLocalAttachmentStorage(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("ATTACHMENT_STORAGE", "local")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AttachmentStore != "local" {
		t.Fatalf("unexpected attachment store: %s", cfg.AttachmentStore)
	}
}

func TestLoadParsesKubernetesProxySettings(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("ATTACHMENT_STORAGE", "local")
	t.Setenv("RATE_LIMIT_ENABLED", "false")
	t.Setenv("TRUSTED_PROXY_CIDRS", "10.42.0.0/16, 10.43.0.0/16")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RateLimitEnabled || len(cfg.TrustedProxyCIDRs) != 2 {
		t.Fatalf("unexpected proxy settings: %#v", cfg.TrustedProxyCIDRs)
	}
}

func TestLoadComposesMinIOEndpointFromHostAndPort(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("ATTACHMENT_STORAGE", "minio")
	t.Setenv("MINIO_ENDPOINT", "api-minio.ldy-studio.com")
	t.Setenv("MINIO_PORT", "443")
	t.Setenv("MINIO_PUBLIC_ENDPOINT", "")
	t.Setenv("MINIO_PUBLIC_PORT", "")
	t.Setenv("MINIO_ACCESS_KEY", "test-access-key")
	t.Setenv("MINIO_SECRET_KEY", "test-secret-key")
	t.Setenv("MINIO_USE_SSL", "true")
	t.Setenv("MINIO_PUBLIC_USE_SSL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MinIOEndpoint != "api-minio.ldy-studio.com:443" {
		t.Fatalf("unexpected MinIO endpoint: %s", cfg.MinIOEndpoint)
	}
	if cfg.MinIOPublicEndpoint != cfg.MinIOEndpoint {
		t.Fatalf("public endpoint must fall back to MinIO endpoint: %s", cfg.MinIOPublicEndpoint)
	}
	if !cfg.MinIOUseSSL || !cfg.MinIOPublicUseSSL {
		t.Fatal("public and internal MinIO clients must use SSL")
	}
}

func TestEndpointWithPortKeepsExistingPort(t *testing.T) {
	if endpoint := endpointWithPort("minio:9000", "443"); endpoint != "minio:9000" {
		t.Fatalf("unexpected endpoint: %s", endpoint)
	}
}

func TestLoadBuildsDatabaseURLFromJDBCSettings(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("DB_URL", "jdbc:postgresql://postgres-postgresql.postgres.svc.cluster.local:5432/nodi")
	t.Setenv("DB_USERNAME", "postgres")
	t.Setenv("DB_PASSWORD", "password:with@reserved/characters")
	t.Setenv("DB_SSLMODE", "require")
	t.Setenv("ATTACHMENT_STORAGE", "local")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	password, hasPassword := parsed.User.Password()
	if parsed.User.Username() != "postgres" || !hasPassword || password != "password:with@reserved/characters" {
		t.Fatalf("unexpected database credentials: %s", parsed.User.String())
	}
	if parsed.Hostname() != "postgres-postgresql.postgres.svc.cluster.local" || parsed.Port() != "5432" {
		t.Fatalf("unexpected database host: %s", parsed.Host)
	}
	if parsed.Path != "/nodi" || parsed.Query().Get("sslmode") != "require" {
		t.Fatalf("unexpected database target: %s", parsed.String())
	}
}
