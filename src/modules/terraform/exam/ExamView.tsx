import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Inline, Markdown } from '@/components/Markdown';
import {
  FULL_EXAM_MINUTES,
  FULL_EXAM_SIZE,
  OBJECTIVES,
  PASS_MARK,
  QUESTIONS,
  buildExam,
  buildPractice,
  isCorrect,
  shuffle,
  type ExamQuestion,
  type ObjectiveId,
} from './questions';
import { bestSimulacroScore, clearAttempts, loadAttempts, saveAttempt, type ExamAttempt, type ExamMode } from './history';
import './exam.css';

interface Session {
  mode: ExamMode;
  questions: ExamQuestion[];
  /** Orden de presentación de las opciones (índices originales). */
  orders: number[][];
  answers: (number[] | undefined)[];
  /** Práctica: la pregunta ya se ha corregido. */
  checked: boolean[];
  flagged: boolean[];
  current: number;
  startedAt: number;
  deadline: number | null;
  immediate: boolean;
}

interface Finished {
  session: Session;
  attempt: ExamAttempt;
}

const MODE_LABEL: Record<ExamMode, string> = {
  simulacro: 'Simulacro completo',
  practica: 'Práctica por objetivo',
  repaso: 'Repaso de fallos',
};

const objectiveShort = (id: number) => OBJECTIVES.find((o) => o.id === id)?.short ?? `Objetivo ${id}`;

function newSession(mode: ExamMode, questions: ExamQuestion[], minutes: number | null): Session {
  const now = Date.now();
  return {
    mode,
    questions,
    orders: questions.map((q) => (q.kind === 'truefalse' ? q.options.map((_, i) => i) : shuffle(q.options.map((_, i) => i)))),
    answers: questions.map(() => undefined),
    checked: questions.map(() => false),
    flagged: questions.map(() => false),
    current: 0,
    startedAt: now,
    deadline: minutes ? now + minutes * 60_000 : null,
    immediate: mode !== 'simulacro',
  };
}

function fmtClock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(ms: number) {
  return new Date(ms).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const LETTERS = 'ABCDEFGH';

export function ExamView({ moduleId }: { moduleId: string }) {
  const [attempts, setAttempts] = useState<ExamAttempt[]>(() => loadAttempts());
  const [session, setSession] = useState<Session | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const screenKey = session ? `run-${session.startedAt}-${session.current}` : finished ? `res-${finished.attempt.id}` : 'start';

  // Al cambiar de pantalla o de pregunta, volver arriba (el contenedor con scroll puede ser la página o el host).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
  }, [screenKey]);

  const finish = useCallback((s: Session, timedOut = false) => {
    const byObjective: ExamAttempt['byObjective'] = {};
    let correct = 0;
    s.questions.forEach((q, i) => {
      const ok = isCorrect(q, s.answers[i]);
      if (ok) correct++;
      const b = (byObjective[q.objective] ??= { correct: 0, total: 0 });
      b.total++;
      if (ok) b.correct++;
    });
    const attempt: ExamAttempt = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      date: Date.now(),
      mode: s.mode,
      total: s.questions.length,
      correct,
      score: Math.round((correct / s.questions.length) * 100),
      durationSec: Math.round((Date.now() - s.startedAt) / 1000),
      byObjective,
      timedOut: timedOut || undefined,
    };
    setAttempts(saveAttempt(attempt));
    setFinished({ session: s, attempt });
    setSession(null);
  }, []);

  const start = (mode: ExamMode, questions: ExamQuestion[], minutes: number | null) => {
    if (!questions.length) return;
    setFinished(null);
    setSession(newSession(mode, questions, minutes));
  };

  return (
    <div className="exam" ref={rootRef}>
      {session ? (
        <RunScreen session={session} setSession={setSession} onFinish={finish} />
      ) : finished ? (
        <ResultsScreen
          finished={finished}
          moduleId={moduleId}
          onRetry={(qs) => start('repaso', shuffle(qs), null)}
          onHome={() => setFinished(null)}
        />
      ) : (
        <StartScreen
          moduleId={moduleId}
          attempts={attempts}
          onClear={() => {
            if (confirm('¿Borrar el historial de intentos?')) {
              clearAttempts();
              setAttempts([]);
            }
          }}
          onFull={() => start('simulacro', buildExam(QUESTIONS), FULL_EXAM_MINUTES)}
          onPractice={(objs, n) => start('practica', buildPractice(QUESTIONS, objs, n), null)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ inicio

function StartScreen({
  moduleId,
  attempts,
  onFull,
  onPractice,
  onClear,
}: {
  moduleId: string;
  attempts: ExamAttempt[];
  onFull: () => void;
  onPractice: (objs: ObjectiveId[], n: number) => void;
  onClear: () => void;
}) {
  const [selected, setSelected] = useState<ObjectiveId[]>([]);
  const [count, setCount] = useState(10);
  const counts = useMemo(() => {
    const c: Record<number, number> = {};
    for (const q of QUESTIONS) c[q.objective] = (c[q.objective] ?? 0) + 1;
    return c;
  }, []);
  const pool = selected.reduce((s, id) => s + (counts[id] ?? 0), 0);
  const n = Math.min(count, pool);
  const best = bestSimulacroScore(attempts);
  const toggle = (id: ObjectiveId) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].sort()));

  return (
    <>
      <Link to={`/m/${moduleId}`} className="exam-back">
        ← Volver al módulo
      </Link>
      <header className="exam-hero">
        <span className="exam-badge">Terraform Associate · 004</span>
        <h1>Prepara la certificación</h1>
        <p className="lead">
          {QUESTIONS.length} preguntas originales que cubren los 8 objetivos oficiales del examen. No son preguntas reales del examen: están
          pensadas para comprobar que entiendes cada concepto y sus trampas habituales.
        </p>
        {best !== null && (
          <p className="exam-best">
            Mejor simulacro: <strong className={best >= PASS_MARK ? 'ok' : 'ko'}>{best}%</strong>
          </p>
        )}
      </header>

      <div className="exam-modes">
        <section className="exam-card exam-card-main">
          <h2>📝 Simulacro completo</h2>
          <p className="muted">
            {FULL_EXAM_SIZE} preguntas aleatorias repartidas por objetivo y {FULL_EXAM_MINUTES} minutos de tiempo. Puedes navegar entre preguntas y
            marcarlas para revisar; la corrección llega al final.
          </p>
          <ul className="exam-facts">
            <li>⏱ {FULL_EXAM_MINUTES} min (termina solo al llegar a 0)</li>
            <li>🎯 Aprobado orientativo: {PASS_MARK}%</li>
            <li>🔀 Preguntas y opciones barajadas en cada intento</li>
          </ul>
          <button className="btn btn-primary btn-lg" onClick={onFull}>
            Empezar simulacro →
          </button>
        </section>

        <section className="exam-card">
          <h2>🎯 Práctica por objetivo</h2>
          <p className="muted">Elige uno o varios objetivos. Cada respuesta se corrige al momento con su explicación.</p>
          <div className="exam-objectives">
            {OBJECTIVES.map((o) => (
              <label key={o.id} className={`exam-obj-check ${selected.includes(o.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                <span className="exam-obj-num">{o.id}</span>
                <span className="exam-obj-title">{o.title}</span>
                <span className="exam-obj-count">{counts[o.id] ?? 0}</span>
              </label>
            ))}
          </div>
          <div className="exam-practice-row">
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(selected.length === OBJECTIVES.length ? [] : OBJECTIVES.map((o) => o.id))}>
              {selected.length === OBJECTIVES.length ? 'Ninguno' : 'Todos'}
            </button>
            <label className="exam-count">
              Preguntas
              <select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[5, 10, 20, 30, 50, 999].map((v) => (
                  <option key={v} value={v}>
                    {v === 999 ? 'Todas' : v}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" disabled={pool === 0} onClick={() => onPractice(selected, n)}>
              {pool === 0 ? 'Elige un objetivo' : `Practicar ${n} →`}
            </button>
          </div>
        </section>
      </div>

      <section className="exam-history">
        <div className="exam-history-head">
          <h2 className="section-title">Intentos anteriores</h2>
          {attempts.length > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={onClear}>
              Borrar historial
            </button>
          )}
        </div>
        {attempts.length === 0 ? (
          <p className="muted small">Todavía no has hecho ningún intento.</p>
        ) : (
          <ul className="exam-attempts">
            {attempts.slice(0, 12).map((a) => (
              <li key={a.id}>
                <span className={`exam-score ${a.score >= PASS_MARK ? 'ok' : 'ko'}`}>{a.score}%</span>
                <span className="exam-attempt-mode">{MODE_LABEL[a.mode]}</span>
                <span className="muted small">
                  {a.correct}/{a.total} · {Math.round(a.durationSec / 60)} min{a.timedOut ? ' · tiempo agotado' : ''}
                </span>
                <span className="muted small exam-attempt-date">{fmtDate(a.date)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ------------------------------------------------------------------ examen

function RunScreen({
  session,
  setSession,
  onFinish,
}: {
  session: Session;
  setSession: (s: Session) => void;
  onFinish: (s: Session, timedOut?: boolean) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [showNav, setShowNav] = useState(false);
  const { questions, current, orders, answers, checked, flagged, immediate } = session;
  const q = questions[current];
  const order = orders[current];
  const answer = answers[current] ?? [];
  const isChecked = checked[current];
  const multi = q.correct.length > 1;
  const answeredCount = answers.filter((a) => a && a.length > 0).length;
  const remaining = session.deadline ? session.deadline - now : null;

  useEffect(() => {
    if (!session.deadline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session.deadline]);

  useEffect(() => {
    if (remaining !== null && remaining <= 0) onFinish(session, true);
  }, [remaining, session, onFinish]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const update = (patch: Partial<Session>) => setSession({ ...session, ...patch });
  const go = (i: number) => {
    update({ current: Math.max(0, Math.min(questions.length - 1, i)) });
    setShowNav(false);
  };

  const choose = (orig: number) => {
    if (isChecked) return;
    let next: number[];
    if (multi) {
      if (answer.includes(orig)) next = answer.filter((x) => x !== orig);
      else if (answer.length >= q.correct.length) return; // como en el examen real: no más de N
      else next = [...answer, orig];
    } else next = [orig];
    const a = answers.slice();
    a[current] = next;
    update({ answers: a });
  };

  const check = () => {
    const c = checked.slice();
    c[current] = true;
    update({ checked: c });
  };

  const toggleFlag = () => {
    const f = flagged.slice();
    f[current] = !f[current];
    update({ flagged: f });
  };

  const requestFinish = () => {
    const pending = questions.length - answeredCount;
    const flags = flagged.filter(Boolean).length;
    const parts: string[] = [];
    if (pending) parts.push(`${pending} sin responder`);
    if (flags) parts.push(`${flags} marcadas para revisar`);
    if (parts.length && !confirm(`Tienes ${parts.join(' y ')}. ¿Terminar de todos modos?`)) return;
    onFinish(session);
  };

  const last = current === questions.length - 1;
  const canCheck = answer.length > 0 && (!multi || answer.length === q.correct.length);
  const correctNow = isChecked && isCorrect(q, answer);

  return (
    <div className="exam-run">
      <div className="exam-topline">
        <span className="exam-mode-label">{MODE_LABEL[session.mode]}</span>
        <span className="muted small">
          {answeredCount}/{questions.length} respondidas
        </span>
        <span className="exam-spacer" />
        {remaining !== null && (
          <span className={`exam-timer ${remaining < 5 * 60_000 ? 'low' : ''}`} aria-live="off">
            ⏱ {fmtClock(remaining)}
          </span>
        )}
        <button className="btn btn-sm btn-ghost exam-nav-toggle" onClick={() => setShowNav((v) => !v)}>
          {showNav ? 'Ocultar mapa' : 'Mapa de preguntas'}
        </button>
        <button className="btn btn-sm" onClick={requestFinish}>
          Terminar
        </button>
      </div>
      <div className="exam-progress" aria-hidden>
        <div style={{ width: `${((current + 1) / questions.length) * 100}%` }} />
      </div>

      <div className="exam-run-grid">
        <article className="exam-question">
          <div className="exam-q-head">
            <span className="exam-q-num">
              Pregunta {current + 1} de {questions.length}
            </span>
            <span className="pill">
              {q.objective} · {objectiveShort(q.objective)}
            </span>
            {immediate && <span className="pill">{q.subtopic}</span>}
            <button className={`exam-flag ${flagged[current] ? 'on' : ''}`} onClick={toggleFlag} aria-pressed={flagged[current]}>
              {flagged[current] ? '🚩 Marcada' : '🏳 Marcar para revisar'}
            </button>
          </div>

          <div className="exam-prompt">
            <Markdown source={q.prompt} />
          </div>
          <p className="exam-hint small muted">
            {multi ? `Selecciona ${q.correct.length} respuestas.` : 'Selecciona una respuesta.'}
          </p>

          <div className="exam-options" role={multi ? 'group' : 'radiogroup'}>
            {order.map((orig, pos) => {
              const sel = answer.includes(orig);
              const isRight = q.correct.includes(orig);
              let cls = sel ? 'selected' : '';
              if (isChecked) cls += isRight ? ' right' : sel ? ' wrong' : ' dim';
              return (
                <button
                  key={orig}
                  className={`exam-option ${cls}`}
                  onClick={() => choose(orig)}
                  disabled={isChecked}
                  role={multi ? 'checkbox' : 'radio'}
                  aria-checked={sel}
                >
                  <span className={`exam-option-key ${multi ? 'square' : ''}`}>{LETTERS[pos]}</span>
                  <span className="exam-option-text">
                    <Inline text={q.options[orig]} />
                  </span>
                  {isChecked && isRight && <span className="exam-option-mark">✓</span>}
                  {isChecked && sel && !isRight && <span className="exam-option-mark">✗</span>}
                </button>
              );
            })}
          </div>

          {isChecked && (
            <div className={`exam-feedback ${correctNow ? 'ok' : 'ko'}`}>
              <strong>{correctNow ? '✓ ¡Correcto!' : '✗ Incorrecto'}</strong>
              <Markdown source={q.explanation} />
            </div>
          )}

          <div className="exam-actions">
            <button className="btn" onClick={() => go(current - 1)} disabled={current === 0}>
              ← Anterior
            </button>
            {immediate && !isChecked ? (
              <button className="btn btn-primary" onClick={check} disabled={!canCheck}>
                Comprobar
              </button>
            ) : last ? (
              <button className="btn btn-primary" onClick={requestFinish}>
                Ver resultados
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => go(current + 1)}>
                Siguiente →
              </button>
            )}
          </div>
        </article>

        <aside className={`exam-navigator ${showNav ? 'open' : ''}`}>
          <h3>Mapa de preguntas</h3>
          <div className="exam-nav-grid">
            {questions.map((qq, i) => {
              const answered = (answers[i]?.length ?? 0) > 0;
              let cls = answered ? 'answered' : '';
              if (checked[i]) cls = isCorrect(qq, answers[i]) ? 'right' : 'wrong';
              return (
                <button
                  key={qq.id}
                  className={`exam-nav-cell ${cls} ${i === current ? 'current' : ''} ${flagged[i] ? 'flagged' : ''}`}
                  onClick={() => go(i)}
                  aria-label={`Pregunta ${i + 1}${answered ? ', respondida' : ''}${flagged[i] ? ', marcada' : ''}`}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
          <ul className="exam-legend small muted">
            <li>
              <span className="exam-nav-cell answered" /> Respondida
            </li>
            <li>
              <span className="exam-nav-cell flagged" /> Marcada
            </li>
            {immediate && (
              <li>
                <span className="exam-nav-cell right" /> Acierto / <span className="exam-nav-cell wrong" /> Fallo
              </li>
            )}
          </ul>
        </aside>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ resultados

function ResultsScreen({
  finished,
  moduleId,
  onRetry,
  onHome,
}: {
  finished: Finished;
  moduleId: string;
  onRetry: (qs: ExamQuestion[]) => void;
  onHome: () => void;
}) {
  const { session, attempt } = finished;
  const [filter, setFilter] = useState<'all' | 'wrong' | 'flagged'>('all');
  const passed = attempt.score >= PASS_MARK;
  const wrong = session.questions.filter((q, i) => !isCorrect(q, session.answers[i]));
  const items = session.questions
    .map((q, i) => ({ q, i, ok: isCorrect(q, session.answers[i]) }))
    .filter(({ ok, i }) => (filter === 'wrong' ? !ok : filter === 'flagged' ? session.flagged[i] : true));

  return (
    <div className="exam-results">
      <header className={`exam-result-hero ${passed ? 'ok' : 'ko'}`}>
        <div className="exam-big-score">
          <span>{attempt.score}%</span>
          <small>
            {attempt.correct} de {attempt.total} correctas
          </small>
        </div>
        <div>
          <span className="exam-mode-label">{MODE_LABEL[attempt.mode]}</span>
          <h1>{passed ? '¡Por encima del aprobado!' : 'Aún por debajo del aprobado'}</h1>
          <div className="exam-passbar" aria-label={`Nota ${attempt.score}%, aprobado orientativo ${PASS_MARK}%`}>
            <div className="exam-passbar-fill" style={{ width: `${attempt.score}%` }} />
            <div className="exam-passbar-mark" style={{ left: `${PASS_MARK}%` }}>
              <span>{PASS_MARK}%</span>
            </div>
          </div>
          <p className="small muted">
            El {PASS_MARK}% es una referencia orientativa: HashiCorp no publica la nota de corte exacta del examen real.
            {attempt.timedOut ? ' El tiempo se agotó y el examen se cerró automáticamente.' : ''} Duración: {Math.round(attempt.durationSec / 60)} min.
          </p>
          <div className="hero-cta">
            {wrong.length > 0 && (
              <button className="btn btn-primary" onClick={() => onRetry(wrong)}>
                Repetir las {wrong.length} falladas
              </button>
            )}
            <button className="btn" onClick={onHome}>
              Nuevo intento
            </button>
            <Link className="btn btn-ghost" to={`/m/${moduleId}`}>
              Volver al módulo
            </Link>
          </div>
        </div>
      </header>

      <h2 className="section-title">Resultado por objetivo</h2>
      <div className="exam-breakdown">
        {OBJECTIVES.filter((o) => attempt.byObjective[o.id]).map((o) => {
          const b = attempt.byObjective[o.id];
          const pct = Math.round((b.correct / b.total) * 100);
          return (
            <div key={o.id} className="exam-break-row">
              <span className="exam-break-label">
                <span className="exam-obj-num">{o.id}</span> {o.title}
              </span>
              <div className="exam-break-bar">
                <div className={pct >= PASS_MARK ? 'ok' : 'ko'} style={{ width: `${Math.max(pct, 2)}%` }} />
              </div>
              <span className="exam-break-num">
                {b.correct}/{b.total} · {pct}%
              </span>
            </div>
          );
        })}
      </div>

      <div className="exam-review-head">
        <h2 className="section-title">Revisión</h2>
        <div className="exam-filter" role="tablist">
          {(
            [
              ['all', `Todas (${session.questions.length})`],
              ['wrong', `Falladas (${wrong.length})`],
              ['flagged', `Marcadas (${session.flagged.filter(Boolean).length})`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(k)} role="tab" aria-selected={filter === k}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 && <p className="muted small">No hay preguntas en este filtro.</p>}
      <ol className="exam-review">
        {items.map(({ q, i, ok }) => {
          const ans = session.answers[i] ?? [];
          return (
            <li key={q.id} className={`exam-review-item ${ok ? 'ok' : 'ko'}`}>
              <details open={!ok}>
                <summary>
                  <span className="exam-review-icon">{ok ? '✓' : '✗'}</span>
                  <span className="exam-review-n">{i + 1}.</span>
                  <span className="exam-review-sub">
                    {objectiveShort(q.objective)} · {q.subtopic}
                  </span>
                  {session.flagged[i] && <span title="Marcada">🚩</span>}
                </summary>
                <div className="exam-prompt">
                  <Markdown source={q.prompt} />
                </div>
                <ul className="exam-review-options">
                  {q.options.map((opt, oi) => {
                    const sel = ans.includes(oi);
                    const right = q.correct.includes(oi);
                    if (!sel && !right) return null;
                    return (
                      <li key={oi} className={right ? 'right' : 'wrong'}>
                        <span className="exam-review-tag">{right && sel ? 'Tu respuesta ✓' : right ? 'Correcta' : 'Tu respuesta ✗'}</span>
                        <Inline text={opt} />
                      </li>
                    );
                  })}
                  {ans.length === 0 && <li className="wrong">Sin responder</li>}
                </ul>
                <div className="exam-explanation">
                  <Markdown source={q.explanation} />
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
