-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0031: Funcionário (caixa/atendente) vê só o necessário
-- Pedido do Proprietário: ao entrar, o funcionário vê Ponto e Caixa; nada de estoque nem financeiro.
-- Ficam: pos.operate (caixa — inclui consulta de preço e o lançamento de pedido do iFood no caixa), ifood.operate,
--        timeclock.punch (próprio ponto).
-- Saem do perfil: dashboard.view, alerts.view, stock.view, stock.move, products.view, external.operate.
-- A venda continua baixando o estoque e lançando no caixa normalmente (o sistema faz isso internamente).
-- Concessões individuais feitas pelo Proprietário (Usuários › Permissões) não são alteradas.
-- =====================================================================
DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE code = 'FUNCIONARIO')
  AND permission_id IN (SELECT id FROM permissions WHERE code IN
      ('dashboard.view', 'alerts.view', 'stock.view', 'stock.move', 'products.view', 'external.operate'));
UPDATE roles SET description = 'Caixa/atendente: bate o próprio ponto, opera o próprio caixa (vendas, consulta de preço, pedidos do iFood). Sem acesso a estoque e financeiro.'
WHERE code = 'FUNCIONARIO';
