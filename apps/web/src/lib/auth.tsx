import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { CurrentUser } from './types';

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<CurrentUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: CurrentUser }>('/auth/me');
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => {
      setUser(null);
      qc.clear();
    };
    window.addEventListener('esg:unauthorized', onUnauthorized);
    return () => window.removeEventListener('esg:unauthorized', onUnauthorized);
  }, [refresh, qc]);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ user: CurrentUser }>('/auth/login', { email, password });
    setUser(r.user);
    return r.user;
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
    qc.clear();
  };

  const can = (permission: string) => !!user?.permissions.includes(permission);

  return <AuthContext.Provider value={{ user, loading, login, logout, refresh, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}

/** Proprietário: único perfil que altera ou exclui lançamentos já feitos (regra do servidor; aqui só esconde os botões). */
export function useIsOwner(): boolean {
  return useAuth().user?.roleCode === 'PROPRIETARIO';
}
