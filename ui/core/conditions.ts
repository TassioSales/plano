import type { IndexSpec } from "./types";

/** One comparison found in a Filter or Index Cond. */
export type Predicate = {
  column: string;
  fn?: "lower" | "upper";
  /** "eq" can lead an index; "range" can only be its last useful column. */
  op: "eq" | "range";
};

/** Splits "((a = 1) AND (b > 2))" on the ANDs that are not inside parentheses. */
function conjuncts(expr: string): string[] | null {
  let e = expr.trim();
  // Peel one pair of parentheses that wraps the whole expression.
  while (e.startsWith("(") && matching(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && e.startsWith(" AND ", i)) {
      parts.push(e.slice(start, i));
      start = i + 5;
    } else if (depth === 0 && e.startsWith(" OR ", i)) {
      return null; // an OR can't be served by one plain index
    }
  }
  parts.push(e.slice(start));
  return parts.map((p) => p.trim());
}

function matching(e: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < e.length; i++) {
    if (e[i] === "'") quoted = !quoted;
    if (quoted) continue;
    if (e[i] === "(") depth++;
    if (e[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

const IDENT = String.raw`(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)`;
const FUNC = new RegExp(String.raw`^\(?(lower|upper)\(\(?${IDENT}\)?(?:::[a-z ]+)?\)\s*(=)\s`, "i");
const PLAIN = new RegExp(String.raw`^\(?\(?${IDENT}\)?(?:::[a-z ]+)?\s*(=|<=|>=|<|>)\s`, "i");

/**
 * Reads the comparisons out of a condition as Postgres prints it, e.g.
 *   ((criado_em >= '2025-01-01'::timestamptz) AND (status = 'pago'::text))
 * Returns null when the condition has an OR or nothing an index could use.
 */
export function predicates(expr: string | undefined): Predicate[] | null {
  if (!expr) return null;
  const parts = conjuncts(expr);
  if (!parts) return null;
  const out: Predicate[] = [];
  for (const part of parts) {
    const f = FUNC.exec(part);
    if (f) {
      out.push({ column: f[2]!, fn: f[1]!.toLowerCase() as "lower" | "upper", op: "eq" });
      continue;
    }
    const p = PLAIN.exec(part);
    if (p) out.push({ column: p[1]!, op: p[2] === "=" ? "eq" : "range" });
  }
  return out.length ? out : null;
}

/**
 * The index that serves a set of comparisons: equality columns first (any
 * order works for them), then one range column, because a b-tree can only
 * narrow by a range on the last column it uses.
 */
export function indexFor(table: string, preds: Predicate[]): IndexSpec | null {
  const seen = new Set<string>();
  const columns: IndexSpec["columns"] = [];
  const add = (p: Predicate) => {
    const key = `${p.fn ?? ""}:${p.column}`;
    if (seen.has(key)) return;
    seen.add(key);
    columns.push(p.fn ? { name: p.column, fn: p.fn } : { name: p.column });
  };
  for (const p of preds) if (p.op === "eq") add(p);
  const range = preds.find((p) => p.op === "range" && !seen.has(`:${p.column}`));
  if (range) add(range);
  return columns.length ? { table, columns } : null;
}

const quote = (id: string) => (/^[a-z_][a-z0-9_]*$/.test(id) ? id : `"${id.replace(/"/g, '""')}"`);

/** The CREATE INDEX statement for a spec. */
export function indexSql(spec: IndexSpec): string {
  const cols = spec.columns.map((c) => (c.fn ? `${c.fn}(${quote(c.name)})` : quote(c.name)));
  return `CREATE INDEX ON ${quote(spec.table)} (${cols.join(", ")});`;
}
