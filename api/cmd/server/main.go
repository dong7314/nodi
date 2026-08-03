package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nodi-app/nodi/api/internal/api"
	"github.com/nodi-app/nodi/api/internal/config"
	"github.com/nodi-app/nodi/api/internal/database"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	startupContext, cancelStartup := context.WithTimeout(context.Background(), 15*time.Second)
	pool, err := database.Open(startupContext, cfg)
	cancelStartup()
	if err != nil {
		logger.Error("database startup failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	apiServer, err := api.NewServer(pool, cfg)
	if err != nil {
		logger.Error("api startup failed", "error", err)
		os.Exit(1)
	}
	httpServer := &http.Server{
		Addr:              cfg.Address,
		Handler:           apiServer,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	shutdownSignal, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdownSignal.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		if err := httpServer.Shutdown(shutdownContext); err != nil {
			logger.Error("graceful shutdown failed", "error", err)
		}
	}()

	logger.Info("nodi api listening", "address", cfg.Address, "db_max_connections", cfg.MaxDatabaseConns)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("http server stopped unexpectedly", "error", err)
		os.Exit(1)
	}
	logger.Info("nodi api stopped")
}
