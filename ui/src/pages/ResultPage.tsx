import clsx from "clsx";
import { ArrowLeft, ArrowRight, FlaskConical, Link2, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { explain, fmtFactor, fmtMs, fmtSize, type IndexSpec, type Insight } from "../../core";
import { Card, CopyButton, InsightCard, NodeDetail, Summary, TimeBar } from "../components/panels";
import { Tree } from "../components/Tree";
import { examples } from "../lib/examples";
import { api, decodeSource, encodeSource, useWorkspace, type Source, type Trial } from "../lib/workspace";

/** /exemplo/:id — one of the bundled real plans. */
export function ExamplePage() {
  const { id } = useParams();
  const ex = examples.find((e) => e.id === id);
  if (!ex) return <Missing />;
  return <Result key={ex.id} source={{ plan: ex.json, sql: ex.sql, title: ex.title }} />;
}

/** /plano — whatever was pasted, run, or packed into the link's fragment. */
export function ResultPage() {
  const { source, setSource } = useWorkspace();
  const [loading, setLoading] = useState(!source && location.hash.length > 1);
  useEffect(() => {
    if (source || location.hash.length <= 1) return;
    decodeSource(location.hash.slice(1)).then((s) => {
      if (s) setSource(s);
      setLoading(false);
    });
  }, [source, setSource]);
  if (loading) return <p className="py-24 text-center text-ink-3">Abrindo o plano do link…</p>;
  if (!source) return <Missing />;
  return <Result key={source.plan.length + (source.sql ?? "")} source={source} />;
}

function Missing() {
  return (
    <div className="py-24 text-center">
      <p className="font-display text-3xl font-semibold">Nenhum plano aberto</p>
      <Link to="/" className="mt-4 inline-block font-medium text-indigo hover:underline">
        Colar um plano
      </Link>
    </div>
  );
}

type TrialState = { index: IndexSpec; status: "running" } | { index: IndexSpec; status: "done"; trial: Trial } | { index: IndexSpec; status: "error"; message: string };

function Result({ source }: { source: Source }) {
  const { info } = useWorkspace();
  const navigate = useNavigate();
  const live = info?.live === true;
  const original = useMemo(() => explain(source.plan), [source.plan]);
  const [trial, setTrial] = useState<TrialState | null>(null);
  const [showing, setShowing] = useState<"before" | "after">("before");
  const after = useMemo(() => (trial?.status === "done" ? explain(JSON.stringify(trial.trial.after)) : null), [trial]);
  const before = useMemo(() => (trial?.status === "done" ? explain(JSON.stringify(trial.trial.before)) : null), [trial]);
  const current = showing === "after" && after ? after : (before ?? original);
  const { plan, insights } = current;

  const [selected, setSelected] = useState<number | null>(() => insights.find((i) => i.node !== undefined)?.node ?? 0);
  const [hovered, setHovered] = useState<number | null>(null);
  const node = plan.nodes[selected ?? 0] ?? plan.root;
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    encodeSource(source).then((frag) => setLink(`${location.origin}${import.meta.env.BASE_URL}plano#${frag}`));
  }, [source]);

  const tryIndex = async (index: IndexSpec) => {
    if (!source.sql) return;
    setTrial({ index, status: "running" });
    try {
      const t = await api.tryIndex(source.sql, index);
      setTrial({ index, status: "done", trial: t });
      setShowing("after");
      setSelected(0);
    } catch (err) {
      setTrial({ index, status: "error", message: (err as Error).message });
    }
  };

  const sameIndex = (i: Insight) => trial && JSON.stringify(trial.index) === JSON.stringify(i.fix?.index);

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => navigate("/")} className="rounded-md p-1.5 text-ink-3 hover:bg-card hover:text-ink" aria-label="Voltar">
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="font-display text-2xl font-semibold">{source.title ?? "Plano de consulta"}</h1>
        <span className="rounded-full border border-line bg-card px-2.5 py-0.5 text-[11px] font-medium text-ink-3">formato {plan.format === "json" ? "JSON" : "texto"}</span>
        {link && (
          <span className="ml-auto flex items-center gap-1 text-xs text-ink-3">
            <Link2 className="size-3.5" />
            <CopyButton text={link} label="Copiar link deste plano" />
          </span>
        )}
      </div>

      {source.sql && (
        <Card className="flex items-start justify-between gap-3 px-4 py-3">
          <pre className="num min-w-0 flex-1 overflow-x-auto text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{source.sql}</pre>
          <CopyButton text={source.sql} />
        </Card>
      )}

      {trial?.status === "done" && before && after && (
        <Comparison trial={trial.trial} beforeMs={before.plan.totalMs} afterMs={after.plan.totalMs} showing={showing} onShow={setShowing} />
      )}

      <Summary plan={plan} />
      <TimeBar plan={plan} hovered={hovered} onHover={setHovered} onSelect={setSelected} />

      <div className="grid items-start gap-5 xl:grid-cols-[440px_1fr]">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">
            Diagnóstico <span className="font-normal text-ink-3">· o mais caro primeiro</span>
          </h2>
          {insights.map((i, k) => (
            <InsightCard
              key={`${showing}-${i.code}-${i.node}-${k}`}
              insight={i}
              active={i.node !== undefined && i.node === selected}
              onPick={i.node !== undefined ? () => setSelected(i.node!) : undefined}
              action={
                i.fix?.index && showing === "before" ? (
                  live && source.sql ? (
                    <div>
                      <button
                        onClick={() => tryIndex(i.fix!.index!)}
                        disabled={trial?.status === "running"}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-indigo px-3 text-xs font-semibold text-white hover:bg-indigo-2 disabled:opacity-60"
                      >
                        {trial?.status === "running" && sameIndex(i) ? <LoaderCircle className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                        Testar este índice sem criá-lo
                      </button>
                      {trial?.status === "error" && sameIndex(i) && <p className="mt-2 text-xs text-crit">{trial.message}</p>}
                      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
                        Cria o índice numa transação, mede a consulta de novo e desfaz tudo. Enquanto o índice é construído, escritas na tabela esperam.
                      </p>
                    </div>
                  ) : (
                    <p className="text-[11px] leading-relaxed text-ink-3">
                      {live ? "Para testar o índice, execute a consulta pela aba “Executar no banco”." : "Com o plano conectado a um banco (modo ao vivo), dá para testar este índice sem criá-lo."}
                    </p>
                  )
                ) : undefined
              }
            />
          ))}
        </div>

        <div className="min-w-0 space-y-4">
          <Card className="overflow-hidden">
            <div className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-2.5">
              <h2 className="text-sm font-semibold">Árvore do plano</h2>
              <p className="text-xs text-ink-3">as folhas leem as tabelas e as linhas sobem; a espessura da ligação é o volume de linhas</p>
            </div>
            <Tree plan={plan} insights={insights} selected={selected} hovered={hovered} onSelect={setSelected} onHover={setHovered} />
          </Card>
          <NodeDetail key={`${showing}-${node.id}`} node={node} plan={plan} />
        </div>
      </div>
    </div>
  );
}

function Comparison({ trial, beforeMs, afterMs, showing, onShow }: { trial: Trial; beforeMs: number; afterMs: number; showing: "before" | "after"; onShow: (s: "before" | "after") => void }) {
  const faster = afterMs < beforeMs;
  const factor = faster ? beforeMs / Math.max(afterMs, 0.001) : afterMs / Math.max(beforeMs, 0.001);
  return (
    <Card className={clsx("rise border-2 p-5", faster ? "border-good/40 bg-good-soft" : "border-warn/40 bg-warn-soft")}>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <div>
          <div className="text-[11px] font-semibold tracking-wider text-ink-3 uppercase">Índice testado</div>
          <code className="num text-[13px]">{trial.ddl}</code>
        </div>
        <div className="flex items-center gap-3">
          <span className="num text-2xl text-ink-2">{fmtMs(beforeMs)}</span>
          <ArrowRight className="size-5 text-ink-3" />
          <span className={clsx("num text-3xl font-semibold", faster ? "text-good" : "text-warn")}>{fmtMs(afterMs)}</span>
          <span className={clsx("rounded-full px-2.5 py-1 text-sm font-semibold text-white", faster ? "bg-good" : "bg-warn")}>
            {factor < 1.05 ? "sem diferença" : `${fmtFactor(factor)} ${faster ? "mais rápido" : "mais lento"}`}
          </span>
        </div>
        <div className="text-xs leading-relaxed text-ink-2">
          O índice ocuparia <b className="num">{fmtSize(trial.indexBytes / 1024)}</b> e levou <b className="num">{fmtMs(trial.buildMs)}</b> para ser construído.
          <br />
          Nada foi alterado: a transação foi desfeita.
        </div>
        <div className="ml-auto inline-flex rounded-lg border border-line bg-card p-0.5 text-sm font-medium">
          {(["before", "after"] as const).map((s) => (
            <button key={s} onClick={() => onShow(s)} className={clsx("rounded-md px-3 py-1.5", showing === s ? "bg-indigo text-white" : "text-ink-2 hover:text-ink")}>
              {s === "before" ? "Plano antes" : "Plano depois"}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
