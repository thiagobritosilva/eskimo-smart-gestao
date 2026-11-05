-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0011: saldo inicial da conta OPCIONAL
-- Motivo: a loja usa uma única conta bancária e quer lançar pagamentos sem antes informar o saldo.
-- Para não inventar valor, o saldo inicial pode ficar "não informado" (NULL): o sistema mostra a
-- movimentação registrada e avisa que não é o saldo real. Ao informar o saldo depois, tudo se ajusta.
-- Somente relaxa uma restrição e acrescenta uma coluna à visão; nenhum dado é alterado.
-- =====================================================================
ALTER TABLE financial_accounts ALTER COLUMN opening_balance DROP DEFAULT;
ALTER TABLE financial_accounts ALTER COLUMN opening_balance DROP NOT NULL;

CREATE OR REPLACE VIEW financial_account_balances AS
SELECT a.id AS account_id,
       coalesce(a.opening_balance, 0) + coalesce(sum(CASE t.direction WHEN 'entrada' THEN t.amount ELSE -t.amount END), 0) AS balance,
       (a.opening_balance IS NOT NULL) AS opening_known
FROM financial_accounts a
LEFT JOIN financial_transactions t ON t.account_id = a.id
GROUP BY a.id;
