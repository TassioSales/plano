import clsx from "clsx";
import { Minus, Plus, Scan } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtFactor, fmtMs, fmtPct, fmtShort, underLimit, type Insight, type Plan, type PlanNode } from "../../core";
import { heat, layout, NODE_H, NODE_W, thickness } from "../lib/layout";

type Props = {
  plan: Plan;
  insights: Insight[];
  selected: number | null;
  hovered: number | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
};

const PAD = 24;

/**
 * The plan as a tree, read from the bottom up like Postgres executes it:
 * leaves read tables, rows flow up the edges (thicker = more rows), and the
 * root hands the result to the client. Colour is time spent in the node itself.
 */
export function Tree({ plan, insights, selected, hovered, onSelect, onHover }: Props) {
  const l = useMemo(() => layout(plan.root), [plan]);
  const wrap = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const maxRows = useMemo(() => Math.max(1, ...plan.nodes.map((n) => n.rowsOut)), [plan]);
  const flagged = useMemo(() => {
    const m = new Map<number, Insight["severity"]>();
    for (const i of insights) if (i.node !== undefined && !m.has(i.node)) m.set(i.node, i.severity);
    return m;
  }, [insights]);

  const fit = () => {
    const el = wrap.current;
    if (!el) return;
    setZoom(Math.max(0.35, Math.min(1, (el.clientWidth - 8) / (l.width + PAD * 2))));
  };
  // Refit whenever a different plan is shown.
  useEffect(fit, [l]);

  // Bring the selected node into view when it is picked from the findings list.
  useEffect(() => {
    if (selected === null) return;
    wrap.current?.querySelector(`[data-node="${selected}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [selected]);

  const W = l.width + PAD * 2;
  const H = l.height + PAD * 2;

  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10 flex overflow-hidden rounded-md border border-line bg-card shadow-sm">
        <ZoomButton label="Afastar" onClick={() => setZoom((z) => Math.max(0.35, z - 0.15))}>
          <Minus className="size-3.5" />
        </ZoomButton>
        <ZoomButton label="Ajustar à largura" onClick={fit}>
          <Scan className="size-3.5" />
        </ZoomButton>
        <ZoomButton label="Aproximar" onClick={() => setZoom((z) => Math.min(1.4, z + 0.15))}>
          <Plus className="size-3.5" />
        </ZoomButton>
      </div>
      <div ref={wrap} className="overflow-auto" style={{ maxHeight: "72vh" }}>
        <div className="mx-auto" style={{ width: W * zoom, height: H * zoom }}>
          <div className="relative origin-top-left" style={{ width: W, height: H, transform: `scale(${zoom})` }}>
            <svg width={W} height={H} className="absolute inset-0" aria-hidden>
              {l.placed.map(({ node, x, y }) =>
                node.children.map((c) => {
                  const child = l.byId.get(c.id)!;
                  const x1 = PAD + child.x + NODE_W / 2;
                  const y1 = PAD + child.y;
                  const x2 = PAD + x + NODE_W / 2;
                  const y2 = PAD + y + NODE_H;
                  const mid = (y1 + y2) / 2;
                  const sub = c.relationship === "SubPlan" || c.relationship === "InitPlan";
                  return (
                    <g key={c.id}>
                      <path
                        d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`}
                        fill="none"
                        stroke={sub ? "#a5b4fc" : "#cbd0de"}
                        strokeWidth={plan.analyzed ? thickness(c.rowsOut, maxRows) : 2}
                        strokeDasharray={sub ? "6 5" : undefined}
                        strokeLinecap="round"
                      />
                      {plan.analyzed && (
                        <text x={(x1 + x2) / 2} y={mid + 4} textAnchor="middle" className="num fill-ink-3 text-[10.5px]" style={{ paintOrder: "stroke", stroke: "var(--color-card)", strokeWidth: 4 }}>
                          {c.approximate ? "~" : ""}
                          {fmtShort(c.rowsOut)} {c.rowsOut === 1 ? "linha" : "linhas"}
                          {(c.loops ?? 1) > 1 && !c.approximate ? ` · ${fmtShort(c.loops!)}×` : ""}
                        </text>
                      )}
                    </g>
                  );
                }),
              )}
            </svg>
            {l.placed.map(({ node, x, y }) => (
              <NodeCard
                key={node.id}
                node={node}
                analyzed={plan.analyzed}
                flag={flagged.get(node.id)}
                selected={selected === node.id}
                hovered={hovered === node.id}
                style={{ left: PAD + x, top: PAD + y }}
                onClick={() => onSelect(node.id)}
                onHover={onHover}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function NodeCard({
  node,
  analyzed,
  flag,
  selected,
  hovered,
  style,
  onClick,
  onHover,
}: {
  node: PlanNode;
  analyzed: boolean;
  flag?: Insight["severity"];
  selected: boolean;
  hovered: boolean;
  style: React.CSSProperties;
  onClick: () => void;
  onHover: (id: number | null) => void;
}) {
  // Under a LIMIT, producing fewer rows than planned is the plan stopping early, not a bad estimate.
  const off = node.estimateFactor >= 10 && !(node.estimateDirection === "over" && underLimit(node));
  return (
    <button
      data-node={node.id}
      onClick={onClick}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      style={{ ...style, width: NODE_W, height: NODE_H }}
      className={clsx(
        "absolute flex flex-col overflow-hidden rounded-lg border bg-card text-left shadow-sm transition-shadow",
        selected ? "border-indigo ring-2 ring-indigo/30" : hovered ? "border-indigo/60 shadow-md" : "border-line-2",
        node.neverExecuted && "opacity-50",
      )}
    >
      {/* the heat strip: time spent in this node itself */}
      <span className="h-1.5 w-full shrink-0" style={{ background: analyzed ? heat(node.selfShare) : "#e2e5ee" }} />
      <span className="flex min-h-0 flex-1 flex-col px-2.5 py-1.5">
        <span className="flex items-center gap-1.5">
          {flag && flag !== "good" && flag !== "info" && (
            <span className={clsx("size-2 shrink-0 rounded-full", flag === "critical" ? "bg-crit" : "bg-warn")} title="Há um diagnóstico sobre este nó" />
          )}
          <span className="truncate text-[12.5px] leading-tight font-semibold">{node.type}</span>
        </span>
        <span className="num truncate text-[11px] text-ink-3">
          {[node.subplan, node.relation ?? (node.sortKey ? `por ${node.sortKey.join(", ")}` : (node.hashCond ?? node.groupKey?.join(", "))), node.index].filter(Boolean).join(" · ")}
        </span>
        <span className="mt-auto flex items-end justify-between gap-2">
          {analyzed ? (
            node.neverExecuted ? (
              <span className="text-[11px] text-ink-3">não executado</span>
            ) : (
              <>
                <span className="num text-[13px] font-medium">
                  {fmtMs(node.selfMs)}
                  <span className="ml-1 text-[10.5px] font-normal text-ink-3">{fmtPct(node.selfShare)}</span>
                </span>
                {off && (
                  <span
                    className="num rounded bg-warn-soft px-1 text-[10px] font-medium text-warn"
                    title={`Estimativa ${node.estimateDirection === "under" ? "abaixo" : "acima"} do real`}
                  >
                    est. {fmtFactor(node.estimateFactor)} {node.estimateDirection === "under" ? "↓" : "↑"}
                  </span>
                )}
              </>
            )
          ) : (
            <span className="num text-[11px] text-ink-3">custo {fmtShort(node.totalCost)}</span>
          )}
        </span>
      </span>
    </button>
  );
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="grid size-8 place-items-center text-ink-2 hover:bg-page hover:text-ink">
      {children}
    </button>
  );
}
