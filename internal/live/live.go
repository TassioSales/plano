// Package live runs EXPLAIN against a real database and tries out indexes
// without leaving anything behind.
package live

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	MaxSQL      = 100 << 10
	stmtTimeout = "30s"
	lockTimeout = "3s"
)

// Service talks to the database under inspection.
type Service struct {
	pool *pgxpool.Pool
}

// Open connects to the database.
func Open(ctx context.Context, url string) (*Service, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("live: URL inválida: %w", err)
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("live: não foi possível conectar: %w", err)
	}
	return &Service{pool: pool}, nil
}

// Close releases the connections.
func (s *Service) Close() { s.pool.Close() }

// UserError is a problem with what the user sent (bad SQL, unknown table),
// safe to show as is.
type UserError struct{ Message string }

func (e *UserError) Error() string { return e.Message }

func userErr(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		msg := pg.Message
		if pg.Hint != "" {
			msg += " (" + pg.Hint + ")"
		}
		return &UserError{Message: msg}
	}
	return err
}

func checkSQL(sql string) (string, error) {
	sql = strings.TrimSpace(sql)
	sql = strings.TrimRight(sql, "; \n\t")
	if sql == "" {
		return "", &UserError{Message: "escreva uma consulta"}
	}
	if len(sql) > MaxSQL {
		return "", &UserError{Message: "consulta grande demais"}
	}
	if regexp.MustCompile(`(?i)^\s*explain\b`).MatchString(sql) {
		return "", &UserError{Message: "escreva só a consulta: o EXPLAIN (ANALYZE, BUFFERS) é acrescentado automaticamente"}
	}
	return sql, nil
}

// begin opens a transaction with timeouts. Every transaction here ends in a
// rollback: nothing this service does is meant to persist.
func (s *Service) begin(ctx context.Context, readOnly bool) (pgx.Tx, error) {
	mode := pgx.ReadWrite
	if readOnly {
		mode = pgx.ReadOnly
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: mode})
	if err != nil {
		return nil, err
	}
	for _, set := range []string{"SET LOCAL statement_timeout = '" + stmtTimeout + "'", "SET LOCAL lock_timeout = '" + lockTimeout + "'"} {
		if _, err := tx.Exec(ctx, set); err != nil {
			tx.Rollback(ctx)
			return nil, err
		}
	}
	return tx, nil
}

// explain runs the statement for real, with ANALYZE. The extended protocol
// refuses more than one statement per query, so "SELECT 1; DROP TABLE x"
// fails as a whole instead of running its second half.
func explain(ctx context.Context, tx pgx.Tx, sql string) (json.RawMessage, error) {
	var plan []byte
	if err := tx.QueryRow(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+sql).Scan(&plan); err != nil {
		return nil, userErr(err)
	}
	return plan, nil
}

// Explain runs EXPLAIN (ANALYZE, BUFFERS) in a read-only transaction that is
// rolled back. Statements that write are refused by the database.
func (s *Service) Explain(ctx context.Context, sql string) (json.RawMessage, error) {
	sql, err := checkSQL(sql)
	if err != nil {
		return nil, err
	}
	tx, err := s.begin(ctx, true)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	return explain(ctx, tx, sql)
}

// IndexSpec describes an index to try. It is structured, not SQL, so the
// statement is built here with every identifier quoted.
type IndexSpec struct {
	Table   string `json:"table"`
	Columns []struct {
		Name string `json:"name"`
		Fn   string `json:"fn,omitempty"`
	} `json:"columns"`
}

// SQL builds the CREATE INDEX statement.
func (i IndexSpec) SQL(name string) (string, error) {
	if i.Table == "" || len(i.Columns) == 0 || len(i.Columns) > 8 {
		return "", &UserError{Message: "o índice precisa de uma tabela e de 1 a 8 colunas"}
	}
	cols := make([]string, len(i.Columns))
	for k, c := range i.Columns {
		if c.Name == "" {
			return "", &UserError{Message: "coluna sem nome"}
		}
		col := pgx.Identifier{c.Name}.Sanitize()
		switch c.Fn {
		case "":
		case "lower", "upper":
			col = c.Fn + "(" + col + ")"
		default:
			return "", &UserError{Message: fmt.Sprintf("função %q não é permitida em índices de teste", c.Fn)}
		}
		cols[k] = col
	}
	return fmt.Sprintf("CREATE INDEX %s ON %s (%s)", pgx.Identifier{name}.Sanitize(), pgx.Identifier{i.Table}.Sanitize(), strings.Join(cols, ", ")), nil
}

// Trial is a before/after comparison.
type Trial struct {
	Before     json.RawMessage `json:"before"`
	After      json.RawMessage `json:"after"`
	DDL        string          `json:"ddl"`
	BuildMs    float64         `json:"buildMs"`
	IndexBytes int64           `json:"indexBytes"`
}

// TryIndex measures a query, creates the index, measures again and rolls
// everything back. The index never exists outside this transaction.
//
// It is not free: while the index is being built, writes to the table wait
// (CREATE INDEX takes a SHARE lock). Meant for development databases.
func (s *Service) TryIndex(ctx context.Context, sql string, spec IndexSpec) (*Trial, error) {
	sql, err := checkSQL(sql)
	if err != nil {
		return nil, err
	}
	const name = "plano_indice_de_teste"
	ddl, err := spec.SQL(name)
	if err != nil {
		return nil, err
	}
	tx, err := s.begin(ctx, false)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	out := &Trial{DDL: strings.Replace(ddl, pgx.Identifier{name}.Sanitize()+" ", "", 1) + ";"}
	// A savepoint, so a query that writes is undone before the index is built
	// and the "after" run sees the same data as the "before" one.
	if _, err := tx.Exec(ctx, "SAVEPOINT antes"); err != nil {
		return nil, err
	}
	if out.Before, err = explain(ctx, tx, sql); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT antes"); err != nil {
		return nil, err
	}

	start := time.Now()
	if _, err := tx.Exec(ctx, ddl); err != nil {
		return nil, userErr(err)
	}
	out.BuildMs = float64(time.Since(start).Microseconds()) / 1000
	// Expression indexes only get statistics after an ANALYZE.
	if _, err := tx.Exec(ctx, "ANALYZE "+pgx.Identifier{spec.Table}.Sanitize()); err != nil {
		return nil, userErr(err)
	}
	if err := tx.QueryRow(ctx, "SELECT pg_relation_size($1::regclass)", pgx.Identifier{name}.Sanitize()).Scan(&out.IndexBytes); err != nil {
		return nil, userErr(err)
	}
	if out.After, err = explain(ctx, tx, sql); err != nil {
		return nil, err
	}
	return out, nil
}

// Table is one table of the connected database.
type Table struct {
	Name    string   `json:"name"`
	Rows    int64    `json:"rows"`
	Bytes   int64    `json:"bytes"`
	Columns []string `json:"columns"`
	Indexes []string `json:"indexes"`
}

// Info describes the connected database.
type Info struct {
	Database string  `json:"database"`
	Version  string  `json:"version"`
	Tables   []Table `json:"tables"`
}

// Describe lists the user tables with their sizes and indexes.
func (s *Service) Describe(ctx context.Context) (*Info, error) {
	info := &Info{Tables: []Table{}}
	if err := s.pool.QueryRow(ctx, "SELECT current_database(), current_setting('server_version')").Scan(&info.Database, &info.Version); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.relname, greatest(c.reltuples, 0)::bigint, pg_total_relation_size(c.oid),
			ARRAY(SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
				WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum),
			ARRAY(SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid = c.oid ORDER BY 1)
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var t Table
		if err := rows.Scan(&t.Name, &t.Rows, &t.Bytes, &t.Columns, &t.Indexes); err != nil {
			return nil, err
		}
		info.Tables = append(info.Tables, t)
	}
	return info, rows.Err()
}
