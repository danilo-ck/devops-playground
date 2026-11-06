import { apply, cloudCreate, cloudDelete, cloudModify, emptyCloud, emptyState, loadConfig, requiredProviderNames, type CloudChanges, type TfState } from '../engine';
import type { TerraformLesson } from './types';

/** Punto de partida de una lección: infraestructura desplegada (setup) y cambios hechos "a mano" (drift). */
export function lessonStart(lesson: TerraformLesson): { state: TfState; initialized: string[]; cloud: CloudChanges } {
  let state = emptyState();
  let initialized: string[] = [];
  let cloud = emptyCloud();
  if (lesson.setup) {
    const r = apply(lesson.setup, state);
    if (r.ok) state = { ...r.state, serial: 1 };
    initialized = requiredProviderNames(loadConfig(lesson.setup));
  }
  for (const [p, v] of Object.entries(lesson.locks ?? {})) initialized.push(`lock:${p}=${v}`);
  const d = lesson.drift;
  if (d) {
    for (const [addr, assigns] of Object.entries(d.modify ?? {})) cloud = cloudModify(state, cloud, addr, assigns).cloud;
    for (const addr of d.delete ?? []) cloud = cloudDelete(state, cloud, addr).cloud;
    for (const c of d.create ?? []) cloud = cloudCreate(state, cloud, c.type, c.args).cloud;
  }
  return { state, initialized, cloud };
}
