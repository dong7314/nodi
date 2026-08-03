package api

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/nodi-app/nodi/api/internal/config"
)

type Server struct {
	pool                  *pgxpool.Pool
	config                config.Config
	router                http.Handler
	limiter               *ipLimiter
	inFlight              chan struct{}
	minio                 *minio.Client
	minioPublic           *minio.Client
	attachmentCleanupMu   sync.Mutex
	lastAttachmentCleanup time.Time
	realtime              *pageRealtimeHub
}

func NewServer(pool *pgxpool.Pool, cfg config.Config) (*Server, error) {
	s := &Server{
		pool:     pool,
		config:   cfg,
		limiter:  newIPLimiter(cfg.RateLimitPerMinute, cfg.RateLimitBurst),
		inFlight: make(chan struct{}, cfg.MaxInFlight),
		realtime: newPageRealtimeHub(),
	}
	if cfg.AttachmentStore == "minio" {
		var err error
		s.minio, err = minio.New(cfg.MinIOEndpoint, &minio.Options{
			Creds:  credentials.NewStaticV4(cfg.MinIOAccessKey, cfg.MinIOSecretKey, ""),
			Secure: cfg.MinIOUseSSL,
			Region: cfg.MinIORegion,
		})
		if err != nil {
			return nil, fmt.Errorf("create MinIO client: %w", err)
		}
		s.minioPublic, err = minio.New(cfg.MinIOPublicEndpoint, &minio.Options{
			Creds:  credentials.NewStaticV4(cfg.MinIOAccessKey, cfg.MinIOSecretKey, ""),
			Secure: cfg.MinIOPublicUseSSL,
			Region: cfg.MinIORegion,
		})
		if err != nil {
			return nil, fmt.Errorf("create public MinIO signer: %w", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		exists, err := s.minio.BucketExists(ctx, cfg.MinIOBucket)
		if err != nil {
			return nil, fmt.Errorf("check MinIO bucket: %w", err)
		}
		if !exists {
			if err = s.minio.MakeBucket(ctx, cfg.MinIOBucket, minio.MakeBucketOptions{Region: cfg.MinIORegion}); err != nil {
				return nil, fmt.Errorf("create MinIO bucket: %w", err)
			}
		}
	}
	cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelCleanup()
	if err := s.cleanupStaleAttachments(cleanupContext, time.Now().Add(-24*time.Hour), 1000); err != nil {
		return nil, fmt.Errorf("clean stale attachments: %w", err)
	}
	s.lastAttachmentCleanup = time.Now()
	s.router = s.routes()
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.router.ServeHTTP(w, r)
}

func (s *Server) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(middleware.NoCache)
	r.Use(s.securityHeaders)
	r.Use(s.cors)
	r.Use(s.limiter.middleware)
	r.Use(s.limitConcurrency)

	r.Get("/health", s.health)
	r.Get("/v1/public/pages/{pageID}", s.getPublicPage)
	r.Put("/v1/attachments/{attachmentID}/content", s.uploadAttachmentContent)
	r.Get("/v1/attachments/{attachmentID}/content", s.downloadAttachmentContent)

	r.Route("/v1/auth", func(r chi.Router) {
		r.Post("/register", s.register)
		r.Post("/login", s.login)
		r.Group(func(r chi.Router) {
			r.Use(s.requireAuth)
			r.Post("/logout", s.logout)
			r.Get("/me", s.getMe)
			r.Patch("/me", s.updateMe)
			r.Post("/change-password", s.changePassword)
			r.Get("/users", s.searchUsers)
			r.Group(func(r chi.Router) {
				r.Use(s.requireAdmin)
				r.Get("/registration-requests", s.listRegistrationRequests)
				r.Patch("/registration-requests/{userID}", s.decideRegistrationRequest)
			})
		})
	})

	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Get("/v1/home", s.getHomePage)
		r.Put("/v1/home", s.updateHomePage)
		r.Get("/v1/preferences", s.getPreferences)
		r.Put("/v1/preferences", s.updatePreferences)
		r.Get("/v1/pages", s.listPages)
		r.Post("/v1/pages", s.createPage)
		r.Get("/v1/pages/{pageID}", s.getPage)
		r.Get("/v1/pages/{pageID}/realtime", s.pageRealtime)
		r.Patch("/v1/pages/{pageID}", s.updatePage)
		r.Delete("/v1/pages/{pageID}", s.deletePage)
		r.Put("/v1/pages/{pageID}/blocks", s.updatePageBlocks)
		r.Put("/v1/pages/{pageID}/favorite", s.setPageFavorite)
		r.Get("/v1/search", s.searchPages)

		r.Get("/v1/folders", s.listFolders)
		r.Post("/v1/folders", s.createFolder)
		r.Patch("/v1/folders/{folderID}", s.updateFolder)
		r.Delete("/v1/folders/{folderID}", s.deleteFolder)

		r.Get("/v1/pages/{pageID}/comments", s.listComments)
		r.Get("/v1/comments", s.listAllComments)
		r.Post("/v1/pages/{pageID}/comments", s.createCommentThread)
		r.Post("/v1/comments/{threadID}/messages", s.addCommentMessage)
		r.Patch("/v1/comments/{threadID}", s.resolveCommentThread)
		r.Delete("/v1/comments/{threadID}", s.deleteCommentThread)
		r.Delete("/v1/comments/{threadID}/messages/{messageID}", s.deleteCommentMessage)

		r.Get("/v1/notifications", s.listNotifications)
		r.Post("/v1/notifications/read-all", s.readAllNotifications)
		r.Patch("/v1/notifications/{notificationID}", s.updateNotification)
		r.Delete("/v1/notifications/{notificationID}", s.deleteNotification)

		r.Get("/v1/pages/{pageID}/shares", s.listPageShares)
		r.Get("/v1/shares", s.listAllPageShares)
		r.Put("/v1/pages/{pageID}/shares/{userID}", s.setPageShare)
		r.Delete("/v1/pages/{pageID}/shares/{userID}", s.deletePageShare)

		r.Get("/v1/databases/{databaseID}", s.getInlineDatabase)
		r.Put("/v1/databases/{databaseID}", s.putInlineDatabase)
		r.Delete("/v1/databases/{databaseID}", s.deleteInlineDatabase)

		r.Post("/v1/attachments/presign", s.presignAttachment)
		r.Post("/v1/attachments/{attachmentID}/complete", s.completeAttachment)
		r.Delete("/v1/attachments/{attachmentID}", s.deleteAttachment)

		r.Get("/v1/presets", s.listPresets)
		r.Post("/v1/presets", s.createPreset)
		r.Patch("/v1/presets/{presetID}", s.updatePreset)
		r.Delete("/v1/presets/{presetID}", s.deletePreset)
		r.Get("/v1/tags", s.listTags)
		r.Post("/v1/tags", s.createTag)
		r.Patch("/v1/tags/{tagID}", s.updateTag)
		r.Delete("/v1/tags/{tagID}", s.deleteTag)
	})

	return r
}

func (s *Server) limitConcurrency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A WebSocket request remains open while the page is being edited. It
		// must not occupy one of the short-lived HTTP request slots, otherwise a
		// few editors could make every regular API request return SERVER_BUSY.
		if strings.HasSuffix(r.URL.Path, "/realtime") {
			next.ServeHTTP(w, r)
			return
		}
		select {
		case s.inFlight <- struct{}{}:
			defer func() { <-s.inFlight }()
			next.ServeHTTP(w, r)
		default:
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusServiceUnavailable, "SERVER_BUSY", "서버가 처리할 수 있는 동시 요청 수를 초과했습니다.", nil)
		}
	})
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 2*time.Second)
	defer cancel()
	if err := s.pool.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "DATABASE_UNAVAILABLE", "데이터베이스에 연결할 수 없습니다.", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok", "service": "nodi-api", "time": time.Now().UTC(),
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			_, exact := s.config.CORSOrigins[origin]
			_, wildcard := s.config.CORSOrigins["*"]
			if !exact && !wildcard {
				writeError(w, http.StatusForbidden, "CORS_ORIGIN_DENIED", "허용되지 않은 요청 출처입니다.", nil)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Request-ID")
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type ipBucket struct {
	window   time.Time
	count    int
	lastSeen time.Time
}

type ipLimiter struct {
	mu          sync.Mutex
	clients     map[string]*ipBucket
	perMinute   int
	burst       int
	lastCleanup time.Time
}

func newIPLimiter(perMinute, burst int) *ipLimiter {
	return &ipLimiter{clients: make(map[string]*ipBucket), perMinute: perMinute, burst: burst, lastCleanup: time.Now()}
}

func (l *ipLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.allow(clientIP(r), time.Now()) {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (l *ipLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastCleanup) > time.Minute {
		for key, bucket := range l.clients {
			if now.Sub(bucket.lastSeen) > 5*time.Minute {
				delete(l.clients, key)
			}
		}
		l.lastCleanup = now
	}
	bucket := l.clients[ip]
	if bucket == nil || now.Sub(bucket.window) >= time.Minute {
		l.clients[ip] = &ipBucket{window: now, count: 1, lastSeen: now}
		return true
	}
	bucket.lastSeen = now
	limit := l.perMinute
	if now.Sub(bucket.window) < 10*time.Second {
		limit = l.burst
	}
	if bucket.count >= limit {
		return false
	}
	bucket.count++
	return true
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}
