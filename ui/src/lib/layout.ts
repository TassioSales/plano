import type { PlanNode } from "../../core";

export const NODE_W = 216;
export const NODE_H = 92;
const GAP_X = 28;
const GAP_Y = 64;

export type Placed = { node: PlanNode; x: number; y: number };
export type Layout = { placed: Placed[]; byId: Map<number, Placed>; width: number; height: number };

/**
 * A tidy top-down tree: leaves are spread left to right, each parent sits
 * centred over its children. Plans are narrow and rarely deep, so this
 * simple pass is enough and never overlaps.
 */
export function layout(root: PlanNode): Layout {
  const placed: Placed[] = [];
  const byId = new Map<number, Placed>();
  let nextLeaf = 0;
  let maxDepth = 0;

  const place = (node: PlanNode, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    let x: number;
    if (node.children.length === 0) {
      x = nextLeaf++ * (NODE_W + GAP_X);
    } else {
      const xs = node.children.map((c) => place(c, depth + 1));
      x = (xs[0]! + xs[xs.length - 1]!) / 2;
    }
    const p = { node, x, y: depth * (NODE_H + GAP_Y) };
    placed.push(p);
    byId.set(node.id, p);
    return x;
  };
  place(root, 0);

  return {
    placed,
    byId,
    width: Math.max(1, nextLeaf) * (NODE_W + GAP_X) - GAP_X,
    height: (maxDepth + 1) * (NODE_H + GAP_Y) - GAP_Y,
  };
}

/**
 * The one loud colour of the app: how much of the query's time a node took
 * by itself. Square-rooted so that 10% already looks warm.
 */
export function heat(share: number): string {
  if (share < 0.005) return "#e2e5ee";
  const x = Math.sqrt(Math.min(1, share));
  const hue = 48 - 40 * x; // yellow → red-orange
  const light = 72 - 22 * x;
  return `hsl(${hue.toFixed(0)} 92% ${light.toFixed(0)}%)`;
}

/** Edge thickness from the number of rows flowing through it (log scale, 1.5–14 px). */
export function thickness(rows: number, max: number): number {
  if (rows <= 0 || max <= 1) return 1.5;
  return 1.5 + 12.5 * (Math.log10(rows + 1) / Math.log10(max + 1));
}
