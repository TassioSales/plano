import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explain, indexFor, indexSql, ParseError, predicates, type PlanNode } from "./index";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""));

/** What must be the same no matter which format the plan was pasted in. */
const shape = (n: PlanNode): unknown => ({
  type: n.type,
  kind: n.kind,
  relation: n.relation,
  alias: n.alias,
  index: n.index,
  subplan: n.subplan,
  planRows: n.planRows,
  loops: n.loops,
  filter: n.filter,
  hashCond: n.hashCond,
  indexCond: n.indexCond,
  sortKey: n.sortKey,
  sortSpaceType: n.sortSpaceType,
  hashBatches: n.hashBatches,
  workers: [n.workersPlanned, n.workersLaunched],
  children: n.children.map(shape),
});

describe("the two formats", () => {
  it.each(names)("%s: text and JSON give the same tree and the same findings", (name) => {
    const json = explain(read(`${name}.json`));
    const text = explain(read(`${name}.txt`));
    expect(json.plan.format).toBe("json");
    expect(text.plan.format).toBe("text");
    // The two files are two separate runs of the same query: same shape, different timings.
    expect(shape(text.plan.root)).toEqual(shape(json.plan.root));
    const findings = (r: typeof json) => r.insights.filter((i) => i.severity !== "info").map((i) => [i.code, i.node, i.fix?.sql]);
    expect(findings(text)).toEqual(findings(json));
    for (const p of [json.plan, text.plan]) {
      expect(p.analyzed).toBe(true);
      expect(p.hasBuffers).toBe(true);
      expect(p.executionMs).toBeGreaterThan(0);
      expect(p.planningMs).toBeGreaterThan(0);
    }
  });

  it("accepts what psql prints in its default aligned format", () => {
    for (const ext of ["json", "txt"]) {
      const body = read(`ordenacao-em-disco.${ext}`).trimEnd().split("\n");
      const lines = body.map((l, i) => " " + l + (ext === "json" && i < body.length - 1 ? "    +" : ""));
      const wrapped = ["                 QUERY PLAN", "-----------------------------", ...lines, "(1 row)", ""].join("\n");
      const { plan, insights } = explain(wrapped);
      expect(plan.nodes.map((n) => n.type)).toEqual(["Sort", "Seq Scan"]);
      expect(insights[0]!.code).toBe("sort-on-disk");
    }
  });
});

describe("timing", () => {
  it("multiplies a subplan by its loops", () => {
    const { plan } = explain(read("subconsulta-repetida.txt"));
    const [limit, scan, agg, inner] = plan.nodes as [PlanNode, PlanNode, PlanNode, PlanNode];
    expect(agg.subplan).toBe("SubPlan 1");
    expect(agg.relationship).toBe("SubPlan");
    // 44.946 ms × 40 loops
    expect(agg.inclusiveMs).toBeCloseTo(1797.84, 1);
    expect(inner.rowsOut).toBe(200);
    // The outer scan's 1810 ms are almost all the subplan's.
    expect(scan.selfMs).toBeCloseTo(1810.185 - 1797.84, 1);
    expect(limit.selfMs).toBeCloseTo(1888.892 - 1810.185, 1);
    const sum = plan.nodes.reduce((s, n) => s + n.selfMs, 0);
    expect(sum).toBeCloseTo(limit.inclusiveMs, 3);
  });

  it("does not multiply parallel workers: they run at the same time", () => {
    const { plan } = explain(read("agregacao-paralela.txt"));
    const scan = plan.nodes.find((n) => n.relation === "itens_pedido")!;
    expect(scan.type).toBe("Parallel Seq Scan");
    expect(scan.loops).toBe(3);
    expect(scan.inclusiveMs).toBeCloseTo(65.277, 3); // not × 3
    expect(scan.rowsOut).toBe(2_000_001); // 666667 × 3: rows do add up
    expect(scan.approximate).toBe(true);
    expect(plan.root.approximate).toBe(false);
    // No node can take longer than the whole query.
    for (const n of plan.nodes) expect(n.inclusiveMs).toBeLessThanOrEqual(plan.totalMs + 0.001);
    const top = [...plan.nodes].sort((a, b) => b.selfMs - a.selfMs)[0]!;
    expect(top.type).toBe("Partial HashAggregate");
  });

  it("computes self buffers by subtracting the children", () => {
    const { plan } = explain(read("ordenacao-em-disco.txt"));
    const [sort, scan] = plan.nodes as [PlanNode, PlanNode];
    expect(scan.selfBuffers.sharedRead).toBe(7200);
    expect(sort.selfBuffers.sharedRead).toBe(0);
    expect(sort.selfBuffers.tempWritten).toBe(3082);
    expect(sort.sortSpaceKB).toBe(24544);
  });
});

describe("diagnostics", () => {
  const top = (name: string) => explain(read(`${name}.json`)).insights;

  it("missing index on an equality filter", () => {
    const [i] = top("email-sem-indice");
    expect(i).toMatchObject({ code: "seq-scan-filter", severity: "critical", node: 0 });
    expect(i!.fix!.sql).toBe("CREATE INDEX ON clientes (email);");
    expect(i!.title).toBe("clientes: leu a tabela inteira para aproveitar 1 de 200.000 linhas");
  });

  it("function on the column needs an expression index", () => {
    const [i] = top("funcao-na-coluna");
    expect(i!.fix!.sql).toBe("CREATE INDEX ON clientes (lower(email));");
    expect(i!.fix!.index).toEqual({ table: "clientes", columns: [{ name: "email", fn: "lower" }] });
  });

  it("equalities lead a composite index, the range goes last", () => {
    const [i] = top("periodo-e-status");
    expect(i!.fix!.sql).toBe("CREATE INDEX ON pedidos (status, criado_em);");
  });

  it("a hash join that reads a whole table to match a few rows", () => {
    const list = top("juncao-sem-indice");
    expect(list.map((i) => i.code).slice(0, 2)).toEqual(["join-scan", "seq-scan-filter"]);
    expect(list[0]!.fix!.sql).toBe("CREATE INDEX ON itens_pedido (pedido_id);");
    expect(list[1]!.fix!.sql).toBe("CREATE INDEX ON pedidos (cliente_id);");
  });

  it("a subquery that runs once per outer row", () => {
    const list = top("subconsulta-repetida");
    expect(list[0]).toMatchObject({ code: "repeated-subplan", severity: "critical" });
    expect(list[0]!.title).toMatch(/rodou 40 vezes/);
    expect(list[0]!.fix!.sql).toBe("CREATE INDEX ON pedidos (cliente_id);");
    // The scan inside it is the same story, and the outer scan stopped early
    // because of the LIMIT: neither is reported separately.
    expect(list.filter((i) => i.severity !== "info").length).toBe(1);
  });

  it("a sort that spilled to disk", () => {
    const [i] = top("ordenacao-em-disco");
    expect(i).toMatchObject({ code: "sort-on-disk", severity: "critical" });
    expect(i!.fix!.sql).toBe("SET work_mem = '72MB';\n-- ou\nCREATE INDEX ON pedidos (total);");
  });

  it("correlated columns: reported once, where the error starts", () => {
    const list = top("estimativa-errada").filter((i) => i.code === "misestimate");
    expect(list.length).toBe(1);
    expect(list[0]!.fix!.sql).toBe("CREATE STATISTICS ON cidade, uf FROM clientes;\nANALYZE clientes;");
    expect(list[0]!.title).toMatch(/^Estimativa 20× abaixo do real/);
  });

  it("healthy plans are called healthy", () => {
    for (const name of ["saudavel", "agregacao-paralela"]) {
      const list = top(name);
      expect(list[0]!.code).toBe("healthy");
      expect(list.some((i) => i.severity === "critical" || i.severity === "warning")).toBe(false);
    }
  });

  it("a plan without ANALYZE only gets told so", () => {
    const { plan, insights } = explain("Seq Scan on clientes  (cost=0.00..5137.00 rows=1 width=58)\n  Filter: (email = 'a'::text)");
    expect(plan.analyzed).toBe(false);
    expect(plan.root.filter).toBe("(email = 'a'::text)");
    expect(insights.map((i) => i.code)).toEqual(["not-analyzed"]);
  });
});

describe("conditions", () => {
  it("reads comparisons out of what Postgres prints", () => {
    expect(predicates("(email = 'a@b.c'::text)")).toEqual([{ column: "email", op: "eq" }]);
    expect(predicates("(lower(email) = 'a'::text)")).toEqual([{ column: "email", fn: "lower", op: "eq" }]);
    expect(predicates("(lower((nome)::text) = 'a'::text)")).toEqual([{ column: "nome", fn: "lower", op: "eq" }]);
    expect(predicates("((p.total)::numeric > 100)")).toEqual([{ column: "total", op: "range" }]);
    expect(predicates("(cliente_id = c.id)")).toEqual([{ column: "cliente_id", op: "eq" }]);
    expect(
      predicates("((criado_em >= '2025-01-01 00:00:00+00'::timestamp with time zone) AND (criado_em < '2025-01-08'::date) AND (status = 'pago'::text))"),
    ).toEqual([
      { column: "criado_em", op: "range" },
      { column: "criado_em", op: "range" },
      { column: "status", op: "eq" },
    ]);
    // A string that contains AND and parentheses is one value, not two conditions.
    expect(predicates("(nome = 'a AND (b)'::text)")).toEqual([{ column: "nome", op: "eq" }]);
  });

  it("gives up on OR and on things no b-tree serves", () => {
    expect(predicates("((status = 'pago'::text) OR (total > 10))")).toBeNull();
    expect(predicates("(nome ~~ '%silva%'::text)")).toBeNull();
    expect(predicates(undefined)).toBeNull();
  });

  it("orders index columns and quotes odd names", () => {
    const spec = indexFor("pedidos", predicates("((criado_em >= '1'::date) AND (status = 'x'::text) AND (uf = 'SP'::bpchar) AND (total < 5))")!)!;
    expect(spec.columns.map((c) => c.name)).toEqual(["status", "uf", "criado_em"]);
    expect(indexSql({ table: "Pedidos Antigos", columns: [{ name: "data" }, { name: 'a"b', fn: "lower" }] })).toBe(
      'CREATE INDEX ON "Pedidos Antigos" (data, lower("a""b"));',
    );
  });
});

describe("bad input", () => {
  it("explains what is wrong instead of crashing", () => {
    expect(() => explain("")).toThrow(ParseError);
    expect(() => explain("SELECT * FROM clientes")).toThrow(/Não reconheci/);
    expect(() => explain('[{"foo": 1}]')).toThrow(/falta a chave "Plan"/);
    expect(() => explain('[{"Plan": {')).toThrow(/incompleto ou inválido/);
  });
});
