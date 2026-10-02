// Command plano serves the query-plan explorer. With -db it also runs
// EXPLAIN against that database and tries out indexes.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"time"

	"plano/internal/live"
	"plano/internal/server"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7676", "endereço HTTP")
	db := flag.String("db", os.Getenv("PLANO_DATABASE_URL"), "URL do Postgres para o modo ao vivo (ou PLANO_DATABASE_URL)")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "plano — explorador de planos de consulta do Postgres")
		fmt.Fprintln(os.Stderr, "\nuso: plano [-addr 127.0.0.1:7676] [-db postgres://usuario:senha@host:porta/banco]")
		fmt.Fprintln(os.Stderr)
		flag.PrintDefaults()
		fmt.Fprintln(os.Stderr, "\nSem -db, o plano analisa o que você colar. Com -db, também executa EXPLAIN e testa índices.")
	}
	flag.Parse()
	if err := run(*addr, *db); err != nil {
		fmt.Fprintln(os.Stderr, "erro:", err)
		os.Exit(1)
	}
}

func run(addr, db string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var svc *live.Service
	if db != "" {
		openCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		s, err := live.Open(openCtx, db)
		cancel()
		if err != nil {
			return err
		}
		defer s.Close()
		svc = s
	}

	srv := &http.Server{Addr: addr, Handler: server.Handler(svc), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	slog.Info("plano ouvindo", "url", "http://"+addr, "ao_vivo", svc != nil)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
