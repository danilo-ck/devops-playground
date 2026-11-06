import { storage } from '@/core/progress';

export const EXAM_STORAGE_KEY = 'devopslab:exam:terraform:v1';
const MAX_ATTEMPTS = 50;

export type ExamMode = 'simulacro' | 'practica' | 'repaso';

export interface ExamAttempt {
  id: string;
  /** Fecha de finalización (ms epoch). */
  date: number;
  mode: ExamMode;
  total: number;
  correct: number;
  /** Porcentaje 0–100 redondeado. */
  score: number;
  durationSec: number;
  /** Aciertos por objetivo: { "4": { correct, total } }. */
  byObjective: Record<string, { correct: number; total: number }>;
  /** El simulacro terminó porque se agotó el tiempo. */
  timedOut?: boolean;
}

export function loadAttempts(): ExamAttempt[] {
  const raw = storage.get(EXAM_STORAGE_KEY);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as ExamAttempt[]) : [];
  } catch {
    return [];
  }
}

export function saveAttempt(a: ExamAttempt): ExamAttempt[] {
  const list = [a, ...loadAttempts()].slice(0, MAX_ATTEMPTS);
  storage.set(EXAM_STORAGE_KEY, JSON.stringify(list));
  return list;
}

export function clearAttempts() {
  storage.remove(EXAM_STORAGE_KEY);
}

/** Mejor nota en un simulacro completo (o null si no hay ninguno). */
export function bestSimulacroScore(list: ExamAttempt[] = loadAttempts()): number | null {
  const sims = list.filter((a) => a.mode === 'simulacro');
  return sims.length ? Math.max(...sims.map((a) => a.score)) : null;
}
