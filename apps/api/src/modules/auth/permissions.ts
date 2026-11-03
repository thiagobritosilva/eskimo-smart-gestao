import type { Queryable } from '../../db/pool.js';

export const OWNER_ROLE = 'PROPRIETARIO';
export const AI_ROLE = 'IA';

/**
 * Permissões efetivas = permissões do perfil ∪ concessões individuais − revogações individuais.
 * O Proprietário sempre possui todas (revogações são ignoradas para evitar bloqueio total do sistema).
 */
export async function loadEffectivePermissions(db: Queryable, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ code: string }>(
    `WITH u AS (
       SELECT u.id, u.role_id, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1
     )
     SELECT p.code
     FROM permissions p, u
     WHERE u.role_code = '${OWNER_ROLE}'
        OR (
          (EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = u.role_id AND rp.permission_id = p.id)
           OR EXISTS (SELECT 1 FROM user_permission_overrides o
                      WHERE o.user_id = u.id AND o.permission_id = p.id AND o.effect = 'grant'))
          AND NOT EXISTS (SELECT 1 FROM user_permission_overrides o
                          WHERE o.user_id = u.id AND o.permission_id = p.id AND o.effect = 'revoke')
        )
     ORDER BY p.code`,
    [userId],
  );
  return rows.map((r) => r.code);
}
