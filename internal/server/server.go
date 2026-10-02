// Package server serves the app and, when a database is configured, the
// live endpoints.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"plano/internal/live"
	"plano/ui"
)

// Handler builds the routes. svc is nil when no database was given: the app
// still works for pasted plans, which are analysed entirely in the browser.
func Handler(svc *live.Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/info", func(w http.ResponseWriter, r *http.Request) {
		if svc == nil {
			writeJSON(w, http.StatusOK, map[string]any{"live": false})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		info, err := svc.Describe(ctx)
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"live": true, "database": info})
	})
	mux.HandleFunc("POST /api/explain", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			SQL string `json:"sql"`
		}
		if !decode(w, r, svc, &in) {
			return
		}
		plan, err := svc.Explain(r.Context(), in.SQL)
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"plan": plan})
	})
	mux.HandleFunc("POST /api/try-index", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			SQL   string         `json:"sql"`
			Index live.IndexSpec `json:"index"`
		}
		if !decode(w, r, svc, &in) {
			return
		}
		trial, err := svc.TryIndex(r.Context(), in.SQL, in.Index)
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, trial)
	})
	mux.Handle("/", spa())
	return secure(mux)
}

// decode reads the request body, refusing when the live mode is off.
func decode(w http.ResponseWriter, r *http.Request, svc *live.Service, dst any) bool {
	if svc == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "o modo ao vivo está desligado: inicie com -db"})
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, live.MaxSQL+4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido: " + err.Error()})
		return false
	}
	return true
}

// fail shows the user their own mistakes (bad SQL) and hides everything else.
func fail(w http.ResponseWriter, err error) {
	var ue *live.UserError
	switch {
	case errors.As(err, &ue):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": ue.Message})
	case errors.Is(err, context.Canceled):
	case errors.Is(err, context.DeadlineExceeded):
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "a consulta demorou demais"})
	default:
		slog.Error("erro interno", "erro", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "erro ao falar com o banco"})
	}
}

func secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:")
		// The live endpoints run SQL: only this app's own pages may call them.
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			origin := r.Header.Get("Origin")
			if origin != "" && origin != "http://"+r.Host && origin != "https://"+r.Host {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "origem não permitida"})
				return
			}
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "envie application/json"})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// spa serves the embedded frontend with a fallback to index.html.
func spa() http.Handler {
	dist, err := fs.Sub(ui.Dist, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if strings.HasPrefix(p, "api/") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "rota não encontrada, ou o modo ao vivo está desligado"})
			return
		}
		if p != "" {
			if _, err := fs.Stat(dist, p); err == nil {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		index, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			http.Error(w, "frontend não compilado: rode .\\run.ps1", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(index)
	})
}
