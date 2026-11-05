/**
 * Modelo de valores del lenguaje HCL simulado.
 *
 * `Unknown` representa un valor que solo se conocerá tras el apply
 * ("(known after apply)"). Guarda opcionalmente la dirección de la
 * instancia que lo producirá, lo que permite a la vista de infraestructura
 * saber, por ejemplo, en qué VPC (todavía no creada) vivirá una subred.
 */
export class Unknown {
  constructor(public readonly source?: string) {}
  toString() {
    return '(known after apply)';
  }
}

export type Value = string | number | boolean | null | Unknown | Value[] | ValueMap;
export interface ValueMap {
  [key: string]: Value;
}

export const isUnknown = (v: unknown): v is Unknown => v instanceof Unknown;

export const isMap = (v: unknown): v is ValueMap =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Unknown);

const sets = new WeakSet<Value[]>();
/** Marca una lista como `set` (necesario para for_each). */
export function markSet(a: Value[]): Value[] {
  sets.add(a);
  return a;
}
export const isSet = (v: unknown): boolean => Array.isArray(v) && sets.has(v);

export function containsUnknown(v: Value | undefined): boolean {
  if (v === undefined) return false;
  if (isUnknown(v)) return true;
  if (Array.isArray(v)) return v.some(containsUnknown);
  if (isMap(v)) return Object.values(v).some(containsUnknown);
  return false;
}

export function deepEqual(a: Value | undefined, b: Value | undefined): boolean {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  if (isUnknown(x) || isUnknown(y)) return false;
  if (Array.isArray(x)) {
    return Array.isArray(y) && x.length === y.length && x.every((item, i) => deepEqual(item, y[i]));
  }
  if (isMap(x)) {
    if (!isMap(y)) return false;
    const kx = Object.keys(x).filter((k) => x[k] !== null);
    const ky = Object.keys(y).filter((k) => y[k] !== null);
    return kx.length === ky.length && kx.every((k) => deepEqual(x[k], y[k]));
  }
  return x === y;
}

export function typeName(v: Value): string {
  if (v === null) return 'null';
  if (isUnknown(v)) return 'unknown';
  if (Array.isArray(v)) return isSet(v) ? 'set' : 'list';
  if (isMap(v)) return 'object';
  if (typeof v === 'boolean') return 'bool';
  return typeof v;
}

/** Copia profunda de un valor (los `Unknown` se comparten). */
export function cloneValue<T extends Value>(v: T): T {
  if (Array.isArray(v)) {
    const out = v.map(cloneValue);
    if (isSet(v)) markSet(out);
    return out as T;
  }
  if (isMap(v)) {
    const out: ValueMap = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneValue(val);
    return out as T;
  }
  return v;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Representación HCL de un valor, como la que muestra `terraform plan`. */
export function formatHcl(v: Value | undefined, sensitive = false): string {
  if (sensitive) return '(sensitive value)';
  if (v === undefined || v === null) return 'null';
  if (isUnknown(v)) return '(known after apply)';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${v.map((x) => formatHcl(x)).join(', ')}]`;
  }
  const entries = Object.entries(v).filter(([, val]) => val !== null);
  if (entries.length === 0) return '{}';
  return `{ ${entries
    .map(([k, val]) => `${IDENT_RE.test(k) ? k : JSON.stringify(k)} = ${formatHcl(val)}`)
    .join(', ')} }`;
}

/** Convierte a JSON plano (para el fichero de estado). */
export function toJson(v: Value): unknown {
  if (isUnknown(v)) return '(known after apply)';
  if (Array.isArray(v)) return v.map(toJson);
  if (isMap(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = toJson(val);
    return out;
  }
  return v;
}

export function fromJson(v: unknown): Value {
  if (Array.isArray(v)) return v.map(fromJson);
  if (v && typeof v === 'object') {
    const out: ValueMap = {};
    for (const [k, val] of Object.entries(v)) out[k] = fromJson(val);
    return out;
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return null;
}
