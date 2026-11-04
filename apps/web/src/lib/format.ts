const TZ = 'America/Sao_Paulo';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const num = new Intl.NumberFormat('pt-BR');

export function formatMoney(v: string | number): string {
  return brl.format(typeof v === 'string' ? Number(v) : v);
}

export function formatNumber(v: string | number): string {
  return num.format(typeof v === 'string' ? Number(v) : v);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(iso));
}

export function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

export function todayYMD(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export function firstDayOfMonthYMD(): string {
  return `${todayYMD().slice(0, 8)}01`;
}

export const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Login',
  'auth.logout': 'Logout',
  'auth.login_failed': 'Falha de login',
  'auth.login_locked': 'Login bloqueado',
  'auth.account_locked': 'Conta bloqueada',
  'auth.password_changed': 'Senha alterada',
  'user.created': 'Usuário criado',
  'user.updated': 'Usuário alterado',
  'user.activated': 'Usuário ativado',
  'user.deactivated': 'Usuário desativado',
  'user.password_reset': 'Senha redefinida',
  'user.sessions_revoked': 'Sessões encerradas',
  'user.permissions_changed': 'Permissões alteradas',
  'user.owner_bootstrap': 'Proprietário inicial criado',
  'settings.updated': 'Configuração alterada',
};

export function formatQty(v: string | number | null | undefined, unit?: string): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  const s = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(n);
  return unit ? `${s} ${unit}` : s;
}

export function formatMoneyOrDash(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === '' ? '—' : formatMoney(v);
}

/** Aceita "12,50" ou "12.50" e devolve "12.50" (string decimal para a API). */
export function toDecimal(input: string): string {
  const s = input.trim().replace(/\s/g, '');
  if (!s) return '';
  return s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
}

export function fromDecimal(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  return String(Number(v)).replace('.', ',');
}

export const MOVEMENT_LABELS: Record<string, string> = {
  entrada_inicial: 'Estoque inicial',
  entrada_compra: 'Entrada por compra',
  saida_venda: 'Saída por venda',
  transferencia: 'Transferência',
  perda: 'Perda',
  avaria: 'Produto danificado',
  vencido: 'Produto vencido',
  devolucao_cliente: 'Devolução de cliente',
  devolucao_fornecedor: 'Devolução ao fornecedor',
  ajuste_inventario: 'Ajuste de inventário',
  estorno: 'Estorno',
};

Object.assign(ACTION_LABELS, {
  'product.created': 'Produto criado',
  'product.updated': 'Produto alterado',
  'product.imported': 'Importação de produtos',
  'category.created': 'Categoria criada',
  'category.updated': 'Categoria alterada',
  'stock.movement_created': 'Movimentação de estoque',
  'stock.movement_reversed': 'Estorno de movimentação',
  'stock.location_min_set': 'Mínimo por localização',
  'freezer.updated': 'Freezer alterado',
  'freezer.created': 'Freezer cadastrado',
  'inventory.opened': 'Contagem aberta',
  'inventory.finalized': 'Contagem finalizada',
  'inventory.cancelled': 'Contagem cancelada',
  'finance.account_created': 'Conta financeira criada',
  'finance.account_updated': 'Conta financeira alterada',
  'finance.category_created': 'Categoria financeira criada',
  'finance.category_updated': 'Categoria financeira alterada',
  'finance.payment_method_updated': 'Forma de pagamento alterada',
  'finance.title_created': 'Título financeiro lançado',
  'finance.title_updated': 'Título financeiro alterado',
  'finance.title_cancelled': 'Título financeiro cancelado',
  'finance.installment_settled': 'Pagamento/recebimento',
  'finance.transaction_reversed': 'Estorno financeiro',
  'finance.transferencia': 'Transferência entre contas',
  'finance.sangria': 'Sangria',
  'finance.suprimento': 'Suprimento',
  'finance.cash_opened': 'Abertura de caixa',
  'finance.cash_closed': 'Fechamento de caixa',
  'finance.reconciled': 'Conciliação',
  'finance.recurring_created': 'Despesa fixa cadastrada',
  'finance.recurring_updated': 'Despesa fixa alterada',
  'finance.recurring_deleted': 'Despesa fixa EXCLUÍDA',
  'finance.recurring_generated': 'Contas do mês geradas (despesas fixas)',
  'finance.recurring_month_amount': 'Valor do mês informado (despesa variável)',
  'finance.recurring_imported': 'Planilha de despesas fixas importada',
  'cart.created': 'Carrinho cadastrado',
  'cart.updated': 'Carrinho alterado',
  'cart.rented': 'Carrinho alugado',
  'cart.returned': 'Devolução de carrinho',
  'finance.unreconciled': 'Conciliação desfeita',
  'supplier.created': 'Fornecedor cadastrado',
  'supplier.updated': 'Fornecedor alterado',
  'purchase.order_created': 'Pedido de compra criado',
  'purchase.order_updated': 'Pedido de compra alterado',
  'purchase.order_sent': 'Pedido enviado',
  'purchase.order_cancelled': 'Pedido cancelado',
  'purchase.received': 'Nota fiscal recebida',
  'purchase.receipt_reversed': 'Recebimento estornado',
  'pdv.connector_updated': 'Conector PDV alterado',
  'pdv.import': 'Importação de NFC-e',
  'pdv.product_linked': 'Código do PDV vinculado',
  'pdv.rule_saved': 'Regra de baixa salva',
  'pdv.rule_deleted': 'Regra de baixa excluída',
  'pdv.manual_allocation': 'Baixa manual de venda',
  'pdv.consolidated': 'Consolidação de vendas',
  'pdv.issue_resolved': 'Pendência do PDV resolvida',
});
