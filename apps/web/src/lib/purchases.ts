export interface Supplier {
  id: string;
  name: string;
  trade_name: string | null;
  document: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  payment_terms: string | null;
  notes: string | null;
  is_active: boolean;
  receipts_count: number;
  total_purchased?: string;
  last_purchase_at: string | null;
  open_orders: number;
}

export type OrderStatus = 'rascunho' | 'enviado' | 'recebido_parcial' | 'recebido' | 'cancelado';

export interface OrderListItem {
  id: string;
  number: string;
  status: OrderStatus;
  order_date: string;
  expected_date: string | null;
  supplier_id: string;
  supplier_name: string;
  lines_count: number;
  total_estimate?: string;
  received_percent: number;
  received_amount?: string;
  created_by_name: string | null;
}

export interface OrderLine {
  id: string;
  line_no: number;
  product_id: string;
  internal_code: string;
  product_name: string;
  unit_code: string;
  tracks_expiry: boolean;
  quantity: string;
  unit_cost?: string;
  received_qty: string;
  remaining_qty: string;
  line_total?: string;
}

export interface ReceiptSummary {
  id: string;
  number: string;
  received_at: string;
  invoice_number: string;
  invoice_series: string | null;
  invoice_amount: string;
  freight: string;
  other_costs: string;
  discount: string;
  goods_amount: string;
  location_name: string;
  received_by_name: string;
  title_id: string | null;
  title_number: string | null;
  title_status: string | null;
  no_payable_reason: string | null;
  reversed_at: string | null;
  reverse_reason: string | null;
}

export interface OrderDetail {
  id: string;
  number: string;
  status: OrderStatus;
  order_date: string;
  expected_date: string | null;
  est_freight?: string;
  est_discount?: string;
  payment_terms: string | null;
  notes: string | null;
  cancel_reason: string | null;
  created_by_name: string | null;
  supplier_id: string;
  supplier_name: string;
  supplier_document: string | null;
  supplier_payment_terms: string | null;
  lines: OrderLine[];
  receipts: ReceiptSummary[];
}

export interface Suggestion {
  product_id: string;
  internal_code: string;
  product_name: string;
  unit_code: string;
  qty_per_box: string | null;
  stock_qty: string;
  min_stock: string;
  max_stock: string | null;
  pending_qty: string;
  out_30d: string;
  need_qty: string;
  suggested_qty: string;
  last_supplier_id: string | null;
  last_supplier_name: string | null;
  reference_cost?: string | null;
}

export const ORDER_STATUS: Record<OrderStatus, { label: string; cls: string }> = {
  rascunho: { label: 'Rascunho', cls: 'bg-slate-100 text-slate-700' },
  enviado: { label: 'Enviado', cls: 'bg-brand-100 text-brand-800' },
  recebido_parcial: { label: 'Recebido parcial', cls: 'bg-amber-100 text-amber-800' },
  recebido: { label: 'Recebido', cls: 'bg-emerald-100 text-emerald-800' },
  cancelado: { label: 'Cancelado', cls: 'bg-red-100 text-red-700' },
};

export function formatDocument(d: string | null): string {
  if (!d) return '—';
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
}
