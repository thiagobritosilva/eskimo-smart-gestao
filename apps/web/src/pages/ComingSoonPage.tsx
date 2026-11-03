import { Construction } from 'lucide-react';
import { PageHeader } from '../components/ui';
import { PHASE_LABEL } from '../lib/navigation';

export function ComingSoonPage({ title, phase, description }: { title: string; phase: number; description: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="card flex flex-col items-center px-6 py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
          <Construction className="h-7 w-7" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-ink-900">Módulo previsto para a {PHASE_LABEL[phase]}</h2>
        <p className="mt-2 max-w-lg text-sm text-slate-500">{description}</p>
        <p className="mt-4 max-w-lg text-xs text-slate-400">
          Este módulo ainda não está implantado. Nenhuma informação é exibida aqui para não misturar dados fictícios com dados reais.
        </p>
      </div>
    </>
  );
}
