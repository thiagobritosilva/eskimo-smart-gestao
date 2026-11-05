import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

/**
 * Mantém as abas abertas na versão mais recente do sistema.
 * O servidor se atualiza sozinho; uma aba já aberta continuaria rodando a versão antiga até ser recarregada.
 * Aqui a aba consulta a versão publicada a cada minuto e, quando muda:
 *  - recarrega sozinha ao trocar de tela ou ao voltar para a aba (momentos em que nada está sendo digitado);
 *  - mostra um aviso com o botão "Atualizar agora".
 */
async function fetchVersion(): Promise<string | null> {
  try {
    const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return null;
    return ((await r.json()) as { web: string }).web;
  } catch {
    return null;
  }
}

export function useVersionWatcher() {
  const initial = useRef<string | null>(null);
  const [outdated, setOutdated] = useState(false);
  const location = useLocation();

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const v = await fetchVersion();
      if (!alive || !v) return;
      if (initial.current === null) initial.current = v;
      else if (v !== initial.current) setOutdated(true);
    };
    void check();
    const timer = setInterval(check, 60_000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void check().then(() => {
        // voltou para a aba e há versão nova: recarrega antes de a pessoa começar a digitar
        if (alive && initial.current) void fetchVersion().then((v) => { if (v && v !== initial.current) window.location.reload(); });
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  // troca de tela com versão nova pendente: recarrega já na tela de destino
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (outdated) window.location.reload();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  return outdated;
}

export function UpdateBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-ink-900 px-4 py-3 text-sm text-white shadow-2xl" role="status">
      <RefreshCw className="h-4 w-4 text-accent-400" />
      <span>Há uma versão nova do sistema.</span>
      <button className="rounded-lg bg-accent-400 px-3 py-1.5 font-semibold text-ink-900 hover:bg-accent-300" onClick={() => window.location.reload()}>Atualizar agora</button>
    </div>
  );
}
