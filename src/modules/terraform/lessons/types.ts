import type { LessonMeta, Objective } from '@/core/types';
import type { Config, DepGraph, HistoryEntry, InstanceState, TfState } from '../engine';

/** Contexto con el que se evalúan los objetivos de una lección de Terraform. */
export interface TfLessonContext {
  files: Record<string, string>;
  state: TfState;
  history: HistoryEntry[];
  initialized: string[];
  config: Config;
  graph: DepGraph | null;
}

export type VizTab = 'infra' | 'graph' | 'plan' | 'state' | 'docs';

export interface TerraformLesson extends LessonMeta {
  /** Teoría en Markdown. */
  content: string;
  /** Ficheros iniciales del editor. */
  files: Record<string, string>;
  /** Si existe, se aplica al empezar: la lección parte de infraestructura ya creada. */
  setup?: Record<string, string>;
  objectives: Objective<TfLessonContext>[];
  hints: string[];
  solution?: Record<string, string>;
  defaultView?: VizTab;
}

// ------------------------------------------------------------ helpers para objetivos

export const instancesOf = (ctx: TfLessonContext, type: string): InstanceState[] =>
  Object.values(ctx.state.resources).filter((r) => r.type === type && r.mode === 'managed');

export const resourcesInConfig = (ctx: TfLessonContext, type: string) => Object.values(ctx.config.resources).filter((r) => r.type === type && r.mode === 'managed');

/** ¿Se ha ejecutado con éxito este comando? (opcionalmente, con una condición extra) */
export const ran = (ctx: TfLessonContext, command: string, pred: (h: HistoryEntry) => boolean = () => true) =>
  ctx.history.some((h) => h.command === command && h.ok && pred(h));

/** ¿Depende el nodo `id` del grafo de algún nodo que empiece por `prefix`? */
export const dependsOn = (ctx: TfLessonContext, id: string, prefix: string) => !!ctx.graph?.deps[id]?.some((d) => d.startsWith(prefix));

export const allSource = (ctx: TfLessonContext) => Object.entries(ctx.files).filter(([f]) => f.endsWith('.tf')).map(([, s]) => s).join('\n');

/** Elimina comentarios para comprobar el código real escrito. */
export const codeOnly = (ctx: TfLessonContext) => allSource(ctx).replace(/#.*$/gm, '').replace(/\/\/.*$/gm, '');
