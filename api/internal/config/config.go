package config

import (
	"fmt"
	"net"
	"net/url"
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
	MinIOUseSSL         bool
	MinIOPublicUseSSL   bool
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
	RateLimitEnabled    bool
	TrustedProxyCIDRs   []string
	AutoMigrate         bool
}

func Load() (Config, error) {
	port := env("PORT", "8787")
	databaseURL, err := loadDatabaseURL()
	if err != nil {
		return Config{}, err
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
	minioEndpointHost := env("MINIO_ENDPOINT", "localhost")
	minioPort := env("MINIO_PORT", "9000")
	minioPublicEndpointHost := env("MINIO_PUBLIC_ENDPOINT", minioEndpointHost)
	minioPublicPort := env("MINIO_PUBLIC_PORT", minioPort)

	return Config{
		Address:             ":" + port,
		DatabaseURL:         databaseURL,
		PublicBaseURL:       strings.TrimRight(env("PUBLIC_BASE_URL", "http://localhost:"+port), "/"),
		CORSOrigins:         csvSet(env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174")),
		UploadDir:           env("UPLOAD_DIR", "./data/uploads"),
		AttachmentStore:     attachmentStore,
		MinIOEndpoint:       endpointWithPort(minioEndpointHost, minioPort),
		MinIOPublicEndpoint: endpointWithPort(minioPublicEndpointHost, minioPublicPort),
		MinIOAccessKey:      minioAccessKey,
		MinIOSecretKey:      minioSecretKey,
		MinIOBucket:         env("MINIO_BUCKET", "nodi-attachments"),
		MinIOUseSSL:         envBool("MINIO_USE_SSL", false),
		MinIOPublicUseSSL:   envBool("MINIO_PUBLIC_USE_SSL", envBool("MINIO_USE_SSL", false)),
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
		RateLimitEnabled:    envBool("RATE_LIMIT_ENABLED", true),
		TrustedProxyCIDRs:   csvList(os.Getenv("TRUSTED_PROXY_CIDRS")),
		AutoMigrate:         envBool("AUTO_MIGRATE", true),
	}, nil
}

func loadDatabaseURL() (string, error) {
	if databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL")); databaseURL != "" {
		return databaseURL, nil
	}

	databaseURL := strings.TrimSpace(os.Getenv("DB_URL"))
	username := strings.TrimSpace(os.Getenv("DB_USERNAME"))
	password := strings.TrimSpace(os.Getenv("DB_PASSWORD"))
	if databaseURL == "" || username == "" || password == "" {
		return "", fmt.Errorf("DATABASE_URL or DB_URL, DB_USERNAME, and DB_PASSWORD are required")
	}

	databaseURL = strings.TrimPrefix(databaseURL, "jdbc:")
	database, err := url.Parse(databaseURL)
	if err != nil {
		return "", fmt.Errorf("parse DB_URL: %w", err)
	}
	if database.Scheme != "postgres" && database.Scheme != "postgresql" {
		return "", fmt.Errorf("DB_URL must use jdbc:postgresql, postgresql, or postgres scheme")
	}
	if database.Host == "" || strings.Trim(database.Path, "/") == "" {
		return "", fmt.Errorf("DB_URL must include PostgreSQL host and database name")
	}
	database.Scheme = "postgres"
	database.User = url.UserPassword(username, password)
	query := database.Query()
	if query.Get("sslmode") == "" {
		query.Set("sslmode", env("DB_SSLMODE", "disable"))
	}
	database.RawQuery = query.Encode()
	return database.String(), nil
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

func endpointWithPort(endpoint, port string) string {
	endpoint = strings.TrimSpace(endpoint)
	port = strings.TrimSpace(port)
	if port == "" {
		return endpoint
	}
	if _, _, err := net.SplitHostPort(endpoint); err == nil {
		return endpoint
	}
	return net.JoinHostPort(endpoint, port)
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

func csvList(value string) []string {
	result := make([]string, 0)
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}
