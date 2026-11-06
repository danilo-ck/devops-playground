import { Link, Navigate, useParams } from 'react-router-dom';
import { getModule } from '@/modules';
import { useProgress } from '@/core/progress';

export function ModulePage() {
  const { moduleId } = useParams();
  const mod = getModule(moduleId);
  const completed = useProgress((s) => s.completed);
  const resetModule = useProgress((s) => s.resetModule);
  if (!mod || mod.status !== 'available') return <Navigate to="/" replace />;

  const path = mod.lessons.filter((l) => !l.freeform);
  const free = mod.lessons.filter((l) => l.freeform);
  const done = path.filter((l) => completed[`${mod.id}/${l.id}`]).length;
  const nextLesson = path.find((l) => !completed[`${mod.id}/${l.id}`]) ?? path[0];
  const examBest = mod.exam?.bestScore?.() ?? null;

  return (
    <div className="page" style={{ ['--mod' as string]: mod.accent }}>
      <section className="module-hero">
        <span className="module-icon xl">{mod.icon}</span>
        <div>
          <h1>{mod.title}</h1>
          <p className="lead">{mod.description}</p>
          <div className="module-progress wide">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${(done / path.length) * 100}%` }} />
            </div>
            <span className="small muted">
              {done} de {path.length} lecciones completadas
            </span>
          </div>
          <div className="hero-cta">
            <Link className="btn btn-primary" to={`/m/${mod.id}/${nextLesson.id}`}>
              {done === 0 ? 'Empezar' : done === path.length ? 'Repasar' : 'Continuar'}: {nextLesson.title} →
            </Link>
            {done > 0 && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  if (confirm('¿Borrar el progreso de este módulo?')) resetModule(mod.id);
                }}
              >
                Reiniciar progreso
              </button>
            )}
          </div>
        </div>
      </section>

      {mod.exam && (
        <Link
          to={`/m/${mod.id}/examen`}
          className="path-card"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1em',
            flexWrap: 'wrap',
            marginTop: '1.5em',
            borderColor: 'var(--accent)',
            background: 'linear-gradient(135deg, var(--accent-soft), var(--panel) 60%)',
          }}
        >
          <span style={{ fontSize: '2.2em' }} aria-hidden>
            🎓
          </span>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <h3>{mod.exam.title}</h3>
            <p className="muted">{mod.exam.summary}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8em', flexWrap: 'wrap' }}>
            {examBest !== null && (
              <span className="pill" title="Mejor nota en un simulacro completo">
                Mejor nota: {examBest}%
              </span>
            )}
            <span className="btn btn-primary">Ir al examen →</span>
          </div>
        </Link>
      )}

      <h2 className="section-title">Ruta de aprendizaje</h2>
      <ol className="path">
        {path.map((l, i) => {
          const isDone = !!completed[`${mod.id}/${l.id}`];
          return (
            <li key={l.id} className={`path-item ${isDone ? 'done' : ''} ${l.id === nextLesson.id && !isDone ? 'current' : ''}`}>
              <span className="path-node">{isDone ? '✓' : i + 1}</span>
              <Link to={`/m/${mod.id}/${l.id}`} className="path-card">
                <div className="path-card-head">
                  <h3>{l.title}</h3>
                  <span className={`pill pill-${l.difficulty}`}>{l.difficulty}</span>
                  <span className="pill">⏱ {l.duration}</span>
                </div>
                <p className="muted">{l.summary}</p>
                <div className="topics">
                  {l.concepts.map((c) => (
                    <span key={c} className="topic">
                      {c}
                    </span>
                  ))}
                </div>
              </Link>
            </li>
          );
        })}
      </ol>

      {free.length > 0 && (
        <>
          <h2 className="section-title">Practica libremente</h2>
          <div className="free-grid">
            {free.map((l) => (
              <Link key={l.id} to={`/m/${mod.id}/${l.id}`} className="path-card sandbox-card">
                <h3>🧪 {l.title}</h3>
                <p className="muted">{l.summary}</p>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
