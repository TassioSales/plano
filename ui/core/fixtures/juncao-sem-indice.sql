SELECT p.id, p.total, i.produto_id, i.quantidade FROM pedidos p JOIN itens_pedido i ON i.pedido_id = p.id WHERE p.cliente_id = 4242
