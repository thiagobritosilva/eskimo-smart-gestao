-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0032: Estoquista também pode ser caixa
-- Pedido do Proprietário: o estoquista passa a operar o próprio caixa (vender, consultar preço, fechar com envelope)
-- e lançar o pedido do iFood pelo caixa. Mantém as permissões de estoque que já tinha.
-- Continua SEM financeiro: no caixa, cada operador vê só o próprio turno (regra já existente).
-- =====================================================================
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('pos.operate', 'ifood.operate')
WHERE r.code = 'ESTOQUISTA'
ON CONFLICT DO NOTHING;
UPDATE roles SET description = 'Estoque (entradas, contagens, perdas) e caixa: opera o próprio caixa e lança pedidos do iFood. Sem acesso ao financeiro.'
WHERE code = 'ESTOQUISTA';
