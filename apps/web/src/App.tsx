import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './lib/auth';
import { AppLayout } from './layout/AppLayout';
import { Spinner } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { ForcePasswordChangePage } from './pages/ForcePasswordChangePage';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { AuditPage } from './pages/AuditPage';
import { SettingsPage } from './pages/SettingsPage';
import { ProfilePage } from './pages/ProfilePage';
import { ComingSoonPage } from './pages/ComingSoonPage';
import { ProductsPage } from './pages/ProductsPage';
import { FreezersPage } from './pages/FreezersPage';
import { LocationDetailPage } from './pages/LocationDetailPage';
import { CartsPage } from './pages/CartsPage';
import { StockPage } from './pages/StockPage';
import { InventoryCountPage, InventoryListPage } from './pages/InventoryPages';
import { FinancePage } from './pages/FinancePage';
import { PurchasesPage } from './pages/PurchasesPage';
import { PurchaseOrderPage } from './pages/PurchaseOrderPage';
import { PdvPage } from './pages/PdvPage';

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="flex min-h-screen items-center justify-center"><Spinner className="h-8 w-8" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword) return <ForcePasswordChangePage />;
  return <>{children}</>;
}

function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return <div className="card p-8 text-center text-sm text-slate-500">Você não tem permissão para acessar este módulo.</div>;
  }
  return <>{children}</>;
}

const FUTURE = [
  { path: 'assistente', title: 'Assistente IA', phase: 6, perm: 'ai.chat', desc: 'Consultas em linguagem natural via Claude e ChatGPT, somente leitura, sobre os dados reais da loja.' },
  { path: 'relatorios', title: 'Relatórios', phase: 7, perm: 'reports.view', desc: 'Relatórios gerenciais com exportação para Excel e PDF.' },
  { path: 'indicadores', title: 'Rentabilidade', phase: 7, perm: 'reports.view', desc: 'Margens, giro, valor parado em estoque e ponto de equilíbrio.' },
  { path: 'notificacoes', title: 'Notificações', phase: 7, perm: 'alerts.view', desc: 'Central de alertas: estoque baixo, vencimentos, contas, divergências e falhas de sincronização.' },
];

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Protected><AppLayout /></Protected>}>
        <Route index element={<RequirePermission permission="dashboard.view"><DashboardPage /></RequirePermission>} />
        <Route path="usuarios" element={<RequirePermission permission="users.view"><UsersPage /></RequirePermission>} />
        <Route path="auditoria" element={<RequirePermission permission="audit.view"><AuditPage /></RequirePermission>} />
        <Route path="configuracoes" element={<RequirePermission permission="settings.manage"><SettingsPage /></RequirePermission>} />
        <Route path="perfil" element={<ProfilePage />} />
        <Route path="produtos" element={<RequirePermission permission="products.view"><ProductsPage /></RequirePermission>} />
        <Route path="freezers" element={<RequirePermission permission="stock.view"><FreezersPage /></RequirePermission>} />
        <Route path="carrinhos" element={<RequirePermission permission="stock.view"><CartsPage /></RequirePermission>} />
        <Route path="carrinhos/:id" element={<RequirePermission permission="stock.view"><LocationDetailPage /></RequirePermission>} />
        <Route path="freezers/:id" element={<RequirePermission permission="stock.view"><LocationDetailPage /></RequirePermission>} />
        <Route path="pdv" element={<RequirePermission permission="sales.view"><PdvPage /></RequirePermission>} />
        <Route path="compras" element={<RequirePermission permission="purchases.view"><PurchasesPage /></RequirePermission>} />
        <Route path="compras/pedidos/:id" element={<RequirePermission permission="purchases.view"><PurchaseOrderPage /></RequirePermission>} />
        <Route path="financeiro" element={<RequirePermission permission="finance.view"><FinancePage /></RequirePermission>} />
        <Route path="estoque" element={<RequirePermission permission="stock.view"><StockPage /></RequirePermission>} />
        <Route path="inventario" element={<RequirePermission permission="stock.view"><InventoryListPage /></RequirePermission>} />
        <Route path="inventario/:id" element={<RequirePermission permission="stock.view"><InventoryCountPage /></RequirePermission>} />
        {FUTURE.map((f) => (
          <Route key={f.path} path={f.path} element={<RequirePermission permission={f.perm}><ComingSoonPage title={f.title} phase={f.phase} description={f.desc} /></RequirePermission>} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
