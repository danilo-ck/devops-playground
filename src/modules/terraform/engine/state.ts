import { PROVIDERS, providerOf } from './providers';
import { cloneValue, fromJson, toJson, type Value, type ValueMap } from './values';

export interface InstanceState {
  /** aws_instance.web[0] */
  addr: string;
  /** aws_instance.web */
  resourceAddr: string;
  /** Módulo al que pertenece (module.red) o undefined en la raíz. */
  module?: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  indexKey?: string | number;
  attributes: ValueMap;
  sensitiveAttrs: string[];
  dependencies: string[];
  /** terraform taint (o un create fallido): se reemplazará en el próximo apply. */
  tainted?: boolean;
}

export interface TfState {
  serial: number;
  lineage: string;
  resources: Record<string, InstanceState>;
  outputs: Record<string, { value: Value; sensitive: boolean }>;
}

export const emptyState = (): TfState => ({
  serial: 0,
  lineage: crypto.randomUUID ? crypto.randomUUID() : `lineage-${Date.now()}`,
  resources: {},
  outputs: {},
});

export function cloneState(s: TfState): TfState {
  const resources: Record<string, InstanceState> = {};
  for (const [k, r] of Object.entries(s.resources))
    resources[k] = { ...r, attributes: cloneValue(r.attributes), dependencies: [...r.dependencies], sensitiveAttrs: [...r.sensitiveAttrs] };
  const outputs: TfState['outputs'] = {};
  for (const [k, o] of Object.entries(s.outputs)) outputs[k] = { ...o, value: cloneValue(o.value) };
  return { ...s, resources, outputs };
}

export const managedInstances = (s: TfState) => Object.values(s.resources).filter((r) => r.mode === 'managed');

export function instanceAddr(resourceAddr: string, key?: string | number): string {
  if (key === undefined) return resourceAddr;
  return typeof key === 'number' ? `${resourceAddr}[${key}]` : `${resourceAddr}[${JSON.stringify(key)}]`;
}

/** Representación tipo terraform.tfstate (v4) para mostrar al usuario. */
export function toTfStateJson(s: TfState): unknown {
  const groups = new Map<string, InstanceState[]>();
  for (const r of Object.values(s.resources)) {
    if (!groups.has(r.resourceAddr)) groups.set(r.resourceAddr, []);
    groups.get(r.resourceAddr)!.push(r);
  }
  const outputs: Record<string, unknown> = {};
  for (const [k, o] of Object.entries(s.outputs)) outputs[k] = { value: toJson(o.value), type: typeof o.value, ...(o.sensitive ? { sensitive: true } : {}) };
  return {
    version: 4,
    terraform_version: '1.9.8',
    serial: s.serial,
    lineage: s.lineage,
    outputs,
    resources: [...groups.values()].map((insts) => {
      const r = insts[0];
      const p = PROVIDERS[providerOf(r.type)];
      return {
        ...(r.module ? { module: r.module } : {}),
        mode: r.mode,
        type: r.type,
        name: r.name,
        provider: `provider["registry.terraform.io/${p?.source ?? 'hashicorp/' + providerOf(r.type)}"]`,
        instances: insts.map((i) => ({
          ...(i.indexKey !== undefined ? { index_key: i.indexKey } : {}),
          ...(i.tainted ? { status: 'tainted' } : {}),
          schema_version: 0,
          attributes: toJson(i.attributes),
          ...(i.sensitiveAttrs.length ? { sensitive_attributes: i.sensitiveAttrs } : {}),
          ...(i.dependencies.length ? { dependencies: i.dependencies } : {}),
        })),
      };
    }),
  };
}

/** Serialización compacta para persistir en localStorage. */
export function serializeState(s: TfState): string {
  return JSON.stringify({
    ...s,
    resources: Object.fromEntries(Object.entries(s.resources).map(([k, r]) => [k, { ...r, attributes: toJson(r.attributes) }])),
    outputs: Object.fromEntries(Object.entries(s.outputs).map(([k, o]) => [k, { ...o, value: toJson(o.value) }])),
  });
}

export function deserializeState(raw: string): TfState {
  const s = JSON.parse(raw);
  for (const r of Object.values(s.resources) as InstanceState[]) r.attributes = fromJson(r.attributes) as ValueMap;
  for (const o of Object.values(s.outputs) as { value: Value }[]) o.value = fromJson(o.value);
  return s as TfState;
}

// ------------------------------------------------------------ renombrar (state mv / moved)

const parseInstance = (addr: string) => {
  const m = /^(.*?)(\[(?:\d+|"[^"]*")\])?$/.exec(addr)!;
  return { base: m[1], index: m[2] };
};
const keyOfIndex = (index?: string): string | number | undefined =>
  index === undefined ? undefined : index.startsWith('["') ? index.slice(2, -2) : Number(index.slice(1, -1));

/** Renombra un recurso, una instancia o un módulo entero dentro del estado. Devuelve los pares movidos. */
export function moveInState(state: TfState, from: string, to: string): { from: string; to: string }[] {
  const moves: { from: string; to: string }[] = [];
  const isModule = (a: string) => /^(module\.[^.[\]]+\.?)+$/.test(a) && !/\.(aws|random|local)_/.test(a);
  const all = Object.values(state.resources);
  let picked: [InstanceState, string][] = [];
  if (isModule(from) && isModule(to)) {
    const fp = from + '.';
    picked = all.filter((r) => r.addr.startsWith(fp)).map((r) => [r, to + '.' + r.addr.slice(fp.length)]);
  } else {
    const f = parseInstance(from);
    const t = parseInstance(to);
    if (f.index) picked = all.filter((r) => r.addr === from).map((r) => [r, to]);
    else picked = all.filter((r) => r.resourceAddr === from).map((r) => [r, t.index ? to : to + r.addr.slice(r.resourceAddr.length)]);
  }
  for (const [r] of picked) delete state.resources[r.addr];
  for (const [r, nextAddr] of picked) {
    const { base, index } = parseInstance(nextAddr);
    const mod = /^((?:module\.[^.]+\.)*)/.exec(base)![1];
    const local = base.slice(mod.length).split('.');
    const name = local[local.length - 1];
    state.resources[nextAddr] = { ...r, addr: nextAddr, resourceAddr: base, module: mod ? mod.slice(0, -1) : undefined, name, indexKey: keyOfIndex(index) };
    moves.push({ from: r.addr, to: nextAddr });
  }
  return moves;
}

/** Aplica los bloques moved al estado (antes del refresh), como hace terraform plan. */
export function applyMoves(prior: TfState, moved: { from: string; to: string }[]): { state: TfState; moves: { from: string; to: string }[]; warnings: string[] } {
  if (!moved.length) return { state: prior, moves: [], warnings: [] };
  const state = cloneState(prior);
  const moves: { from: string; to: string }[] = [];
  const warnings: string[] = [];
  for (const m of moved) {
    const exists = (a: string) => Object.values(state.resources).some((r) => r.addr === a || r.resourceAddr === a || r.addr.startsWith(a + '.') || r.addr.startsWith(a + '['));
    if (!exists(m.from)) continue; // ya movido en un apply anterior
    if (exists(m.to)) {
      warnings.push(`Cannot move ${m.from} to ${m.to}: the target already exists in the state.`);
      continue;
    }
    moves.push(...moveInState(state, m.from, m.to));
  }
  return { state, moves, warnings };
}
