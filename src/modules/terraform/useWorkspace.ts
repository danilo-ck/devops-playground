import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { storage } from '@/core/progress';
import {
  applySummaryLines,
  confirmApply,
  currentBackend,
  deserializeCloud,
  deserializeState,
  installedModules,
  renderApplyEvent,
  runCommand,
  serializeCloud,
  serializeState,
  validate,
  type ApplyResult,
  type CloudChanges,
  type HistoryEntry,
  type PendingApply,
  type PlanResult,
  type SavedPlan,
  type StateLock,
  type TermLine,
  type TfState,
} from './engine';
import type { TerminalLine } from './components/Terminal';
import { lessonStart } from './lessons/start';
import type { TerraformLesson, TfLessonContext } from './lessons/types';

interface Persisted {
  files: Record<string, string>;
  activeFile: string;
  state: string;
  initialized: string[];
  history: HistoryEntry[];
  cloud?: string;
  env?: Record<string, string>;
  workspace?: string;
  stateStore?: Record<string, string>;
  lock?: StateLock | null;
  savedPlans?: Record<string, SavedPlan>;
}

const keyOf = (id: string) => `devopslab:tf:${id}:v1`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freshData(lesson: TerraformLesson) {
  const { state, initialized, cloud } = lessonStart(lesson);
  return {
    files: { ...lesson.files },
    activeFile: Object.keys(lesson.files)[0],
    state,
    initialized,
    cloud,
    history: [] as HistoryEntry[],
    env: {} as Record<string, string>,
    workspace: 'default',
    stateStore: {} as Record<string, TfState>,
    lock: null as StateLock | null,
    savedPlans: {} as Record<string, SavedPlan>,
  };
}

function loadData(lesson: TerraformLesson) {
  const raw = storage.get(keyOf(lesson.id));
  if (raw) {
    try {
      const p = JSON.parse(raw) as Persisted;
      return {
        files: p.files,
        activeFile: p.files[p.activeFile] !== undefined ? p.activeFile : Object.keys(p.files)[0],
        state: deserializeState(p.state),
        initialized: p.initialized,
        history: p.history,
        cloud: deserializeCloud(p.cloud),
        env: p.env ?? {},
        workspace: p.workspace ?? 'default',
        stateStore: Object.fromEntries(Object.entries(p.stateStore ?? {}).map(([k, v]) => [k, deserializeState(v)])),
        lock: p.lock ?? null,
        savedPlans: p.savedPlans ?? {},
        restored: true,
      };
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
  const [cloud, setCloud] = useState<CloudChanges>(initial.cloud);
  const [env, setEnv] = useState<Record<string, string>>(initial.env);
  const [workspace, setWorkspace] = useState<string>(initial.workspace);
  const [stateStore, setStateStore] = useState<Record<string, TfState>>(initial.stateStore);
  const [lock, setLock] = useState<StateLock | null>(initial.lock);
  const [savedPlans, setSavedPlans] = useState<Record<string, SavedPlan>>(initial.savedPlans);
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
  const analysis = useMemo(() => validate(analyzed, installedModules(initialized)), [analyzed, initialized]);

  // Persistencia
  useEffect(() => {
    if (busy) return;
    const p: Persisted = {
      files,
      activeFile,
      state: serializeState(state),
      initialized,
      history: history.slice(-200),
      cloud: serializeCloud(cloud),
      env,
      workspace,
      stateStore: Object.fromEntries(Object.entries(stateStore).map(([k, v]) => [k, serializeState(v)])),
      lock,
      savedPlans,
    };
    storage.set(keyOf(lesson.id), JSON.stringify(p));
  }, [files, activeFile, state, initialized, history, cloud, env, workspace, stateStore, lock, savedPlans, busy, lesson.id]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ctxRef = useRef({ files, state, initialized, consoleMode, pending, busy, cloud, env, workspace, stateStore, lock, savedPlans });
  ctxRef.current = { files, state, initialized, consoleMode, pending, busy, cloud, env, workspace, stateStore, lock, savedPlans };

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
      setCloud(result.cloud);
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
        if (p.unlockId) {
          if (cmd.trim() === 'yes') {
            setLock(null);
            push([
              { text: '' },
              { text: 'Terraform state has been successfully unlocked!', tone: 'success' },
              { text: '' },
              { text: 'The state has been unlocked, and Terraform commands should now be able to obtain a new lock on the remote state.', tone: 'muted' },
            ]);
            addHistory({ command: 'force-unlock', ok: true, at: Date.now(), args: [p.unlockId] });
          } else push([{ text: '' }, { text: 'force-unlock cancelled.', tone: 'error' }]);
          return;
        }
        const expected = p.policyOverride ? 'override' : 'yes';
        if (cmd.trim() === expected) {
          const result = confirmApply(p, { ...ctx, consoleMode: false });
          await animateApply(result, {
            command: p.destroy ? 'destroy' : 'apply',
            ok: true,
            at: Date.now(),
            summary: p.plan.summary,
            actions: [...new Set(p.plan.changes.map((c) => c.action).filter((a) => a !== 'noop'))],
            args: p.args ?? (p.refreshOnly ? ['-refresh-only'] : []),
            workspace: ctx.workspace,
            policy: p.policy,
          });
        } else {
          push([
            { text: '' },
            { text: p.policyOverride ? 'Policy override cancelled.' : p.destroy ? 'Destroy cancelled.' : 'Apply cancelled.', tone: 'error' },
            {
              text: p.policyOverride
                ? '💡 Una política soft-mandatory falló: solo alguien con permiso para hacer override puede seguir escribiendo "override". Mejor corrige el código.'
                : '💡 Solo se acepta "yes" exactamente. Es una medida de seguridad para no cambiar la infraestructura por error.',
              tone: 'hint',
            },
          ]);
        }
        return;
      }

      push([{ text: `${ctx.consoleMode ? '>' : '$'} ${cmd}`, tone: 'cmd' }]);
      const out = runCommand(cmd, {
        files: ctx.files,
        state: ctx.state,
        initialized: ctx.initialized,
        consoleMode: ctx.consoleMode,
        cloud: ctx.cloud,
        env: ctx.env,
        workspace: ctx.workspace,
        stateStore: ctx.stateStore,
        lock: ctx.lock,
        savedPlans: ctx.savedPlans,
        policies: lesson.policies,
      });
      if (out.kind === 'clear') {
        setLines([]);
        return;
      }
      // Cambios de sesión comunes a todos los comandos.
      if (out.initialized) setInitialized(out.initialized);
      if (out.state) setState(out.state);
      if (out.cloud) setCloud(out.cloud);
      if (out.env) setEnv(out.env);
      if (out.workspace) setWorkspace(out.workspace);
      if (out.stateStore) setStateStore(out.stateStore);
      if (out.lock !== undefined) setLock(out.lock);
      if (out.savedPlans) setSavedPlans(out.savedPlans);
      if (out.files) {
        const added = Object.keys(out.files).find((f) => ctx.files[f] === undefined);
        setFiles(out.files);
        if (added && !added.endsWith('.log')) setActiveFile(added);
      }
      switch (out.kind) {
        case 'lines':
          push(out.lines);
          if (out.consoleMode !== undefined) setConsoleMode(out.consoleMode);
          if (out.plan) {
            setLastPlan(out.plan);
            setPlanFiles(JSON.stringify(out.files ?? ctx.files));
            setLastEvent({ kind: 'plan', at: Date.now() });
          }
          if (out.history) addHistory(out.history);
          return;
        case 'confirm':
          push(out.lines);
          setPending(out.pending);
          if (out.pending.unlockId) return;
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
    [push, addHistory, animateApply, lesson.policies],
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
    setCloud(d.cloud);
    setEnv(d.env);
    setWorkspace(d.workspace);
    setStateStore(d.stateStore);
    setLock(d.lock);
    setSavedPlans(d.savedPlans);
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
    () => ({ files, state, history, initialized, config: analysis.config, graph: analysis.graph, cloud, env, workspace, stateStore, lock }),
    [files, state, history, initialized, analysis, cloud, env, workspace, stateStore, lock],
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
    cloud,
    workspace,
    backend: currentBackend(initialized),
    lock,
    env,
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
  if (lesson.drift) ls.push({ text: '✋ Alguien ha hecho cambios a mano en la nube. Usa "cloud ls" para ver lo que existe de verdad.', tone: 'warn' });
  if (restored) ls.push({ text: '↺  Se ha restaurado tu trabajo anterior en esta lección.', tone: 'info' });
  ls.push({ text: '' });
  return ls.map(mk);
}
