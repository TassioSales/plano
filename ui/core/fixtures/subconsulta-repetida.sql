SELECT c.id, c.nome, (SELECT count(*) FROM pedidos p WHERE p.cliente_id = c.id) AS pedidos FROM clientes c WHERE c.uf = 'AC' LIMIT 40
