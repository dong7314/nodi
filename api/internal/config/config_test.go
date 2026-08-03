package config

import "testing"

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
