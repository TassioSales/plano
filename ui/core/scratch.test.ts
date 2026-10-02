import { readdirSync, readFileSync } from "node:fs";
import { it } from "vitest";
import { explain } from "./index";

it("prints", () => {
  const dir = new URL("./fixtures/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    for (const ext of [".json", ".txt"]) {
      const { plan, insights } = explain(readFileSync(new URL(f.replace(".json", ext), dir), "utf8"));
      console.log(`\n== ${f.replace(".json", ext)} total=${plan.totalMs} nodes=${plan.nodes.length} top=${[...plan.nodes].sort((a, b) => b.selfMs - a.selfMs)[0]!.type}`);
      for (const i of insights) console.log(`  [${i.severity}] ${i.code} n=${i.node}: ${i.title}${i.fix?.sql ? "\n      => " + i.fix.sql.replace(/\n/g, " | ") : ""}`);
    }
  }
});
