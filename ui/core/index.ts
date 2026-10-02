import { analyze } from "./analyze";
import { diagnose } from "./insights";
import { parse } from "./parse";
import type { Insight, Plan } from "./types";

export * from "./types";
export * from "./format";
export { parse, kindOf } from "./parse";
export { analyze, blocks } from "./analyze";
export { diagnose, underLimit } from "./insights";
export { predicates, indexFor, indexSql } from "./conditions";

/** Everything at once: parse, measure, diagnose. */
export function explain(input: string): { plan: Plan; insights: Insight[] } {
  const plan = analyze(parse(input));
  return { plan, insights: diagnose(plan) };
}
