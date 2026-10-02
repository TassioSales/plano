package live

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

var ctx = context.Background()

// open connects to the demo database, skipping the test when it is not up.
func open(t *testing.T) *Service {
	t.Helper()
	url := os.Getenv("PLANO_DATABASE_URL")
	if url == "" {
		url = "postgres://plano:plano@127.0.0.1:54330/loja"
	}
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	s, err := Open(c, url)
	if err != nil {
		t.Skipf("banco de demonstração indisponível (%v): rode `docker compose up -d --wait`", err)
	}
	t.Cleanup(s.Close)
	return s
}

type planJSON []struct {
	Plan struct {
		NodeType string `json:"Node Type"`
		Index    string `json:"Index Name"`
	} `json:"Plan"`
	Execution float64 `json:"Execution Time"`
}

func decode(t *testing.T, raw json.RawMessage) planJSON {
	t.Helper()
	var p planJSON
	if err := json.Unmarshal(raw, &p); err != nil || len(p) != 1 {
		t.Fatalf("plano inesperado: %v %s", err, raw)
	}
	return p
}

func indexes(t *testing.T, s *Service) int {
	t.Helper()
	var n int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func produtos(t *testing.T, s *Service) {
	t.Helper()
	var n int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM produtos").Scan(&n); err != nil || n != 20000 {
		t.Fatalf("a tabela produtos foi afetada: %d %v", n, err)
	}
}

func wantUserError(t *testing.T, err error, contains string) {
	t.Helper()
	var ue *UserError
	if !errors.As(err, &ue) || !strings.Contains(ue.Message, contains) {
		t.Fatalf("erro = %v, queria um UserError contendo %q", err, contains)
	}
}

func TestExplain(t *testing.T) {
	s := open(t)
	raw, err := s.Explain(ctx, "SELECT * FROM clientes WHERE email = 'cliente7@exemplo.com.br';")
	if err != nil {
		t.Fatal(err)
	}
	p := decode(t, raw)
	if p[0].Plan.NodeType == "" || p[0].Execution <= 0 {
		t.Fatalf("plano sem medições: %s", raw)
	}
}

func TestExplainRefusesWhatItShould(t *testing.T) {
	s := open(t)
	before := indexes(t, s)

	_, err := s.Explain(ctx, "SELECT 1; DROP TABLE produtos")
	wantUserError(t, err, "multiple commands")
	_, err = s.Explain(ctx, "UPDATE pedidos SET total = 0")
	wantUserError(t, err, "read-only")
	if _, err = s.Explain(ctx, "CREATE INDEX ON pedidos (total)"); err == nil {
		t.Fatal("DDL passou pelo EXPLAIN")
	}
	_, err = s.Explain(ctx, "EXPLAIN SELECT 1")
	wantUserError(t, err, "só a consulta")
	_, err = s.Explain(ctx, "   ;  ")
	wantUserError(t, err, "escreva uma consulta")
	_, err = s.Explain(ctx, "SELECT * FROM tabela_que_nao_existe")
	wantUserError(t, err, "does not exist")

	produtos(t, s)
	if after := indexes(t, s); after != before {
		t.Fatalf("índices: %d antes, %d depois", before, after)
	}
}

func spec(table string, cols ...string) IndexSpec {
	s := IndexSpec{Table: table}
	for _, c := range cols {
		name, fn, _ := strings.Cut(c, ":")
		s.Columns = append(s.Columns, struct {
			Name string `json:"name"`
			Fn   string `json:"fn,omitempty"`
		}{name, fn})
	}
	return s
}

func TestTryIndexShowsTheGainAndLeavesNothingBehind(t *testing.T) {
	s := open(t)
	before := indexes(t, s)

	trial, err := s.TryIndex(ctx, "SELECT * FROM clientes WHERE email = 'cliente123456@exemplo.com.br'", spec("clientes", "email"))
	if err != nil {
		t.Fatal(err)
	}
	b, a := decode(t, trial.Before), decode(t, trial.After)
	if !strings.Contains(b[0].Plan.NodeType, "Seq Scan") && b[0].Plan.NodeType != "Gather" {
		t.Fatalf("antes: %s, queria uma varredura sequencial", b[0].Plan.NodeType)
	}
	if a[0].Plan.NodeType != "Index Scan" || a[0].Plan.Index != "plano_indice_de_teste" {
		t.Fatalf("depois: %s usando %q, queria Index Scan no índice de teste", a[0].Plan.NodeType, a[0].Plan.Index)
	}
	if a[0].Execution >= b[0].Execution {
		t.Fatalf("o índice não ajudou: %.2f ms → %.2f ms", b[0].Execution, a[0].Execution)
	}
	if trial.DDL != `CREATE INDEX ON "clientes" ("email");` || trial.IndexBytes <= 0 || trial.BuildMs <= 0 {
		t.Fatalf("relatório do teste: %+v", trial)
	}
	t.Logf("%.2f ms → %.3f ms (%.0f×), índice de %d kB criado em %.0f ms",
		b[0].Execution, a[0].Execution, b[0].Execution/a[0].Execution, trial.IndexBytes/1024, trial.BuildMs)

	// Expression index, picked up thanks to the ANALYZE inside the transaction.
	trial, err = s.TryIndex(ctx, "SELECT id FROM clientes WHERE lower(email) = 'cliente4242@exemplo.com.br'", spec("clientes", "email:lower"))
	if err != nil {
		t.Fatal(err)
	}
	if a := decode(t, trial.After); !strings.Contains(a[0].Plan.NodeType, "Index") && a[0].Plan.NodeType != "Bitmap Heap Scan" {
		t.Fatalf("índice de expressão não foi usado: %s", a[0].Plan.NodeType)
	}

	if after := indexes(t, s); after != before {
		t.Fatalf("o índice de teste ficou no banco: %d índices antes, %d depois", before, after)
	}
}

func TestTryIndexRejectsBadSpecs(t *testing.T) {
	s := open(t)
	q := "SELECT 1"
	_, err := s.TryIndex(ctx, q, spec(""))
	wantUserError(t, err, "tabela")
	_, err = s.TryIndex(ctx, q, spec("clientes", "email:md5"))
	wantUserError(t, err, "não é permitida")
	_, err = s.TryIndex(ctx, q, spec("clientes", "coluna_inexistente"))
	wantUserError(t, err, "does not exist")
	// Names are quoted, so these are just a table and a column that don't exist.
	_, err = s.TryIndex(ctx, q, spec("clientes (id); DROP TABLE produtos; --", "id"))
	wantUserError(t, err, "does not exist")
	_, err = s.TryIndex(ctx, q, spec("clientes", "id); DROP TABLE produtos; --"))
	wantUserError(t, err, "does not exist")
	produtos(t, s)
}

func TestDescribe(t *testing.T) {
	s := open(t)
	info, err := s.Describe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if info.Database != "loja" || len(info.Tables) < 4 {
		t.Fatalf("info = %+v", info)
	}
	for _, tb := range info.Tables {
		if tb.Name == "pedidos" && (tb.Rows < 900_000 || len(tb.Indexes) != 1 || len(tb.Columns) != 5) {
			t.Fatalf("pedidos = %+v", tb)
		}
	}
}
