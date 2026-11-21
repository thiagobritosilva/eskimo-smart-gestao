-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0029: gestão do ponto exclusiva do Proprietário
-- Ver o ponto de todos, aprovar/recusar ajustes, espelho de qualquer empregado e local da loja: somente o
-- Proprietário (verificado pelo PERFIL no servidor; permissão individual não libera). Demais usuários: "Meu ponto".
-- =====================================================================
DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'timeclock.manage')
  AND role_id <> (SELECT id FROM roles WHERE code = 'PROPRIETARIO');
DELETE FROM user_permission_overrides
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'timeclock.manage') AND effect = 'grant';
UPDATE permissions SET description = 'Gestão do ponto (exclusiva do Proprietário): ponto de todos, ajustes, espelhos e local da loja'
WHERE code = 'timeclock.manage';
