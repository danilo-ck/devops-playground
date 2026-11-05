import { describe, expect, it } from 'vitest';
import { apply, buildGraph, emptyState, loadConfig, plan } from '../../engine';
import { terraformLessons } from '..';

describe('lecciones de Terraform', () => {
  for (const lesson of terraformLessons) {
    describe(lesson.id, () => {
      const base = lesson.setup ? apply(lesson.setup, emptyState()) : null;
      const start = base?.state ?? emptyState();

      it('el código inicial no tiene errores de sintaxis', () => {
        const cfg = loadConfig(lesson.files);
        expect(cfg.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      });

      if (lesson.setup) {
        it('la infraestructura inicial se despliega', () => {
          expect(base!.ok).toBe(true);
          expect(plan(lesson.files, start).changes.every((c) => c.action === 'noop')).toBe(true);
        });
      }

      if (lesson.solution) {
        it('la solución se aplica sin errores', () => {
          const r = apply(lesson.solution!, start);
          expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
          expect(r.ok).toBe(true);
          // y es estable: un segundo plan no propone cambios
          const p = plan(lesson.solution!, r.state);
          expect(p.changes.filter((c) => c.action !== 'noop')).toEqual([]);
        });

        it('los objetivos que dependen solo del código y el estado se cumplen con la solución', () => {
          const r = apply(lesson.solution!, start);
          const config = loadConfig(lesson.solution!);
          const ctx = {
            files: lesson.solution!,
            state: r.state,
            initialized: ['aws', 'random', 'local'],
            config,
            graph: buildGraph(config),
            history: [
              { command: 'init', ok: true, at: 1 },
              { command: 'plan', ok: true, at: 2, summary: r.summary },
              { command: 'apply', ok: true, at: 3, summary: r.summary, actions: ['create', 'update', 'replace'] as never },
              { command: 'console-eval', ok: true, at: 4 },
            ],
          };
          const failing = lesson.objectives.filter((o) => !o.check(ctx)).map((o) => o.id);
          // lección 4 requiere un destroy fallido; no se puede deducir solo del apply
          expect(failing.filter((id) => !(lesson.id === 'ciclo-de-vida' && id === 'refuse'))).toEqual([]);
        });
      }
    });
  }
});
