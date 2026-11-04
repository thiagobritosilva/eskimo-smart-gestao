export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
  mustChangePassword: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  roleCode: string;
  roleName: string;
  isActive: boolean;
  mustChangePassword: boolean;
  isLocked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  activeSessions: number;
}

export interface Role {
  code: string;
  name: string;
  description: string;
  permissions: string[];
}

export interface Permission {
  code: string;
  module: string;
  description: string;
}

export type IndicatorStatus = 'ok' | 'no_data' | 'unavailable';

export interface Indicator {
  key: string;
  label: string;
  group: 'vendas' | 'financeiro' | 'estoque' | 'freezers';
  unit: 'BRL' | 'count' | 'percent';
  value: string | number | null;
  status: IndicatorStatus;
  reason?: string;
  caveats?: string[];
}

export interface DashboardSummary {
  generatedAt: string;
  filters: { from: string; to: string; categoryId?: string };
  indicators: Indicator[];
  charts: { key: string; label: string; status: IndicatorStatus; reason?: string; series: Record<string, string | null>[] }[];
  system: {
    activeUsers: number;
    usersLoggedToday: number;
    pdvConnector: { status: string; message: string };
  };
}

export interface AuditItem {
  id: string;
  occurred_at: string;
  actor_type: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  ip: string | null;
  user_agent: string | null;
}

// ---------------- Fase 2 ----------------
export interface Category { id: string; name: string; is_active: boolean; products_count: number }
export interface Unit { code: string; name: string; allows_fraction: boolean }

export interface Product {
  id: string;
  internal_code: string;
  barcode: string | null;
  name: string;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  brand: string | null;
  unit_code: string;
  packaging: string | null;
  qty_per_box: string | null;
  cost_price?: string | null;
  avg_cost?: string | null;
  sale_price: string | null;
  min_stock: string | null;
  max_stock: string | null;
  alert_percent?: string | null;
  tracks_expiry: boolean;
  is_active: boolean;
  margin_percent?: string | null;
  stock_qty: string;
}

export interface LocationSummary {
  id: string;
  code: string;
  kind: 'central' | 'freezer' | 'carrinho';
  name: string;
  ownership: 'eskimo' | 'proprio' | null;
  open_rental?: { id: string; renter_name: string; started_on: string; expected_return: string | null } | null;
  number: number | null;
  physical_location: string | null;
  capacity_liters: string | null;
  status: 'operando' | 'manutencao' | 'inativo' | null;
  notes: string | null;
  products_count: number;
  total_qty: string;
  cost_value?: string;
  sale_value: string;
  items_without_cost?: number;
  items_without_price: number;
  low_stock_count: number;
  expiring_count: number;
}

export interface Balance {
  product_id: string;
  internal_code: string;
  product_name: string;
  unit_code: string;
  category_name: string | null;
  location_id: string;
  location_code: string;
  location_name: string;
  ownership: string | null;
  quantity: string;
  reserved_qty: string;
  available_qty: string;
  avg_cost?: string | null;
  sale_price: string | null;
  cost_value?: string | null;
  sale_value: string | null;
  location_min_qty: string | null;
  below_location_min: boolean;
  next_expiry: string | null;
}

export interface ProductStock {
  product_id: string;
  internal_code: string;
  product_name: string;
  unit_code: string;
  category_name: string | null;
  quantity: string;
  available_qty: string;
  locations_count: number;
  min_stock: string | null;
  max_stock: string | null;
  avg_cost?: string | null;
  sale_price: string | null;
  cost_value?: string | null;
  sale_value: string | null;
  below_min: boolean;
  next_expiry: string | null;
  has_expired: boolean;
  expiring_soon: boolean;
}

export interface MovementType {
  code: string;
  label: string;
  direction: 'in' | 'out' | 'transfer' | 'either';
  permission: string;
  costEntry?: boolean;
  reasonRequired?: boolean;
  manual: boolean;
}

export interface MovementListItem {
  id: string;
  number: string;
  movement_type: string;
  occurred_at: string;
  reason: string | null;
  reference_doc: string | null;
  source_type: string;
  reverses_movement_id: string | null;
  reversed_by_id: string | null;
  user_name: string | null;
  lines_count: number;
  total_qty: string;
  total_cost?: string | null;
  products: string;
}

export interface MovementDetail extends Omit<MovementListItem, 'lines_count' | 'total_qty' | 'total_cost' | 'products'> {
  source_id: string | null;
  lines: {
    id: string;
    product_id: string;
    internal_code: string;
    product_name: string;
    unit_code: string;
    lot_code: string | null;
    expiry_date: string | null;
    from_location_name: string | null;
    to_location_name: string | null;
    quantity: string;
    unit_cost?: string | null;
    line_cost?: string | null;
  }[];
}

export interface InventoryCountSummary {
  id: string;
  number: string;
  location_id: string;
  location_name: string;
  status: 'aberta' | 'finalizada' | 'cancelada';
  notes: string | null;
  started_at: string;
  started_by_name: string;
  finished_at: string | null;
  finished_by_name: string | null;
  lines_count: number;
  divergent_count: number;
}

export interface InventoryCount extends Omit<InventoryCountSummary, 'lines_count' | 'divergent_count'> {
  location_code: string;
  blind: boolean;
  adjustment_movement_id: string | null;
  lines: { product_id: string; internal_code: string; product_name: string; unit_code: string; tracks_expiry: boolean; counted_qty: string; expiry_date: string | null; system_qty?: string | null; difference?: string | null; counted_by_name: string }[];
  expectedProducts: { product_id: string; internal_code: string; product_name: string; unit_code: string; tracks_expiry: boolean; system_qty?: string }[];
}
