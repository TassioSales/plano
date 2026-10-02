import { noBuffers, type Buffers, type Plan, type PlanNode } from "./types";

/**
 * Fills in what EXPLAIN doesn't say directly: how long each node took by
 * itself, how many rows it produced in total, and how wrong its estimate was.
 */
export function analyze(plan: Plan): Plan {
  if (plan.analyzed) timing(plan.root, 1);
  for (const n of plan.nodes) {
    estimate(n);
    n.selfBuffers = subtract(n.buffers, n.children);
  }
  plan.totalMs = plan.executionMs ?? plan.root.inclusiveMs;
  for (const n of plan.nodes) n.selfShare = plan.totalMs > 0 ? Math.min(1, n.selfMs / plan.totalMs) : 0;
  return plan;
}

/**
 * EXPLAIN reports time per loop. A node on the inner side of a nested loop,
 * or in a subplan, really cost time × loops. Under a Gather it is different:
 * the "loops" are the leader and the workers running at the same time, so
 * the wall-clock cost is one loop's worth. `concurrency` carries how many
 * processes share the loops at this point of the tree.
 */
function timing(n: PlanNode, concurrency: number): void {
  const loops = n.loops ?? 1;
  n.inclusiveMs = ((n.actualTotal ?? 0) * loops) / concurrency;
  n.rowsOut = (n.actualRows ?? 0) * loops;
  n.approximate = concurrency > 1;
  const below = n.kind === "gather" ? concurrency * ((n.workersLaunched ?? 0) + 1) : concurrency;
  let children = 0;
  for (const c of n.children) {
    timing(c, below);
    children += c.inclusiveMs;
  }
  // Rounding in EXPLAIN and overlapping parallel work can push the sum past
  // the parent by a hair; a node never takes negative time.
  n.selfMs = Math.max(0, n.inclusiveMs - children);
}

function estimate(n: PlanNode): void {
  if (n.actualRows === undefined || n.neverExecuted) return;
  // Both numbers are per loop. Postgres never estimates below 1 row.
  const actual = Math.max(n.actualRows, 1);
  const planned = Math.max(n.planRows, 1);
  if (actual >= planned) {
    n.estimateFactor = actual / planned;
    n.estimateDirection = n.estimateFactor > 1 ? "under" : "ok";
  } else {
    n.estimateFactor = planned / actual;
    n.estimateDirection = "over";
  }
}

function subtract(own: Buffers, children: PlanNode[]): Buffers {
  const out = noBuffers();
  for (const k of Object.keys(out) as (keyof Buffers)[]) {
    out[k] = Math.max(0, own[k] - children.reduce((s, c) => s + c.buffers[k], 0));
  }
  return out;
}

/** Total 8 kB blocks a node touched itself. */
export const blocks = (b: Buffers) => b.sharedHit + b.sharedRead + b.localHit + b.localRead;
