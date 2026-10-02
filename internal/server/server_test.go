package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"plano/internal/live"
)

func post(t *testing.T, url, body string, headers map[string]string, out any) int {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

func TestWithoutDatabase(t *testing.T) {
	srv := httptest.NewServer(Handler(nil))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/info")
	if err != nil {
		t.Fatal(err)
	}
	var info struct{ Live bool }
	json.NewDecoder(res.Body).Decode(&info)
	res.Body.Close()
	if res.StatusCode != 200 || info.Live {
		t.Fatalf("info sem banco: %d %+v", res.StatusCode, info)
	}
	var e struct{ Error string }
	if code := post(t, srv.URL+"/api/explain", `{"sql":"SELECT 1"}`, nil, &e); code != 404 || !strings.Contains(e.Error, "desligado") {
		t.Fatalf("explain sem banco: %d %q", code, e.Error)
	}
	// The app itself is still served, including client-side routes.
	res, err = http.Get(srv.URL + "/exemplo/qualquer")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("rota do app: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
}

func TestLiveEndpoints(t *testing.T) {
	url := os.Getenv("PLANO_DATABASE_URL")
	if url == "" {
		url = "postgres://plano:plano@127.0.0.1:54330/loja"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	svc, err := live.Open(ctx, url)
	if err != nil {
		t.Skipf("banco de demonstração indisponível: %v", err)
	}
	defer svc.Close()
	srv := httptest.NewServer(Handler(svc))
	defer srv.Close()

	var ok struct {
		Plan []struct {
			Plan map[string]any `json:"Plan"`
		} `json:"plan"`
	}
	if code := post(t, srv.URL+"/api/explain", `{"sql":"SELECT * FROM pedidos WHERE id = 1"}`, nil, &ok); code != 200 || len(ok.Plan) != 1 {
		t.Fatalf("explain: %d %+v", code, ok)
	}
	var e struct{ Error string }
	if code := post(t, srv.URL+"/api/explain", `{"sql":"SELEC 1"}`, nil, &e); code != 422 || !strings.Contains(e.Error, "syntax error") {
		t.Fatalf("SQL inválido: %d %q", code, e.Error)
	}
	if code := post(t, srv.URL+"/api/explain", `{"sql":"SELECT 1","extra":true}`, nil, &e); code != 400 {
		t.Fatalf("campo desconhecido: %d", code)
	}
	// A page on another site must not be able to run SQL here.
	if code := post(t, srv.URL+"/api/explain", `{"sql":"SELECT 1"}`, map[string]string{"Origin": "https://evil.example"}, nil); code != 403 {
		t.Fatalf("outra origem: %d", code)
	}
	// Nor a plain HTML form, which can't send JSON.
	if code := post(t, srv.URL+"/api/explain", `sql=SELECT 1`, map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, nil); code != 415 {
		t.Fatalf("formulário: %d", code)
	}
	var trial struct {
		DDL    string `json:"ddl"`
		Before json.RawMessage
		After  json.RawMessage
	}
	body := `{"sql":"SELECT * FROM pedidos WHERE cliente_id = 4242","index":{"table":"pedidos","columns":[{"name":"cliente_id"}]}}`
	if code := post(t, srv.URL+"/api/try-index", body, nil, &trial); code != 200 || !strings.Contains(string(trial.After), "plano_indice_de_teste") {
		t.Fatalf("try-index: %d %s", code, trial.DDL)
	}
}
