import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';

export type Severity = 'critico' | 'atencao' | 'info';
export interface AlertRow { id: string; label: string; detail: string; value?: string | null; date?: string | null; link?: string | null; severity: Severity }
export interface AlertGroup { key: string; title: string; description: string; severity: Severity; count: number; total?: string | null; link: string; rows: AlertRow[] }
export interface AlertsResponse {
  generatedAt: string;
  params: { payablesDueDays: number; fragileStockPercent: number };
  summary: { critico: number; atencao: number; info: number; total: number };
  groups: AlertGroup[];
}

/** Alertas calculados no servidor; atualiza a cada 2 minutos. */
export function useAlerts() {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['alerts'],
    queryFn: () => api.get<AlertsResponse>('/alerts'),
    enabled: can('alerts.view'),
    refetchInterval: 120_000,
  });
}
