import clsx from "clsx";
import { ArrowRight, ClipboardPaste, Database, LoaderCircle, Play } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { explain, fmtMs, fmtShort, fmtSize } from "../../core";
import { Card } from "../components/panels";
import { examples } from "../lib/examples";
import { api, useWorkspace } from "../lib/workspace";

const inputClass =
  "w-full rounded-lg border border-line-2 bg-card px-3 py-2.5 font-mono text-[12.5px] leading-relaxed placeholder:text-ink-4 focus:border-indigo focus:outline-none focus:ring-2 focus:ring-indigo/20";

export function HomePage() {
  const { setSource, info } = useWorkspace();
  const navigate = useNavigate();
  const live = info?.live ? info.database : null;
  const [mode, setMode] = useState<"paste" | "run">("paste");
  const [text, setText] = useState("");
  const [sql, setSql] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (plan: string, query?: string, title?: string) => {
    try {
      explain(plan); // fail here, with the message next to the input, rather than on the next page
      setSource({ plan, sql: query, title });
      navigate("/plano");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { plan } = await api.explain(sql);
      open(JSON.stringify(plan, null, 2), sql.trim().replace(/;+\s*$/, ""));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="max-w-3xl">
        <h1 className="font-display text-4xl leading-[1.1] font-semibold tracking-tight sm:text-5xl">
          Por que esta consulta <span className="text-crit italic">está lenta?</span>
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-2">
          Cole a saída de um <code className="num rounded bg-card px-1.5 py-0.5 text-[15px]">EXPLAIN</code> do Postgres. O plano vira uma árvore com o tempo de cada
          passo, e você recebe em português o que está errado e o comando para corrigir.
        </p>
      </header>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[1.25fr_1fr]">
        <Card className="p-5">
          {live && (
            <div className="mb-4 inline-flex rounded-lg border border-line bg-page p-0.5 text-sm font-medium">
              {(
                [
                  ["paste", "Colar um plano", ClipboardPaste],
                  ["run", "Executar no banco", Database],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  onClick={() => {
                    setMode(id);
                    setError(null);
                  }}
                  className={clsx("flex items-center gap-1.5 rounded-md px-3 py-1.5", mode === id ? "bg-card text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
                >
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </div>
          )}

          {mode === "paste" || !live ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                open(text);
              }}
            >
              <label className="mb-2 block text-sm font-medium" htmlFor="plan">
                Saída do EXPLAIN
              </label>
              <textarea
                id="plan"
                className={inputClass}
                rows={13}
                spellCheck={false}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                }}
                placeholder={"Seq Scan on clientes  (cost=0.00..5137.00 rows=1 width=58) (actual time=9.21..15.30 rows=1 loops=1)\n  Filter: (email = 'ana@exemplo.com.br'::text)\n  Rows Removed by Filter: 199999\nPlanning Time: 0.09 ms\nExecution Time: 15.34 ms"}
              />
              <p className="mt-2 text-xs leading-relaxed text-ink-3">
                Aceita texto e JSON, inclusive com o cabeçalho e os <code className="num">+</code> do psql. Para o diagnóstico completo, gere com{" "}
                <code className="num rounded bg-page px-1 py-0.5 text-ink-2">EXPLAIN (ANALYZE, BUFFERS) sua consulta</code>. Nada sai do seu navegador.
              </p>
              {error && <ErrorNote>{error}</ErrorNote>}
              <button type="submit" disabled={!text.trim()} className={primary}>
                Analisar <ArrowRight className="size-4" />
              </button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run();
              }}
            >
              <label className="mb-2 block text-sm font-medium" htmlFor="sql">
                Consulta em <span className="num text-indigo">{live.database}</span>
              </label>
              <textarea
                id="sql"
                className={inputClass}
                rows={8}
                spellCheck={false}
                value={sql}
                onChange={(e) => {
                  setSql(e.target.value);
                  setError(null);
                }}
                placeholder="SELECT * FROM pedidos WHERE cliente_id = 4242"
              />
              <p className="mt-2 text-xs leading-relaxed text-ink-3">
                A consulta roda de verdade, com ANALYZE, numa transação somente leitura que é desfeita no fim. Comandos que escrevem são recusados pelo banco.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {examples.slice(0, 7).map((ex) => (
                  <button key={ex.id} type="button" onClick={() => setSql(ex.sql)} className="rounded-full border border-line bg-page px-2.5 py-1 text-[11px] text-ink-2 hover:border-indigo hover:text-indigo">
                    {ex.title}
                  </button>
                ))}
              </div>
              {error && <ErrorNote>{error}</ErrorNote>}
              <button type="submit" disabled={!sql.trim() || busy} className={primary}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />} Executar e analisar
              </button>
            </form>
          )}
        </Card>

        <div className="space-y-6">
          <div>
            <h2 className="mb-3 text-sm font-semibold">Ou comece por um exemplo real</h2>
            <ul className="space-y-2">
              {examples.map((ex) => {
                const { plan } = explain(ex.json);
                return (
                  <li key={ex.id}>
                    <button
                      onClick={() => navigate(`/exemplo/${ex.id}`)}
                      className="group flex w-full items-center gap-3 rounded-lg border border-line bg-card px-3.5 py-2.5 text-left transition-colors hover:border-indigo"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{ex.title}</span>
                        <span className="block truncate text-xs text-ink-3">{ex.blurb}</span>
                      </span>
                      <span className="num shrink-0 text-xs text-ink-2">{fmtMs(plan.totalMs)}</span>
                      <ArrowRight className="size-4 shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {live && (
            <Card className="p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Database className="size-4 text-indigo" /> {live.database}
                <span className="font-normal text-ink-3">· PostgreSQL {live.version.split(" ")[0]}</span>
              </h2>
              <ul className="mt-3 space-y-2">
                {live.tables.slice(0, 8).map((t) => (
                  <li key={t.name} className="text-xs">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="num font-medium">{t.name}</span>
                      <span className="num text-ink-3">
                        {fmtShort(t.rows)} linhas · {fmtSize(t.bytes / 1024)}
                      </span>
                    </div>
                    <div className="num mt-0.5 truncate text-[11px] text-ink-3" title={t.indexes.join("\n")}>
                      {t.indexes.length ? t.indexes.map((i) => i.replace(/^CREATE (UNIQUE )?INDEX (\S+) ON \S+ USING \w+ /, "$2 ")).join(" · ") : "sem índices"}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

const primary =
  "mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-indigo px-5 text-sm font-semibold text-white transition-colors hover:bg-indigo-2 disabled:cursor-not-allowed disabled:opacity-50";

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-3 rounded-lg border border-crit/30 bg-crit-soft px-3 py-2 text-sm text-crit">
      {children}
    </p>
  );
}
