# plano

**Cole um `EXPLAIN` do Postgres e descubra por que a consulta está lenta.**

O plano transforma a saída do `EXPLAIN` numa árvore com o tempo de cada passo, diz em português
o que está errado e entrega o comando para corrigir. Ligado a um banco, ele vai além: **testa o
índice sugerido dentro de uma transação que é desfeita** e mostra o antes e o depois, sem criar
nada.

```
Uma subconsulta rodou 40 vezes e levou 92% do tempo

Cada execução leva 45 ms, o que parece pouco, mas ela se repete para cada linha de fora:
40 × 45 ms = 1,8 s. E a cada vez o Seq Scan em pedidos lê 1.000.000 linhas para aproveitar 5.

O que fazer: crie um índice na coluna do filtro.
    CREATE INDEX ON pedidos (cliente_id);

    [ Testar este índice sem criá-lo ]   →   1,63 s  →  12 ms   (141× mais rápido)
                                              o índice ocuparia 11 MB; nada foi alterado
```

## Sumário

- [O que ele faz](#o-que-ele-faz)
- [Como rodar](#como-rodar)
- [Os diagnósticos](#os-diagnósticos)
- [Como o tempo é calculado](#como-o-tempo-é-calculado)
- [O modo ao vivo](#o-modo-ao-vivo)
- [O banco de demonstração](#o-banco-de-demonstração)
- [Testes](#testes)
- [Publicar como site estático](#publicar-como-site-estático)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Limites](#limites)

## O que ele faz

- **Lê os dois formatos**: texto e JSON, inclusive colados direto do psql (com o cabeçalho
  `QUERY PLAN`, a régua e os `+` de continuação).
- **Mostra para onde foi o tempo**: uma barra única da execução, dividida pelo tempo que cada nó
  gastou sozinho, e a árvore do plano com cor por tempo e ligações mais grossas onde passam mais
  linhas.
- **Diagnostica**: varredura que descarta quase tudo, subconsulta repetida, junção que lê uma
  tabela inteira para casar com poucas linhas, estimativa errada, ordenação em disco, e outros.
  Cada achado vem com a explicação e o comando.
- **Sugere o índice certo**: colunas de igualdade primeiro, a de intervalo por último; índice sobre
  expressão quando a coluna passa por `lower()`; estatísticas estendidas quando colunas andam juntas.
- **Testa o índice sem criá-lo** (modo ao vivo): mede, cria, mede de novo, desfaz.
- **Compartilha por link**: o plano vai comprimido no fragmento da URL. Não há servidor guardando nada.
- **Funciona sem backend**: a análise roda inteira no navegador. O que você cola não sai da sua máquina.

## Como rodar

Pré-requisitos: **Go 1.26+** e **Node 22+**. O **Docker Desktop** é opcional: com ele, o script
sobe um banco de demonstração e liga o modo ao vivo.

```powershell
.\run.ps1
```

ou dois cliques em `run.bat`. Abre `http://127.0.0.1:7676`.

| Comando | O que faz |
|---|---|
| `.\run.ps1` | Sobe o banco de demonstração no Docker e roda com o modo ao vivo |
| `.\run.ps1 -Static` | Sem Docker: só a análise de planos colados |
| `.\run.ps1 -Db "postgres://..."` | Modo ao vivo no **seu** banco |
| `.\run.ps1 -Dev` | Servidor + Vite com hot reload em `http://localhost:5176` |
| `.\run.ps1 -Test` | Testes do motor (vitest), do servidor (Go) e build com checagem de tipos |
| `.\run.ps1 -Down` | Para o banco de demonstração |

Na primeira vez o banco de demonstração cria 3,2 milhões de linhas, o que leva cerca de um minuto.
Sem Docker instalado, o script segue no modo estático em vez de falhar.

### Roteiro de 2 minutos

1. Na página inicial, clique no exemplo **Subconsulta que se repete**.
2. Veja a barra de tempo (92% num único nó) e o diagnóstico à esquerda.
3. Clique em **Testar este índice sem criá-lo**: aparece o antes e o depois, e o botão *Plano depois*
   troca a árvore para o plano novo.
4. Volte, abra a aba **Executar no banco** e rode uma consulta sua na loja de exemplo.
5. Clique em **Copiar link deste plano** e abra o link em outra aba.

## Os diagnósticos

Cada regra olha para o que o plano mediu, não para o texto da consulta. Os nomes à esquerda são os
exemplos da página inicial: planos reais, tirados do banco de demonstração.

| Exemplo | O que o plano mostra | O que o plano diz | Correção |
|---|---|---|---|
| Busca sem índice | Seq Scan que lê 200.000 linhas e fica com 1 | Leu a tabela inteira para aproveitar 1 linha | `CREATE INDEX ON clientes (email)` |
| Função na coluna | Filtro `lower(email) = ...` | Índice comum não serve quando a coluna passa por função | `CREATE INDEX ON clientes (lower(email))` |
| Período e status | Filtro com intervalo de datas e igualdade | Índice composto: igualdade primeiro, intervalo por último | `CREATE INDEX ON pedidos (status, criado_em)` |
| Junção que lê tudo | Hash Join: 2 milhões de linhas de um lado, poucas do outro | Leu ~2.000.000 linhas para casar com poucas | `CREATE INDEX ON itens_pedido (pedido_id)` |
| Subconsulta que se repete | SubPlan com `loops=40` | Rodou 40 vezes e levou 92% do tempo | `CREATE INDEX ON pedidos (cliente_id)` |
| Ordenação em disco | `Sort Method: external merge  Disk: 24544kB` | Não coube na memória, usou 24 MB de disco | `SET work_mem = '72MB'`, ou um índice que já entrega em ordem |
| Estimativa errada | Esperava 101 linhas, vieram 2.000 | Estimativa 20× abaixo do real: as colunas andam juntas | `CREATE STATISTICS ON cidade, uf FROM clientes` |
| Agregação paralela, Plano saudável | Nada fora do lugar | Nada chama atenção | — |

Também são detectados: tabela hash dividida em lotes por falta de memória, bitmap que ficou
impreciso (*lossy*), Index Only Scan indo demais à tabela (falta de `VACUUM`), processos paralelos
planejados que não subiram, filtro de junção que descarta milhares de pares, JIT custando mais do
que ajuda, planejamento mais lento que a execução, tempo em gatilhos, e cache frio.

Três cuidados para não gritar à toa:

- **Uma história por problema.** A varredura dentro de uma subconsulta repetida não vira um segundo
  aviso; um erro de estimativa é reportado só no nó onde nasce, não em cada nó acima que o herdou.
- **`LIMIT` não é erro de estimativa.** Um nó abaixo de um `LIMIT` que produz menos linhas do que o
  previsto parou cedo de propósito.
- **O que é barato não aparece.** Uma varredura "ruim" que custa menos de 2% da consulta não é
  mencionada.

## Como o tempo é calculado

O `EXPLAIN` reporta o tempo **por execução** de cada nó, incluindo os filhos. Para saber quanto um
nó custou sozinho é preciso desfazer isso, e há duas armadilhas:

**Loops.** Um nó no lado interno de um nested loop, ou dentro de um SubPlan, é executado várias
vezes. Seu custo real é `tempo × loops`:

```
SubPlan 1
  ->  Aggregate  (actual time=44.946..44.946 rows=1 loops=40)     →  44,9 ms × 40 = 1,8 s
```

**Paralelismo.** Abaixo de um `Gather`, `loops=3` significa o líder e dois ajudantes rodando **ao
mesmo tempo**. Multiplicar por 3 daria um nó mais lento que a consulta inteira. O tempo de relógio
é o de uma execução; as linhas, essas sim, somam.

```
->  Parallel Seq Scan on itens_pedido  (actual time=0.053..65.277 rows=666667 loops=3)
        tempo: 65 ms (não 196 ms)        linhas: ~2.000.000
```

Como o `EXPLAIN` arredonda a média por processo, as contagens sob um `Gather` aparecem com `~`, e um
`rows=0` é mostrado como "poucas" em vez de zero.

O tempo próprio de um nó é o seu tempo total menos o dos filhos. Há um teste que confere que os
tempos próprios somam o tempo total da raiz, e outro que nenhum nó passa do tempo da consulta.

## O modo ao vivo

Com `-db`, o servidor Go ganha dois endpoints.

**`POST /api/explain`** roda `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` numa transação **somente
leitura** que é desfeita. Um `UPDATE` ou `DELETE` é recusado pelo próprio Postgres.

**`POST /api/try-index`** faz, numa única transação:

```
BEGIN
  SAVEPOINT antes
  EXPLAIN ANALYZE <consulta>          ← plano "antes"
  ROLLBACK TO SAVEPOINT antes
  CREATE INDEX plano_indice_de_teste ON tabela (colunas)
  ANALYZE tabela                      ← índices de expressão só ganham estatísticas assim
  EXPLAIN ANALYZE <consulta>          ← plano "depois"
ROLLBACK
```

O índice nunca existe fora dessa transação. O relatório traz também o tamanho que ele ocuparia e
quanto levou para ser construído, que são os dois custos reais de um índice.

Cuidados de segurança:

- O índice chega como **estrutura** (`{tabela, colunas, função}`), não como SQL. O comando é montado
  no servidor com cada identificador entre aspas, e só `lower` e `upper` são aceitas como função.
- O protocolo estendido do Postgres recusa mais de um comando por consulta: `SELECT 1; DROP TABLE x`
  falha inteiro.
- `statement_timeout` de 30 s e `lock_timeout` de 3 s em toda transação.
- Só requisições JSON da própria origem são aceitas; o servidor escuta em `127.0.0.1`.

E o que **não** é seguro: o `CREATE INDEX` bloqueia escritas na tabela enquanto constrói, e funções
com efeito colateral fora da transação (`nextval`, `dblink`) não são desfeitas. O modo ao vivo é
para bancos de desenvolvimento, não de produção.

## O banco de demonstração

`db/seed.sql` cria uma loja: 200 mil clientes, 20 mil produtos, 1 milhão de pedidos e 2 milhões de
itens, só com os índices das chaves primárias. Os problemas dos exemplos vêm daí, e de um detalhe
proposital: a cidade determina a UF, então as duas colunas são correlacionadas e o planejador,
que as trata como independentes, erra a estimativa.

Os nove planos de exemplo (`ui/core/fixtures/`) foram capturados desse banco, em texto e em JSON.
São os mesmos arquivos usados pelos testes do motor. Para recapturar depois de mudar o seed, as
consultas estão em `db/exemplos.sql.txt`.

## Testes

```powershell
.\run.ps1 -Test
```

**Motor (vitest, 27 testes)**, todos sobre planos reais:

- Para cada um dos 9 exemplos: o texto e o JSON produzem **a mesma árvore e os mesmos achados**
  (são duas execuções separadas da mesma consulta, então os tempos diferem e a forma não).
- Saída do psql no formato alinhado, com cabeçalho, régua, `+` e `(1 row)`.
- Tempo: subplano multiplicado pelos loops, nós paralelos não multiplicados, tempos próprios que
  somam o total, buffers próprios por subtração.
- Cada diagnóstico da tabela acima, com o comando exato esperado.
- Leitura de condições: funções, casts, colunas qualificadas, strings que contêm `AND` e parênteses,
  e a desistência diante de `OR` e `LIKE`.
- Entradas ruins viram mensagens úteis, não exceções.

**Servidor (Go, 7 testes)**, contra o banco de demonstração (pulados se ele não estiver de pé):

- O teste de índice mostra o ganho (**11,84 ms → 0,054 ms, 219×** na busca por e-mail) e o número
  de índices do banco é o mesmo antes e depois.
- Recusas: vários comandos, `UPDATE`, DDL, `EXPLAIN` duplicado, consulta vazia.
- Tentativas de injeção pelo nome da tabela e da coluna viram "não existe", e a tabela-alvo
  continua com suas 20 mil linhas.
- Função fora da lista é recusada; requisição de outra origem e formulário HTML também.
- Sem banco, a página e as rotas do app continuam servidas e os endpoints respondem 404.

**No navegador**, conferi manualmente: os exemplos, colar plano em texto no formato do psql,
mensagem de erro para entrada inválida, link compartilhado abrindo o mesmo plano, executar consulta
no banco, testar índice com troca entre plano antes e depois, e a recusa de um `DELETE`.

## Publicar como site estático

A análise não precisa de servidor, então `ui/dist` pode ir para qualquer hospedagem estática.
Para um sub-caminho (GitHub Pages):

```bash
cd ui
PLANO_BASE=/plano/ npm run build
cp dist/index.html dist/404.html   # para as rotas do app funcionarem ao recarregar
```

Nesse modo o cabeçalho mostra "análise local, no navegador" e os botões de teste de índice dão
lugar a uma explicação. O workflow `.github/workflows/pages.yml` faz isso a cada push na `main`.

## Estrutura do projeto

```
cmd/plano/               servidor: app embutido e, com -db, o modo ao vivo
internal/
  live/                  EXPLAIN em transação desfeita, teste de índice, descrição do banco
  server/                HTTP
db/
  seed.sql               a loja de demonstração
  exemplos.sql.txt       as consultas dos exemplos
ui/
  core/                  o motor (TypeScript, zero dependências)
    parse.ts             texto e JSON → a mesma árvore
    analyze.ts           tempo próprio, linhas, erro de estimativa, buffers
    conditions.ts        lê comparações de um Filter e monta o índice
    insights.ts          os diagnósticos
    fixtures/            9 planos reais, em .txt, .json e .sql
  src/
    components/Tree.tsx  a árvore
    components/panels.tsx  resumo, barra de tempo, diagnósticos, detalhe do nó
    pages/               início, resultado
docker-compose.yml       PostgreSQL 17 com o seed
run.ps1 / run.bat        sobe tudo
```

**Motor e interface:** TypeScript 7, React 19, Vite 8, Tailwind CSS 4, Vitest 5. A árvore é HTML e
SVG feitos à mão, sem biblioteca de grafos.
**Servidor:** Go 1.26 e `pgx/v5`.

## Limites

- **As sugestões saem do plano, não do esquema.** O plano não sabe se já existe um índice parecido,
  se a coluna tem poucos valores distintos ou se a tabela é escrita o tempo todo. O teste ao vivo
  existe justamente para conferir antes de acreditar.
- **Só índices b-tree simples.** Nada de GIN, GiST, BRIN, índices parciais ou `INCLUDE`. Condições
  com `OR`, `LIKE` e `IN` não geram sugestão.
- **O parser de texto cobre o que o Postgres 17 imprime nos casos comuns.** Nós raros (por exemplo
  `Memoize`, `WindowAgg` com seus detalhes) são lidos como nós genéricos: aparecem na árvore com
  tempo e linhas, mas sem diagnóstico próprio.
- **CTEs podem ter o tempo atribuído de forma imprecisa**: o tempo da CTE aparece tanto no nó que
  a define quanto em quem a lê, e o tempo próprio é truncado em zero para não ficar negativo.
- **Um plano é uma execução.** Cache frio, concorrência e parâmetros diferentes mudam tudo. O aviso
  de cache frio existe para lembrar disso.
- **Modo ao vivo é para desenvolvimento** (veja [O modo ao vivo](#o-modo-ao-vivo)).

## Licença

MIT. Veja [LICENSE](LICENSE).
