import { describe, expect, it } from 'vitest';
import {
  EXAM_WEIGHTS,
  FULL_EXAM_SIZE,
  OBJECTIVES,
  QUESTIONS,
  allocate,
  buildExam,
  buildPractice,
  isCorrect,
  type ExamQuestion,
  type ObjectiveId,
} from '../questions';

const NUMBER_WORDS: Record<number, string> = { 2: 'dos', 3: 'tres', 4: 'cuatro' };

/** Generador pseudoaleatorio determinista (mulberry32). */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const countBy = (qs: ExamQuestion[]) => {
  const c: Record<number, number> = {};
  for (const q of qs) c[q.objective] = (c[q.objective] ?? 0) + 1;
  return c;
};

describe('banco de preguntas', () => {
  it('tiene al menos 90 preguntas', () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(90);
  });

  it('los ids son únicos', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cada objetivo 1–8 tiene al menos 6 preguntas', () => {
    const c = countBy(QUESTIONS);
    for (const o of OBJECTIVES) expect(c[o.id] ?? 0, `objetivo ${o.id}`).toBeGreaterThanOrEqual(6);
    expect(OBJECTIVES.map((o) => o.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  for (const q of QUESTIONS) {
    describe(q.id, () => {
      it('es estructuralmente válida', () => {
        expect(q.options.length).toBeGreaterThanOrEqual(2);
        expect(q.correct.length).toBeGreaterThan(0);
        expect(new Set(q.correct).size).toBe(q.correct.length);
        for (const c of q.correct) {
          expect(Number.isInteger(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThan(q.options.length);
        }
        expect(q.correct.length).toBeLessThan(q.options.length);
        expect(new Set(q.options).size).toBe(q.options.length);
        expect(q.prompt.trim()).not.toBe('');
        expect(q.subtopic.trim()).not.toBe('');
        expect(q.explanation.trim().length).toBeGreaterThan(20);
        expect([1, 2, 3, 4, 5, 6, 7, 8]).toContain(q.objective);
      });

      it('el tipo es coherente con las respuestas', () => {
        if (q.kind === 'multi') {
          expect(q.correct.length).toBeGreaterThan(1);
          const word = NUMBER_WORDS[q.correct.length];
          expect(q.prompt.toLowerCase()).toContain(`elige ${word}`);
        } else {
          expect(q.correct.length).toBe(1);
          expect(q.prompt.toLowerCase()).not.toMatch(/elige (dos|tres|cuatro)/);
        }
        if (q.kind === 'truefalse') expect(q.options).toEqual(['Verdadero', 'Falso']);
      });

      it('los bloques de código están cerrados', () => {
        expect((q.prompt.match(/```/g) ?? []).length % 2).toBe(0);
        expect((q.explanation.match(/```/g) ?? []).length % 2).toBe(0);
      });
    });
  }
});

describe('helpers del examen', () => {
  it('los pesos del simulacro suman el tamaño del examen', () => {
    expect(Object.values(EXAM_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(FULL_EXAM_SIZE);
  });

  it('buildExam crea un simulacro proporcional, sin repetidos y aleatorio', () => {
    const a = buildExam(QUESTIONS, FULL_EXAM_SIZE, seeded(1));
    expect(a).toHaveLength(FULL_EXAM_SIZE);
    expect(new Set(a.map((q) => q.id)).size).toBe(FULL_EXAM_SIZE);
    const c = countBy(a);
    for (const id of Object.keys(EXAM_WEIGHTS)) {
      expect(c[Number(id)]).toBe(EXAM_WEIGHTS[Number(id) as ObjectiveId]);
    }
    const b = buildExam(QUESTIONS, FULL_EXAM_SIZE, seeded(2));
    expect(b.map((q) => q.id)).not.toEqual(a.map((q) => q.id));
    // determinista con la misma semilla
    expect(buildExam(QUESTIONS, FULL_EXAM_SIZE, seeded(1)).map((q) => q.id)).toEqual(a.map((q) => q.id));
  });

  it('buildExam escala el reparto a otros tamaños', () => {
    const e = buildExam(QUESTIONS, 20, seeded(3));
    expect(e).toHaveLength(20);
    const c = countBy(e);
    // el objetivo con más peso (4) recibe más preguntas que el de menos (1)
    expect(c[4]).toBeGreaterThan(c[1] ?? 0);
  });

  it('allocate redistribuye cuando un objetivo no tiene suficientes preguntas', () => {
    const r = allocate(10, { 1: 5, 2: 5 }, { 1: 2, 2: 20 });
    expect(r).toEqual({ 1: 2, 2: 8 });
    expect(allocate(100, { 1: 1, 2: 1 }, { 1: 3, 2: 4 })).toEqual({ 1: 3, 2: 4 });
  });

  it('buildPractice solo usa los objetivos elegidos', () => {
    const p = buildPractice(QUESTIONS, [6, 7], 12, seeded(4));
    expect(p).toHaveLength(12);
    expect(p.every((q) => q.objective === 6 || q.objective === 7)).toBe(true);
    const all = buildPractice(QUESTIONS, [1], 999, seeded(5));
    expect(all).toHaveLength(QUESTIONS.filter((q) => q.objective === 1).length);
  });

  it('isCorrect exige exactamente las respuestas correctas', () => {
    const q = QUESTIONS.find((x) => x.kind === 'multi')!;
    expect(isCorrect(q, q.correct)).toBe(true);
    expect(isCorrect(q, [...q.correct].reverse())).toBe(true);
    expect(isCorrect(q, q.correct.slice(0, 1))).toBe(false);
    expect(isCorrect(q, undefined)).toBe(false);
  });
});
