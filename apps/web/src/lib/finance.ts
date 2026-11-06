import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface FinAccount {
  id: string;
  pos_terminal_id?: string | null;
  kind: 'caixa' | 'banco' | 'carteira_digital';
  name: string;
  bank_name: string | null;
  agency: string | null;
  account_number: string | null;
  opening_balance: string | null;
  /** false = saldo inicial não informado: o saldo mostra só a movimentação registrada. */
  opening_known: boolean;
  opening_date: string;
  allow_negative: boolean;
  is_active: boolean;
  balance: string;
  transactions_count: number;
  open_session_id: string | null;
}

export interface FinCategory { id: string; kind: 'receita' | 'despesa'; name: string; dre_group: string; is_active: boolean; titles_count: number }
export interface PaymentMethod { code: string; name: string; fee_percent: string | null; settlement_days: number | null; is_active: boolean }

export interface InstallmentRow {
  id: string;
  title_id: string;
  title_number: string;
  direction: 'pagar' | 'receber';
  description: string;
  counterparty: string | null;
  document: string | null;
  category_name: string;
  payment_method_code: string | null;
  competence_date: string;
  number: number;
  installments_count: number;
  due_date: string;
  amount: string;
  settled: string;
  open_amount: string;
  overdue: boolean;
  days_to_due: number;
}

export interface TitleDetail {
  id: string;
  number: string;
  direction: 'pagar' | 'receber';
  description: string;
  category_id: string;
  category_name: string;
  counterparty: string | null;
  document: string | null;
  payment_method_code: string | null;
  payment_method_name: string | null;
  competence_date: string;
  issue_date: string;
  total_amount: string;
  status: 'aberto' | 'parcial' | 'quitado' | 'cancelado';
  notes: string | null;
  created_by_name: string | null;
  cancel_reason: string | null;
  installments: { id: string; number: number; due_date: string; amount: string; settled: string; open_amount: string; overdue: boolean }[];
  settlements: { installment_id: string; principal: string; interest: string; discount: string; fee: string; transaction_id: string; transaction_number: string; occurred_at: string; amount: string; account_name: string; user_name: string | null; reversed: boolean }[];
}

export interface FinTransaction {
  id: string;
  number: string;
  account_id: string;
  account_name: string;
  account_kind: string;
  occurred_at: string;
  direction: 'entrada' | 'saida';
  amount: string;
  kind: string;
  description: string;
  payment_method_code: string | null;
  transfer_group: string | null;
  reverses_id: string | null;
  reversed: boolean;
  reconciled: boolean;
  statement_ref: string | null;
  user_name: string | null;
  interest: string | null;
  discount: string | null;
  fee: string | null;
  title_id: string | null;
}

export interface CashSession {
  id: string;
  cancel_reason?: string | null;
  number: string;
  account_id: string;
  account_name: string;
  status: 'aberta' | 'fechada' | 'cancelada';
  opened_at: string;
  opened_by_name: string;
  opening_counted: string;
  opening_system: string;
  closed_at: string | null;
  closed_by_name: string | null;
  closing_counted: string | null;
  closing_expected: string | null;
  difference: string | null;
  entries: string;
  exits: string;
}

export const DRE_GROUPS: Record<string, string> = {
  receita_vendas: 'Receita de vendas',
  outras_receitas: 'Outras receitas',
  receita_financeira: 'Receita financeira',
  deducoes: 'Deduções da receita',
  despesa_pessoal: 'Pessoal',
  despesa_ocupacao: 'Ocupação',
  despesa_comercial: 'Comercial / meios de pagamento',
  despesa_administrativa: 'Administrativa / serviços',
  despesa_manutencao: 'Manutenção',
  despesa_financeira: 'Despesa financeira',
  impostos: 'Impostos',
  compras_mercadorias: 'Compras de mercadorias (fora do DRE)',
  investimentos: 'Investimentos (fora do DRE)',
  distribuicao_lucros: 'Distribuição de lucros (fora do DRE)',
};

export const TX_KIND: Record<string, string> = {
  liquidacao: 'Pagamento/recebimento',
  transferencia: 'Transferência',
  sangria: 'Sangria',
  suprimento: 'Suprimento',
  ajuste_caixa: 'Ajuste de fechamento',
  estorno: 'Estorno',
};

export const ACCOUNT_KIND: Record<string, string> = { caixa: 'Caixa', banco: 'Banco', carteira_digital: 'Carteira digital' };

export function useFinAccounts() {
  return useQuery({ queryKey: ['fin', 'accounts'], queryFn: () => api.get<FinAccount[]>('/finance/accounts') });
}
export function useFinCategories() {
  return useQuery({ queryKey: ['fin', 'categories'], queryFn: () => api.get<FinCategory[]>('/finance/categories') });
}
export function usePaymentMethods() {
  return useQuery({ queryKey: ['fin', 'payment-methods'], queryFn: () => api.get<PaymentMethod[]>('/finance/payment-methods') });
}

export function invalidateFinance(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['fin'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  void qc.invalidateQueries({ queryKey: ['alerts'] });
}

/** Converte "2026-10-15T14:30" (datetime-local) para ISO com fuso do navegador. */
export function localToIso(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}
