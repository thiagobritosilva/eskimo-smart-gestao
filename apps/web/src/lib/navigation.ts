import {
  BarChart3, Bell, Bot, Boxes, ClipboardCheck, FileText, LayoutDashboard, Package, Plug, Settings, ShieldCheck,
  ShoppingCart, Snowflake, Users, Wallet, type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission?: string;
  /** Fase em que o módulo será entregue; ausente = disponível. */
  phase?: number;
  section: 'Visão geral' | 'Operação' | 'Gestão' | 'Sistema';
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard.view', section: 'Visão geral' },
  { to: '/notificacoes', label: 'Notificações', icon: Bell, permission: 'alerts.view', phase: 7, section: 'Visão geral' },
  { to: '/freezers', label: 'Freezers', icon: Snowflake, permission: 'stock.view', section: 'Operação' },
  { to: '/estoque', label: 'Estoque', icon: Boxes, permission: 'stock.view', section: 'Operação' },
  { to: '/inventario', label: 'Inventário', icon: ClipboardCheck, permission: 'stock.view', section: 'Operação' },
  { to: '/produtos', label: 'Produtos', icon: Package, permission: 'products.view', section: 'Operação' },
  { to: '/compras', label: 'Compras e fornecedores', icon: ShoppingCart, permission: 'purchases.view', section: 'Operação' },
  { to: '/financeiro', label: 'Financeiro', icon: Wallet, permission: 'finance.view', section: 'Gestão' },
  { to: '/relatorios', label: 'Relatórios', icon: FileText, permission: 'reports.view', phase: 7, section: 'Gestão' },
  { to: '/indicadores', label: 'Rentabilidade', icon: BarChart3, permission: 'reports.view', phase: 7, section: 'Gestão' },
  { to: '/assistente', label: 'Assistente IA', icon: Bot, permission: 'ai.chat', phase: 6, section: 'Gestão' },
  { to: '/pdv', label: 'PDV Connector', icon: Plug, permission: 'sales.view', section: 'Sistema' },
  { to: '/usuarios', label: 'Usuários', icon: Users, permission: 'users.view', section: 'Sistema' },
  { to: '/auditoria', label: 'Auditoria', icon: ShieldCheck, permission: 'audit.view', section: 'Sistema' },
  { to: '/configuracoes', label: 'Configurações', icon: Settings, permission: 'settings.manage', section: 'Sistema' },
];

export const PHASE_LABEL: Record<number, string> = {
  2: 'Fase 2 — Estoque',
  3: 'Fase 3 — Financeiro',
  4: 'Fase 4 — Compras',
  5: 'Fase 5 — Integração PDV',
  6: 'Fase 6 — Inteligência artificial',
  7: 'Fase 7 — Relatórios e alertas',
};
