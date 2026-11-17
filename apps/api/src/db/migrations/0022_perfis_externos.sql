-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0022: perfis "Vendedor externo e repositor" e "Motorista e repositor"
-- Motivo: funções de rua (visitas a lojas, comodato de freezers, reposição e entregas) com acesso só ao necessário.
-- O perfil de um usuário existente é alterado em Usuários › Editar (auditado). Nenhum usuário é alterado aqui.
-- =====================================================================
INSERT INTO roles (code, name, description) VALUES
  ('VENDEDOR_EXTERNO', 'Vendedor externo e repositor', 'Visita lojas (comodato de freezers, reposição, carrinho), registra visitas e retornos e movimenta estoque para reposição.'),
  ('MOTORISTA',        'Motorista e repositor',        'Entregas e reposição: consulta e movimenta estoque (transferências para freezers/carrinhos) e registra as visitas de reposição.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view', 'products.view', 'stock.view', 'stock.move', 'alerts.view', 'external.operate'
) WHERE r.code IN ('VENDEDOR_EXTERNO', 'MOTORISTA')
ON CONFLICT DO NOTHING;
