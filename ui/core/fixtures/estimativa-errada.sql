SELECT c.nome, p.total FROM clientes c JOIN pedidos p ON p.cliente_id = c.id WHERE c.cidade = 'Rio Branco' AND c.uf = 'AC' AND p.status = 'cancelado'
