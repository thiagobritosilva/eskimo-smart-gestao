import type { Queryable } from '../../db/pool.js';
import { addDays, addMonths, fromCents, toCents } from '../../lib/money.js';
import { dre, dreByMonth } from '../finance/finance.reports.js';
import { conciliation } from '../finance/conciliation.service.js';
import { getStockParams } from '../stock/stock.queries.js';

/**
 * Relatórios gerenciais (Fase 7). Cada relatório lê SOMENTE os dados reais lançados/sincronizados.
 * Nada é estimado sem aviso: limitações aparecem em "notes" e também saem no Excel/PDF.
 */

export type ColType = 'text' | 'money' | 'qty' | 'int' | 'date' | 'datetime' | 'percent';
export interface ReportColumn { key: string; label: string; type: ColType; total?: boolean }
export interface ReportResult { columns: ReportColumn[]; rows: Record<string, unknown>[]; notes?: string[] }
export type FilterKey = 'period' | 'month' | 'titleStatus' | 'location' | 'days';
export interface ReportParams { from: string; to: string; month: string; titleStatus: 'abertas' | 'quitadas' | 'todas'; locationId?: string; days?: number }
export interface ReportCtx { canSeeCost: boolean }
export interface ReportDef {
  key: string;
  group: 'Financeiro' | 'Estoque' | 'Compras' | 'Vendas' | 'Carrinhos' | 'Controle';
  title: string;
  description: string;
  /** todas exigidas (além de reports.view) */
  permissions: string[];
  filters: FilterKey[];
  run: (db: Queryable, p: ReportParams, ctx: ReportCtx) => Promise<ReportResult>;
}

const MOVEMENT: Record<string, string> = {
  entrada_inicial: 'Estoque inicial', entrada_compra: 'Entrada por compra', saida_venda: 'Saída por venda', transferencia: 'Transferência',
  perda: 'Perda', avaria: 'Produto danificado', vencido: 'Produto vencido', devolucao_cliente: 'Devolução de cliente',
  devolucao_fornecedor: 'Devolução ao fornecedor', ajuste_inventario: 'Ajuste de inventário', estorno: 'Estorno',
};
const TX_KIND: Record<string, string> = {
  liquidacao: 'Pagamento/recebimento', transferencia: 'Transferência', sangria: 'Sangria', suprimento: 'Suprimento',
  estorno: 'Estorno', ajuste_caixa: 'Ajuste de caixa', taxa: 'Taxa',
};
const TITLE_STATUS: Record<string, string> = { aberto: 'Em aberto', parcial: 'Parcial', quitado: 'Quitado', cancelado: 'Cancelado' };
const DRE_GROUP: Record<string, string> = {
  receita_vendas: 'Receita de vendas', outras_receitas: 'Outras receitas', receita_financeira: 'Receitas financeiras', deducoes: 'Deduções',
  despesa_pessoal: 'Pessoal', despesa_ocupacao: 'Ocupação', despesa_comercial: 'Comerciais', despesa_administrativa: 'Administrativas',
  despesa_manutencao: 'Manutenção', despesa_financeira: 'Despesas financeiras', impostos: 'Impostos', compras_mercadorias: 'Compras de mercadorias',
  investimentos: 'Investimentos', distribuicao_lucros: 'Distribuição de lucros',
};
const TZ = `'America/Sao_Paulo'`;
const inPeriod = (col: string) => `(${col} AT TIME ZONE ${TZ})::date BETWEEN $1::date AND $2::date`;
const pct = (part: number, total: number) => (total ? Math.round((part / total) * 10000) / 100 : null);
const sumCents = (rows: Record<string, unknown>[], k: string) => rows.reduce((s, r) => s + (r[k] == null ? 0 : toCents(String(r[k]).replace('-', ''))) * (String(r[k]).startsWith('-') ? -1 : 1), 0);

// ------------------------------------------------------------------ Financeiro
function titlesReport(direction: 'pagar' | 'receber'): ReportDef['run'] {
  return async (db, p) => {
    const status = p.titleStatus === 'abertas' ? 'AND i.settled < i.amount' : p.titleStatus === 'quitadas' ? 'AND i.settled >= i.amount' : '';
    const { rows } = await db.query(
      `SELECT i.due_date::text AS due, t.number::text AS numero, t.description, c.name AS categoria, t.counterparty AS pessoa,
              t.competence_date::text AS competencia, i.amount::text AS valor, i.settled::text AS liquidado,
              (i.amount - i.settled)::text AS aberto, t.status
       FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id JOIN financial_categories c ON c.id = t.category_id
       WHERE t.direction = $3 AND t.status <> 'cancelado' AND i.due_date BETWEEN $1::date AND $2::date ${status}
       ORDER BY i.due_date, t.number`,
      [p.from, p.to, direction],
    );
    return {
      columns: [
        { key: 'due', label: 'Vencimento', type: 'date' }, { key: 'numero', label: 'Nº', type: 'text' },
        { key: 'description', label: 'Descrição', type: 'text' }, { key: 'categoria', label: 'Categoria', type: 'text' },
        { key: 'pessoa', label: direction === 'pagar' ? 'Favorecido' : 'Pagador', type: 'text' },
        { key: 'competencia', label: 'Competência', type: 'date' },
        { key: 'valor', label: 'Valor', type: 'money', total: true }, { key: 'liquidado', label: direction === 'pagar' ? 'Pago' : 'Recebido', type: 'money', total: true },
        { key: 'aberto', label: 'Em aberto', type: 'money', total: true }, { key: 'situacao', label: 'Situação', type: 'text' },
      ],
      rows: rows.map((r) => ({ ...r, situacao: TITLE_STATUS[r.status] ?? r.status })),
      notes: ['Por data de vencimento da parcela. Títulos cancelados não entram.'],
    };
  };
}

const finance: ReportDef[] = [
  {
    key: 'conciliacao', group: 'Financeiro', title: 'Conciliação do período',
    description: 'Confere vendas, caixa, cartão/Pix, iFood, contas e estoque do período, com a situação de cada item.',
    permissions: ['finance.view'], filters: ['period'],
    run: async (db, p) => {
      const r = await conciliation(db, p.from, p.to);
      const ST: Record<string, string> = { ok: 'OK', atencao: 'Atenção', pendente: 'Pendente' };
      return {
        columns: [
          { key: 'area', label: 'Área', type: 'text' }, { key: 'item', label: 'Item', type: 'text' },
          { key: 'expected', label: 'Esperado/vendido', type: 'money' }, { key: 'actual', label: 'Realizado/lançado', type: 'money' },
          { key: 'difference', label: 'Diferença', type: 'money' }, { key: 'situacao', label: 'Situação', type: 'text' }, { key: 'detail', label: 'Observação', type: 'text' },
        ],
        rows: [
          ...r.sales.channels.map((ch) => ({ area: 'Vendas', item: `${ch.canal} — ${ch.vendas} venda(s)${ch.canceladas ? ` · ${ch.canceladas} cancelada(s)` : ''}`, expected: null, actual: ch.liquido, difference: null, situacao: 'Informativo', detail: `Bruto R$ ${ch.bruto} · descontos R$ ${ch.desconto}` })),
          ...r.checks.map((x) => ({ ...x, situacao: ST[x.status] })),
        ],
        notes: [`Resumo: ${r.summary.ok} OK · ${r.summary.atencao} atenção · ${r.summary.pendente} pendente(s). Total vendido no período (líquido): R$ ${r.sales.total}.`],
      };
    },
  },
  { key: 'contas-pagar', group: 'Financeiro', title: 'Contas a pagar', description: 'Parcelas por vencimento, com valor pago e em aberto.', permissions: ['finance.view'], filters: ['period', 'titleStatus'], run: titlesReport('pagar') },
  { key: 'contas-receber', group: 'Financeiro', title: 'Contas a receber', description: 'Parcelas por vencimento, com valor recebido e em aberto.', permissions: ['finance.view'], filters: ['period', 'titleStatus'], run: titlesReport('receber') },
  {
    key: 'movimentacao-financeira', group: 'Financeiro', title: 'Movimentação financeira (extrato)',
    description: 'Tudo o que entrou e saiu das contas, no regime de caixa.', permissions: ['finance.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query(
        `SELECT t.occurred_at, t.number::text AS numero, a.name AS conta, t.kind, t.description, c.name AS categoria,
                CASE WHEN t.direction = 'entrada' THEN t.amount::text END AS entrada,
                CASE WHEN t.direction = 'saida' THEN t.amount::text END AS saida, u.name AS usuario,
                (t.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM financial_transactions r WHERE r.reverses_id = t.id)) AS estornado
         FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id
         LEFT JOIN financial_categories c ON c.id = t.category_id LEFT JOIN users u ON u.id = t.user_id
         WHERE ${inPeriod('t.occurred_at')} ORDER BY t.occurred_at, t.number`,
        [p.from, p.to],
      );
      return {
        columns: [
          { key: 'occurred_at', label: 'Data/hora', type: 'datetime' }, { key: 'numero', label: 'Nº', type: 'text' },
          { key: 'conta', label: 'Conta', type: 'text' }, { key: 'tipo', label: 'Tipo', type: 'text' },
          { key: 'description', label: 'Descrição', type: 'text' }, { key: 'categoria', label: 'Categoria', type: 'text' },
          { key: 'entrada', label: 'Entrada', type: 'money', total: true }, { key: 'saida', label: 'Saída', type: 'money', total: true },
          { key: 'usuario', label: 'Usuário', type: 'text' },
        ],
        rows: rows.map((r) => ({ ...r, tipo: `${TX_KIND[r.kind] ?? r.kind}${r.estornado && r.kind !== 'estorno' ? ' (estornado)' : ''}` })),
        notes: ['Estornos aparecem como lançamentos inversos; o original permanece (histórico imutável).'],
      };
    },
  },
  {
    key: 'despesas-categoria', group: 'Financeiro', title: 'Despesas por categoria',
    description: 'Total de despesas do período (competência) por categoria e grupo do DRE.', permissions: ['finance.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query<{ categoria: string; dre_group: string; lancamentos: number; total: string }>(
        `SELECT c.name AS categoria, c.dre_group, count(*)::int AS lancamentos, sum(t.total_amount)::text AS total
         FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id
         WHERE t.direction = 'pagar' AND t.status <> 'cancelado' AND t.competence_date BETWEEN $1::date AND $2::date
         GROUP BY c.id ORDER BY sum(t.total_amount) DESC`,
        [p.from, p.to],
      );
      const total = rows.reduce((s, r) => s + toCents(r.total), 0);
      return {
        columns: [
          { key: 'categoria', label: 'Categoria', type: 'text' }, { key: 'grupo', label: 'Grupo no DRE', type: 'text' },
          { key: 'lancamentos', label: 'Lançamentos', type: 'int', total: true }, { key: 'total', label: 'Total', type: 'money', total: true },
          { key: 'participacao', label: '% do total', type: 'percent' },
        ],
        rows: rows.map((r) => ({ ...r, grupo: DRE_GROUP[r.dre_group] ?? r.dre_group, participacao: pct(toCents(r.total), total) })),
        notes: ['Regime de competência. Compras de mercadoria aparecem aqui, mas no DRE entram pelo CMV (custo do que foi vendido).'],
      };
    },
  },
  {
    key: 'dre', group: 'Financeiro', title: 'DRE gerencial', description: 'Resultado do período: receitas, CMV, despesas e resultado.',
    permissions: ['finance.view', 'dashboard.financial'], filters: ['period'],
    async run(db, p) {
      const d = await dre(db, p.from, p.to);
      return {
        columns: [{ key: 'label', label: 'Linha', type: 'text' }, { key: 'value', label: 'Valor', type: 'money' }],
        rows: d.lines.map((l: { label: string; value: string; kind: string; sign?: number }) => ({
          label: l.kind === 'line' ? `    ${l.label}` : l.label, value: l.sign === -1 && l.value !== '0.00' ? `-${l.value}` : l.value, _kind: l.kind,
        })),
        notes: ['Resultado ESTIMADO (gerencial), não substitui a contabilidade.', d.basis, ...d.caveats],
      };
    },
  },
  {
    key: 'dre-mensal', group: 'Financeiro', title: 'DRE mês a mês', description: 'Comparativo mensal do resultado (até 12 meses).',
    permissions: ['finance.view', 'dashboard.financial'], filters: ['period'],
    async run(_db, p) {
      const d = await dreByMonth(p.from, p.to);
      const cols: ReportColumn[] = [{ key: 'label', label: 'Linha', type: 'text' }];
      d.months.forEach((m: { label: string }, i: number) => cols.push({ key: `m${i}`, label: `${m.label.slice(5, 7)}/${m.label.slice(0, 4)}`, type: 'money' }));
      cols.push({ key: 'total', label: 'Total', type: 'money' });
      const rows = d.total.lines.map((l: { key: string; label: string; value: string; kind: string; sign?: number }) => {
        const sign = (v: string | undefined) => (v && l.sign === -1 && v !== '0.00' ? `-${v}` : v ?? '0.00');
        const row: Record<string, unknown> = { label: l.kind === 'line' ? `    ${l.label}` : l.label, total: sign(l.value), _kind: l.kind };
        d.months.forEach((m: { lines: { key: string; value: string }[] }, i: number) => { row[`m${i}`] = sign(m.lines.find((x) => x.key === l.key)?.value); });
        return row;
      });
      return { columns: cols, rows, notes: ['Resultado ESTIMADO (gerencial), não substitui a contabilidade.', ...d.total.caveats] };
    },
  },
  {
    key: 'despesas-fixas', group: 'Financeiro', title: 'Despesas fixas do mês', description: 'Cada despesa fixa no mês: valor, vencimento e se já foi paga.',
    permissions: ['finance.view'], filters: ['month'],
    async run(db, p) {
      const first = `${p.month}-01`;
      const { rows } = await db.query(
        `SELECT r.description, c.name AS categoria, r.due_day, r.variable_amount, r.amount::text AS modelo,
                x.amount::text AS valor_mes, t.status AS titulo, i.settled::text AS pago, r.is_active, r.deleted_at
         FROM recurring_expenses r JOIN financial_categories c ON c.id = r.category_id
         LEFT JOIN recurring_expense_runs x ON x.recurring_id = r.id AND x.month = $1::date
         LEFT JOIN financial_titles t ON t.id = x.title_id
         LEFT JOIN financial_installments i ON i.title_id = t.id AND i.number = 1
         WHERE r.start_month <= $1::date AND (r.end_month IS NULL OR r.end_month >= $1::date)
           AND (x.recurring_id IS NOT NULL OR (r.is_active AND r.deleted_at IS NULL))
         ORDER BY r.due_day, r.description`,
        [first],
      );
      return {
        columns: [
          { key: 'due_day', label: 'Dia', type: 'int' }, { key: 'description', label: 'Despesa', type: 'text' }, { key: 'categoria', label: 'Categoria', type: 'text' },
          { key: 'valor_mes', label: 'Valor do mês', type: 'money', total: true }, { key: 'pago', label: 'Pago', type: 'money', total: true },
          { key: 'situacao', label: 'Situação', type: 'text' },
        ],
        rows: rows.map((r) => ({
          ...r,
          situacao: r.titulo ? (r.titulo === 'cancelado' ? 'Cancelada' : TITLE_STATUS[r.titulo]) : r.variable_amount ? 'Aguardando valor do mês' : r.modelo ? 'Ainda não lançada' : 'Valor a definir',
        })),
      };
    },
  },
];

// ------------------------------------------------------------------ Estoque
const stock: ReportDef[] = [
  {
    key: 'posicao-estoque', group: 'Estoque', title: 'Posição de estoque por produto', description: 'Estoque total da loja, mínimo, referência e valor.',
    permissions: ['stock.view'], filters: [],
    async run(db, _p, ctx) {
      const { rows } = await db.query(
        `SELECT p.internal_code AS codigo, p.name AS produto, c.name AS categoria, p.unit_code AS un,
                coalesce(t.q, 0)::text AS estoque, p.min_stock::text AS minimo, p.max_stock::text AS referencia,
                CASE WHEN p.max_stock > 0 THEN round(coalesce(t.q, 0) / p.max_stock * 100, 1)::text END AS pct_ref,
                p.avg_cost::text AS custo_medio, round(coalesce(t.q, 0) * p.avg_cost, 2)::text AS valor_custo,
                round(coalesce(t.q, 0) * p.sale_price, 2)::text AS valor_venda
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN (SELECT product_id, sum(quantity) AS q FROM stock_balances GROUP BY 1) t ON t.product_id = p.id
         WHERE p.is_active ORDER BY p.name`,
      );
      const cols: ReportColumn[] = [
        { key: 'codigo', label: 'Código', type: 'text' }, { key: 'produto', label: 'Produto', type: 'text' }, { key: 'categoria', label: 'Categoria', type: 'text' },
        { key: 'un', label: 'Un.', type: 'text' }, { key: 'estoque', label: 'Estoque', type: 'qty', total: true }, { key: 'minimo', label: 'Mínimo', type: 'qty' },
        { key: 'referencia', label: 'Referência (máx.)', type: 'qty' }, { key: 'pct_ref', label: '% da referência', type: 'percent' },
      ];
      if (ctx.canSeeCost) cols.push({ key: 'custo_medio', label: 'Custo médio', type: 'money' }, { key: 'valor_custo', label: 'Valor (custo)', type: 'money', total: true });
      cols.push({ key: 'valor_venda', label: 'Valor (venda)', type: 'money', total: true });
      return { columns: cols, rows, notes: ['Soma de todos os locais: estoque central, freezers e carrinhos. Produto sem custo/preço cadastrado fica sem valor.'] };
    },
  },
  {
    key: 'estoque-local', group: 'Estoque', title: 'Estoque por local (freezer/carrinho)', description: 'O que há em cada local, com validade mais próxima.',
    permissions: ['stock.view'], filters: ['location'],
    async run(db, p, ctx) {
      const { rows } = await db.query(
        `SELECT loc.code AS local, p.internal_code AS codigo, p.name AS produto, sum(b.quantity)::text AS qtd, p.unit_code AS un,
                min(l.expiry_date)::text AS validade, round(sum(b.quantity) * p.avg_cost, 2)::text AS valor_custo,
                round(sum(b.quantity) * p.sale_price, 2)::text AS valor_venda
         FROM stock_balances b JOIN products p ON p.id = b.product_id JOIN locations loc ON loc.id = b.location_id
         LEFT JOIN lots l ON l.id = b.lot_id
         WHERE b.quantity > 0 ${p.locationId ? 'AND b.location_id = $1' : ''}
         GROUP BY loc.id, p.id ORDER BY loc.sort_order, p.name`,
        p.locationId ? [p.locationId] : [],
      );
      const cols: ReportColumn[] = [
        { key: 'local', label: 'Local', type: 'text' }, { key: 'codigo', label: 'Código', type: 'text' }, { key: 'produto', label: 'Produto', type: 'text' },
        { key: 'qtd', label: 'Quantidade', type: 'qty', total: true }, { key: 'un', label: 'Un.', type: 'text' }, { key: 'validade', label: 'Validade mais próxima', type: 'date' },
      ];
      if (ctx.canSeeCost) cols.push({ key: 'valor_custo', label: 'Valor (custo)', type: 'money', total: true });
      cols.push({ key: 'valor_venda', label: 'Valor (venda)', type: 'money', total: true });
      return { columns: cols, rows };
    },
  },
  {
    key: 'movimentacoes-estoque', group: 'Estoque', title: 'Movimentações de estoque', description: 'Entradas, saídas, transferências, perdas e ajustes do período.',
    permissions: ['stock.view'], filters: ['period', 'location'],
    async run(db, p, ctx) {
      const { rows } = await db.query(
        `SELECT m.occurred_at, m.number::text AS numero, m.movement_type, p.name AS produto, lf.code AS origem, lt.code AS destino,
                x.quantity::text AS qtd, x.unit_cost::text AS custo_unit, coalesce(m.reason, m.reference_doc) AS motivo, u.name AS usuario
         FROM stock_movement_lines x JOIN stock_movements m ON m.id = x.movement_id JOIN products p ON p.id = x.product_id
         LEFT JOIN locations lf ON lf.id = x.from_location_id LEFT JOIN locations lt ON lt.id = x.to_location_id
         LEFT JOIN users u ON u.id = m.user_id
         WHERE ${inPeriod('m.occurred_at')} ${p.locationId ? 'AND (x.from_location_id = $3 OR x.to_location_id = $3)' : ''}
         ORDER BY m.occurred_at, m.number`,
        p.locationId ? [p.from, p.to, p.locationId] : [p.from, p.to],
      );
      const cols: ReportColumn[] = [
        { key: 'occurred_at', label: 'Data/hora', type: 'datetime' }, { key: 'numero', label: 'Nº', type: 'text' }, { key: 'tipo', label: 'Tipo', type: 'text' },
        { key: 'produto', label: 'Produto', type: 'text' }, { key: 'origem', label: 'Origem', type: 'text' }, { key: 'destino', label: 'Destino', type: 'text' },
        { key: 'qtd', label: 'Quantidade', type: 'qty' },
      ];
      if (ctx.canSeeCost) cols.push({ key: 'custo_unit', label: 'Custo unit.', type: 'money' });
      cols.push({ key: 'motivo', label: 'Motivo / documento', type: 'text' }, { key: 'usuario', label: 'Usuário', type: 'text' });
      return { columns: cols, rows: rows.map((r) => ({ ...r, tipo: MOVEMENT[r.movement_type] ?? r.movement_type })) };
    },
  },
  {
    key: 'perdas', group: 'Estoque', title: 'Perdas, avarias e vencidos', description: 'Baixas por perda no período, com valor pelo custo.',
    permissions: ['stock.view'], filters: ['period'],
    async run(db, p, ctx) {
      const { rows } = await db.query(
        `SELECT m.occurred_at, m.number::text AS numero, m.movement_type, p.name AS produto, lf.code AS local, x.quantity::text AS qtd,
                round(x.quantity * x.unit_cost, 2)::text AS valor_custo, m.reason AS motivo, u.name AS usuario,
                EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id) AS estornada
         FROM stock_movement_lines x JOIN stock_movements m ON m.id = x.movement_id JOIN products p ON p.id = x.product_id
         LEFT JOIN locations lf ON lf.id = x.from_location_id LEFT JOIN users u ON u.id = m.user_id
         WHERE m.movement_type IN ('perda', 'avaria', 'vencido') AND ${inPeriod('m.occurred_at')}
         ORDER BY m.occurred_at`,
        [p.from, p.to],
      );
      const cols: ReportColumn[] = [
        { key: 'occurred_at', label: 'Data/hora', type: 'datetime' }, { key: 'numero', label: 'Nº', type: 'text' }, { key: 'tipo', label: 'Tipo', type: 'text' },
        { key: 'produto', label: 'Produto', type: 'text' }, { key: 'local', label: 'Local', type: 'text' }, { key: 'qtd', label: 'Quantidade', type: 'qty', total: true },
      ];
      if (ctx.canSeeCost) cols.push({ key: 'valor_custo', label: 'Valor (custo)', type: 'money', total: true });
      cols.push({ key: 'motivo', label: 'Motivo', type: 'text' }, { key: 'usuario', label: 'Usuário', type: 'text' });
      return { columns: cols, rows: rows.map((r) => ({ ...r, tipo: `${MOVEMENT[r.movement_type]}${r.estornada ? ' (estornada)' : ''}` })) };
    },
  },
  {
    key: 'validades', group: 'Estoque', title: 'Validades', description: 'Lotes vencidos ou que vencem nos próximos dias, por local.',
    permissions: ['stock.view'], filters: ['days'],
    async run(db, p) {
      const days = p.days ?? (await getStockParams(db)).expiryWarningDays;
      const { rows } = await db.query(
        `SELECT l.expiry_date::text AS validade, (l.expiry_date - (now() AT TIME ZONE ${TZ})::date)::int AS dias, p.name AS produto,
                nullif(l.lot_code, '') AS lote, loc.code AS local, sum(b.quantity)::text AS qtd
         FROM stock_balances b JOIN lots l ON l.id = b.lot_id JOIN products p ON p.id = b.product_id JOIN locations loc ON loc.id = b.location_id
         WHERE b.quantity > 0 AND l.expiry_date <= (now() AT TIME ZONE ${TZ})::date + $1::int
         GROUP BY l.id, p.id, loc.id ORDER BY l.expiry_date, p.name`,
        [days],
      );
      return {
        columns: [
          { key: 'validade', label: 'Validade', type: 'date' }, { key: 'situacao', label: 'Situação', type: 'text' }, { key: 'produto', label: 'Produto', type: 'text' },
          { key: 'lote', label: 'Lote', type: 'text' }, { key: 'local', label: 'Local', type: 'text' }, { key: 'qtd', label: 'Quantidade', type: 'qty', total: true },
        ],
        rows: rows.map((r) => ({ ...r, situacao: r.dias < 0 ? `vencido há ${-r.dias} dia(s)` : r.dias === 0 ? 'vence hoje' : `vence em ${r.dias} dia(s)` })),
        notes: [`Janela: ${days} dias (inclui vencidos). Só produtos que controlam validade.`],
      };
    },
  },
  {
    key: 'inventarios', group: 'Estoque', title: 'Inventários (divergências)', description: 'Contagens finalizadas no período: sistema × contado.',
    permissions: ['stock.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query(
        `SELECT c.finished_at, c.number::text AS numero, loc.code AS local, p.name AS produto, l.system_qty::text AS sistema,
                l.counted_qty::text AS contado, l.difference::text AS diferenca
         FROM inventory_counts c JOIN inventory_count_lines l ON l.count_id = c.id JOIN products p ON p.id = l.product_id
         JOIN locations loc ON loc.id = c.location_id
         WHERE c.status = 'finalizada' AND ${inPeriod('c.finished_at')} AND l.difference IS DISTINCT FROM 0
         ORDER BY c.finished_at, p.name`,
        [p.from, p.to],
      );
      return {
        columns: [
          { key: 'finished_at', label: 'Finalizada em', type: 'datetime' }, { key: 'numero', label: 'Contagem', type: 'text' }, { key: 'local', label: 'Local', type: 'text' },
          { key: 'produto', label: 'Produto', type: 'text' }, { key: 'sistema', label: 'Sistema', type: 'qty' }, { key: 'contado', label: 'Contado', type: 'qty' },
          { key: 'diferenca', label: 'Diferença', type: 'qty', total: true },
        ],
        rows,
        notes: ['Somente itens com diferença. Os ajustes viram movimentações de "Ajuste de inventário".'],
      };
    },
  },
];

// ------------------------------------------------------------------ Compras
const purchases: ReportDef[] = [
  {
    key: 'compras', group: 'Compras', title: 'Compras recebidas', description: 'Notas recebidas no período, com frete, descontos e total.',
    permissions: ['purchases.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query(
        `SELECT r.received_at, r.number::text AS numero, s.name AS fornecedor, r.invoice_number AS nota, r.goods_amount::text AS mercadorias,
                r.freight::text AS frete, r.discount::text AS desconto, r.invoice_amount::text AS total, r.reversed_at
         FROM purchase_receipts r JOIN suppliers s ON s.id = r.supplier_id
         WHERE ${inPeriod('r.received_at')} ORDER BY r.received_at`,
        [p.from, p.to],
      );
      const valid = rows.map((r) => (r.reversed_at ? { ...r, mercadorias: null, frete: null, desconto: null, total: null, situacao: `Estornada (valor ${r.total})` } : { ...r, situacao: 'Recebida' }));
      return {
        columns: [
          { key: 'received_at', label: 'Recebida em', type: 'datetime' }, { key: 'numero', label: 'Nº', type: 'text' }, { key: 'fornecedor', label: 'Fornecedor', type: 'text' },
          { key: 'nota', label: 'Nota fiscal', type: 'text' }, { key: 'mercadorias', label: 'Mercadorias', type: 'money', total: true },
          { key: 'frete', label: 'Frete', type: 'money', total: true }, { key: 'desconto', label: 'Desconto', type: 'money', total: true },
          { key: 'total', label: 'Total', type: 'money', total: true }, { key: 'situacao', label: 'Situação', type: 'text' },
        ],
        rows: valid,
        notes: ['Recebimentos estornados aparecem sem valor (não somam nos totais).'],
      };
    },
  },
  {
    key: 'compras-fornecedor', group: 'Compras', title: 'Compras por fornecedor', description: 'Quanto foi comprado de cada fornecedor no período.',
    permissions: ['purchases.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query<{ fornecedor: string; documento: string | null; notas: number; total: string }>(
        `SELECT s.name AS fornecedor, s.document AS documento, count(*)::int AS notas, sum(r.invoice_amount)::text AS total
         FROM purchase_receipts r JOIN suppliers s ON s.id = r.supplier_id
         WHERE r.reversed_at IS NULL AND ${inPeriod('r.received_at')}
         GROUP BY s.id ORDER BY sum(r.invoice_amount) DESC`,
        [p.from, p.to],
      );
      const total = rows.reduce((s, r) => s + toCents(r.total), 0);
      return {
        columns: [
          { key: 'fornecedor', label: 'Fornecedor', type: 'text' }, { key: 'documento', label: 'CNPJ/CPF', type: 'text' },
          { key: 'notas', label: 'Notas', type: 'int', total: true }, { key: 'total', label: 'Total', type: 'money', total: true },
          { key: 'participacao', label: '% do total', type: 'percent' },
        ],
        rows: rows.map((r) => ({ ...r, participacao: pct(toCents(r.total), total) })),
      };
    },
  },
];

// ------------------------------------------------------------------ Vendas (PDV)
const SALES_NOTE = 'Vendas importadas do PDV (NFC-e). Enquanto a integração não cobrir todo o período, os números podem estar incompletos.';
const sales: ReportDef[] = [
  {
    key: 'vendas-dia', group: 'Vendas', title: 'Vendas por dia', description: 'Quantidade de vendas, valores e ticket médio por dia.',
    permissions: ['sales.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query<{ dia: string; vendas: number; bruto: string; descontos: string; liquido: string }>(
        `SELECT (s.sold_at AT TIME ZONE ${TZ})::date::text AS dia, count(*)::int AS vendas, sum(s.gross_amount)::text AS bruto,
                sum(s.discount_amount)::text AS descontos, sum(s.net_amount)::text AS liquido
         FROM sales s WHERE s.status = 'concluida' AND ${inPeriod('s.sold_at')} GROUP BY 1 ORDER BY 1`,
        [p.from, p.to],
      );
      return {
        columns: [
          { key: 'dia', label: 'Dia', type: 'date' }, { key: 'vendas', label: 'Vendas', type: 'int', total: true },
          { key: 'bruto', label: 'Bruto', type: 'money', total: true }, { key: 'descontos', label: 'Descontos', type: 'money', total: true },
          { key: 'liquido', label: 'Líquido', type: 'money', total: true }, { key: 'ticket', label: 'Ticket médio', type: 'money' },
        ],
        rows: rows.map((r) => ({ ...r, ticket: r.vendas ? fromCents(Math.round(toCents(r.liquido) / r.vendas)) : null })),
        notes: [SALES_NOTE, 'Vendas canceladas não entram.'],
      };
    },
  },
  {
    key: 'vendas-pagamento', group: 'Vendas', title: 'Vendas por forma de pagamento', description: 'Total recebido por forma de pagamento.',
    permissions: ['sales.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query<{ forma: string; qtd: number; total: string }>(
        `SELECT coalesce(pm.name, sp.method_code) AS forma, count(*)::int AS qtd, sum(sp.amount)::text AS total
         FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id LEFT JOIN payment_methods pm ON pm.code = sp.method_code
         WHERE s.status = 'concluida' AND ${inPeriod('s.sold_at')} GROUP BY 1 ORDER BY sum(sp.amount) DESC`,
        [p.from, p.to],
      );
      const total = rows.reduce((s, r) => s + toCents(r.total), 0);
      return {
        columns: [
          { key: 'forma', label: 'Forma', type: 'text' }, { key: 'qtd', label: 'Pagamentos', type: 'int', total: true },
          { key: 'total', label: 'Total', type: 'money', total: true }, { key: 'participacao', label: '% do total', type: 'percent' },
        ],
        rows: rows.map((r) => ({ ...r, participacao: pct(toCents(r.total), total) })),
        notes: [SALES_NOTE, 'Valores de pagamento informados na NFC-e (troco descontado).'],
      };
    },
  },
  {
    key: 'produtos-vendidos', group: 'Vendas', title: 'Produtos mais vendidos', description: 'Ranking de produtos por valor vendido.',
    permissions: ['sales.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query<{ produto: string; vinculado: boolean; qtd: string; valor: string }>(
        `SELECT coalesce(p.name, si.description) AS produto, (si.product_id IS NOT NULL) AS vinculado,
                sum(si.quantity)::text AS qtd, sum(si.net_amount)::text AS valor
         FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN products p ON p.id = si.product_id
         WHERE s.status = 'concluida' AND ${inPeriod('s.sold_at')}
         GROUP BY coalesce(p.name, si.description), si.product_id IS NOT NULL ORDER BY sum(si.net_amount) DESC`,
        [p.from, p.to],
      );
      const total = rows.reduce((s, r) => s + toCents(r.valor), 0);
      return {
        columns: [
          { key: 'pos', label: '#', type: 'int' }, { key: 'produto', label: 'Produto', type: 'text' },
          { key: 'qtd', label: 'Quantidade', type: 'qty', total: true }, { key: 'valor', label: 'Valor vendido', type: 'money', total: true },
          { key: 'participacao', label: '% do total', type: 'percent' },
        ],
        rows: rows.map((r, i) => ({ ...r, pos: i + 1, produto: r.vinculado ? r.produto : `${r.produto} (não vinculado ao cadastro)`, participacao: pct(toCents(r.valor), total) })),
        notes: [SALES_NOTE],
      };
    },
  },
];

// ------------------------------------------------------------------ Carrinhos e controle
const others: ReportDef[] = [
  {
    key: 'alugueis-carrinhos', group: 'Carrinhos', title: 'Aluguéis de carrinhos', description: 'Aluguéis iniciados no período ou ainda em aberto.',
    permissions: ['stock.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query(
        `SELECT l.code AS carrinho, r.renter_name AS locatario, r.renter_phone AS telefone, r.started_on::text AS retirada,
                r.expected_return::text AS prevista, r.returned_on::text AS devolucao, r.amount::text AS valor, r.billing_period,
                (coalesce(r.returned_on, (now() AT TIME ZONE ${TZ})::date) - r.started_on)::int AS dias
         FROM cart_rentals r JOIN locations l ON l.id = r.cart_id
         WHERE r.started_on BETWEEN $1::date AND $2::date OR r.returned_on IS NULL
         ORDER BY r.started_on, l.sort_order`,
        [p.from, p.to],
      );
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      return {
        columns: [
          { key: 'carrinho', label: 'Carrinho', type: 'text' }, { key: 'locatario', label: 'Locatário', type: 'text' }, { key: 'telefone', label: 'Telefone', type: 'text' },
          { key: 'retirada', label: 'Retirada', type: 'date' }, { key: 'prevista', label: 'Devolução prevista', type: 'date' }, { key: 'devolucao', label: 'Devolvido em', type: 'date' },
          { key: 'dias', label: 'Dias', type: 'int' }, { key: 'valor', label: 'Valor', type: 'money', total: true }, { key: 'cobranca', label: 'Cobrança', type: 'text' },
          { key: 'situacao', label: 'Situação', type: 'text' },
        ],
        rows: rows.map((r) => ({
          ...r, cobranca: r.billing_period,
          situacao: r.devolucao ? 'Devolvido' : r.prevista && r.prevista < today ? 'ATRASADO' : 'Em aberto',
        })),
        notes: ['Valor = o informado no aluguel (pode estar em branco). O recebimento é controlado em Contas a receber.'],
      };
    },
  },
  {
    key: 'auditoria', group: 'Controle', title: 'Auditoria', description: 'Quem fez o quê e quando, com o motivo das alterações.',
    permissions: ['audit.view'], filters: ['period'],
    async run(db, p) {
      const { rows } = await db.query(
        `SELECT a.occurred_at, coalesce(u.name, a.actor_type) AS usuario, a.action, a.entity, a.metadata->>'reason' AS motivo, host(a.ip) AS ip
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE ${inPeriod('a.occurred_at')} ORDER BY a.occurred_at DESC LIMIT 20000`,
        [p.from, p.to],
      );
      return {
        columns: [
          { key: 'occurred_at', label: 'Data/hora', type: 'datetime' }, { key: 'usuario', label: 'Usuário', type: 'text' }, { key: 'action', label: 'Ação', type: 'text' },
          { key: 'entity', label: 'Registro', type: 'text' }, { key: 'motivo', label: 'Motivo', type: 'text' }, { key: 'ip', label: 'IP', type: 'text' },
        ],
        rows,
        notes: ['Registro imutável. Detalhes (antes/depois) em Sistema → Auditoria.'],
      };
    },
  },
];

export const REPORTS: ReportDef[] = [...finance, ...stock, ...purchases, ...sales, ...others];

export function defaultParams(today: string): Pick<ReportParams, 'from' | 'to' | 'month'> {
  return { from: `${today.slice(0, 7)}-01`, to: addDays(addMonths(`${today.slice(0, 7)}-01`, 1), -1), month: today.slice(0, 7) };
}

export function computeTotals(r: ReportResult): Record<string, string> | null {
  const cols = r.columns.filter((c) => c.total);
  if (!cols.length || !r.rows.length) return null;
  const out: Record<string, string> = {};
  for (const c of cols) {
    if (c.type === 'money') out[c.key] = fromCents(sumCents(r.rows, c.key));
    else out[c.key] = String(Math.round(r.rows.reduce((s, x) => s + Number(x[c.key] ?? 0), 0) * 1000) / 1000);
  }
  return out;
}
