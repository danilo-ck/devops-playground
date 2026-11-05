import { useEffect, useMemo, useRef, useState } from 'react';
import type { LessonViewProps } from '@/core/types';
import { useProgress } from '@/core/progress';
import { LessonPanel } from '@/components/LessonPanel';
import { CodeEditor, type CodeEditorHandle } from './components/CodeEditor';
import { Terminal } from './components/Terminal';
import { CloudCanvas } from './components/CloudCanvas';
import { ResourceGraph } from './components/ResourceGraph';
import { PlanView } from './components/PlanView';
import { StateView } from './components/StateView';
import { DocsView } from './components/DocsView';
import { useTerraformWorkspace } from './useWorkspace';
import { terraformLessons } from './lessons';
import type { VizTab } from './lessons/types';

const TABS: { id: VizTab; label: string; icon: string }[] = [
  { id: 'infra', label: 'Infraestructura', icon: '☁️' },
  { id: 'graph', label: 'Grafo', icon: '🕸️' },
  { id: 'plan', label: 'Plan', icon: '📋' },
  { id: 'state', label: 'Estado', icon: '🗄️' },
  { id: 'docs', label: 'Docs', icon: '📚' },
];

export function TerraformLessonView({ moduleId, lessonId }: LessonViewProps) {
  const index = terraformLessons.findIndex((l) => l.id === lessonId);
  const lesson = terraformLessons[index];
  const ws = useTerraformWorkspace(lesson);
  const editorRef = useRef<CodeEditorHandle>(null);
  const [tab, setTab] = useState<VizTab>(lesson.defaultView ?? 'infra');
  const [newFile, setNewFile] = useState<string | null>(null);

  const markComplete = useProgress((s) => s.markComplete);
  const completed = useProgress((s) => !!s.completed[`${moduleId}/${lessonId}`]);

  const objectives = useMemo(
    () =>
      lesson.objectives.map((o) => {
        let done = false;
        try {
          done = o.check(ws.checkCtx);
        } catch {
          done = false;
        }
        return { id: o.id, label: o.label, done };
      }),
    [lesson, ws.checkCtx],
  );
  const allDone = objectives.length > 0 && objectives.every((o) => o.done);
  useEffect(() => {
    if (allDone && !lesson.freeform) markComplete(moduleId, lessonId);
  }, [allDone, lesson.freeform, markComplete, moduleId, lessonId]);

  // Cambia de pestaña automáticamente para que se vea el efecto de cada comando.
  useEffect(() => {
    if (!ws.lastEvent) return;
    if (ws.lastEvent.kind === 'plan') setTab((t) => (t === 'state' || t === 'docs' ? 'infra' : t));
    if (ws.lastEvent.kind === 'apply') setTab((t) => (t === 'plan' || t === 'docs' ? 'infra' : t));
  }, [ws.lastEvent]);

  const pathLessons = terraformLessons.filter((l) => !l.freeform);
  const next = lesson.freeform ? undefined : pathLessons[pathLessons.indexOf(lesson) + 1];

  const errors = ws.analysis.diagnostics;
  const fileErrors = errors.filter((d) => d.file === ws.activeFile);
  const errCount = errors.filter((d) => d.severity === 'error').length;
  const actionable = ws.lastPlan?.ok ? ws.lastPlan.changes.filter((c) => c.action !== 'noop').length : 0;
  const starterFiles = Object.keys(lesson.files);

  const createFile = () => {
    let name = (newFile ?? '').trim();
    if (!name) return setNewFile(null);
    if (!/\.(tf|tfvars)$/.test(name)) name += '.tf';
    ws.addFile(name);
    setNewFile(null);
  };

  return (
    <div className="workspace">
      <LessonPanel
        moduleId={moduleId}
        moduleTitle="Terraform"
        lesson={lesson}
        index={pathLessons.indexOf(lesson)}
        total={pathLessons.length}
        content={lesson.content}
        objectives={objectives}
        hints={lesson.hints}
        completed={completed}
        next={next}
        onShowSolution={lesson.solution ? ws.loadSolution : undefined}
        onReset={ws.reset}
      />

      <section className="ws-center">
        <div className="editor-pane">
          <div className="file-tabs">
            {Object.keys(ws.files).map((f) => {
              const fe = errors.filter((d) => d.file === f && d.severity === 'error').length;
              return (
                <div key={f} className={`file-tab ${f === ws.activeFile ? 'active' : ''}`} onClick={() => ws.setActiveFile(f)}>
                  <span className="file-ico">{f.endsWith('.tfvars') ? '⚙' : '◆'}</span>
                  {f.includes('/') && <span className="file-dir">{f.slice(0, f.lastIndexOf('/') + 1)}</span>}
                  {f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f}
                  {fe > 0 && <span className="file-err">{fe}</span>}
                  {!starterFiles.includes(f) && (
                    <button
                      className="file-close"
                      title="Eliminar fichero"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`¿Eliminar ${f}?`)) ws.removeFile(f);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            {newFile !== null ? (
              <input
                className="file-new-input"
                autoFocus
                placeholder="main.tf o modules/red/main.tf"
                value={newFile}
                onChange={(e) => setNewFile(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createFile();
                  if (e.key === 'Escape') setNewFile(null);
                }}
                onBlur={createFile}
              />
            ) : (
              <button className="file-add" title="Nuevo fichero" onClick={() => setNewFile('')}>
                +
              </button>
            )}
            <span className="file-tabs-spacer" />
            <button className="btn btn-sm btn-primary" disabled={ws.busy} onClick={() => ws.run('terraform plan')} title="Ctrl+Enter">
              ▶ plan
            </button>
          </div>
          {ws.files[ws.activeFile] !== undefined ? (
            <CodeEditor
              ref={editorRef}
              value={ws.files[ws.activeFile]}
              onChange={(v) => ws.updateFile(ws.activeFile, v)}
              diagnostics={fileErrors}
              onRunShortcut={() => ws.run('terraform plan')}
            />
          ) : (
            <div className="viz-empty">Crea un fichero con el botón +</div>
          )}
          <ProblemsBar
            diagnostics={errors}
            onJump={(file, line) => {
              ws.setActiveFile(file);
              setTimeout(() => editorRef.current?.goToLine(line), 30);
            }}
          />
        </div>
        <Terminal lines={ws.lines} onSubmit={ws.run} busy={ws.busy} awaitingConfirm={!!ws.pending} consoleMode={ws.consoleMode} />
      </section>

      <section className="ws-viz">
        <nav className="viz-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              <span className="viz-tab-icon">{t.icon}</span> {t.label}
              {t.id === 'plan' && actionable > 0 && <span className={`badge ${ws.planStale ? 'badge-stale' : ''}`}>{actionable}</span>}
              {t.id === 'graph' && errCount > 0 && <span className="badge badge-err">!</span>}
              {t.id === 'state' && Object.keys(ws.state.resources).length > 0 && <span className="badge badge-dim">{Object.keys(ws.state.resources).length}</span>}
            </button>
          ))}
        </nav>
        <div className="viz-body">
          {tab === 'infra' && <CloudCanvas state={ws.displayState} plan={ws.planStale ? null : ws.lastPlan?.ok ? ws.lastPlan : null} active={ws.active} busy={ws.busy} />}
          {tab === 'graph' && <ResourceGraph graph={ws.analysis.graph} plan={!ws.planStale && ws.lastPlan?.ok && !ws.busy ? ws.lastPlan : null} state={ws.displayState} active={ws.active} />}
          {tab === 'plan' && <PlanView plan={ws.lastPlan} stale={ws.planStale} />}
          {tab === 'state' && <StateView state={ws.displayState} />}
          {tab === 'docs' && <DocsView />}
        </div>
        {tab === 'infra' && ws.planStale && <div className="viz-hint">✏️ Código modificado: ejecuta <code>terraform plan</code> para previsualizar los cambios.</div>}
      </section>
    </div>
  );
}

function ProblemsBar({ diagnostics, onJump }: { diagnostics: import('./engine').Diagnostic[]; onJump: (file: string, line: number) => void }) {
  const [open, setOpen] = useState(false);
  const errs = diagnostics.filter((d) => d.severity === 'error');
  const warns = diagnostics.filter((d) => d.severity === 'warning');
  if (!diagnostics.length) {
    return (
      <div className="problems ok">
        <span>✓ Sin errores de sintaxis ni referencias</span>
      </div>
    );
  }
  const first = errs[0] ?? warns[0];
  return (
    <div className={`problems ${errs.length ? 'has-err' : 'has-warn'} ${open ? 'open' : ''}`}>
      <button className="problems-head" onClick={() => setOpen((o) => !o)}>
        <span>{errs.length ? `✖ ${errs.length} error${errs.length > 1 ? 'es' : ''}` : `⚠ ${warns.length} aviso${warns.length > 1 ? 's' : ''}`}</span>
        {!open && (
          <span className="problems-first">
            {first.file}:{first.line} — {first.hint ?? first.summary}
          </span>
        )}
        <span className="problems-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="problems-list">
          {diagnostics.map((d, i) => (
            <li key={i} onClick={() => d.file && d.line && onJump(d.file, d.line)}>
              <span className={d.severity === 'error' ? 'p-err' : 'p-warn'}>{d.severity === 'error' ? '✖' : '⚠'}</span>
              <span className="p-loc">
                {d.file}:{d.line}
              </span>
              <span className="p-msg">
                <strong>{d.summary}</strong>
                {d.detail && <span className="muted"> — {d.detail}</span>}
                {d.hint && <span className="p-hint">💡 {d.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
