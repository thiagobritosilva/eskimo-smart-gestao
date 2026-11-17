-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0024: informações financeiras só para Proprietário, Gerente e Financeiro
-- Motivo: perfis operacionais (caixa/funcionário, estoquista, vendedor externo/motorista) não veem números sensíveis
-- (faturamento, valor do estoque, custos, lucros, taxas/repasse do iFood, valor de aluguel, valor de notas de compra).
-- O Gerente passa a ver o financeiro por padrão (consulta + indicadores financeiros do dashboard).
-- O "financeiro" de cada pessoa continua podendo ser liberado individualmente em Usuários › Permissões.
-- =====================================================================
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('finance.view', 'dashboard.financial')
WHERE r.code = 'GERENTE'
ON CONFLICT DO NOTHING;
