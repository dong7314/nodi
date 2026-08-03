package config

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Address             string
	DatabaseURL         string
	PublicBaseURL       string
	CORSOrigins         map[string]struct{}
	UploadDir           string
	AttachmentStore     string
	MinIOEndpoint       string
	MinIOPublicEndpoint string
	MinIOAccessKey      string
	MinIOSecretKey      string
	MinIOBucket         string
	MinIORegion         string
	MinIOUseSSL         bool
	MinIOPublicUseSSL   bool
	MinIOPresignTTL     time.Duration
	SessionTTL          time.Duration
	RequestTimeout      time.Duration
	ShutdownTimeout     time.Duration
	MaxBodyBytes        int64
	MaxImageBytes       int64
	MaxFileBytes        int64
	MaxDatabaseConns    int32
	MinDatabaseConns    int32
	MaxInFlight         int
	RateLimitPerMinute  int
	RateLimitBurst      int
	AutoMigrate         bool
}

func Load() (Config, error) {
	port := env("PORT", "8787")
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}

	maxConns := int32(envInt("DB_MAX_CONNS", min(max(runtime.GOMAXPROCS(0)*2, 4), 20)))
	minConns := int32(envInt("DB_MIN_CONNS", min(2, int(maxConns))))
	if minConns > maxConns {
		minConns = maxConns
	}

	attachmentStore := strings.ToLower(env("ATTACHMENT_STORAGE", "local"))
	if attachmentStore != "local" && attachmentStore != "minio" {
		return Config{}, fmt.Errorf("ATTACHMENT_STORAGE must be local or minio")
	}
	minioAccessKey := strings.TrimSpace(os.Getenv("MINIO_ACCESS_KEY"))
	minioSecretKey := strings.TrimSpace(os.Getenv("MINIO_SECRET_KEY"))
	if attachmentStore == "minio" && (minioAccessKey == "" || minioSecretKey == "") {
		return Config{}, fmt.Errorf("MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required when ATTACHMENT_STORAGE=minio")
	}

	return Config{
		Address:             ":" + port,
		DatabaseURL:         databaseURL,
		PublicBaseURL:       strings.TrimRight(env("PUBLIC_BASE_URL", "http://localhost:"+port), "/"),
		CORSOrigins:         csvSet(env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174")),
		UploadDir:           env("UPLOAD_DIR", "./data/uploads"),
		AttachmentStore:     attachmentStore,
		MinIOEndpoint:       env("MINIO_ENDPOINT", "localhost:9000"),
		MinIOPublicEndpoint: env("MINIO_PUBLIC_ENDPOINT", env("MINIO_ENDPOINT", "localhost:9000")),
		MinIOAccessKey:      minioAccessKey,
		MinIOSecretKey:      minioSecretKey,
		MinIOBucket:         env("MINIO_BUCKET", "nodi-attachments"),
		MinIORegion:         env("MINIO_REGION", "us-east-1"),
		MinIOUseSSL:         envBool("MINIO_USE_SSL", false),
		MinIOPublicUseSSL:   envBool("MINIO_PUBLIC_USE_SSL", envBool("MINIO_USE_SSL", false)),
		MinIOPresignTTL:     time.Duration(envInt("MINIO_PRESIGN_MINUTES", 15)) * time.Minute,
		SessionTTL:          time.Duration(envInt("SESSION_DAYS", 30)) * 24 * time.Hour,
		RequestTimeout:      time.Duration(envInt("REQUEST_TIMEOUT_SECONDS", 15)) * time.Second,
		ShutdownTimeout:     time.Duration(envInt("SHUTDOWN_TIMEOUT_SECONDS", 10)) * time.Second,
		MaxBodyBytes:        int64(envInt("MAX_JSON_MB", 10)) * 1024 * 1024,
		MaxImageBytes:       int64(envInt("MAX_IMAGE_MB", 20)) * 1024 * 1024,
		MaxFileBytes:        int64(envInt("MAX_FILE_MB", 100)) * 1024 * 1024,
		MaxDatabaseConns:    maxConns,
		MinDatabaseConns:    minConns,
		MaxInFlight:         envInt("MAX_IN_FLIGHT", 256),
		RateLimitPerMinute:  envInt("RATE_LIMIT_PER_MINUTE", 300),
		RateLimitBurst:      envInt("RATE_LIMIT_BURST", 120),
		AutoMigrate:         envBool("AUTO_MIGRATE", true),
	}, nil
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func csvSet(value string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result[item] = struct{}{}
		}
	}
	return result
}
