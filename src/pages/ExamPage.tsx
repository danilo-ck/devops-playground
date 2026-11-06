import { Suspense } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { getModule } from '@/modules';

/** Página del modo examen de un módulo: /m/:moduleId/examen */
export function ExamPage() {
  const { moduleId } = useParams();
  const mod = getModule(moduleId);
  if (!mod || mod.status !== 'available') return <Navigate to="/" replace />;
  if (!mod.exam) return <Navigate to={`/m/${mod.id}`} replace />;
  const View = mod.exam.View;
  return (
    <div style={{ height: '100%', overflowY: 'auto', ['--mod' as string]: mod.accent }}>
      <Suspense fallback={<p className="muted" style={{ padding: '2em', textAlign: 'center' }}>Cargando el examen…</p>}>
        <View moduleId={mod.id} />
      </Suspense>
    </div>
  );
}
