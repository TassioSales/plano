import { noBuffers, ParseError, type Buffers, type Kind, type Plan, type PlanNode } from "./types";

/** Parses EXPLAIN output in either format. */
export function parse(input: string): Plan {
  const text = clean(input);
  if (!text) throw new ParseError("Cole a saída de um EXPLAIN para começar.");
  const plan = text.startsWith("[") || text.startsWith("{") ? parseJson(text) : parseText(text);
  number(plan);
  return plan;
}

/**
 * Removes what psql wraps around a plan: the "QUERY PLAN" header and its
 * rule, the "(N rows)" footer, and the "+" that the aligned format puts at
 * the end of each line of a multi-line value.
 */
function clean(input: string): string {
  const lines = input.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (let line of lines) {
    if (/^\s*QUERY PLAN\s*$/.test(line) || /^\s*-{3,}\s*$/.test(line) || /^\s*\(\d+ (rows?|linhas?)\)\s*$/.test(line)) continue;
    line = line.replace(/\s*\+\s*$/, "").replace(/\s+$/, "");
    out.push(line);
  }
  while (out.length && !out[0]!.trim()) out.shift();
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  // psql indents every line of an aligned result by one space.
  if (out.length && out.every((l) => l === "" || l.startsWith(" "))) return out.map((l) => l.slice(1)).join("\n");
  return out.join("\n");
}

function number(plan: Plan): void {
  plan.nodes = [];
  const walk = (n: PlanNode, parent?: PlanNode) => {
    n.id = plan.nodes.length;
    n.parent = parent;
    plan.nodes.push(n);
    for (const c of n.children) walk(c, n);
  };
  walk(plan.root);
  plan.analyzed = plan.nodes.some((n) => n.actualTotal !== undefined);
  plan.hasBuffers = plan.nodes.some((n) => Object.values(n.buffers).some((v) => v > 0));
}

function blank(type: string): PlanNode {
  return {
    id: 0,
    type,
    kind: kindOf(type),
    startupCost: 0,
    totalCost: 0,
    planRows: 0,
    planWidth: 0,
    neverExecuted: false,
    buffers: noBuffers(),
    children: [],
    inclusiveMs: 0,
    selfMs: 0,
    selfShare: 0,
    rowsOut: 0,
    approximate: false,
    estimateFactor: 1,
    estimateDirection: "ok",
    selfBuffers: noBuffers(),
  };
}

export function kindOf(type: string): Kind {
  const t = type.replace(/^Parallel /, "");
  if (t === "Seq Scan") return "seq-scan";
  if (t.startsWith("Index Only Scan")) return "index-only-scan";
  if (t.startsWith("Index Scan")) return "index-scan";
  if (t === "Bitmap Heap Scan") return "bitmap-heap-scan";
  if (t === "Bitmap Index Scan") return "bitmap-index-scan";
  if (t.endsWith(" Scan")) return "other-scan";
  if (t.startsWith("Nested Loop")) return "nested-loop";
  if (t.startsWith("Hash") && t.endsWith("Join")) return "hash-join";
  if (t.startsWith("Merge") && t.endsWith("Join")) return "merge-join";
  if (t === "Hash") return "hash";
  if (t === "Sort" || t === "Incremental Sort") return "sort";
  if (t.includes("Aggregate")) return "aggregate";
  if (t === "Gather" || t === "Gather Merge") return "gather";
  if (t === "Limit") return "limit";
  return "other";
}

// ---- JSON ------------------------------------------------------------------

type Raw = Record<string, unknown>;

function parseJson(text: string): Plan {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ParseError(`O JSON do plano está incompleto ou inválido (${(err as Error).message}).`);
  }
  const top = (Array.isArray(data) ? data[0] : data) as Raw | undefined;
  const rawPlan = top?.["Plan"] as Raw | undefined;
  if (!rawPlan || typeof rawPlan !== "object") {
    throw new ParseError('Isto é JSON, mas não parece um EXPLAIN: falta a chave "Plan". Use EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON).');
  }
  const jit = top!["JIT"] as Raw | undefined;
  const triggers = top!["Triggers"] as Raw[] | undefined;
  return {
    root: jsonNode(rawPlan),
    nodes: [],
    format: "json",
    analyzed: false,
    hasBuffers: false,
    planningMs: num(top!["Planning Time"]),
    executionMs: num(top!["Execution Time"]),
    totalMs: 0,
    jitMs: num((jit?.["Timing"] as Raw | undefined)?.["Total"]),
    triggerMs: triggers?.reduce((s, t) => s + (num(t["Time"]) ?? 0), 0) || undefined,
  };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);

const AGG: Record<string, string> = { Plain: "Aggregate", Sorted: "GroupAggregate", Hashed: "HashAggregate", Mixed: "MixedAggregate" };

/** Builds the name text EXPLAIN would print, so both formats show the same thing. */
function jsonType(r: Raw): string {
  let type = String(r["Node Type"] ?? "?");
  if (type === "Aggregate") {
    type = AGG[String(r["Strategy"])] ?? "Aggregate";
    const mode = str(r["Partial Mode"]);
    if (mode && mode !== "Simple") type = `${mode} ${type}`;
  }
  const join = str(r["Join Type"]);
  if (join && join !== "Inner") {
    type = type === "Nested Loop" ? `Nested Loop ${join} Join` : type.replace(/ Join$/, ` ${join} Join`);
  }
  if (r["Scan Direction"] === "Backward" && type.startsWith("Index")) type = type.replace(" Scan", " Scan Backward");
  if (r["Parallel Aware"] === true) type = `Parallel ${type}`;
  return type;
}

function jsonNode(r: Raw): PlanNode {
  const n = blank(jsonType(r));
  n.relation = str(r["Relation Name"]) ?? str(r["CTE Name"]) ?? str(r["Function Name"]);
  n.alias = str(r["Alias"]);
  n.index = str(r["Index Name"]);
  n.relationship = str(r["Parent Relationship"]);
  n.subplan = str(r["Subplan Name"]);
  n.startupCost = num(r["Startup Cost"]) ?? 0;
  n.totalCost = num(r["Total Cost"]) ?? 0;
  n.planRows = num(r["Plan Rows"]) ?? 0;
  n.planWidth = num(r["Plan Width"]) ?? 0;
  n.actualStartup = num(r["Actual Startup Time"]);
  n.actualTotal = num(r["Actual Total Time"]);
  n.actualRows = num(r["Actual Rows"]);
  n.loops = num(r["Actual Loops"]);
  n.neverExecuted = n.loops === 0;
  n.filter = str(r["Filter"]);
  n.rowsRemovedByFilter = num(r["Rows Removed by Filter"]);
  n.indexCond = str(r["Index Cond"]);
  n.recheckCond = str(r["Recheck Cond"]);
  n.hashCond = str(r["Hash Cond"]);
  n.mergeCond = str(r["Merge Cond"]);
  n.joinFilter = str(r["Join Filter"]);
  n.rowsRemovedByJoinFilter = num(r["Rows Removed by Join Filter"]);
  n.sortKey = list(r["Sort Key"]);
  n.sortMethod = str(r["Sort Method"]);
  n.sortSpaceKB = num(r["Sort Space Used"]);
  const space = str(r["Sort Space Type"]);
  n.sortSpaceType = space === "Disk" || space === "Memory" ? space : undefined;
  n.groupKey = list(r["Group Key"]);
  n.hashBuckets = num(r["Hash Buckets"]);
  n.hashBatches = num(r["Hash Batches"]) ?? num(r["HashAgg Batches"]);
  n.peakMemoryKB = num(r["Peak Memory Usage"]);
  n.heapFetches = num(r["Heap Fetches"]);
  n.exactHeapBlocks = num(r["Exact Heap Blocks"]);
  n.lossyHeapBlocks = num(r["Lossy Heap Blocks"]);
  n.workersPlanned = num(r["Workers Planned"]);
  n.workersLaunched = num(r["Workers Launched"]);
  n.buffers = {
    sharedHit: num(r["Shared Hit Blocks"]) ?? 0,
    sharedRead: num(r["Shared Read Blocks"]) ?? 0,
    sharedDirtied: num(r["Shared Dirtied Blocks"]) ?? 0,
    sharedWritten: num(r["Shared Written Blocks"]) ?? 0,
    localHit: num(r["Local Hit Blocks"]) ?? 0,
    localRead: num(r["Local Read Blocks"]) ?? 0,
    tempRead: num(r["Temp Read Blocks"]) ?? 0,
    tempWritten: num(r["Temp Written Blocks"]) ?? 0,
  };
  n.children = (Array.isArray(r["Plans"]) ? (r["Plans"] as Raw[]) : []).map(jsonNode);
  return n;
}

// ---- text ------------------------------------------------------------------

const NODE =
  /^(\s*)(->\s+)?(.+?)\s+\(cost=([\d.]+)\.\.([\d.]+) rows=(\d+) width=(\d+)\)(?:\s+\((?:actual(?: time=([\d.]+)\.\.([\d.]+))? rows=([\d.]+) loops=(\d+)|(never executed))\))?\s*$/;

function parseText(text: string): Plan {
  const plan: Plan = { root: blank("?"), nodes: [], format: "text", analyzed: false, hasBuffers: false, totalMs: 0 };
  /** Open nodes, with the column where each one's name starts. */
  const stack: { col: number; node: PlanNode }[] = [];
  let label: { name: string; kind: string } | null = null;
  let footer = false; // inside "Planning:" / "JIT:" / trigger lines after the tree
  let root: PlanNode | null = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = NODE.exec(line);
    if (m && !footer) {
      const col = m[1]!.length + (m[2]?.length ?? 0);
      const node = textNode(m);
      while (stack.length && stack[stack.length - 1]!.col >= col) stack.pop();
      const parent = stack[stack.length - 1]?.node;
      if (!parent) {
        if (root) throw new ParseError("O texto tem mais de um plano. Cole um de cada vez.");
        root = node;
      } else {
        if (label) {
          node.subplan = label.name;
          node.relationship = label.kind;
        } else {
          node.relationship = parent.children.length === 0 ? "Outer" : "Inner";
        }
        parent.children.push(node);
      }
      label = null;
      stack.push({ col, node });
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0 && root) {
      // Summary lines after the tree.
      footer = true;
      const time = /^(Planning|Execution) Time: ([\d.]+) ms/.exec(body);
      if (time) plan[time[1] === "Planning" ? "planningMs" : "executionMs"] = Number(time[2]);
      const trig = /^Trigger .*?: time=([\d.]+) calls=/.exec(body);
      if (trig) plan.triggerMs = (plan.triggerMs ?? 0) + Number(trig[1]);
      continue;
    }
    if (footer) {
      const jit = /^Timing: .*Total ([\d.]+) ms/.exec(body);
      if (jit) plan.jitMs = Number(jit[1]);
      continue;
    }
    if (!root) {
      throw new ParseError(
        "Não reconheci isto como um plano. Cole a saída de EXPLAIN (ANALYZE, BUFFERS) em texto, ou de EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON).",
      );
    }
    const sub = /^(SubPlan|InitPlan|CTE)\s+(.+?)(?:\s+\(returns .*\))?$/.exec(body);
    if (sub && !body.includes(":")) {
      label = { name: `${sub[1]} ${sub[2]}`, kind: sub[1] === "CTE" ? "InitPlan" : sub[1]! };
      continue;
    }
    // A property belongs to the deepest open node that starts to its left.
    let owner: PlanNode | undefined;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.col < indent) {
        owner = stack[i]!.node;
        break;
      }
    }
    if (owner) property(owner, body);
  }
  if (!root) {
    throw new ParseError(
      "Não encontrei nenhum nó de plano. A primeira linha deve ser algo como: Seq Scan on tabela  (cost=0.00..1.00 rows=1 width=4).",
    );
  }
  plan.root = root;
  return plan;
}

function textNode(m: RegExpExecArray): PlanNode {
  let title = m[3]!.trim();
  let relation: string | undefined;
  let alias: string | undefined;
  let index: string | undefined;
  // "Index Scan using idx on rel alias", "Seq Scan on rel alias", "Bitmap Index Scan on idx"
  const scan = /^(.*?Scan(?: Backward)?)(?: using (\S+))? on (\S+)(?: (\S+))?$/.exec(title);
  if (scan) {
    title = scan[1]!;
    index = scan[2];
    if (title.replace(/^Parallel /, "") === "Bitmap Index Scan") index = scan[3];
    else {
      relation = scan[3]!.split(".").pop();
      alias = scan[4] ?? relation;
    }
  }
  const n = blank(title);
  n.relation = relation;
  n.alias = alias;
  n.index = index;
  n.startupCost = Number(m[4]);
  n.totalCost = Number(m[5]);
  n.planRows = Number(m[6]);
  n.planWidth = Number(m[7]);
  if (m[11] !== undefined) {
    n.actualStartup = m[8] === undefined ? undefined : Number(m[8]);
    n.actualTotal = m[9] === undefined ? undefined : Number(m[9]);
    n.actualRows = Number(m[10]);
    n.loops = Number(m[11]);
  }
  if (m[12]) {
    n.neverExecuted = true;
    n.loops = 0;
    n.actualRows = 0;
    n.actualTotal = 0;
  }
  return n;
}

const KB = (v: string) => Number(v);

function property(n: PlanNode, body: string): void {
  const sep = body.indexOf(": ");
  if (sep < 0) return;
  const key = body.slice(0, sep);
  const value = body.slice(sep + 2).trim();
  switch (key) {
    case "Filter":
      n.filter = value;
      break;
    case "Rows Removed by Filter":
      n.rowsRemovedByFilter = Number(value);
      break;
    case "Index Cond":
      n.indexCond = value;
      break;
    case "Recheck Cond":
      n.recheckCond = value;
      break;
    case "Hash Cond":
      n.hashCond = value;
      break;
    case "Merge Cond":
      n.mergeCond = value;
      break;
    case "Join Filter":
      n.joinFilter = value;
      break;
    case "Rows Removed by Join Filter":
      n.rowsRemovedByJoinFilter = Number(value);
      break;
    case "Sort Key":
      n.sortKey = splitTop(value);
      break;
    case "Group Key":
      n.groupKey = splitTop(value);
      break;
    case "Sort Method": {
      const m = /^(.*?)\s+(Disk|Memory): (\d+)kB/.exec(value);
      if (m) {
        n.sortMethod = m[1];
        n.sortSpaceType = m[2] as "Disk" | "Memory";
        n.sortSpaceKB = KB(m[3]!);
      } else n.sortMethod = value;
      break;
    }
    case "Buckets": {
      // "32768 (originally 1024)  Batches: 1 (originally 1)  Memory Usage: 1145kB"
      n.hashBuckets = Number(/^(\d+)/.exec(value)?.[1]);
      n.hashBatches = Number(/Batches: (\d+)/.exec(value)?.[1] ?? 1);
      const mem = /Memory Usage: (\d+)kB/.exec(value);
      if (mem) n.peakMemoryKB = KB(mem[1]!);
      break;
    }
    case "Batches": {
      // HashAggregate: "Batches: 5  Memory Usage: 4145kB  Disk Usage: 24544kB"
      n.hashBatches = Number(/^(\d+)/.exec(value)?.[1]);
      const mem = /Memory Usage: (\d+)kB/.exec(value);
      if (mem) n.peakMemoryKB = KB(mem[1]!);
      break;
    }
    case "Heap Fetches":
      n.heapFetches = Number(value);
      break;
    case "Heap Blocks":
      n.exactHeapBlocks = Number(/exact=(\d+)/.exec(value)?.[1] ?? 0);
      n.lossyHeapBlocks = Number(/lossy=(\d+)/.exec(value)?.[1] ?? 0);
      break;
    case "Workers Planned":
      n.workersPlanned = Number(value);
      break;
    case "Workers Launched":
      n.workersLaunched = Number(value);
      break;
    case "Buffers":
      n.buffers = textBuffers(value);
      break;
  }
}

/** "shared hit=3 read=7350, temp read=3179 written=3190" */
function textBuffers(value: string): Buffers {
  const b = noBuffers();
  for (const group of value.split(", ")) {
    const scope = /^(shared|local|temp)/.exec(group)?.[1];
    if (!scope) continue;
    for (const [, what, n] of group.matchAll(/(hit|read|dirtied|written)=(\d+)/g)) {
      const key = `${scope}${what![0]!.toUpperCase()}${what!.slice(1)}` as keyof Buffers;
      if (key in b) b[key] = Number(n);
    }
  }
  return b;
}

/** Splits "a, lower(b, c), d DESC" on the commas that are not inside parentheses. */
function splitTop(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}
