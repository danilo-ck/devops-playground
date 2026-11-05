import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LessonMeta } from '@/core/types';
import { Markdown } from './Markdown';

export interface ObjectiveStatus {
  id: string;
  label: string;
  done: boolean;
}

interface Props {
  moduleId: string;
  moduleTitle: string;
  lesson: LessonMeta;
  index: number;
  total: number;
  content: string;
  objectives: ObjectiveStatus[];
  hints: string[];
  completed: boolean;
  next?: LessonMeta;
  onShowSolution?: () => void;
  onReset: () => void;
}

/** Panel lateral genérico de una lección: teoría, misión, pistas y progreso. */
export function LessonPanel(p: Props) {
  const [tab, setTab] = useState<'theory' | 'mission'>('theory');
  const [hintsShown, setHintsShown] = useState(0);
  const done = p.objectives.filter((o) => o.done).length;
  const allDone = p.objectives.length > 0 && done === p.objectives.length;

  useEffect(() => {
    setTab('theory');
    setHintsShown(0);
  }, [p.lesson.id]);

  return (
    <aside className="lesson-panel">
      <header className="lesson-head">
        <div className="lesson-crumbs">
          <Link to={`/m/${p.moduleId}`}>{p.moduleTitle}</Link>
          {!p.lesson.freeform && (
            <span>
              {' '}
              · Lección {p.index + 1} de {p.total}
            </span>
          )}
        </div>
        <h1>{p.lesson.title}</h1>
        <div className="lesson-meta">
          <span className={`pill pill-${p.lesson.difficulty}`}>{p.lesson.difficulty}</span>
          <span className="pill">⏱ {p.lesson.duration}</span>
          {p.completed && <span className="pill pill-done">✓ Completada</span>}
        </div>
      </header>

      {p.objectives.length > 0 && (
        <nav className="lesson-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'theory'} className={tab === 'theory' ? 'active' : ''} onClick={() => setTab('theory')}>
            📖 Teoría
          </button>
          <button role="tab" aria-selected={tab === 'mission'} className={tab === 'mission' ? 'active' : ''} onClick={() => setTab('mission')}>
            🎯 Misión <span className="tab-count">{done}/{p.objectives.length}</span>
          </button>
        </nav>
      )}

      <div className="lesson-body">
        {tab === 'theory' || p.objectives.length === 0 ? (
          <>
            <Markdown source={p.content} />
            {p.objectives.length > 0 && (
              <button className="btn btn-primary btn-block" onClick={() => setTab('mission')}>
                Ir a la misión →
              </button>
            )}
          </>
        ) : (
          <div className="mission">
            <p className="muted">Completa estos objetivos usando el editor y la terminal. Se comprueban automáticamente.</p>
            <ol className="objectives">
              {p.objectives.map((o, i) => (
                <li key={o.id} className={o.done ? 'done' : ''}>
                  <span className="obj-check">{o.done ? '✓' : i + 1}</span>
                  <span className="obj-label">{renderInlineCode(o.label)}</span>
                </li>
              ))}
            </ol>

            {p.hints.length > 0 && (
              <div className="hints">
                <h3>Pistas</h3>
                {p.hints.slice(0, hintsShown).map((h, i) => (
                  <div key={i} className="hint">
                    <Markdown source={h} />
                  </div>
                ))}
                {hintsShown < p.hints.length && (
                  <button className="btn btn-ghost" onClick={() => setHintsShown((n) => n + 1)}>
                    💡 {hintsShown === 0 ? 'Necesito una pista' : 'Otra pista'} ({hintsShown}/{p.hints.length})
                  </button>
                )}
              </div>
            )}
            <div className="mission-actions">
              {p.onShowSolution && (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    if (confirm('Se sustituirá tu código por la solución. ¿Continuar?')) p.onShowSolution!();
                  }}
                >
                  👀 Ver solución
                </button>
              )}
              <button
                className="btn btn-ghost"
                onClick={() => {
                  if (confirm('Se restaurará el código inicial y el estado de la lección. ¿Continuar?')) p.onReset();
                }}
              >
                ↺ Reiniciar lección
              </button>
            </div>
          </div>
        )}
      </div>

      {p.objectives.length > 0 && (
        <footer className={`lesson-foot ${allDone ? 'is-done' : ''}`}>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${(done / p.objectives.length) * 100}%` }} />
          </div>
          {allDone ? (
            <div className="lesson-foot-row">
              <span>🎉 ¡Lección completada!</span>
              {p.next ? (
                <Link className="btn btn-primary" to={`/m/${p.moduleId}/${p.next.id}`}>
                  Siguiente: {p.next.title} →
                </Link>
              ) : (
                <Link className="btn btn-primary" to={`/m/${p.moduleId}`}>
                  Volver al módulo
                </Link>
              )}
            </div>
          ) : (
            <div className="lesson-foot-row muted">
              {done}/{p.objectives.length} objetivos completados
              {tab === 'theory' && (
                <button className="link" onClick={() => setTab('mission')}>
                  ver misión
                </button>
              )}
            </div>
          )}
        </footer>
      )}
    </aside>
  );
}

function renderInlineCode(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) => (part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part));
}
