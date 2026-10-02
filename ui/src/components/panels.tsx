import clsx from "clsx";
import { AlertTriangle, Check, CheckCircle2, Copy, Flame, Info } from "lucide-react";
import { useState, type ReactNode } from "react";
import { blocks, fmtCount, fmtFactor, fmtMs, fmtPct, fmtShort, fmtSize, type Insight, type Plan, type PlanNode, type Severity } from "../../core";
import { heat } from "../lib/layout";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx("rounded-xl border border-line bg-card", className)}>{children}</section>;
}

export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-ink-3 hover:bg-page hover:text-ink"
    >
      {done ? <Check className="size-3 text-good" /> : <Copy className="size-3" />}
      {done ? "copiado" : label}
    </button>
  );
}

// ---- summary ------------------------------------------------------------------

export function Summary({ plan }: { plan: Plan }) {
  const top = [...plan.nodes].sort((a, b) => b.selfMs - a.selfMs)[0];
  const b = plan.root.buffers;
  const items: [string, ReactNode, ReactNode?][] = plan.analyzed
    ? [
        ["Execução", fmtMs(plan.executionMs ?? plan.totalMs), plan.planningMs !== undefined ? `+ ${fmtMs(plan.planningMs)} de planejamento` : undefined],
        ["Nó mais caro", top ? fmtPct(top.selfShare) : "—", top ? `${top.type}${top.relation ? ` em ${top.relation}` : ""}` : undefined],
        ["Linhas devolvidas", fmtCount(plan.root.rowsOut), `${plan.nodes.length} ${plan.nodes.length === 1 ? "nó" : "nós"} no plano`],
        [
          "Blocos lidos",
          plan.hasBuffers ? fmtShort(b.sharedHit + b.sharedRead) : "—",
          plan.hasBuffers ? `${fmtSize((b.sharedHit + b.sharedRead) * 8)} · ${fmtPct(b.sharedRead / Math.max(1, b.sharedHit + b.sharedRead))} do disco` : "rode com BUFFERS",
        ],
      ]
    : [
        ["Custo estimado", fmtShort(plan.root.totalCost), "unidades do planejador"],
        ["Linhas estimadas", fmtCount(plan.root.planRows)],
        ["Nós", plan.nodes.length],
      ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map(([label, value, sub]) => (
        <div key={label} className="rounded-xl border border-line bg-card px-4 py-3">
          <div className="text-[11px] font-medium tracking-wider text-ink-3 uppercase">{label}</div>
          <div className="num mt-0.5 text-2xl font-medium">{value}</div>
          {sub && <div className="mt-0.5 truncate text-xs text-ink-3">{sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ---- time bar -----------------------------------------------------------------

/** The whole execution as one bar, split by where the time was spent. */
export function TimeBar({ plan, hovered, onHover, onSelect }: { plan: Plan; hovered: number | null; onHover: (id: number | null) => void; onSelect: (id: number) => void }) {
  if (!plan.analyzed) return null;
  const parts = plan.nodes.filter((n) => n.selfMs > 0).sort((a, b) => b.selfMs - a.selfMs);
  const accounted = parts.reduce((s, n) => s + n.selfMs, 0);
  const rest = Math.max(0, plan.totalMs - accounted);
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between text-xs">
        <span className="font-medium text-ink-2">Para onde foi o tempo</span>
        <span className="text-ink-3">cada faixa é o tempo que um nó gastou sozinho, sem contar os filhos</span>
      </div>
      <div className="flex h-9 overflow-hidden rounded-md bg-page">
        {parts.map((n) => {
          const w = (n.selfMs / plan.totalMs) * 100;
          return (
            <button
              key={n.id}
              onMouseEnter={() => onHover(n.id)}
              onMouseLeave={() => onHover(null)}
              onClick={() => onSelect(n.id)}
              title={`${n.type}${n.relation ? ` em ${n.relation}` : ""}: ${fmtMs(n.selfMs)} (${fmtPct(n.selfShare)})`}
              style={{ width: `${w}%`, background: heat(n.selfShare) }}
              className={clsx("flex min-w-[2px] items-center overflow-hidden border-r border-card px-2 text-left transition-[filter]", hovered === n.id && "brightness-90")}
            >
              {w > 9 && (
                <span className="truncate text-[11px] font-medium text-ink">
                  {n.type}
                  {n.relation ? ` · ${n.relation}` : ""} <span className="num font-normal">{fmtPct(n.selfShare)}</span>
                </span>
              )}
            </button>
          );
        })}
        {rest / plan.totalMs > 0.01 && (
          <div style={{ width: `${(rest / plan.totalMs) * 100}%` }} className="flex items-center px-2" title="Tempo fora dos nós: iniciar e encerrar o executor, JIT, gatilhos">
            <span className="truncate text-[11px] text-ink-3">fora dos nós</span>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---- insights -----------------------------------------------------------------

const tone: Record<Severity, { box: string; icon: ReactNode; label: string }> = {
  critical: { box: "border-crit/30 bg-crit-soft", icon: <Flame className="size-4 text-crit" />, label: "Gargalo" },
  warning: { box: "border-warn/30 bg-warn-soft", icon: <AlertTriangle className="size-4 text-warn" />, label: "Atenção" },
  info: { box: "border-line bg-info-soft", icon: <Info className="size-4 text-info" />, label: "Nota" },
  good: { box: "border-good/30 bg-good-soft", icon: <CheckCircle2 className="size-4 text-good" />, label: "Tudo certo" },
};

export function InsightCard({
  insight,
  active,
  onPick,
  action,
}: {
  insight: Insight;
  active: boolean;
  onPick?: () => void;
  action?: ReactNode;
}) {
  const t = tone[insight.severity];
  return (
    <article
      className={clsx("rise rounded-xl border p-4 transition-shadow", t.box, active && "ring-2 ring-indigo/40", onPick && "cursor-pointer hover:shadow-md")}
      onClick={onPick}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{t.icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] leading-snug font-semibold">{insight.title}</h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{insight.detail}</p>
          {insight.fix && (
            <div className="mt-3 rounded-lg border border-line bg-card" onClick={(e) => e.stopPropagation()}>
              <p className="px-3 pt-2.5 text-[12.5px] leading-relaxed text-ink">
                <span className="font-semibold text-indigo">O que fazer: </span>
                {insight.fix.label}.
              </p>
              {insight.fix.sql && (
                <div className="mt-2 flex items-start justify-between gap-2 border-t border-line bg-page/60 px-3 py-2">
                  <pre className="num min-w-0 flex-1 overflow-x-auto text-[12px] leading-relaxed whitespace-pre text-ink">{insight.fix.sql}</pre>
                  <CopyButton text={insight.fix.sql} />
                </div>
              )}
              {action && <div className="border-t border-line px-3 py-2.5">{action}</div>}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

// ---- node detail --------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-1.5 last:border-0">
      <dt className="shrink-0 text-xs text-ink-3">{label}</dt>
      <dd className="num min-w-0 text-right text-[12.5px] break-words">{children}</dd>
    </div>
  );
}

export function NodeDetail({ node, plan }: { node: PlanNode; plan: Plan }) {
  const loops = node.loops ?? 1;
  const sb = node.selfBuffers;
  const conds: [string, string | undefined][] = [
    ["Filtro", node.filter],
    ["Condição do índice", node.indexCond],
    ["Recheck", node.recheckCond],
    ["Condição do hash", node.hashCond],
    ["Condição do merge", node.mergeCond],
    ["Filtro da junção", node.joinFilter],
    ["Ordenar por", node.sortKey?.join(", ")],
    ["Agrupar por", node.groupKey?.join(", ")],
  ];
  return (
    <Card className="rise p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg leading-tight font-semibold">{node.type}</h3>
          <p className="num truncate text-xs text-ink-3">
            {[node.subplan, node.relation && `tabela ${node.relation}`, node.alias && node.alias !== node.relation && `alias ${node.alias}`, node.index && `índice ${node.index}`]
              .filter(Boolean)
              .join(" · ") || `nó ${node.id}`}
          </p>
        </div>
        {plan.analyzed && !node.neverExecuted && (
          <div className="shrink-0 text-right">
            <div className="num text-xl font-medium">{fmtMs(node.selfMs)}</div>
            <div className="text-[11px] text-ink-3">próprio · {fmtPct(node.selfShare)}</div>
          </div>
        )}
      </div>

      <dl className="mt-3">
        {plan.analyzed && !node.neverExecuted && (
          <>
            <Row label="Tempo com os filhos">{fmtMs(node.inclusiveMs)}</Row>
            <Row label="Execuções (loops)">
              {fmtCount(loops)}
              {loops > 1 && !node.approximate && <span className="text-ink-3"> × {fmtMs(node.actualTotal ?? 0)} cada</span>}
              {node.approximate && <span className="text-ink-3"> processos em paralelo</span>}
            </Row>
            <Row label="Linhas produzidas">
              {node.approximate ? "~" : ""}
              {fmtCount(node.rowsOut)}
              <span className={node.estimateFactor >= 10 ? "text-warn" : "text-ink-3"}>
                {" "}
                · estimadas {fmtCount(node.planRows * loops)}
                {node.estimateFactor >= 2 && ` (${fmtFactor(node.estimateFactor)} ${node.estimateDirection === "under" ? "abaixo" : "acima"})`}
              </span>
            </Row>
            {node.rowsRemovedByFilter !== undefined && (
              <Row label="Descartadas pelo filtro">
                {fmtCount(node.rowsRemovedByFilter * loops)}
                <span className="text-ink-3"> · {fmtPct((node.rowsRemovedByFilter * loops) / Math.max(1, node.rowsOut + node.rowsRemovedByFilter * loops))} do lido</span>
              </Row>
            )}
            {node.rowsRemovedByJoinFilter !== undefined && <Row label="Descartadas na junção">{fmtCount(node.rowsRemovedByJoinFilter * loops)}</Row>}
          </>
        )}
        {node.neverExecuted && <Row label="Execução">nunca executado: o plano não precisou deste ramo</Row>}
        {conds.map(([label, value]) => value && <Row key={label} label={label}>{value}</Row>)}
        {node.sortMethod && (
          <Row label="Ordenação">
            {node.sortMethod}
            {node.sortSpaceKB !== undefined && (
              <span className={node.sortSpaceType === "Disk" ? "text-crit" : "text-ink-3"}>
                {" "}
                · {fmtSize(node.sortSpaceKB)} {node.sortSpaceType === "Disk" ? "em disco" : "em memória"}
              </span>
            )}
          </Row>
        )}
        {node.hashBatches !== undefined && (
          <Row label="Tabela hash">
            {node.hashBatches} {node.hashBatches === 1 ? "lote" : "lotes"}
            {node.peakMemoryKB !== undefined && <span className="text-ink-3"> · pico {fmtSize(node.peakMemoryKB)}</span>}
          </Row>
        )}
        {node.heapFetches !== undefined && <Row label="Idas à tabela">{fmtCount(node.heapFetches)}</Row>}
        {node.workersPlanned !== undefined && (
          <Row label="Processos paralelos">
            {node.workersLaunched ?? "?"} de {node.workersPlanned} planejados
          </Row>
        )}
        {plan.hasBuffers && blocks(sb) + sb.tempRead + sb.tempWritten > 0 && (
          <Row label="Blocos (só este nó)">
            {fmtCount(sb.sharedHit)} do cache · {fmtCount(sb.sharedRead)} do disco
            {sb.tempWritten + sb.tempRead > 0 && <span className="text-crit"> · {fmtCount(sb.tempWritten)} temporários gravados</span>}
          </Row>
        )}
        <Row label="Custo estimado">
          {fmtShort(node.startupCost)} … {fmtShort(node.totalCost)}
          <span className="text-ink-3"> · {node.planWidth} bytes por linha</span>
        </Row>
      </dl>
    </Card>
  );
}
