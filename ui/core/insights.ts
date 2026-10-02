import { indexFor, indexSql, predicates } from "./conditions";
import { fmtCount, fmtFactor, fmtMs, fmtPct, fmtSize } from "./format";
import type { Insight, Plan, PlanNode, Severity } from "./types";

/**
 * Reads a plan the way someone who tunes queries would, and says what is
 * wrong in plain language, with the fix. Findings are ranked by how much
 * time is at stake.
 */
export function diagnose(plan: Plan): Insight[] {
  const out: Insight[] = [];
  if (!plan.analyzed) {
    out.push({
      code: "not-analyzed",
      severity: "info",
      title: "Este plano só tem estimativas",
      detail:
        "Sem ANALYZE o Postgres não executa a consulta: os custos e as linhas são o que o planejador imagina, não o que aconteceu. Dá para ver a forma do plano, mas não onde o tempo foi gasto.",
      fix: { label: "Rode com medições reais", sql: "EXPLAIN (ANALYZE, BUFFERS) <sua consulta>;" },
      impactMs: 0,
    });
    return out;
  }

  for (const n of plan.nodes) {
    if (n.neverExecuted) continue;
    repeated(plan, n, out);
    wastefulScan(plan, n, out);
    joinScan(plan, n, out);
    misestimate(plan, n, out);
    spilledSort(plan, n, out);
    spilledHash(plan, n, out);
    lossyBitmap(n, out);
    heapFetches(n, out);
    missingWorkers(n, out);
    joinFilter(plan, n, out);
  }
  wholePlan(plan, out);

  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2, good: 3 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.impactMs - a.impactMs);
  if (!out.some((i) => i.severity === "critical" || i.severity === "warning")) {
    out.unshift({
      code: "healthy",
      severity: "good",
      title: "Nada chama atenção neste plano",
      detail: `A consulta levou ${fmtMs(plan.totalMs)}, as estimativas estão próximas da realidade e nenhum nó desperdiça trabalho de forma evidente.`,
      impactMs: 0,
    });
  }
  return out;
}

/**
 * A row count for a sentence. Under a Gather the numbers are per-process
 * averages, so the total is shown rounded, and a zero as "poucas".
 */
function rows(n: PlanNode, value: number): string {
  if (!n.approximate) return fmtCount(value);
  if (value === 0) return "poucas";
  const digits = Math.max(0, Math.floor(Math.log10(value)) - 2);
  return `~${fmtCount(Math.round(value / 10 ** digits) * 10 ** digits)}`;
}

/** True when some ancestor is a Limit, which may stop this node before it finishes. */
export const underLimit = (n: PlanNode): boolean => {
  for (let p = n.parent; p; p = p.parent) if (p.kind === "limit") return true;
  return false;
};

const label = (n: PlanNode) => (n.relation ? `${n.type} em ${n.relation}` : n.type);

/** By time at stake: more than 30% of the query is critical. */
function severityOf(plan: Plan, ms: number): Severity {
  const share = plan.totalMs > 0 ? ms / plan.totalMs : 0;
  return share >= 0.3 && ms >= 5 ? "critical" : "warning";
}

/** The first table scan found under a node that throws most rows away. */
function wastefulBelow(n: PlanNode): PlanNode | undefined {
  if ((n.kind === "seq-scan" || n.kind === "index-scan") && isWasteful(n)) return n;
  for (const c of n.children) {
    const found = wastefulBelow(c);
    if (found) return found;
  }
  return undefined;
}

function isWasteful(n: PlanNode): boolean {
  const removed = n.rowsRemovedByFilter ?? 0;
  const kept = n.actualRows ?? 0;
  return removed >= 1000 && kept / (kept + removed) < 0.05;
}

function indexFix(n: PlanNode): Insight["fix"] | undefined {
  if (!n.relation) return undefined;
  const preds = [...(predicates(n.indexCond) ?? []), ...(predicates(n.filter) ?? [])];
  const spec = indexFor(n.relation, preds);
  if (!spec) return undefined;
  const expr = spec.columns.some((c) => c.fn);
  return {
    label: expr
      ? "Crie um índice sobre a expressão: um índice comum na coluna não serve quando ela passa por uma função"
      : spec.columns.length > 1
        ? "Crie um índice composto: igualdades primeiro, o intervalo por último"
        : "Crie um índice na coluna do filtro",
    sql: indexSql(spec),
    index: spec,
  };
}

/** A subplan or the inner side of a nested loop that runs many times. */
function repeated(plan: Plan, n: PlanNode, out: Insight[]): void {
  const loops = n.loops ?? 1;
  const isSubplan = n.relationship === "SubPlan";
  const isInner = n.relationship === "Inner" && n.parent?.kind === "nested-loop";
  if (!(isSubplan || isInner) || loops < 10) return;
  if (n.inclusiveMs < 0.2 * plan.totalMs || n.inclusiveMs < 5) return;
  const scan = wastefulBelow(n);
  const each = n.inclusiveMs / loops;
  const fix = scan ? indexFix(scan) : undefined;
  out.push({
    code: isSubplan ? "repeated-subplan" : "repeated-inner",
    severity: "critical",
    node: n.id,
    title: isSubplan
      ? `Uma subconsulta rodou ${fmtCount(loops)} vezes e levou ${fmtPct(n.inclusiveMs / plan.totalMs)} do tempo`
      : `O lado interno do nested loop rodou ${fmtCount(loops)} vezes e levou ${fmtPct(n.inclusiveMs / plan.totalMs)} do tempo`,
    detail:
      `Cada execução leva ${fmtMs(each)}, o que parece pouco, mas ela se repete para cada linha de fora: ${fmtCount(loops)} × ${fmtMs(each)} = ${fmtMs(n.inclusiveMs)}.` +
      (scan
        ? ` E a cada vez o ${label(scan)} lê ${fmtCount((scan.actualRows ?? 0) + (scan.rowsRemovedByFilter ?? 0))} linhas para aproveitar ${fmtCount(scan.actualRows ?? 0)}.`
        : ""),
    fix:
      fix ??
      (isSubplan
        ? { label: "Reescreva a subconsulta como JOIN com GROUP BY, para que a tabela seja lida uma vez só" }
        : { label: "Um índice na coluna da junção, ou mais work_mem para o planejador preferir um hash join" }),
    impactMs: n.inclusiveMs,
  });
}

/** A scan that reads a lot and keeps almost nothing. */
function wastefulScan(plan: Plan, n: PlanNode, out: Insight[]): void {
  if (n.kind !== "seq-scan" && n.kind !== "index-scan") return;
  if (!isWasteful(n)) return;
  // When it sits inside a repeated subplan, that finding already tells the story.
  for (let p: PlanNode | undefined = n; p; p = p.parent) {
    if (out.some((i) => i.node === p!.id && i.code.startsWith("repeated"))) return;
  }
  // Too cheap to matter: pointing at it would only distract from what does.
  if (n.selfShare < 0.02 && n.selfMs < 20) return;
  const loops = n.loops ?? 1;
  const kept = (n.actualRows ?? 0) * loops;
  const removed = (n.rowsRemovedByFilter ?? 0) * loops;
  const seq = n.kind === "seq-scan";
  out.push({
    code: seq ? "seq-scan-filter" : "index-scan-filter",
    severity: severityOf(plan, n.selfMs),
    node: n.id,
    title: seq
      ? `${n.relation}: leu a tabela inteira para aproveitar ${rows(n, kept)} de ${rows(n, kept + removed)} linhas`
      : `${n.relation}: o índice ${n.index} trouxe ${rows(n, kept + removed)} linhas e o filtro descartou ${fmtPct(removed / (kept + removed))}`,
    detail: seq
      ? `O filtro ${n.filter} descartou ${fmtPct(removed / (kept + removed))} do que foi lido. Isso custou ${fmtMs(n.selfMs)} (${fmtPct(n.selfShare)} da consulta).`
      : `O índice atende só parte da condição; o resto (${n.filter}) é conferido linha a linha depois de buscá-la na tabela.`,
    fix: indexFix(n),
    impactMs: n.selfMs,
  });
}

/**
 * A hash join that reads a whole big table to match a handful of rows from
 * the other side. With an index on the join column, Postgres could look up
 * just those rows instead.
 */
function joinScan(plan: Plan, n: PlanNode, out: Insight[]): void {
  if (n.kind !== "hash-join" || !n.hashCond) return;
  const scans = n.children.map((c) => (c.kind === "hash" ? (c.children[0] ?? c) : c));
  for (const big of scans) {
    const small = scans.find((s) => s !== big);
    if (!small || big.kind !== "seq-scan" || big.filter || !big.relation) continue;
    if (big.rowsOut < 50_000 || small.rowsOut > big.rowsOut / 100) continue;
    // "(i.pedido_id = p.id)": the side written with the big scan's alias is its column.
    const m = /^\(?(\w+)\.(\w+) = (\w+)\.(\w+)\)?$/.exec(n.hashCond);
    if (!m) continue;
    const column = m[1] === big.alias ? m[2] : m[3] === big.alias ? m[4] : undefined;
    if (!column) continue;
    const spec = { table: big.relation, columns: [{ name: column }] };
    out.push({
      code: "join-scan",
      severity: severityOf(plan, big.selfMs + n.selfMs),
      node: big.id,
      title: `${big.relation}: leu ${rows(big, big.rowsOut)} linhas para casar com ${rows(small, small.rowsOut)}`,
      detail: `O outro lado da junção tem só ${rows(small, small.rowsOut)} linha${small.rowsOut === 1 ? "" : "s"}, mas sem índice em ${big.relation}.${column} o único jeito de achar os pares é ler a tabela inteira e montar um hash. Isso custou ${fmtMs(big.selfMs + n.selfMs)}.`,
      fix: { label: "Um índice na coluna da junção permite buscar só as linhas necessárias", sql: indexSql(spec), index: spec },
      impactMs: big.selfMs + n.selfMs,
    });
  }
}

/** Row estimates off by 10× or more, reported where the error is born. */
function misestimate(_plan: Plan, n: PlanNode, out: Insight[]): void {
  if (n.estimateFactor < 10) return;
  if (Math.max(n.actualRows ?? 0, n.planRows) < 100) return;
  // Under a LIMIT a node stops as soon as enough rows came out: producing
  // fewer rows than planned is the plan working, not the estimate failing.
  if (n.estimateDirection === "over" && underLimit(n)) return;
  // If a child is just as wrong in the same direction, the error came from below.
  if (n.children.some((c) => c.estimateDirection === n.estimateDirection && c.estimateFactor >= n.estimateFactor / 3 && c.estimateFactor >= 10)) return;
  const preds = predicates(n.filter);
  const cols = [...new Set((preds ?? []).filter((p) => !p.fn).map((p) => p.column))];
  const under = n.estimateDirection === "under";
  let fix: Insight["fix"];
  const viaFunction = (preds ?? []).find((p) => p.fn);
  if (n.relation && viaFunction) {
    const spec = { table: n.relation, columns: [{ name: viaFunction.column, fn: viaFunction.fn }] };
    fix = {
      label: `O Postgres não guarda estatísticas sobre ${viaFunction.fn}(${viaFunction.column}), então chuta uma fração fixa. Um índice sobre a expressão faz o ANALYZE passar a coletá-las`,
      sql: indexSql(spec),
      index: spec,
    };
  } else if (n.relation && cols.length >= 2) {
    fix = {
      label:
        "As colunas do filtro andam juntas (uma determina a outra), mas o planejador as trata como independentes e multiplica as probabilidades. Estatísticas estendidas ensinam a correlação",
      sql: `CREATE STATISTICS ON ${cols.join(", ")} FROM ${n.relation};\nANALYZE ${n.relation};`,
    };
  } else if (n.relation) {
    fix = { label: "As estatísticas da tabela podem estar velhas", sql: `ANALYZE ${n.relation};` };
  }
  out.push({
    code: "misestimate",
    severity: "warning",
    node: n.id,
    title: `Estimativa ${fmtFactor(n.estimateFactor)} ${under ? "abaixo" : "acima"} do real em ${label(n)}`,
    detail:
      `O planejador esperava ${fmtCount(n.planRows)} linha${n.planRows === 1 ? "" : "s"} ${n.approximate ? "por processo " : ""}e vieram ${n.approximate && !n.actualRows ? "quase nenhuma" : fmtCount(n.actualRows ?? 0)}. ` +
      (under
        ? "Quando ele acha que vêm poucas linhas, escolhe estratégias que só são boas para poucas (nested loop, pouca memória para o hash), e o erro se propaga para os nós acima."
        : "Quando ele acha que vêm muitas linhas, reserva memória e paralelismo à toa e pode evitar um índice que seria melhor."),
    fix,
    impactMs: n.parent?.inclusiveMs ?? n.inclusiveMs,
  });
}

function mb(kb: number): number {
  return Math.max(4, Math.ceil((kb * 3) / 1024 / 4) * 4);
}

function spilledSort(plan: Plan, n: PlanNode, out: Insight[]): void {
  if (n.kind !== "sort" || n.sortSpaceType !== "Disk" || !n.sortSpaceKB) return;
  const scan = n.children[0];
  const key = n.sortKey?.length === 1 ? /^([a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)( DESC)?$/i.exec(n.sortKey[0]!) : null;
  const byIndex = key && scan?.relation && scan.kind === "seq-scan" && !scan.filter;
  out.push({
    code: "sort-on-disk",
    severity: severityOf(plan, n.selfMs),
    node: n.id,
    title: `A ordenação não coube na memória e usou ${fmtSize(n.sortSpaceKB)} de disco`,
    detail: `O Sort levou ${fmtMs(n.selfMs)} (${fmtPct(n.selfShare)} da consulta) gravando e relendo arquivos temporários. Em memória, o mesmo volume ordena várias vezes mais rápido.`,
    fix: {
      label: byIndex
        ? `Dê mais memória para a ordenação nesta sessão, ou evite ordenar: um índice em ${scan!.relation} (${key![2]}) já entrega as linhas em ordem`
        : "Dê mais memória para a ordenação nesta sessão (ordenar em memória ocupa mais do que em disco, daí a folga)",
      sql: `SET work_mem = '${mb(n.sortSpaceKB)}MB';` + (byIndex ? `\n-- ou\nCREATE INDEX ON ${scan!.relation} (${key![2]});` : ""),
    },
    impactMs: n.selfMs,
  });
}

function spilledHash(plan: Plan, n: PlanNode, out: Insight[]): void {
  if ((n.kind !== "hash" && n.kind !== "aggregate") || (n.hashBatches ?? 1) <= 1) return;
  const owner = n.kind === "hash" ? (n.parent ?? n) : n;
  out.push({
    code: "hash-batches",
    severity: severityOf(plan, owner.selfMs + n.selfMs),
    node: n.id,
    title: `A tabela hash foi dividida em ${n.hashBatches} lotes por falta de memória`,
    detail: `Com mais de um lote, parte das linhas vai para arquivos temporários e é relida depois. ${n.peakMemoryKB ? `O pico foi de ${fmtSize(n.peakMemoryKB)} por lote.` : ""}`,
    fix: {
      label: "Aumente work_mem para a tabela hash caber inteira na memória",
      sql: `SET work_mem = '${mb((n.peakMemoryKB ?? 4096) * (n.hashBatches ?? 2))}MB';`,
    },
    impactMs: owner.selfMs + n.selfMs,
  });
}

function lossyBitmap(n: PlanNode, out: Insight[]): void {
  if (n.kind !== "bitmap-heap-scan" || !n.lossyHeapBlocks) return;
  out.push({
    code: "lossy-bitmap",
    severity: "warning",
    node: n.id,
    title: `O bitmap de ${n.relation} ficou impreciso em ${fmtCount(n.lossyHeapBlocks)} blocos`,
    detail:
      "Sem memória para lembrar linha por linha, o bitmap passou a lembrar só de blocos inteiros. Cada linha desses blocos precisa ser conferida de novo contra a condição.",
    fix: { label: "Aumente work_mem para o bitmap continuar exato", sql: "SET work_mem = '64MB';" },
    impactMs: n.selfMs,
  });
}

function heapFetches(n: PlanNode, out: Insight[]): void {
  if (n.kind !== "index-only-scan" || !n.heapFetches) return;
  const rows = Math.max(1, n.rowsOut);
  if (n.heapFetches < 1000 || n.heapFetches / rows < 0.5) return;
  out.push({
    code: "heap-fetches",
    severity: "warning",
    node: n.id,
    title: `O Index Only Scan em ${n.relation} precisou ir à tabela ${fmtCount(n.heapFetches)} vezes`,
    detail:
      "A promessa do Index Only Scan é responder só com o índice. Ele só pode fazer isso em páginas marcadas como 'todas visíveis', e essa marca é posta pelo VACUUM. A tabela mudou muito desde o último.",
    fix: { label: "Rode um VACUUM (e confira se o autovacuum está dando conta)", sql: `VACUUM (ANALYZE) ${n.relation};` },
    impactMs: n.selfMs,
  });
}

function missingWorkers(n: PlanNode, out: Insight[]): void {
  if (n.kind !== "gather" || n.workersPlanned === undefined || n.workersLaunched === undefined) return;
  if (n.workersLaunched >= n.workersPlanned) return;
  out.push({
    code: "missing-workers",
    severity: "warning",
    node: n.id,
    title: `O plano contava com ${n.workersPlanned} processos paralelos e só ${n.workersLaunched} subiram`,
    detail: "O limite de processos paralelos do servidor estava esgotado na hora. O plano foi feito para dividir o trabalho e acabou fazendo quase tudo sozinho.",
    fix: { label: "Aumente o limite global, ou reduza o paralelismo por consulta", sql: "SHOW max_parallel_workers;\nSHOW max_worker_processes;" },
    impactMs: n.inclusiveMs,
  });
}

function joinFilter(plan: Plan, n: PlanNode, out: Insight[]): void {
  const removed = (n.rowsRemovedByJoinFilter ?? 0) * (n.loops ?? 1);
  if (n.kind !== "nested-loop" || removed < 10_000 || removed < 10 * Math.max(1, n.rowsOut)) return;
  out.push({
    code: "join-filter",
    severity: severityOf(plan, n.selfMs),
    node: n.id,
    title: `A junção testou e descartou ${fmtCount(removed)} pares de linhas`,
    detail: `A condição ${n.joinFilter} é conferida par a par depois de combinar as linhas, em vez de ser usada para buscá-las. Isso costuma acontecer com condições que não são igualdade (intervalos, OR, funções).`,
    fix: { label: "Reescreva a condição de junção como igualdade sobre colunas indexadas, se possível" },
    impactMs: n.selfMs,
  });
}

function wholePlan(plan: Plan, out: Insight[]): void {
  const exec = plan.executionMs ?? plan.totalMs;
  if (plan.jitMs && plan.jitMs >= 0.25 * exec && plan.jitMs >= 20) {
    out.push({
      code: "jit",
      severity: "warning",
      title: `A compilação JIT levou ${fmtMs(plan.jitMs)}, ${fmtPct(plan.jitMs / exec)} da execução`,
      detail: "O JIT compila partes da consulta em código de máquina. Compensa em consultas longas; numa consulta que já é rápida, o tempo de compilar é maior que o ganho.",
      fix: { label: "Desligue nesta sessão, ou suba o custo mínimo para ele entrar", sql: "SET jit = off;\n-- ou\nSET jit_above_cost = 500000;" },
      impactMs: plan.jitMs,
    });
  }
  if (plan.planningMs && plan.planningMs > exec && plan.planningMs >= 10) {
    out.push({
      code: "planning",
      severity: "info",
      title: `Planejar (${fmtMs(plan.planningMs)}) demorou mais do que executar (${fmtMs(exec)})`,
      detail: "Acontece com muitas tabelas na junção, muitas partições ou muitos índices para considerar. Se a consulta roda muitas vezes, prepará-la evita replanejar.",
      fix: { label: "Use um prepared statement", sql: "PREPARE consulta AS <sua consulta>;\nEXECUTE consulta;" },
      impactMs: plan.planningMs,
    });
  }
  const total = plan.root.buffers.sharedHit + plan.root.buffers.sharedRead;
  if (plan.hasBuffers && plan.root.buffers.sharedRead >= 1000 && plan.root.buffers.sharedRead / total >= 0.8) {
    out.push({
      code: "cold-cache",
      severity: "info",
      title: `${fmtPct(plan.root.buffers.sharedRead / total)} dos blocos vieram do disco, não do cache`,
      detail: `Foram ${fmtCount(plan.root.buffers.sharedRead)} blocos lidos (${fmtSize(plan.root.buffers.sharedRead * 8)}). Se esta foi a primeira execução, o tempo medido inclui aquecer o cache: rode de novo antes de tirar conclusões.`,
      impactMs: 0,
    });
  }
  if (plan.triggerMs && plan.triggerMs >= 0.2 * exec) {
    out.push({
      code: "triggers",
      severity: "warning",
      title: `Gatilhos levaram ${fmtMs(plan.triggerMs)}, ${fmtPct(plan.triggerMs / exec)} da execução`,
      detail: "O tempo de gatilhos (incluindo a checagem de chaves estrangeiras) não aparece em nenhum nó da árvore. Uma chave estrangeira sem índice na tabela filha é a causa mais comum.",
      impactMs: plan.triggerMs,
    });
  }
}
