-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0023: unifica os perfis de rua
-- Motivo: "Vendedor externo e repositor" e "Motorista e repositor" são a mesma função.
-- Fica um só perfil (VENDEDOR_EXTERNO) chamado "Vendedor externo, motorista e repositor".
-- Usuários que estejam como MOTORISTA passam para ele (auditado); o perfil MOTORISTA é removido.
-- =====================================================================
UPDATE roles SET name = 'Vendedor externo, motorista e repositor',
  description = 'Visitas a lojas (comodato de freezers, reposição, carrinho), entregas e reposição: registra visitas e retornos e movimenta estoque para reposição.'
WHERE code = 'VENDEDOR_EXTERNO';

WITH moved AS (
  UPDATE users u SET role_id = (SELECT id FROM roles WHERE code = 'VENDEDOR_EXTERNO')
  WHERE u.role_id = (SELECT id FROM roles WHERE code = 'MOTORISTA')
  RETURNING u.id
)
INSERT INTO audit_log (actor_type, action, entity, entity_id, before, after, metadata)
SELECT 'system', 'user.updated', 'user', moved.id::text, '{"roleCode": "MOTORISTA"}', '{"roleCode": "VENDEDOR_EXTERNO"}',
       '{"origem": "migration 0023: perfis de rua unificados"}'
FROM moved;

DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE code = 'MOTORISTA');
DELETE FROM roles WHERE code = 'MOTORISTA';
