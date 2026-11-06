import { getSchema, hex, type ResourceSchema } from './providers';
import { cloneState, type InstanceState, type TfState } from './state';
import { cloneValue, deepEqual, fromJson, isMap, toJson, type Value, type ValueMap } from './values';

/**
 * La "nube real" del simulador.
 *
 * Terraform solo conoce el estado (terraform.tfstate). La nube real es el estado
 * más los cambios hechos fuera de Terraform (desde la consola web, scripts…):
 *  - modified: atributos cambiados a mano en recursos que Terraform gestiona
 *  - deleted:  recursos gestionados que alguien borró a mano
 *  - unmanaged: recursos creados a mano que Terraform no conoce (candidatos a import)
 * Todo se indexa por el id del objeto en la nube, como haría el proveedor.
 */
export interface CloudObject {
  type: string;
  attributes: ValueMap;
}

export interface CloudChanges {
  modified: Record<string, ValueMap>;
  deleted: string[];
  unmanaged: Record<string, CloudObject>;
}

export const emptyCloud = (): CloudChanges => ({ modified: {}, deleted: [], unmanaged: {} });

export const hasOutOfBand = (c: CloudChanges) => Object.keys(c.modified).length > 0 || c.deleted.length > 0;

/** Cambio detectado por el refresh: el objeto real ya no coincide con el estado. */
export interface DriftChange {
  addr: string;
  type: string;
  name: string;
  module?: string;
  action: 'update' | 'delete';
  id: string;
  diffs: { name: string; before: Value | undefined; after: Value | undefined }[];
  before: ValueMap;
}

const idOf = (i: InstanceState) => (typeof i.attributes.id === 'string' ? i.attributes.id : '');

/**
 * Refresh: lee cada recurso gestionado de la nube real y actualiza la copia del estado.
 * Devuelve el estado actualizado y la lista de cambios hechos fuera de Terraform.
 */
export function refreshState(prior: TfState, cloud: CloudChanges): { state: TfState; drift: DriftChange[] } {
  const state = cloneState(prior);
  const drift: DriftChange[] = [];
  for (const inst of Object.values(state.resources)) {
    if (inst.mode !== 'managed') continue;
    const id = idOf(inst);
    if (!id) continue;
    const base = { addr: inst.addr, type: inst.type, name: inst.name, module: inst.module, id, before: prior.resources[inst.addr].attributes };
    if (cloud.deleted.includes(id)) {
      delete state.resources[inst.addr];
      drift.push({ ...base, action: 'delete', diffs: [] });
      continue;
    }
    const mods = cloud.modified[id];
    if (!mods) continue;
    const diffs: DriftChange['diffs'] = [];
    for (const [k, v] of Object.entries(mods)) {
      if (deepEqual(inst.attributes[k], v)) continue;
      diffs.push({ name: k, before: inst.attributes[k], after: v });
      inst.attributes[k] = cloneValue(v);
    }
    if (diffs.length) drift.push({ ...base, action: 'update', diffs });
  }
  return { state, drift: drift.sort((a, b) => a.addr.localeCompare(b.addr)) };
}

/** Tras un refresh completo, el estado coincide con la nube: los cambios manuales quedan absorbidos. */
export function afterRefresh(cloud: CloudChanges): CloudChanges {
  return { modified: {}, deleted: [], unmanaged: cloud.unmanaged };
}

// ------------------------------------------------------------ vista de la nube real

export type CloudStatus = 'managed' | 'drifted' | 'deleted' | 'unmanaged';

export interface CloudEntry {
  id: string;
  type: string;
  /** Dirección en el estado (solo si Terraform lo gestiona). */
  addr?: string;
  status: CloudStatus;
  attributes: ValueMap;
  /** Atributos cambiados a mano. */
  changed: string[];
}

/** Lista los objetos que existen (o existían) en la nube, con su relación con Terraform. */
export function cloudEntries(state: TfState, cloud: CloudChanges): CloudEntry[] {
  const out: CloudEntry[] = [];
  for (const inst of Object.values(state.resources)) {
    if (inst.mode !== 'managed' || !idOf(inst)) continue;
    const id = idOf(inst);
    if (cloud.deleted.includes(id)) {
      out.push({ id, type: inst.type, addr: inst.addr, status: 'deleted', attributes: inst.attributes, changed: [] });
      continue;
    }
    const mods = cloud.modified[id] ?? {};
    const changed = Object.keys(mods).filter((k) => !deepEqual(inst.attributes[k], mods[k]));
    out.push({ id, type: inst.type, addr: inst.addr, status: changed.length ? 'drifted' : 'managed', attributes: { ...inst.attributes, ...mods }, changed });
  }
  for (const [id, o] of Object.entries(cloud.unmanaged)) out.push({ id, type: o.type, status: 'unmanaged', attributes: o.attributes, changed: [] });
  // Primero lo que gestiona Terraform (por dirección), después lo creado a mano (por id).
  return out.sort((a, b) => Number(!a.addr) - Number(!b.addr) || (a.addr ?? a.id).localeCompare(b.addr ?? b.id, 'en', { numeric: true }));
}

// ------------------------------------------------------------ cambios manuales ("consola web")

export class CloudError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

/** Busca un objeto por id o por dirección de Terraform. */
function locate(state: TfState, cloud: CloudChanges, ref: string): { id: string; type: string; inst?: InstanceState } {
  const inst = state.resources[ref] ?? Object.values(state.resources).find((r) => r.mode === 'managed' && idOf(r) === ref);
  if (inst && inst.mode === 'managed' && idOf(inst) && !cloud.deleted.includes(idOf(inst))) return { id: idOf(inst), type: inst.type, inst };
  if (cloud.unmanaged[ref]) return { id: ref, type: cloud.unmanaged[ref].type };
  throw new CloudError(`ResourceNotFound: no existe ningún objeto "${ref}" en la nube`, 'Usa "cloud ls" para ver los ids de los objetos que existen.');
}

/** Convierte "t3.large", "true", "8" o '["a","b"]' al tipo que espera el argumento. */
function parseArg(schema: ResourceSchema, name: string, raw: string): Value {
  const spec = schema.args[name];
  if (!spec) {
    throw new CloudError(`InvalidParameter: ${schema.type} no tiene el atributo "${name}"`, `Atributos modificables: ${editableArgs(schema).join(', ')}`);
  }
  switch (spec.type) {
    case 'number':
      if (raw.trim() === '' || isNaN(Number(raw))) throw new CloudError(`InvalidParameterValue: "${name}" debe ser un número`);
      return Number(raw);
    case 'bool':
      if (raw !== 'true' && raw !== 'false') throw new CloudError(`InvalidParameterValue: "${name}" debe ser true o false`);
      return raw === 'true';
    case 'list':
      try {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) return fromJson(v);
      } catch {
        /* se trata como lista de un elemento */
      }
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    case 'map':
      throw new CloudError(`Para cambiar "${name}" indica la clave: ${name}.Clave=valor`);
    default:
      return raw;
  }
}

const editableArgs = (schema: ResourceSchema) => Object.entries(schema.args).filter(([, s]) => s.type !== 'block' && !s.forceNew).map(([n]) => n);

function parseAssignments(args: string[]): [string, string][] {
  return args.map((a) => {
    const eq = a.indexOf('=');
    if (eq < 1) throw new CloudError(`Formato inválido "${a}": usa atributo=valor`);
    return [a.slice(0, eq), a.slice(eq + 1)] as [string, string];
  });
}

/** Aplica "atributo=valor" (o "tags.Clave=valor", o "tags.Clave=" para borrar la etiqueta) a unos atributos. */
function applyAssignments(schema: ResourceSchema, attrs: ValueMap, assigns: [string, string][], allowForceNew: boolean): ValueMap {
  const out: ValueMap = { ...attrs };
  for (const [k, raw] of assigns) {
    const dot = k.indexOf('.');
    if (dot > 0) {
      const mapName = k.slice(0, dot);
      const key = k.slice(dot + 1);
      if (schema.args[mapName]?.type !== 'map') throw new CloudError(`InvalidParameter: "${mapName}" no es un mapa`);
      const m: ValueMap = isMap(out[mapName]) ? { ...(out[mapName] as ValueMap) } : {};
      if (raw === '') delete m[key];
      else m[key] = raw;
      out[mapName] = m;
      continue;
    }
    if (!allowForceNew && schema.args[k]?.forceNew) {
      throw new CloudError(
        `OperationNotPermitted: "${k}" no se puede cambiar en un ${schema.title} existente`,
        `En la nube real tampoco se puede: por eso Terraform marca "${k}" como "forces replacement". Atributos modificables: ${editableArgs(schema).join(', ')}`,
      );
    }
    out[k] = parseArg(schema, k, raw);
  }
  return out;
}

/** cloud modify <id|dirección> atributo=valor … */
export function cloudModify(state: TfState, cloud: CloudChanges, ref: string, rawAssigns: string[]): { cloud: CloudChanges; id: string; type: string } {
  const { id, type, inst } = locate(state, cloud, ref);
  const schema = getSchema('managed', type)!;
  if (!rawAssigns.length) throw new CloudError('Indica qué cambiar: cloud modify <id> atributo=valor', `Atributos modificables: ${editableArgs(schema).join(', ')}`);
  const assigns = parseAssignments(rawAssigns);
  const next: CloudChanges = { ...cloud, modified: { ...cloud.modified }, unmanaged: { ...cloud.unmanaged } };
  if (inst) {
    const current = { ...inst.attributes, ...(cloud.modified[id] ?? {}) };
    const updated = applyAssignments(schema, current, assigns, false);
    const mods: ValueMap = {};
    for (const [k, v] of Object.entries(updated)) if (!deepEqual(inst.attributes[k], v)) mods[k] = v;
    if (Object.keys(mods).length) next.modified[id] = mods;
    else delete next.modified[id];
  } else {
    const o = cloud.unmanaged[id];
    next.unmanaged[id] = { ...o, attributes: applyAssignments(schema, o.attributes, assigns, false) };
  }
  return { cloud: next, id, type };
}

/** cloud delete <id|dirección> */
export function cloudDelete(state: TfState, cloud: CloudChanges, ref: string): { cloud: CloudChanges; id: string; type: string; addr?: string } {
  const { id, type, inst } = locate(state, cloud, ref);
  // Como en AWS: no se puede borrar algo que otro recurso está usando.
  const user = cloudEntries(state, cloud).find((e) => e.id !== id && e.status !== 'deleted' && refersTo(e.attributes, id));
  if (user) {
    throw new CloudError(
      `DependencyViolation: ${id} está en uso por ${user.addr ?? user.id}`,
      'La nube no deja borrar un recurso del que dependen otros. Borra antes los que dependen de él.',
    );
  }
  const next: CloudChanges = { ...cloud, modified: { ...cloud.modified }, unmanaged: { ...cloud.unmanaged }, deleted: [...cloud.deleted] };
  if (inst) {
    next.deleted.push(id);
    delete next.modified[id];
  } else delete next.unmanaged[id];
  return { cloud: next, id, type, addr: inst?.addr };
}

function refersTo(v: Value | undefined, id: string): boolean {
  if (v === id) return true;
  if (Array.isArray(v)) return v.some((x) => refersTo(x, id));
  if (isMap(v)) return Object.entries(v).some(([k, x]) => k !== 'id' && k !== 'arn' && refersTo(x, id));
  return false;
}

/** cloud create <tipo> atributo=valor … → crea un objeto que Terraform no gestiona. */
export function cloudCreate(state: TfState, cloud: CloudChanges, type: string, rawAssigns: string[], region = 'eu-west-1'): { cloud: CloudChanges; id: string } {
  const schema = getSchema('managed', type);
  if (!schema || !schema.generate || !type.startsWith('aws_')) {
    throw new CloudError(`InvalidResourceType: "${type}"`, 'Desde la consola puedes crear recursos de AWS, p.ej. aws_s3_bucket, aws_instance, aws_vpc.');
  }
  let attrs: ValueMap = {};
  for (const [n, s] of Object.entries(schema.args)) attrs[n] = s.type === 'block' ? [] : s.default ?? null;
  attrs = applyAssignments(schema, attrs, parseAssignments(rawAssigns), true);
  for (const [n, s] of Object.entries(schema.args)) {
    if (s.required && (attrs[n] === null || attrs[n] === undefined)) {
      throw new CloudError(`MissingParameter: falta "${n}" (${s.description})`, `Ejemplo: cloud create ${type} ${n}=...`);
    }
  }
  const msg = schema.validate?.(attrs, { region });
  if (msg) throw new CloudError(msg);
  const all = cloudEntries(state, cloud)
    .filter((e) => e.status !== 'deleted')
    .map((e) => ({ id: e.id, addr: e.addr ?? e.id, type: e.type, attributes: e.attributes }));
  const generated = schema.generate(attrs, {
    region,
    addr: `${type}.consola`,
    findById: (id) => all.find((e) => e.id === id),
    all: () => all,
  });
  const value = { ...attrs, ...generated };
  const id = String(value.id ?? `${type}-${hex(8)}`);
  if (all.some((e) => e.id === id)) throw new CloudError(`AlreadyExists: ya existe un objeto con id "${id}"`);
  return { cloud: { ...cloud, unmanaged: { ...cloud.unmanaged, [id]: { type, attributes: value } } }, id };
}

/** Cuando Terraform "olvida" un recurso (state rm), el objeto sigue existiendo en la nube sin gestionar. */
export function forgetInstance(cloud: CloudChanges, inst: InstanceState): CloudChanges {
  const id = idOf(inst);
  if (!id || inst.mode !== 'managed' || cloud.deleted.includes(id)) return cloud;
  const modified = { ...cloud.modified };
  const attributes = { ...inst.attributes, ...(modified[id] ?? {}) };
  delete modified[id];
  return { ...cloud, modified, unmanaged: { ...cloud.unmanaged, [id]: { type: inst.type, attributes } } };
}

// ------------------------------------------------------------ persistencia

export function serializeCloud(c: CloudChanges): string {
  return JSON.stringify({
    modified: Object.fromEntries(Object.entries(c.modified).map(([k, v]) => [k, toJson(v)])),
    deleted: c.deleted,
    unmanaged: Object.fromEntries(Object.entries(c.unmanaged).map(([k, o]) => [k, { type: o.type, attributes: toJson(o.attributes) }])),
  });
}

export function deserializeCloud(raw: string | undefined): CloudChanges {
  if (!raw) return emptyCloud();
  try {
    const p = JSON.parse(raw);
    return {
      modified: Object.fromEntries(Object.entries(p.modified ?? {}).map(([k, v]) => [k, fromJson(v) as ValueMap])),
      deleted: Array.isArray(p.deleted) ? p.deleted : [],
      unmanaged: Object.fromEntries(
        Object.entries((p.unmanaged ?? {}) as Record<string, { type: string; attributes: unknown }>).map(([k, o]) => [k, { type: o.type, attributes: fromJson(o.attributes) as ValueMap }]),
      ),
    };
  } catch {
    return emptyCloud();
  }
}
