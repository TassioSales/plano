-- Loja de demonstração. ~200 mil clientes, 1 milhão de pedidos, 2 milhões de itens.
-- Só existem os índices das chaves primárias: os problemas dos exemplos vêm daí.

CREATE TABLE clientes (
    id        integer PRIMARY KEY,
    nome      text NOT NULL,
    email     text NOT NULL,
    cidade    text NOT NULL,
    uf        char(2) NOT NULL,
    criado_em timestamptz NOT NULL
);

CREATE TABLE produtos (
    id        integer PRIMARY KEY,
    nome      text NOT NULL,
    categoria text NOT NULL,
    preco     numeric(10, 2) NOT NULL
);

CREATE TABLE pedidos (
    id         integer PRIMARY KEY,
    cliente_id integer NOT NULL,
    status     text NOT NULL,
    total      numeric(12, 2) NOT NULL,
    criado_em  timestamptz NOT NULL
);

CREATE TABLE itens_pedido (
    id          integer PRIMARY KEY,
    pedido_id   integer NOT NULL,
    produto_id  integer NOT NULL,
    quantidade  integer NOT NULL,
    preco_unit  numeric(10, 2) NOT NULL
);

-- A cidade determina a UF: duas colunas correlacionadas, que o planejador
-- trata como independentes e por isso subestima.
CREATE TEMP TABLE cidades (n integer, cidade text, uf char(2));
INSERT INTO cidades VALUES
    (0, 'São Paulo', 'SP'), (1, 'Campinas', 'SP'), (2, 'Santos', 'SP'), (3, 'Ribeirão Preto', 'SP'),
    (4, 'Rio de Janeiro', 'RJ'), (5, 'Niterói', 'RJ'), (6, 'Belo Horizonte', 'MG'), (7, 'Uberlândia', 'MG'),
    (8, 'Curitiba', 'PR'), (9, 'Londrina', 'PR'), (10, 'Porto Alegre', 'RS'), (11, 'Salvador', 'BA'),
    (12, 'Recife', 'PE'), (13, 'Fortaleza', 'CE'), (14, 'Manaus', 'AM'), (15, 'Belém', 'PA'),
    (16, 'Goiânia', 'GO'), (17, 'Florianópolis', 'SC'), (18, 'Vitória', 'ES'), (19, 'Rio Branco', 'AC');

SELECT setseed(0.42);

INSERT INTO clientes
SELECT g, 'Cliente ' || g, 'cliente' || g || '@exemplo.com.br', c.cidade, c.uf,
       timestamptz '2022-01-01' + (g % 1000) * interval '1 day'
FROM generate_series(1, 200000) g
JOIN cidades c ON c.n = (CASE WHEN g % 100 < 30 THEN 0 WHEN g % 100 < 45 THEN 4 ELSE g % 20 END);

INSERT INTO produtos
SELECT g, 'Produto ' || g,
       (ARRAY['eletrônicos', 'livros', 'casa', 'moda', 'esporte', 'brinquedos', 'beleza', 'mercado'])[1 + g % 8],
       round((5 + random() * 2000)::numeric, 2)
FROM generate_series(1, 20000) g;

INSERT INTO pedidos
SELECT g, 1 + (random() * 199999)::int,
       (ARRAY['pago', 'pago', 'pago', 'enviado', 'enviado', 'entregue', 'entregue', 'entregue', 'entregue', 'cancelado'])[1 + (random() * 9)::int],
       round((20 + random() * 3000)::numeric, 2),
       timestamptz '2023-01-01' + random() * interval '900 days'
FROM generate_series(1, 1000000) g;

INSERT INTO itens_pedido
SELECT g, 1 + (random() * 999999)::int, 1 + (random() * 19999)::int, 1 + (random() * 4)::int,
       round((5 + random() * 2000)::numeric, 2)
FROM generate_series(1, 2000000) g;

ANALYZE;

CREATE TABLE seed_pronto AS SELECT 1 AS ok;
