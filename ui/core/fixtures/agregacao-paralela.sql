SELECT pr.categoria, sum(i.quantidade * i.preco_unit) AS receita FROM itens_pedido i JOIN produtos pr ON pr.id = i.produto_id GROUP BY pr.categoria ORDER BY receita DESC
