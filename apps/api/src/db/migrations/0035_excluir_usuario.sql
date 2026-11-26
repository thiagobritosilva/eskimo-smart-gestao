-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0035: excluir usuário (somente Proprietário)
-- Dois modos, escolhidos pelo sistema:
--   * SEM nenhum registro (ex.: cadastrado por engano e nunca usado): o usuário é apagado de verdade;
--   * COM histórico (vendas, caixa, ponto, estoque, auditoria…): exclusão lógica — sai da lista, perde o acesso
--     (desativado, sessões encerradas) e o e-mail fica livre para novo cadastro. O nome permanece nos registros
--     antigos (obrigação legal de guarda: ponto, caixa, fiscal), e o e-mail original fica guardado em deleted_email.
-- A exclusão física só é aceita pela operação auditada (variável de transação), nunca por DELETE avulso.
-- =====================================================================
ALTER TABLE users
  ADD COLUMN deleted_at     timestamptz,
  ADD COLUMN deleted_by     uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN deleted_reason text,
  ADD COLUMN deleted_email  text,
  ADD CONSTRAINT users_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_reason IS NULL) AND (deleted_at IS NULL OR is_active = false));

CREATE OR REPLACE FUNCTION users_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('eskimo.user_hard_delete', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Usuário não pode ser apagado diretamente: use "Excluir usuário" (Proprietário).' USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER IF EXISTS users_no_delete ON users;
CREATE TRIGGER users_no_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION users_delete_guard();
