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
