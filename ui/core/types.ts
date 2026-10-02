/** Block counters reported by EXPLAIN (BUFFERS). Inclusive of children, as Postgres reports them. */
export type Buffers = {
  sharedHit: number;
  sharedRead: number;
  sharedDirtied: number;
  sharedWritten: number;
  localHit: number;
  localRead: number;
  tempRead: number;
  tempWritten: number;
};

export const noBuffers = (): Buffers => ({
  sharedHit: 0,
  sharedRead: 0,
  sharedDirtied: 0,
  sharedWritten: 0,
  localHit: 0,
  localRead: 0,
  tempRead: 0,
  tempWritten: 0,
});

/** What a node does, coarsely: the diagnostics reason about these, not about display names. */
export type Kind =
  | "seq-scan"
  | "index-scan"
  | "index-only-scan"
  | "bitmap-heap-scan"
  | "bitmap-index-scan"
  | "other-scan"
  | "nested-loop"
  | "hash-join"
  | "merge-join"
  | "hash"
  | "sort"
  | "aggregate"
  | "gather"
  | "limit"
  | "other";

/** One operator of the plan, as parsed. Both the JSON and the text format end up here. */
export type PlanNode = {
  id: number;
  /** Display name in the style of text EXPLAIN: "Parallel Seq Scan", "Hash Left Join", "HashAggregate". */
  type: string;
  kind: Kind;
  relation?: string;
  alias?: string;
  index?: string;
  /** How this node hangs off its parent: Outer, Inner, SubPlan, InitPlan, Member. */
  relationship?: string;
  /** "SubPlan 1", "InitPlan 2", "CTE recentes". */
  subplan?: string;

  startupCost: number;
  totalCost: number;
  planRows: number;
  planWidth: number;

  /** Per loop, as Postgres reports. Undefined when the plan was not run with ANALYZE. */
  actualStartup?: number;
  actualTotal?: number;
  actualRows?: number;
  loops?: number;
  neverExecuted: boolean;

  filter?: string;
  rowsRemovedByFilter?: number;
  indexCond?: string;
  recheckCond?: string;
  hashCond?: string;
  mergeCond?: string;
  joinFilter?: string;
  rowsRemovedByJoinFilter?: number;
  sortKey?: string[];
  sortMethod?: string;
  sortSpaceKB?: number;
  sortSpaceType?: "Disk" | "Memory";
  groupKey?: string[];
  hashBuckets?: number;
  hashBatches?: number;
  peakMemoryKB?: number;
  heapFetches?: number;
  exactHeapBlocks?: number;
  lossyHeapBlocks?: number;
  workersPlanned?: number;
  workersLaunched?: number;
  buffers: Buffers;

  children: PlanNode[];
  parent?: PlanNode;

  // ---- derived by analyze() ----------------------------------------------
  /** Wall time spent in this node and everything below it, across all loops (ms). */
  inclusiveMs: number;
  /** Wall time spent in this node itself (ms). */
  selfMs: number;
  /** selfMs as a fraction of the whole execution. */
  selfShare: number;
  /** Rows produced across all loops. */
  rowsOut: number;
  /**
   * True under a Gather: EXPLAIN reports the average per process, rounded,
   * so totals are off by a few rows and a "0" may hide one or two.
   */
  approximate: boolean;
  /** How far the row estimate was off, always >= 1. */
  estimateFactor: number;
  /** "under": more rows came than expected. "over": fewer. */
  estimateDirection: "under" | "over" | "ok";
  /** Blocks this node touched itself, children excluded. */
  selfBuffers: Buffers;
};

export type Plan = {
  root: PlanNode;
  /** Every node, in the order EXPLAIN prints them. */
  nodes: PlanNode[];
  format: "json" | "text";
  /** True when the plan carries real timings and row counts. */
  analyzed: boolean;
  hasBuffers: boolean;
  planningMs?: number;
  executionMs?: number;
  /** Execution time, or the root's time when the summary line is missing. */
  totalMs: number;
  jitMs?: number;
  triggerMs?: number;
};

export type Severity = "critical" | "warning" | "info" | "good";

/** An index the tool proposes. Structured so the live mode can build it safely. */
export type IndexSpec = {
  table: string;
  columns: { name: string; fn?: "lower" | "upper" }[];
};

export type Insight = {
  code: string;
  severity: Severity;
  /** The node the finding is about, if any. */
  node?: number;
  title: string;
  detail: string;
  /** What to do about it. */
  fix?: { label: string; sql?: string; index?: IndexSpec };
  /** Roughly how much time is at stake (ms), used to rank findings. */
  impactMs: number;
};

export class ParseError extends Error {}
