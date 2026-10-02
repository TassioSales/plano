// Real plans, captured from the demo database in db/seed.sql. The same files
// are the test fixtures of the analysis engine.
const plans = import.meta.glob("../../core/fixtures/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const texts = import.meta.glob("../../core/fixtures/*.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sqls = import.meta.glob("../../core/fixtures/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export type Example = { id: string; title: string; blurb: string; json: string; text: string; sql: string };

const meta: [string, string, string][] = [
  ["email-sem-indice", "Busca sem índice", "Procura um cliente pelo e-mail lendo a tabela inteira."],
  ["subconsulta-repetida", "Subconsulta que se repete", "Uma contagem por cliente, refeita 40 vezes sobre 1 milhão de linhas."],
  ["juncao-sem-indice", "Junção que lê tudo", "Dois milhões de itens lidos para achar os de cinco pedidos."],
  ["ordenacao-em-disco", "Ordenação em disco", "Um milhão de linhas ordenadas com 4 MB de memória."],
  ["estimativa-errada", "Estimativa errada", "Cidade e UF andam juntas, e o planejador não sabe."],
  ["funcao-na-coluna", "Função na coluna", "lower(email) impede o uso de um índice comum."],
  ["periodo-e-status", "Período e status", "Um intervalo de datas e uma igualdade: a ordem das colunas no índice importa."],
  ["agregacao-paralela", "Agregação paralela", "Um plano com três processos, sem nada de errado."],
  ["saudavel", "Plano saudável", "Busca pela chave primária: 0,1 ms."],
];

const file = (set: Record<string, string>, id: string, ext: string) => set[`../../core/fixtures/${id}.${ext}`] ?? "";

export const examples: Example[] = meta.map(([id, title, blurb]) => ({
  id,
  title,
  blurb,
  json: file(plans, id, "json"),
  text: file(texts, id, "txt"),
  sql: file(sqls, id, "sql").trim(),
}));
