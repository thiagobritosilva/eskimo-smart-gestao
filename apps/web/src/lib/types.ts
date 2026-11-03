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
  charts: { key: string; label: string; status: IndicatorStatus; reason?: string }[];
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
