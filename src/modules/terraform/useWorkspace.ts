import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { storage } from '@/core/progress';
import {
  apply,
  applySummaryLines,
  confirmApply,
  deserializeState,
  emptyState,
  loadConfig,
  renderApplyEvent,
  requiredProviderNames,
  runCommand,
  serializeState,
  validate,
  type ApplyResult,
  type HistoryEntry,
  type PendingApply,
  type PlanResult,
  type TermLine,
  type TfState,
} from './engine';
import type { TerminalLine } from './components/Terminal';
import type { TerraformLesson, TfLessonContext } from './lessons/types';

interface Persisted {
  files: Record<string, string>;
  activeFile: string;
  state: string;
  initialized: string[];
  history: HistoryEntry[];
}

const keyOf = (id: string) => `devopslab:tf:${id}:v1`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freshData(lesson: TerraformLesson) {
  let state = emptyState();
  let initialized: string[] = [];
  if (lesson.setup) {
    const r = apply(lesson.setup, state);
    if (r.ok) state = { ...r.state, serial: 1 };
    initialized = requiredProviderNames(loadConfig(lesson.setup));
  }
  return { files: { ...lesson.files }, activeFile: Object.keys(lesson.files)[0], state, initialized, history: [] as HistoryEntry[] };
}

function loadData(lesson: TerraformLesson) {
  const raw = storage.get(keyOf(lesson.id));
  if (raw) {
    try {
      const p = JSON.parse(raw) as Persisted;
      return { files: p.files, activeFile: p.files[p.activeFile] !== undefined ? p.activeFile : Object.keys(p.files)[0], state: deserializeState(p.state), initialized: p.initialized, history: p.history, restored: true };
    } catch {
      /* datos corruptos: empezamos de cero */
    }
  }
  return { ...freshData(lesson), restored: false };
}

let lineId = 0;
const mk = (l: TermLine): TerminalLine => ({ ...l, id: ++lineId });

export function useTerraformWorkspace(lesson: TerraformLesson) {
  const initial = useMemo(() => loadData(lesson), [lesson]);
  const [files, setFiles] = useState(initial.files);
  const [activeFile, setActiveFile] = useState(initial.activeFile);
  const [state, setState] = useState<TfState>(initial.state);
  const [displayState, setDisplayState] = useState<TfState | null>(null);
  const [initialized, setInitialized] = useState<string[]>(initial.initialized);
  const [history, setHistory] = useState<HistoryEntry[]>(initial.history);
  const [lines, setLines] = useState<TerminalLine[]>(() => welcome(lesson, initial.restored));
  const [pending, setPending] = useState<PendingApply | null>(null);
  const [consoleMode, setConsoleMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [lastPlan, setLastPlan] = useState<PlanResult | null>(null);
  const [planFiles, setPlanFiles] = useState<string>('');
  const [lastEvent, setLastEvent] = useState<{ kind: 'plan' | 'apply'; at: number } | null>(null);

  // Análisis en vivo (con un pequeño retardo mientras se escribe).
  const [analyzed, setAnalyzed] = useState(files);
  useEffect(() => {
    const t = setTimeout(() => setAnalyzed(files), 250);
    return () => clearTimeout(t);
  }, [files]);
  const analysis = useMemo(() => validate(analyzed), [analyzed]);

  // Persistencia
  useEffect(() => {
    if (busy) return;
    const p: Persisted = { files, activeFile, state: serializeState(state), initialized, history: history.slice(-200) };
    storage.set(keyOf(lesson.id), JSON.stringify(p));
  }, [files, activeFile, state, initialized, history, busy, lesson.id]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ctxRef = useRef({ files, state, initialized, consoleMode, pending, busy });
  ctxRef.current = { files, state, initialized, consoleMode, pending, busy };

  const push = useCallback((ls: TermLine[]) => setLines((prev) => [...prev, ...ls.map(mk)].slice(-1500)), []);
  const addHistory = useCallback((h: HistoryEntry) => setHistory((prev) => [...prev, h]), []);

  const animateApply = useCallback(
    async (result: ApplyResult, base: HistoryEntry) => {
      setBusy(true);
      setLastPlan(null);
      setLastEvent({ kind: 'apply', at: Date.now() });
      const evs = result.events;
      const delay = Math.min(420, Math.max(90, 2600 / Math.max(1, evs.length)));
      if (evs.length) push([{ text: '' }]);
      for (const ev of evs) {
        if (!mounted.current) return;
        setActive(ev.addr);
        setDisplayState(ev.state);
        const line = renderApplyEvent(ev);
        if (line) push([line]);
        await sleep(ev.kind === 'start' ? delay : delay * 0.6);
      }
      if (!mounted.current) return;
      setActive(null);
      setState(result.state);
      setDisplayState(null);
      push(applySummaryLines(result));
      addHistory({ ...base, command: result.destroy ? 'destroy' : 'apply', ok: result.ok, at: Date.now() });
      setBusy(false);
    },
    [push, addHistory],
  );

  const run = useCallback(
    async (cmd: string) => {
      const ctx = ctxRef.current;
      if (ctx.busy) return;
      if (ctx.pending) {
        push([{ text: `  Enter a value: ${cmd}`, tone: 'cmd' }]);
        const p = ctx.pending;
        setPending(null);
        if (cmd.trim() === 'yes') {
          const result = confirmApply(p, { ...ctx, consoleMode: false });
          await animateApply(result, {
            command: p.destroy ? 'destroy' : 'apply',
            ok: true,
            at: Date.now(),
            summary: p.plan.summary,
            actions: [...new Set(p.plan.changes.map((c) => c.action).filter((a) => a !== 'noop'))],
          });
        } else {
          push([
            { text: '' },
            { text: p.destroy ? 'Destroy cancelled.' : 'Apply cancelled.', tone: 'error' },
            { text: '💡 Solo se acepta "yes" exactamente. Es una medida de seguridad para no cambiar la infraestructura por error.', tone: 'hint' },
          ]);
        }
        return;
      }

      push([{ text: `${ctx.consoleMode ? '>' : '$'} ${cmd}`, tone: 'cmd' }]);
      const out = runCommand(cmd, { files: ctx.files, state: ctx.state, initialized: ctx.initialized, consoleMode: ctx.consoleMode });
      switch (out.kind) {
        case 'clear':
          setLines([]);
          return;
        case 'lines':
          push(out.lines);
          if (out.initialized) setInitialized(out.initialized);
          if (out.state) setState(out.state);
          if (out.consoleMode !== undefined) setConsoleMode(out.consoleMode);
          if (out.plan) {
            setLastPlan(out.plan);
            setPlanFiles(JSON.stringify(ctx.files));
            setLastEvent({ kind: 'plan', at: Date.now() });
          }
          if (out.history) addHistory(out.history);
          return;
        case 'confirm':
          push(out.lines);
          setPending(out.pending);
          setLastPlan(out.plan);
          setPlanFiles(JSON.stringify(ctx.files));
          setLastEvent({ kind: 'plan', at: Date.now() });
          return;
        case 'apply':
          push(out.lines);
          await animateApply(out.result, out.history);
          return;
      }
    },
    [push, addHistory, animateApply],
  );

  const updateFile = useCallback((name: string, content: string) => setFiles((f) => ({ ...f, [name]: content })), []);

  const addFile = useCallback((name: string) => {
    setFiles((f) => (f[name] !== undefined ? f : { ...f, [name]: '' }));
    setActiveFile(name);
  }, []);

  const removeFile = useCallback(
    (name: string) => {
      setFiles((f) => {
        const next = { ...f };
        delete next[name];
        return next;
      });
      setActiveFile((cur) => (cur === name ? Object.keys(files).find((x) => x !== name) ?? '' : cur));
    },
    [files],
  );

  const reset = useCallback(() => {
    const d = freshData(lesson);
    setFiles(d.files);
    setActiveFile(d.activeFile);
    setState(d.state);
    setInitialized(d.initialized);
    setHistory([]);
    setPending(null);
    setConsoleMode(false);
    setLastPlan(null);
    setLines(welcome(lesson, false));
  }, [lesson]);

  const loadSolution = useCallback(() => {
    if (!lesson.solution) return;
    setFiles({ ...lesson.solution });
    setActiveFile(Object.keys(lesson.solution)[0]);
    push([{ text: '' }, { text: '📘 Se ha cargado la solución en el editor. Ejecuta los comandos para completar la misión.', tone: 'info' }]);
  }, [lesson, push]);

  const checkCtx: TfLessonContext = useMemo(
    () => ({ files, state, history, initialized, config: analysis.config, graph: analysis.graph }),
    [files, state, history, initialized, analysis],
  );

  const planStale = !!lastPlan && planFiles !== JSON.stringify(files);

  return {
    files,
    activeFile,
    setActiveFile,
    updateFile,
    addFile,
    removeFile,
    state,
    displayState: displayState ?? state,
    initialized,
    history,
    lines,
    pending,
    consoleMode,
    busy,
    active,
    lastPlan,
    planStale,
    lastEvent,
    analysis,
    run,
    reset,
    loadSolution,
    checkCtx,
  };
}

function welcome(lesson: TerraformLesson, restored: boolean): TerminalLine[] {
  const ls: TermLine[] = [
    { text: 'Terraform v1.9.8 · simulador interactivo de DevOps Lab', tone: 'muted' },
    { text: 'Escribe "help" para ver los comandos o usa los botones de arriba. Ctrl+Enter en el editor ejecuta terraform plan.', tone: 'muted' },
  ];
  if (lesson.setup) ls.push({ text: 'ℹ️  Esta lección parte de infraestructura ya desplegada: mírala en la pestaña "Infraestructura".', tone: 'info' });
  if (restored) ls.push({ text: '↺  Se ha restaurado tu trabajo anterior en esta lección.', tone: 'info' });
  ls.push({ text: '' });
  return ls.map(mk);
}
