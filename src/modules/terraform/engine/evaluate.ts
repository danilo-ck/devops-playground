import { afterRefresh, emptyCloud, refreshState, type CloudChanges, type CloudObject, type DriftChange } from './cloud';
import { findResource, hasErrors, loadConfig, moduleConfigs, splitAddr, type Condition, type Config, type Diagnostic, type InstalledModules, type ResourceConfig } from './config';
import { callFunction, FunctionError } from './functions';
import { buildGraph, nodePrefix, resourceDependencies, type DepGraph } from './graph';
import { parseExpressionSource, parseHcl, type Body, type Expr } from './parser';
import { getSchema, providerOf, type ArgSpec, type GenCtx, type ResourceSchema } from './providers';
import { applyMoves, cloneState, instanceAddr, type InstanceState, type TfState } from './state';
import {
  cloneValue,
  containsUnknown,
  deepEqual,
  isMap,
  isSet,
  isUnknown,
  markSet,
  typeName,
  Unknown,
  type Value,
  type ValueMap,
} from './values';

// ------------------------------------------------------------ tipos públicos

export type Action = 'create' | 'update' | 'replace' | 'delete' | 'noop' | 'read';

export interface AttrDiff {
  name: string;
  before: Value | undefined;
  after: Value | undefined;
  forcesReplacement: boolean;
}

export interface ResourceChange {
  addr: string;
  resourceAddr: string;
  /** Módulo al que pertenece (module.red) o undefined en la raíz. */
  module?: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  indexKey?: string | number;
  action: Action;
  before: ValueMap | null;
  after: ValueMap | null;
  diffs: AttrDiff[];
  replaceReasons: string[];
  sensitiveAttrs: string[];
  createBeforeDestroy: boolean;
  /** Si el recurso se va a importar en este plan: id del objeto real. */
  importing?: string;
  /** Dirección anterior si un bloque moved lo ha renombrado. */
  movedFrom?: string;
  /** Reemplazo forzado: -replace=… o recurso tainted. */
  reason?: 'requested' | 'tainted';
  /** Atributos write-only enviados en este plan (nunca se guardan). */
  writeOnlyAttrs?: string[];
  /** Región de AWS donde vive (según su configuración de proveedor). */
  region?: string;
}

export interface OutputChange {
  name: string;
  action: 'create' | 'update' | 'delete' | 'noop';
  before?: Value;
  after?: Value;
  sensitive: boolean;
}

export interface PlanSummary {
  add: number;
  change: number;
  destroy: number;
  import: number;
}

export interface PlanResult {
  ok: boolean;
  destroy: boolean;
  /** terraform plan -refresh-only: solo sincroniza el estado con la nube real. */
  refreshOnly: boolean;
  /** Cambios hechos fuera de Terraform que ha detectado el refresh. */
  drift: DriftChange[];
  /** Estado tras el refresh y los imports: el punto de partida del apply. */
  base: TfState;
  /** Renombrados por bloques moved (direcciones de instancia). */
  moves: { from: string; to: string }[];
  diagnostics: Diagnostic[];
  config: Config;
  graph: DepGraph | null;
  changes: ResourceChange[];
  outputChanges: OutputChange[];
  outputs: Record<string, { value: Value; sensitive: boolean }>;
  summary: PlanSummary;
}

export type Phase = 'creating' | 'modifying' | 'destroying' | 'reading' | 'importing';

export interface ApplyEvent {
  kind: 'start' | 'complete' | 'error';
  addr: string;
  phase: Phase;
  id?: string;
  seconds: number;
  message?: string;
  state: TfState;
}

export interface ApplyResult extends PlanResult {
  state: TfState;
  events: ApplyEvent[];
  applied: boolean;
  /** Cambios fuera de Terraform que siguen pendientes tras el apply. */
  cloud: CloudChanges;
  /** Avisos que aparecen durante el apply (p.ej. check blocks evaluados con valores reales). */
  applyWarnings: Diagnostic[];
}

export interface RunOptions {
  /** Valores pasados con -var "nombre=valor". */
  cliVars?: Record<string, string>;
  /** Versiones de módulos instaladas por terraform init. */
  modules?: InstalledModules;
  destroy?: boolean;
  /** Cambios hechos fuera de Terraform (la "nube real"). */
  cloud?: CloudChanges;
  /** false = -refresh=false: no consulta la nube real antes de planificar. */
  refresh?: boolean;
  /** -refresh-only: solo actualiza el estado con lo que hay en la nube. */
  refreshOnly?: boolean;
  /** Variables de entorno (TF_VAR_nombre). */
  env?: Record<string, string>;
  /** Ficheros pasados con -var-file, en orden. */
  varFiles?: string[];
  /** Workspace actual (terraform.workspace). */
  workspace?: string;
  /** -replace=dirección: fuerza el reemplazo de esas instancias. */
  replace?: string[];
}

// ------------------------------------------------------------ evaluación de expresiones

export class EvalError extends Error {
  constructor(
    message: string,
    public line?: number,
    public hint?: string,
    public detail?: string,
  ) {
    super(message);
  }
}

interface Scope {
  vars: ValueMap;
  locals: ValueMap;
  resources: Record<string, ValueMap>;
  /** Outputs de los módulos hijos: module.<nombre>.<output> */
  modules: Record<string, ValueMap>;
  data: Record<string, ValueMap>;
  count?: { index: number };
  each?: { key: Value; value: Value };
  bound: Record<string, Value>;
  splatItem?: Value;
  workspace?: string;
}

const emptyScope = (): Scope => ({ vars: {}, locals: {}, resources: {}, data: {}, modules: {}, bound: {} });

const toNum = (v: Value, line: number): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  throw new EvalError(`Invalid operand: a number is required (recibido ${typeName(v)})`, line, 'Las operaciones aritméticas solo funcionan con números.');
};

const toBool = (v: Value, line: number): boolean => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'false') return v === 'true';
  throw new EvalError(`Invalid operand: a bool is required (recibido ${typeName(v)})`, line);
};

const templateString = (v: Value, line: number): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null)
    throw new EvalError('Invalid template interpolation value: the expression result is null', line, 'Estás interpolando un valor nulo dentro de un string.');
  throw new EvalError(
    `Invalid template interpolation value: cannot include a ${typeName(v)} in a string template`,
    line,
    'Solo se pueden interpolar strings, números o booleanos. Para listas usa join(", ", lista).',
  );
};

export function evalExpr(e: Expr, s: Scope): Value {
  switch (e.kind) {
    case 'literal':
      return e.value;
    case 'splatItem':
      return s.splatItem ?? null;
    case 'template': {
      let out = '';
      for (const p of e.parts) {
        if (typeof p === 'string') {
          out += p;
          continue;
        }
        const v = evalExpr(p, s);
        if (isUnknown(v)) return new Unknown();
        out += templateString(v, p.line);
      }
      return out;
    }
    case 'variable': {
      if (e.name in s.bound) return s.bound[e.name];
      switch (e.name) {
        case 'var':
          return s.vars;
        case 'local':
          return s.locals;
        case 'data':
          return s.data;
        case 'count':
          if (!s.count)
            throw new EvalError('Reference to "count" in non-counted context', e.line, 'count.index solo puede usarse dentro de un recurso que tenga el argumento count.');
          return { index: s.count.index };
        case 'each':
          if (!s.each)
            throw new EvalError('each.value cannot be used in this context', e.line, 'each.key y each.value solo pueden usarse dentro de un recurso con for_each.');
          return { key: s.each.key, value: s.each.value };
        case 'path':
          return { module: '.', root: '.', cwd: '/workspace' };
        case 'module':
          return s.modules;
        case 'terraform':
          return { workspace: s.workspace ?? 'default' };
      }
      if (e.name in s.resources) return s.resources[e.name];
      throw new EvalError(`Invalid reference: "${e.name}"`, e.line, 'Una referencia a un recurso necesita tipo y nombre, p.ej. aws_vpc.main.id. Si es un texto, ponlo entre comillas.');
    }
    case 'getattr': {
      const t = evalExpr(e.target, s);
      if (isUnknown(t)) return t;
      if (t === null) throw new EvalError(`Attempt to get attribute "${e.name}" from null value`, e.line);
      if (Array.isArray(t))
        throw new EvalError(
          `Unsupported attribute: this value is a list, it has no attribute "${e.name}"`,
          e.line,
          `Este recurso tiene varias instancias (count/for_each). Indica cuál: [0].${e.name}, o todas con [*].${e.name}`,
        );
      if (isMap(t)) {
        if (!(e.name in t)) {
          const avail = Object.keys(t).slice(0, 14).join(', ');
          throw new EvalError(`Unsupported attribute: this object does not have an attribute named "${e.name}"`, e.line, avail ? `Atributos disponibles: ${avail}` : undefined);
        }
        const v = t[e.name];
        return v === undefined ? null : v;
      }
      throw new EvalError(`Unsupported attribute "${e.name}" on a ${typeName(t)} value`, e.line);
    }
    case 'index': {
      const t = evalExpr(e.target, s);
      const k = evalExpr(e.key, s);
      if (isUnknown(t) || isUnknown(k)) return new Unknown(isUnknown(t) ? t.source : undefined);
      if (Array.isArray(t)) {
        const i = toNum(k, e.line);
        if (i < 0 || i >= t.length)
          throw new EvalError(`Invalid index: the given index ${i} is out of range (la lista tiene ${t.length} elementos)`, e.line, 'Los índices empiezan en 0.');
        return t[i];
      }
      if (isMap(t)) {
        const key = String(k);
        if (!(key in t)) throw new EvalError(`Invalid index: the given key "${key}" does not exist`, e.line, `Claves disponibles: ${Object.keys(t).join(', ')}`);
        return t[key];
      }
      throw new EvalError(`Invalid index: cannot index a ${typeName(t)} value`, e.line);
    }
    case 'splat': {
      const t = evalExpr(e.target, s);
      if (isUnknown(t)) return t;
      if (t === null) return [];
      const items = Array.isArray(t) ? t : [t];
      return items.map((item) => evalExpr(e.chain, { ...s, splatItem: item }));
    }
    case 'call': {
      let args = e.args.map((a) => evalExpr(a, s));
      if (e.expand) {
        const last = args.pop();
        if (!Array.isArray(last)) throw new EvalError('Invalid expanding argument value: must be a list', e.line);
        args = [...args, ...last];
      }
      try {
        return callFunction(e.name, args);
      } catch (err) {
        if (err instanceof FunctionError) {
          throw new EvalError(
            err.message.startsWith('Call to unknown') ? err.message : `Error in function call ${e.name}(): ${err.message}`,
            e.line,
            err.message.startsWith('Call to unknown') ? 'Esa función no existe. Consulta el panel de funciones disponibles.' : undefined,
          );
        }
        throw err;
      }
    }
    case 'unary': {
      const v = evalExpr(e.operand, s);
      if (isUnknown(v)) return v;
      return e.op === '!' ? !toBool(v, e.line) : -toNum(v, e.line);
    }
    case 'binary': {
      const l = evalExpr(e.left, s);
      if (e.op === '&&' && l === false) return false;
      if (e.op === '||' && l === true) return true;
      const r = evalExpr(e.right, s);
      if (isUnknown(l) || isUnknown(r)) return new Unknown();
      switch (e.op) {
        case '==':
          return deepEqual(l, r);
        case '!=':
          return !deepEqual(l, r);
        case '&&':
          return toBool(l, e.line) && toBool(r, e.line);
        case '||':
          return toBool(l, e.line) || toBool(r, e.line);
        case '+':
          if (typeof l === 'string' && isNaN(Number(l)))
            throw new EvalError('Invalid operand: a number is required', e.line, 'En HCL "+" solo suma números. Para unir textos usa "${a}${b}" o format().');
          return toNum(l, e.line) + toNum(r, e.line);
        case '-':
          return toNum(l, e.line) - toNum(r, e.line);
        case '*':
          return toNum(l, e.line) * toNum(r, e.line);
        case '/':
          return toNum(l, e.line) / toNum(r, e.line);
        case '%':
          return toNum(l, e.line) % toNum(r, e.line);
        case '<':
          return toNum(l, e.line) < toNum(r, e.line);
        case '>':
          return toNum(l, e.line) > toNum(r, e.line);
        case '<=':
          return toNum(l, e.line) <= toNum(r, e.line);
        case '>=':
          return toNum(l, e.line) >= toNum(r, e.line);
      }
      throw new EvalError(`Operador desconocido ${e.op}`, e.line);
    }
    case 'conditional': {
      const c = evalExpr(e.cond, s);
      if (isUnknown(c)) return new Unknown();
      return toBool(c, e.line) ? evalExpr(e.then, s) : evalExpr(e.else, s);
    }
    case 'tuple':
      return e.items.map((i) => evalExpr(i, s));
    case 'object': {
      const out: ValueMap = {};
      for (const { key, value } of e.items) {
        const k = evalExpr(key, s);
        if (isUnknown(k)) return new Unknown();
        out[String(k)] = evalExpr(value, s);
      }
      return out;
    }
    case 'for': {
      const coll = evalExpr(e.coll, s);
      if (isUnknown(coll)) return new Unknown();
      let entries: [Value, Value][];
      if (Array.isArray(coll)) entries = coll.map((v, i) => [isSet(coll) ? v : i, v]);
      else if (isMap(coll)) entries = Object.entries(coll);
      else throw new EvalError(`Iteration over non-iterable value (${typeName(coll)})`, e.line, 'Un for necesita una lista, set o mapa.');
      const run = (k: Value, v: Value) => {
        const bound = { ...s.bound, [e.valVar]: v };
        if (e.keyVar) bound[e.keyVar] = k;
        return { ...s, bound };
      };
      if (e.isObject) {
        const out: ValueMap = {};
        for (const [k, v] of entries) {
          const sc = run(k, v);
          if (e.cond && evalExpr(e.cond, sc) !== true) continue;
          const key = evalExpr(e.keyExpr!, sc);
          if (isUnknown(key)) return new Unknown();
          const val = evalExpr(e.valExpr, sc);
          const ks = String(key);
          if (e.grouping) ((out[ks] ??= []) as Value[]).push(val);
          else {
            if (ks in out) throw new EvalError(`Duplicate object key "${ks}"`, e.line, 'Usa "..." tras el valor para agrupar valores con la misma clave.');
            out[ks] = val;
          }
        }
        return out;
      }
      const out: Value[] = [];
      for (const [k, v] of entries) {
        const sc = run(k, v);
        if (e.cond && evalExpr(e.cond, sc) !== true) continue;
        out.push(evalExpr(e.valExpr, sc));
      }
      return out;
    }
  }
}

// ------------------------------------------------------------ argumentos de recursos

function coerce(v: Value, spec: ArgSpec, name: string, line: number): Value {
  if (v === null || isUnknown(v)) return v;
  const bad = (want: string, hint?: string): never => {
    throw new EvalError(`Incorrect attribute value type: inappropriate value for attribute "${name}": ${want} required (recibido ${typeName(v)})`, line, hint);
  };
  switch (spec.type) {
    case 'string':
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (typeof v !== 'string') bad('string', 'Este argumento espera un texto entre comillas.');
      return v;
    case 'number':
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
      return bad('number', 'Este argumento espera un número (sin comillas).');
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      return bad('bool', 'Este argumento espera true o false.');
    case 'list':
      if (!Array.isArray(v)) bad('list', 'Este argumento espera una lista: ["valor1", "valor2"]');
      return v;
    case 'map':
      if (!isMap(v)) bad('map', 'Este argumento espera un mapa: { clave = "valor" }');
      return v;
    default:
      return v;
  }
}

function evalBody(body: Body, spec: Record<string, ArgSpec>, s: Scope): ValueMap {
  const out: ValueMap = {};
  for (const a of body.attributes) {
    const argSpec = spec[a.name];
    if (!argSpec || argSpec.type === 'block') continue;
    out[a.name] = coerce(evalExpr(a.expr, s), argSpec, a.name, a.line);
  }
  for (const b of body.blocks) {
    if (b.type === 'dynamic') {
      const label = b.labels[0];
      const bs = spec[label];
      const fe = b.body.attributes.find((a) => a.name === 'for_each');
      const content = b.body.blocks.find((x) => x.type === 'content');
      if (!bs || bs.type !== 'block' || !fe || !content) continue;
      const it = b.body.attributes.find((a) => a.name === 'iterator')?.expr;
      const name = it?.kind === 'variable' ? it.name : label;
      const coll = evalExpr(fe.expr, s);
      if (isUnknown(coll)) {
        out[label] = new Unknown();
        continue;
      }
      let entries: [Value, Value][];
      if (coll === null) entries = [];
      else if (Array.isArray(coll)) entries = coll.map((v, i) => [isSet(coll) ? v : i, v]);
      else if (isMap(coll)) entries = Object.entries(coll);
      else throw new EvalError(`Invalid dynamic for_each value: Cannot use a ${typeName(coll)} value in for_each. An iterable collection is required.`, fe.line, 'El for_each de un dynamic necesita una lista, un set o un mapa.');
      const list = (Array.isArray(out[label]) ? out[label] : (out[label] = [])) as Value[];
      for (const [k, v] of entries) list.push(evalBody(content.body, bs.block ?? {}, { ...s, bound: { ...s.bound, [name]: { key: k, value: v } } }));
      continue;
    }
    const bs = spec[b.type];
    if (!bs || bs.type !== 'block') continue;
    ((out[b.type] ??= []) as Value[]).push(evalBody(b.body, bs.block ?? {}, s));
  }
  return out;
}

// ------------------------------------------------------------ sensible y efímero

/** ¿La expresión usa algún valor que cumpla `leaf`? sensitive()/nonsensitive() se tratan aparte. */
function exprUses(e: Expr, leaf: (path: string[]) => boolean, calls: { mark?: string; unmark?: string } = {}): boolean {
  const visit = (x: Expr): boolean => {
    switch (x.kind) {
      case 'call':
        if (x.name === calls.unmark) return false;
        if (x.name === calls.mark) return true;
        return x.args.some(visit);
      case 'getattr':
      case 'index':
      case 'splat': {
        const names: string[] = [];
        let cur: Expr = x;
        let inner = false;
        for (;;) {
          if (cur.kind === 'getattr') {
            names.unshift(cur.name);
            cur = cur.target;
          } else if (cur.kind === 'index') {
            inner = inner || visit(cur.key);
            cur = cur.target;
          } else if (cur.kind === 'splat') {
            let c: Expr = cur.chain;
            const chain: string[] = [];
            while (c.kind === 'getattr') {
              chain.unshift(c.name);
              c = c.target;
            }
            names.unshift(...chain);
            cur = cur.target;
          } else break;
        }
        if (inner) return true;
        return cur.kind === 'variable' ? leaf([cur.name, ...names]) : visit(cur);
      }
      case 'variable':
        return leaf([x.name]);
      case 'template':
        return x.parts.some((p) => typeof p !== 'string' && visit(p));
      case 'unary':
        return visit(x.operand);
      case 'binary':
        return visit(x.left) || visit(x.right);
      case 'conditional':
        return visit(x.cond) || visit(x.then) || visit(x.else);
      case 'tuple':
        return x.items.some(visit);
      case 'object':
        return x.items.some((i) => visit(i.key) || visit(i.value));
      case 'for':
        return visit(x.coll) || visit(x.valExpr) || (!!x.keyExpr && visit(x.keyExpr)) || (!!x.cond && visit(x.cond));
      default:
        return false;
    }
  };
  return visit(e);
}

/** ¿Deriva de un valor sensible? (variable sensitive, atributo sensible, output sensible de un módulo, sensitive()) */
export function isSensitiveExpr(e: Expr, cfg: Config, seen: Set<string> = new Set()): boolean {
  return exprUses(
    e,
    (p) => {
      if (p[0] === 'var') return !!cfg.variables[p[1]]?.sensitive;
      if (p[0] === 'local') {
        const l = cfg.locals[p[1]];
        if (!l || seen.has(p[1])) return false;
        seen.add(p[1]);
        return isSensitiveExpr(l.expr, cfg, seen);
      }
      if (p[0] === 'module') return !!cfg.children[p[1]]?.outputs[p[2]]?.sensitive;
      const [mode, type, attr] = p[0] === 'data' ? ['data' as const, p[1], p[3]] : ['managed' as const, p[0], p[2]];
      const schema = getSchema(mode, type);
      return !!schema && !!attr && sensitiveAttrs(schema).includes(attr);
    },
    { mark: 'sensitive', unmark: 'nonsensitive' },
  );
}

/** ¿Deriva de un valor efímero? (variable ephemeral o output ephemeral de un módulo) */
export function isEphemeralExpr(e: Expr, cfg: Config, seen: Set<string> = new Set()): boolean {
  return exprUses(e, (p) => {
    if (p[0] === 'var') return !!cfg.variables[p[1]]?.ephemeral;
    if (p[0] === 'local') {
      const l = cfg.locals[p[1]];
      if (!l || seen.has(p[1])) return false;
      seen.add(p[1]);
      return isEphemeralExpr(l.expr, cfg, seen);
    }
    if (p[0] === 'module') return !!cfg.children[p[1]]?.outputs[p[2]]?.ephemeral;
    return false;
  });
}

const META_ARGS = new Set(['count', 'for_each', 'depends_on', 'provider']);

/** Reglas de uso de valores sensibles y efímeros (se comprueban sin evaluar nada). */
export function semanticChecks(root: Config): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const cfg of Object.values(moduleConfigs(root))) {
    for (const rc of Object.values(cfg.resources)) {
      const schema = getSchema(rc.mode, rc.type);
      if (!schema) continue;
      for (const a of rc.body.attributes) {
        if (META_ARGS.has(a.name) || !schema.args[a.name] || schema.args[a.name].writeOnly) continue;
        if (isEphemeralExpr(a.expr, cfg))
          diags.push({
            severity: 'error',
            summary: 'Invalid use of ephemeral value',
            detail: `Ephemeral values are not valid for "${a.name}", because it is not a write-only attribute and must be persisted to state.`,
            hint: `Un valor ephemeral nunca se guarda, pero "${a.name}" acabaría en el estado. Úsalo solo en argumentos write-only (como password_wo), en la configuración del proveedor o en otras variables/locals efímeros.`,
            file: rc.file,
            line: a.line,
          });
      }
    }
    for (const o of Object.values(cfg.outputs)) {
      if (!cfg.prefix && !o.sensitive && isSensitiveExpr(o.value, cfg))
        diags.push({
          severity: 'error',
          summary: 'Output refers to sensitive values',
          detail: 'To reduce the risk of accidentally exporting sensitive data that was intended to be only internal, Terraform requires that any root module output containing sensitive data be explicitly marked as sensitive, to confirm your intent.\n\nIf you do intend to export this data, annotate the output value as sensitive by adding the following argument:\n    sensitive = true',
          hint: `El output "${o.name}" usa un valor sensible. Añade sensitive = true (se ocultará en la terminal, pero seguirá guardado en el estado).`,
          file: o.file,
          line: o.line,
        });
      if (!o.ephemeral && isEphemeralExpr(o.value, cfg))
        diags.push({
          severity: 'error',
          summary: 'Ephemeral value not allowed',
          detail: 'This output value is not declared as returning an ephemeral value, so it cannot be set to a result derived from an ephemeral value.',
          hint: cfg.prefix ? 'Marca el output con ephemeral = true.' : 'Un valor efímero no puede salir por un output del módulo raíz: se guardaría en el estado.',
          file: o.file,
          line: o.line,
        });
    }
  }
  return diags;
}

function conditionMessage(c: Condition, s: Scope): string {
  try {
    const m = evalExpr(c.errorMessage, s);
    return typeof m === 'string' ? m : formatValueShort(m);
  } catch {
    return 'Condition failed';
  }
}
const formatValueShort = (v: Value) => (isUnknown(v) ? '(known after apply)' : JSON.stringify(v));

/** Evalúa una condición: lanza EvalError si es falsa; no hace nada si aún es desconocida. */
function checkCondition(c: Condition, s: Scope, summary: string, where: string): void {
  const ok = evalExpr(c.condition, s);
  if (isUnknown(ok) || containsUnknown(ok)) return;
  if (ok !== true && ok !== 'true') {
    if (ok !== false && ok !== 'false') throw new EvalError(`Invalid condition result: a bool is required (recibido ${typeName(ok)})`, c.line, 'condition tiene que dar true o false.');
    const msg = conditionMessage(c, s);
    throw new EvalError(summary, c.line, `La condición de ${where} no se cumple: ${msg}`, msg);
  }
}

function normalize(args: ValueMap, schema: ResourceSchema): ValueMap {
  const out: ValueMap = {};
  for (const [name, spec] of Object.entries(schema.args)) {
    const v = args[name];
    if (v !== undefined && v !== null) out[name] = v;
    else if (spec.type === 'block') out[name] = [];
    else out[name] = spec.default ?? null;
  }
  return out;
}

const sensitiveAttrs = (schema: ResourceSchema) =>
  [...Object.entries(schema.args).filter(([, s]) => s.sensitive).map(([n]) => n), ...(schema.type === 'random_password' ? ['result'] : [])];

// ------------------------------------------------------------ variables

function typeConstraint(e?: Expr): string {
  if (!e) return 'any';
  if (e.kind === 'variable') return e.name;
  if (e.kind === 'call') return e.name;
  return 'any';
}

function convertVar(v: Value, type: string, name: string): Value {
  if (v === null || isUnknown(v)) return v;
  const fail = (): never => {
    throw new EvalError(
      `Invalid value for input variable "${name}": ${type} required (recibido ${typeName(v)})`,
      undefined,
      `La variable "${name}" es de tipo ${type}.`,
    );
  };
  switch (type) {
    case 'string':
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return typeof v === 'string' ? v : fail();
    case 'number':
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
      return fail();
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      return fail();
    case 'list':
    case 'tuple':
      return Array.isArray(v) ? v : fail();
    case 'set':
      return Array.isArray(v) ? markSet([...v]) : fail();
    case 'map':
    case 'object':
      return isMap(v) ? v : fail();
    default:
      return v;
  }
}

function parseVarFile(file: string, src: string, cfg: Config, diags: Diagnostic[]): ValueMap | null {
  const out: ValueMap = {};
  const { body, error } = parseHcl(src);
  if (!body) {
    diags.push({ severity: 'error', summary: 'Syntax error', detail: error!.message, hint: error!.hint, file, line: error!.line });
    return null;
  }
  for (const a of body.attributes) {
    try {
      out[a.name] = evalExpr(a.expr, emptyScope());
    } catch (e) {
      if (e instanceof EvalError) {
        diags.push({ severity: 'error', summary: e.message, hint: 'En un fichero .tfvars solo puedes usar valores literales, no referencias.', file, line: a.line });
        return null;
      }
      throw e;
    }
    if (!cfg.variables[a.name]) {
      diags.push({
        severity: 'warning',
        summary: 'Value for undeclared variable',
        detail: `The root module does not declare a variable named "${a.name}".`,
        hint: `Has dado valor a "${a.name}" en ${file}, pero no existe ningún bloque variable "${a.name}".`,
        file,
        line: a.line,
      });
    }
  }
  return out;
}

/**
 * Precedencia (de menor a mayor): default → TF_VAR_nombre → terraform.tfvars →
 * *.auto.tfvars (orden alfabético) → -var-file (en orden) → -var.
 */
function resolveVariables(cfg: Config, files: Record<string, string>, opts: RunOptions, diags: Diagnostic[]): ValueMap | null {
  const cliVars = opts.cliVars ?? {};
  const raw: Record<string, { value: Value | string; parse: boolean }> = {};
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (k.startsWith('TF_VAR_') && cfg.variables[k.slice(7)]) raw[k.slice(7)] = { value: v, parse: true };
  }
  const auto = Object.keys(files)
    .filter((f) => !f.includes('/') && (f === 'terraform.tfvars' || f.endsWith('.auto.tfvars')))
    .sort((a, b) => (a === 'terraform.tfvars' ? -1 : b === 'terraform.tfvars' ? 1 : a.localeCompare(b)));
  for (const vf of opts.varFiles ?? []) {
    if (files[vf] === undefined) {
      diags.push({ severity: 'error', summary: 'Failed to read variables file', detail: `Given variables file ${vf} does not exist.`, hint: 'Crea el fichero con el botón + del editor o revisa el nombre.' });
      return null;
    }
  }
  for (const file of [...auto, ...(opts.varFiles ?? [])]) {
    const vals = parseVarFile(file, files[file], cfg, diags);
    if (!vals) return null;
    for (const [k, v] of Object.entries(vals)) raw[k] = { value: v, parse: false };
  }
  for (const name of Object.keys(cliVars)) {
    if (!cfg.variables[name]) {
      diags.push({ severity: 'error', summary: 'Value for undeclared variable', detail: `A variable named "${name}" was assigned on the command line, but the root module does not declare a variable of that name.`, hint: `Declara primero: variable "${name}" {}` });
      return null;
    }
    raw[name] = { value: cliVars[name], parse: true };
  }

  const vars: ValueMap = {};
  for (const v of Object.values(cfg.variables)) {
    const type = typeConstraint(v.type);
    let val: Value | undefined;
    try {
      const given = raw[v.name];
      if (given) {
        val = given.parse && typeof given.value === 'string' && ['list', 'set', 'map', 'object', 'tuple'].includes(type) ? evalExpr(parseExpressionSource(given.value, 1), emptyScope()) : (given.value as Value);
      } else if (v.default) val = evalExpr(v.default, emptyScope());
      if (val === undefined) {
        diags.push({
          severity: 'error',
          summary: 'No value for required variable',
          detail: `The root module input variable "${v.name}" is not set, and has no default value.`,
          hint: `Dale un valor: añade default = ... al bloque variable, ponlo en terraform.tfvars, o usa -var="${v.name}=valor".`,
          file: v.file,
          line: v.line,
        });
        continue;
      }
      vars[v.name] = convertVar(val, type, v.name);
      for (const rule of v.validations) {
        const ok = evalExpr(rule.condition, { ...emptyScope(), vars: { [v.name]: vars[v.name] } });
        if (ok === false) {
          diags.push({
            severity: 'error',
            summary: 'Invalid value for variable',
            detail: rule.errorMessage,
            hint: `El valor de var.${v.name} no cumple la regla de validación.`,
            file: v.file,
            line: rule.line,
          });
        }
      }
    } catch (e) {
      if (e instanceof EvalError) diags.push({ severity: 'error', summary: e.message, hint: e.hint, file: v.file, line: v.line });
      else throw e;
    }
  }
  return hasErrors(diags) ? null : vars;
}

// ------------------------------------------------------------ orden de destrucción

/** Ordena instancias para destruirlas: primero las que dependen de otras. */
export function destroyOrder(instances: InstanceState[]): InstanceState[] {
  const remaining = [...instances].sort((a, b) => a.addr.localeCompare(b.addr));
  const out: InstanceState[] = [];
  while (remaining.length) {
    const idx = remaining.findIndex((cand) => !remaining.some((o) => o !== cand && o.dependencies.includes(cand.resourceAddr)));
    const pickIdx = idx >= 0 ? idx : 0;
    out.push(remaining[pickIdx]);
    remaining.splice(pickIdx, 1);
  }
  return out;
}

// ------------------------------------------------------------ motor

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-west-3',
  'eu-central-1', 'eu-south-2', 'eu-north-1', 'sa-east-1', 'ap-southeast-1', 'ap-northeast-1',
];

const fakeSeconds = (phase: Phase, type: string) => {
  const base = type === 'aws_db_instance' ? 180 : type === 'aws_instance' ? 12 : type.startsWith('aws_') ? 2 : 0;
  return phase === 'reading' ? 0 : Math.max(0, base + Math.floor(Math.random() * (base / 2 + 2)) - 1);
};

interface WalkContext {
  cfg: Config;
  graph: DepGraph;
  vars: ValueMap;
  /** Estado contra el que se compara (en apply se va mutando). */
  cur: TfState;
  realize: boolean;
  events: ApplyEvent[];
  diags: Diagnostic[];
  /** Objetos de la nube que Terraform no gestiona (para detectar choques de nombres). */
  unmanaged?: Record<string, CloudObject>;
  workspace?: string;
  replace?: string[];
}

interface WalkResult {
  changes: ResourceChange[];
  outputs: Record<string, { value: Value; sensitive: boolean }>;
  expanded: Set<string>;
  failed: boolean;
  scope: Scope;
  scopes: Record<string, Scope>;
}

/** 'module.a.module.b.' → { parentPrefix: 'module.a.', callName: 'b' } */
function parentOf(prefix: string) {
  const m = /^(.*)module.([^.]+).$/.exec(prefix)!;
  return { parentPrefix: m[1], callName: m[2] };
}

function walk(ctx: WalkContext): WalkResult {
  const { cfg, graph, cur, realize, events, diags } = ctx;
  // Un ámbito (scope) por módulo: cada módulo solo ve sus variables, locals y recursos.
  const configs = moduleConfigs(cfg);
  const scopes: Record<string, Scope> = {};
  for (const [p, c] of Object.entries(configs)) {
    scopes[p] = { ...emptyScope(), vars: p === '' ? ctx.vars : {}, workspace: ctx.workspace ?? 'default' };
    for (const name of Object.keys(c.moduleCalls)) scopes[p].modules[name] = {};
  }
  const scope = scopes[''];
  const changes: ResourceChange[] = [];
  const outputs: WalkResult['outputs'] = {};
  const expanded = new Set<string>();
  const regions: Record<string, string> = {};

  const regionOf = (provider: string): string => {
    if (regions[provider]) return regions[provider];
    let region = 'us-east-1';
    const [pname, alias] = provider.split('.');
    const p = cfg.providers.find((x) => x.name === pname && x.alias === alias);
    const attr = p?.body.attributes.find((a) => a.name === 'region');
    if (p && attr) {
      const v = evalExpr(attr.expr, scope);
      if (typeof v === 'string') {
        if (!AWS_REGIONS.includes(v))
          throw new EvalError(`Invalid AWS Region: ${v}`, attr.line, `Regiones válidas: ${AWS_REGIONS.join(', ')}`);
        region = v;
      }
    }
    regions[provider] = region;
    return region;
  };

  const genCtx = (addr: string, region: string): GenCtx => ({
    region,
    addr,
    findById: (id) => {
      const r = Object.values(cur.resources).find((x) => x.mode === 'managed' && x.attributes.id === id);
      return r ? { addr: r.addr, type: r.type, attributes: r.attributes } : undefined;
    },
    all: () => Object.values(cur.resources).filter((x) => x.mode === 'managed').map((r) => ({ addr: r.addr, type: r.type, attributes: r.attributes })),
  });

  const snapshot = () => cloneState(cur);

  const processResource = (rc: ResourceConfig, prefix: string) => {
    const scope = scopes[prefix];
    const fullAddr = prefix + rc.addr;
    const module = prefix ? prefix.slice(0, -1) : undefined;
    const schema = getSchema(rc.mode, rc.type)!;
    const region = providerOf(rc.type) === 'aws' ? regionOf(prefix ? 'aws' : rc.provider) : 'local';
    const mcfgR = configs[prefix];
    const sensFromExpr = rc.body.attributes.filter((a) => schema.args[a.name] && !META_ARGS.has(a.name) && isSensitiveExpr(a.expr, mcfgR)).map((a) => a.name);
    const writeOnly = Object.entries(schema.args).filter(([, a]) => a.writeOnly).map(([n]) => n);
    const deps = resourceDependencies(graph, fullAddr).filter((d) => graph.nodes[d]?.kind !== 'data');

    let keys: (string | number | undefined)[] = [undefined];
    let eachValues: ValueMap = {};
    if (rc.count) {
      const c = evalExpr(rc.count, scope);
      if (isUnknown(c)) {
        throw new EvalError(
          'Invalid count argument',
          rc.count.line,
          'count debe poder calcularse durante el plan: no puede depender de atributos que solo se conocen tras el apply (como un id).',
          'The "count" value depends on resource attributes that cannot be determined until apply.',
        );
      }
      const n = toNum(c, rc.count.line);
      if (!Number.isInteger(n) || n < 0)
        throw new EvalError('Invalid count argument: must be a whole number, greater than or equal to zero', rc.count.line);
      if (n > 50) throw new EvalError('Invalid count argument: el simulador admite como máximo 50 instancias', rc.count.line);
      keys = Array.from({ length: n }, (_, i) => i);
    } else if (rc.forEach) {
      const f = evalExpr(rc.forEach, scope);
      if (isUnknown(f) || (Array.isArray(f) && f.some(isUnknown))) {
        throw new EvalError(
          'Invalid for_each argument',
          rc.forEach.line,
          'Las claves de for_each deben conocerse durante el plan: no pueden depender de atributos que solo se conocen tras el apply.',
        );
      }
      if (Array.isArray(f)) {
        if (!isSet(f)) {
          throw new EvalError(
            'Invalid for_each argument: the "for_each" argument must be a map, or set of strings, and you have provided a value of type list',
            rc.forEach.line,
            'for_each no acepta listas. Conviértela en un set con toset([...]) o usa un mapa { clave = valor }.',
          );
        }
        keys = f.map(String);
        eachValues = Object.fromEntries(keys.map((k) => [String(k), String(k)]));
      } else if (isMap(f)) {
        keys = Object.keys(f);
        eachValues = f;
      } else {
        throw new EvalError(`Invalid for_each argument: must be a map or set of strings (recibido ${typeName(f)})`, rc.forEach.line);
      }
    }

    const container: Value = rc.count ? [] : rc.forEach ? {} : null;
    let single: Value = null;

    for (const key of keys) {
      const addr = instanceAddr(fullAddr, key);
      const s: Scope = {
        ...scope,
        count: typeof key === 'number' ? { index: key } : undefined,
        each: rc.forEach && key !== undefined ? { key, value: eachValues[String(key)] } : undefined,
      };
      const args = normalize(evalBody(rc.body, schema.args, s), schema);
      const msg = schema.validate?.(args, { region });
      if (msg) throw new EvalError(msg, rc.line, undefined);
      for (const c of rc.preconditions) checkCondition(c, s, 'Resource precondition failed', addr);
      // Los argumentos write-only se envían a la nube, pero nunca se guardan ni se comparan.
      const woSent = writeOnly.filter((n) => args[n] !== null && args[n] !== undefined);
      for (const n of writeOnly) args[n] = null;
      expanded.add(addr);
      const prior = cur.resources[addr];
      const sens = [...new Set([...sensitiveAttrs(schema), ...sensFromExpr])];
      const base = {
        addr,
        resourceAddr: fullAddr,
        module,
        mode: rc.mode,
        type: rc.type,
        name: rc.name,
        indexKey: key,
        sensitiveAttrs: sens,
        createBeforeDestroy: rc.lifecycle.createBeforeDestroy,
        ...(region !== 'local' ? { region } : {}),
        ...(woSent.length ? { writeOnlyAttrs: woSent } : {}),
      };

      let value: ValueMap;

      if (rc.mode === 'data') {
        const deferred = containsUnknown(args);
        if (deferred && !realize) {
          value = { ...args, ...Object.fromEntries(schema.computed.map((c) => [c, new Unknown(addr)])) };
          changes.push({ ...base, action: 'read', before: null, after: value, diffs: [], replaceReasons: [] });
        } else {
          value = { ...args, ...schema.generate!(args, genCtx(addr, region)) };
          if (realize) {
            cur.resources[addr] = { ...base, attributes: value, dependencies: deps, indexKey: key };
          }
        }
      } else {
        // ----- calcular la acción
        const diffs: AttrDiff[] = [];
        const reasons: string[] = [];
        let action: Action = 'create';
        let reason: ResourceChange['reason'];
        const effective: ValueMap = { ...args };
        if (prior) {
          for (const [name, spec] of Object.entries(schema.args)) {
            const before = prior.attributes[name] ?? null;
            let after = args[name] ?? null;
            if (rc.lifecycle.ignoreChanges.includes(name) || (after === null && spec.computed && before !== null)) {
              effective[name] = before;
              continue;
            }
            if (!deepEqual(before, after)) {
              diffs.push({ name, before, after, forcesReplacement: !!spec.forceNew });
              if (spec.forceNew) reasons.push(name);
            }
          }
          action = diffs.length === 0 ? 'noop' : reasons.length ? 'replace' : 'update';
          reason = ctx.replace?.includes(addr) ? 'requested' : prior.tainted ? 'tainted' : undefined;
          if (reason) action = 'replace';
          if (action === 'replace' && rc.lifecycle.preventDestroy) {
            throw new EvalError(
              'Instance cannot be destroyed',
              rc.line,
              `${addr} tiene lifecycle { prevent_destroy = true } y ${reason === 'requested' ? 'has pedido reemplazarlo con -replace' : reason === 'tainted' ? 'está marcado como tainted' : `el cambio en ${reasons.join(', ')} obliga a destruirlo`}. Quita prevent_destroy si de verdad quieres reemplazarlo.`,
            );
          }
        }

        if (!realize) {
          if (action === 'create' || action === 'replace') {
            value = { ...effective };
            for (const c of schema.computed) value[c] = new Unknown(addr);
            for (const [n, spec] of Object.entries(schema.args)) if (spec.computed && value[n] === null) value[n] = new Unknown(addr);
            if (action === 'replace') {
              for (const c of schema.computed) diffs.push({ name: c, before: prior!.attributes[c], after: new Unknown(addr), forcesReplacement: false });
            }
          } else if (action === 'update') {
            value = { ...prior!.attributes, ...effective };
          } else {
            value = prior!.attributes;
          }
          changes.push({ ...base, action, before: prior?.attributes ?? null, after: value, diffs, replaceReasons: reasons, ...(reason ? { reason } : {}) });
        } else {
          // ----- apply real
          const gctx = genCtx(addr, region);
          if (action === 'create' || action === 'replace') {
            if (action === 'replace') {
              // Solo llega aquí con create_before_destroy (los demás reemplazos se destruyeron antes).
            }
            const secs = fakeSeconds('creating', rc.type);
            events.push({ kind: 'start', addr, phase: 'creating', seconds: 0, state: snapshot() });
            const owned = rc.type === 'aws_s3_bucket' && typeof effective.bucket === 'string' ? ctx.unmanaged?.[effective.bucket] : undefined;
            const err = owned
              ? `BucketAlreadyOwnedByYou: ya tienes un bucket "${effective.bucket}" en tu cuenta, creado fuera de Terraform. Impórtalo (bloque import o terraform import) para que Terraform lo gestione en lugar de intentar crearlo.`
              : schema.applyCheck?.(effective, gctx);
            if (err) {
              events.push({ kind: 'error', addr, phase: 'creating', seconds: secs, message: err, state: snapshot() });
              throw new EvalError(`creating ${schema.title} (${addr}): ${err}`, rc.line);
            }
            value = { ...effective, ...schema.generate!(effective, gctx) };
            const deposed = action === 'replace' ? prior : undefined;
            cur.resources[addr] = { ...base, attributes: value, dependencies: deps };
            events.push({ kind: 'complete', addr, phase: 'creating', seconds: secs, id: String(value.id ?? ''), state: snapshot() });
            if (deposed) {
              events.push({ kind: 'start', addr, phase: 'destroying', seconds: 0, id: String(deposed.attributes.id ?? ''), message: 'deposed', state: snapshot() });
              events.push({ kind: 'complete', addr, phase: 'destroying', seconds: fakeSeconds('destroying', rc.type), state: snapshot() });
            }
          } else if (action === 'update') {
            events.push({ kind: 'start', addr, phase: 'modifying', seconds: 0, id: String(prior!.attributes.id ?? ''), state: snapshot() });
            const err = schema.applyCheck?.(effective, gctx);
            if (err) {
              events.push({ kind: 'error', addr, phase: 'modifying', seconds: 1, message: err, state: snapshot() });
              throw new EvalError(`updating ${schema.title} (${addr}): ${err}`, rc.line);
            }
            value = { ...prior!.attributes, ...effective };
            cur.resources[addr] = { ...prior!, attributes: value, dependencies: deps };
            events.push({ kind: 'complete', addr, phase: 'modifying', seconds: fakeSeconds('modifying', rc.type), id: String(value.id ?? ''), state: snapshot() });
          } else {
            value = prior!.attributes;
            if (!deepEqual(prior!.dependencies as Value, deps as Value)) cur.resources[addr] = { ...prior!, dependencies: deps };
          }
        }
      }

      for (const c of rc.postconditions) checkCondition(c, { ...s, bound: { ...s.bound, self: value } }, 'Resource postcondition failed', addr);

      if (Array.isArray(container)) container.push(value);
      else if (isMap(container)) container[String(key)] = value;
      else single = value;
    }

    const target = rc.mode === 'managed' ? scope.resources : scope.data;
    (target[rc.type] ??= {})[rc.name] = container ?? single;
  };

  for (const id of graph.order) {
    const node = graph.nodes[id];
    const prefix = nodePrefix(node);
    const mcfg = configs[prefix];
    const ms = scopes[prefix];
    try {
      if (node.kind === 'variable' && prefix) {
        // Entrada de un módulo hijo: se evalúa en el ámbito del padre.
        const { parentPrefix, callName } = parentOf(prefix);
        const call = configs[parentPrefix].moduleCalls[callName];
        const v = mcfg.variables[node.label];
        const arg = call.args.find((a) => a.name === node.label);
        let val: Value | undefined = arg ? evalExpr(arg.expr, scopes[parentPrefix]) : v.default ? evalExpr(v.default, emptyScope()) : undefined;
        if (val === undefined) throw new EvalError(`Missing required argument "${node.label}" for module "${callName}"`, call.line);
        try {
          val = convertVar(val, typeConstraint(v.type), node.label);
        } catch (e) {
          if (e instanceof EvalError) throw new EvalError(e.message, arg?.line ?? call.line, e.hint);
          throw e;
        }
        for (const rule of v.validations) {
          if (evalExpr(rule.condition, { ...emptyScope(), vars: { [v.name]: val } }) === false)
            throw new EvalError(`Invalid value for variable: ${rule.errorMessage}`, arg?.line ?? call.line, `El valor que el módulo raíz pasa a var.${v.name} no cumple la validación del módulo.`);
        }
        ms.vars[node.label] = val;
      } else if (node.kind === 'local') {
        ms.locals[node.label] = evalExpr(mcfg.locals[node.label].expr, ms);
      } else if (node.kind === 'output') {
        const o = mcfg.outputs[node.label];
        for (const c of o.preconditions) checkCondition(c, ms, 'Module output value precondition failed', `output.${o.name}`);
        const value = evalExpr(o.value, ms);
        if (!prefix) outputs[o.name] = { value, sensitive: o.sensitive };
        else {
          const { parentPrefix, callName } = parentOf(prefix);
          (scopes[parentPrefix].modules[callName] ??= {})[o.name] = value;
        }
      } else if (node.kind === 'resource' || node.kind === 'data') {
        processResource(mcfg.resources[node.key], prefix);
      }
    } catch (e) {
      if (e instanceof EvalError) {
        diags.push({ severity: 'error', summary: e.message, detail: e.detail, hint: e.hint, file: node.file, line: e.line ?? node.line });
        return { changes, outputs, expanded, failed: true, scope, scopes };
      }
      throw e;
    }
  }
  // check blocks: se evalúan al final y solo generan avisos.
  for (const chk of cfg.checks) {
    for (const a of chk.asserts) {
      const at = { file: a.file, line: a.line };
      try {
        const ok = evalExpr(a.condition, scope);
        if (isUnknown(ok) || containsUnknown(ok)) {
          if (!realize)
            diags.push({ severity: 'warning', summary: 'Check block assertion known after apply', detail: 'The condition could not be evaluated at this time, a result will be known when this plan is applied.', hint: `check "${chk.name}" depende de valores que aún no existen: se comprobará durante el apply.`, ...at });
        } else if (ok !== true) {
          diags.push({ severity: 'warning', summary: 'Check block assertion failed', detail: conditionMessage(a, scope), hint: `check "${chk.name}" no se cumple. Los check solo avisan: no bloquean el plan ni el apply.`, ...at });
        }
      } catch (e) {
        if (!(e instanceof EvalError)) throw e;
        diags.push({ severity: 'warning', summary: `Check block assertion failed: ${e.message}`, hint: e.hint, ...at });
      }
    }
  }
  return { changes, outputs, expanded, failed: false, scope, scopes };
}

function prepare(files: Record<string, string>, opts: RunOptions) {
  const cfg = loadConfig(files, opts.modules);
  const diags: Diagnostic[] = [...cfg.diagnostics];
  if (hasErrors(diags)) return { cfg, diags, graph: null, vars: null };
  const graph = buildGraph(cfg);
  diags.push(...graph.diagnostics);
  if (hasErrors(diags)) return { cfg, diags, graph, vars: null };
  diags.push(...semanticChecks(cfg));
  if (hasErrors(diags)) return { cfg, diags, graph, vars: null };
  const vars = resolveVariables(cfg, files, opts, diags);
  return { cfg, diags, graph, vars };
}

const sortChanges = (cs: ResourceChange[]) => cs.sort((a, b) => a.addr.localeCompare(b.addr, 'en', { numeric: true }));

function summarize(changes: ResourceChange[]): PlanSummary {
  const s = { add: 0, change: 0, destroy: 0, import: 0 };
  for (const c of changes) {
    if (c.mode !== 'managed') continue;
    if (c.importing) s.import++;
    if (c.action === 'create') s.add++;
    else if (c.action === 'update') s.change++;
    else if (c.action === 'delete') s.destroy++;
    else if (c.action === 'replace') {
      s.add++;
      s.destroy++;
    }
  }
  return s;
}

function outputChanges(prior: TfState, outputs: PlanResult['outputs'], destroy: boolean): OutputChange[] {
  const out: OutputChange[] = [];
  const names = new Set([...Object.keys(prior.outputs), ...Object.keys(outputs)]);
  for (const name of [...names].sort()) {
    const before = prior.outputs[name];
    const after = destroy ? undefined : outputs[name];
    const sensitive = !!(before?.sensitive || after?.sensitive);
    if (!after) out.push({ name, action: 'delete', before: before?.value, sensitive });
    else if (!before) out.push({ name, action: 'create', after: after.value, sensitive });
    else out.push({ name, action: deepEqual(before.value, after.value) ? 'noop' : 'update', before: before.value, after: after.value, sensitive });
  }
  return out;
}

/** terraform plan */
export function plan(files: Record<string, string>, prior: TfState, opts: RunOptions = {}): PlanResult {
  const destroy = !!opts.destroy;
  const refreshOnly = !!opts.refreshOnly && !destroy;
  const cloud = opts.cloud ?? emptyCloud();
  const { cfg, diags, graph, vars } = prepare(files, opts);
  const fail = (): PlanResult => ({
    ok: false,
    destroy,
    refreshOnly,
    drift: [],
    base: prior,
    moves: [],
    diagnostics: diags,
    config: cfg,
    graph,
    changes: [],
    outputChanges: [],
    outputs: {},
    summary: { add: 0, change: 0, destroy: 0, import: 0 },
  });
  if (!graph || !vars || hasErrors(diags)) return fail();

  // Refresh: antes de planificar, Terraform lee cada recurso real y actualiza su copia del estado.
  // 1) moved: renombra direcciones en el estado antes de nada.
  const moved = applyMoves(prior, cfg.moved);
  for (const w of moved.warnings) diags.push({ severity: 'warning', summary: 'Unresolved move', detail: w, hint: 'El destino del moved ya existe en el estado: Terraform no puede renombrar encima de otro objeto.' });
  // 2) refresh: lee cada recurso real y actualiza su copia del estado.
  const { state: base, drift } = opts.refresh === false ? { state: cloneState(moved.state), drift: [] as DriftChange[] } : refreshState(moved.state, cloud);
  const common = { refreshOnly, drift, base, moves: moved.moves, config: cfg, graph };

  if (refreshOnly) {
    const res = walk({ cfg, graph, vars, cur: cloneState(base), realize: false, events: [], diags, workspace: opts.workspace });
    if (res.failed) return fail();
    const outputs: PlanResult['outputs'] = {};
    for (const [n, o] of Object.entries(res.outputs)) {
      if (!containsUnknown(o.value)) outputs[n] = o;
      else if (prior.outputs[n]) outputs[n] = prior.outputs[n];
    }
    base.outputs = outputs;
    return { ok: true, destroy, ...common, diagnostics: diags, changes: [], outputChanges: outputChanges(prior, outputs, false), outputs, summary: summarize([]) };
  }

  if (destroy) {
    const changes: ResourceChange[] = [];
    for (const inst of destroyOrder(Object.values(base.resources).filter((r) => r.mode === 'managed'))) {
      const rc = findResource(cfg, inst.resourceAddr);
      if (rc?.lifecycle.preventDestroy) {
        diags.push({
          severity: 'error',
          summary: 'Instance cannot be destroyed',
          detail: `Resource ${inst.addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed.`,
          hint: 'prevent_destroy protege recursos críticos de un borrado accidental. Quítalo si de verdad quieres destruirlo.',
          file: rc.file,
          line: rc.line,
        });
        return fail();
      }
      changes.push({
        addr: inst.addr,
        resourceAddr: inst.resourceAddr,
        module: inst.module,
        mode: 'managed',
        type: inst.type,
        name: inst.name,
        indexKey: inst.indexKey,
        action: 'delete',
        before: inst.attributes,
        after: null,
        diffs: [],
        replaceReasons: [],
        sensitiveAttrs: inst.sensitiveAttrs,
        createBeforeDestroy: false,
      });
    }
    return {
      ok: true,
      destroy,
      ...common,
      diagnostics: diags,
      changes,
      outputChanges: outputChanges(prior, {}, true),
      outputs: {},
      summary: summarize(changes),
    };
  }

  // Bloques import: el objeto real entra en el estado y se compara con su configuración.
  const importing = new Map<string, string>();
  for (const imp of cfg.imports) {
    if (base.resources[imp.to]) continue; // ya gestionado: el import no hace nada
    const rc = findResource(cfg, imp.resourceAddr)!;
    const at = { file: imp.file, line: imp.line };
    let id: Value;
    try {
      id = evalExpr(imp.id, { ...emptyScope(), vars });
    } catch (e) {
      if (!(e instanceof EvalError)) throw e;
      diags.push({ severity: 'error', summary: `Invalid import id argument: ${e.message}`, hint: 'El id puede ser un texto o usar variables, pero no atributos de otros recursos.', ...at });
      return fail();
    }
    if (typeof id !== 'string' || !id) {
      diags.push({ severity: 'error', summary: 'Invalid import id argument', detail: 'The import ID must be a non-empty string.', hint: 'id es el identificador del objeto en la nube, p.ej. "mi-bucket" o "i-0abc…".', ...at });
      return fail();
    }
    const obj = cloud.unmanaged[id];
    if (!obj || obj.type !== rc.type) {
      const owner = Object.values(base.resources).find((r) => r.attributes.id === id);
      diags.push({
        severity: 'error',
        summary: 'Cannot import non-existent remote object',
        detail: `While attempting to import an existing object to "${imp.to}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct.`,
        hint: owner
          ? `Ese objeto ya lo gestiona Terraform como ${owner.addr}. Un objeto real solo puede estar en una dirección del estado.`
          : obj
            ? `El objeto "${id}" es de tipo ${obj.type}, pero ${imp.to} es de tipo ${rc.type}.`
            : 'Usa "cloud ls" para ver los objetos que existen en la nube y sus ids.',
        ...at,
      });
      return fail();
    }
    const schema = getSchema('managed', rc.type)!;
    const { prefix } = splitAddr(imp.resourceAddr);
    base.resources[imp.to] = {
      addr: imp.to,
      resourceAddr: imp.resourceAddr,
      module: prefix ? prefix.slice(0, -1) : undefined,
      mode: 'managed',
      type: rc.type,
      name: rc.name,
      indexKey: imp.indexKey,
      attributes: cloneValue(obj.attributes),
      sensitiveAttrs: sensitiveAttrs(schema),
      dependencies: [],
    };
    importing.set(imp.to, id);
  }

  const res = walk({ cfg, graph, vars, cur: base, realize: false, events: [], diags, unmanaged: cloud.unmanaged, workspace: opts.workspace, replace: opts.replace });
  if (res.failed) return fail();
  for (const [addr] of importing) {
    if (res.expanded.has(addr)) continue;
    const imp = cfg.imports.find((i) => i.to === addr)!;
    diags.push({ severity: 'error', summary: 'Configuration for import target does not exist', detail: `The configuration for the given import target ${addr} does not exist.`, hint: 'Ese índice no existe con el count o for_each actual del recurso.', file: imp.file, line: imp.line });
    return fail();
  }
  for (const c of res.changes) {
    if (importing.has(c.addr)) c.importing = importing.get(c.addr);
    const m = moved.moves.find((x) => x.to === c.addr);
    if (m) c.movedFrom = m.from;
  }
  for (const r of opts.replace ?? []) {
    if (!res.changes.some((c) => c.addr === r && c.reason === 'requested'))
      diags.push({ severity: 'warning', summary: 'Incompletely-matched force-replace resource instance', detail: `Your force-replace request for ${r} doesn't match any resource instance that already exists.`, hint: 'Usa terraform state list para ver la dirección exacta (con count: aws_instance.web[0]).' });
  }

  for (const inst of Object.values(base.resources)) {
    if (inst.mode !== 'managed' || res.expanded.has(inst.addr)) continue;
    res.changes.push({
      addr: inst.addr,
      resourceAddr: inst.resourceAddr,
      module: inst.module,
      mode: 'managed',
      type: inst.type,
      name: inst.name,
      indexKey: inst.indexKey,
      action: 'delete',
      before: inst.attributes,
      after: null,
      diffs: [],
      replaceReasons: [],
      sensitiveAttrs: inst.sensitiveAttrs,
      createBeforeDestroy: false,
    });
  }
  return {
    ok: true,
    destroy,
    ...common,
    diagnostics: diags,
    changes: sortChanges(res.changes),
    outputChanges: outputChanges(prior, res.outputs, false),
    outputs: res.outputs,
    summary: summarize(res.changes),
  };
}

/** terraform apply (o destroy si opts.destroy). */
export function apply(files: Record<string, string>, prior: TfState, opts: RunOptions = {}): ApplyResult {
  const p = plan(files, prior, opts);
  const cloud = opts.cloud ?? emptyCloud();
  if (!p.ok) return { ...p, state: prior, events: [], applied: false, cloud, applyWarnings: [] };

  // La nube tras el apply: el refresh absorbe los cambios manuales y los imports dejan de ser "no gestionados".
  let nextCloud: CloudChanges = opts.refresh === false ? { ...cloud, modified: { ...cloud.modified }, deleted: [...cloud.deleted] } : afterRefresh(cloud);
  const imported = p.changes.filter((c) => c.importing);
  nextCloud = { ...nextCloud, unmanaged: Object.fromEntries(Object.entries(nextCloud.unmanaged).filter(([id]) => !imported.some((c) => c.importing === id))) };
  if (opts.refresh === false) {
    for (const c of p.changes) {
      const id = c.before?.id;
      if (c.action === 'noop' || typeof id !== 'string') continue;
      delete nextCloud.modified[id];
      nextCloud.deleted = nextCloud.deleted.filter((x) => x !== id);
    }
  }

  if (p.refreshOnly) {
    const st = cloneState(p.base);
    st.serial++;
    return { ...p, state: st, events: [], applied: true, cloud: nextCloud, applyWarnings: [] };
  }

  const working = cloneState(p.base);
  const events: ApplyEvent[] = [];
  const diags = [...p.diagnostics];
  for (const c of imported) {
    events.push({ kind: 'start', addr: c.addr, phase: 'importing', id: c.importing, seconds: 0, state: cloneState(working) });
    events.push({ kind: 'complete', addr: c.addr, phase: 'importing', id: c.importing, seconds: 0, state: cloneState(working) });
  }

  const destroyNow = p.changes.filter((c) => c.action === 'delete' || (c.action === 'replace' && !c.createBeforeDestroy));
  const insts = destroyOrder(destroyNow.map((c) => working.resources[c.addr]).filter(Boolean));
  for (const inst of insts) {
    events.push({ kind: 'start', addr: inst.addr, phase: 'destroying', id: String(inst.attributes.id ?? ''), seconds: 0, state: cloneState(working) });
    delete working.resources[inst.addr];
    events.push({ kind: 'complete', addr: inst.addr, phase: 'destroying', seconds: fakeSeconds('destroying', inst.type), state: cloneState(working) });
  }

  if (p.destroy) {
    working.resources = {};
    working.outputs = {};
    working.serial++;
    return { ...p, diagnostics: diags, state: working, events, applied: true, cloud: nextCloud, applyWarnings: [] };
  }

  const cfg = p.config;
  const graph = p.graph!;
  const vars = prepare(files, opts).vars!;
  const res = walk({ cfg, graph, vars, cur: working, realize: true, events, diags, unmanaged: nextCloud.unmanaged, workspace: opts.workspace, replace: opts.replace });
  const applyWarnings = diags.slice(p.diagnostics.length).filter((d) => d.severity === 'warning');
  working.serial++;
  if (res.failed) {
    return { ...p, ok: false, diagnostics: diags, state: working, events, applied: true, cloud: nextCloud, applyWarnings };
  }
  // Quitar data sources que ya no están en la configuración.
  for (const inst of Object.values(working.resources)) {
    if (inst.mode === 'data' && !res.expanded.has(inst.addr)) delete working.resources[inst.addr];
  }
  working.outputs = res.outputs;
  return { ...p, diagnostics: diags, outputs: res.outputs, state: working, events, applied: true, cloud: nextCloud, applyWarnings };
}

/** terraform validate: sintaxis, esquema y referencias, sin evaluar valores. */
export function validate(files: Record<string, string>, modules?: InstalledModules): { diagnostics: Diagnostic[]; config: Config; graph: DepGraph | null } {
  const cfg = loadConfig(files, modules);
  if (hasErrors(cfg.diagnostics)) return { diagnostics: cfg.diagnostics, config: cfg, graph: null };
  const graph = buildGraph(cfg);
  return { diagnostics: [...cfg.diagnostics, ...graph.diagnostics, ...(hasErrors(graph.diagnostics) ? [] : semanticChecks(cfg))], config: cfg, graph };
}

/** terraform console: evalúa una expresión con las variables, locals y recursos actuales. */
export function consoleEval(
  files: Record<string, string>,
  state: TfState,
  source: string,
  modules?: InstalledModules,
  opts: { env?: Record<string, string>; workspace?: string } = {},
): { value?: Value; error?: Diagnostic; sensitive?: boolean } {
  const { cfg, diags, graph, vars } = prepare(files, { modules, env: opts.env, workspace: opts.workspace });
  let scope: Scope = { ...emptyScope(), vars: vars ?? {}, workspace: opts.workspace ?? 'default' };
  if (graph && vars && !hasErrors(diags)) {
    const res = walk({ cfg, graph, vars, cur: cloneState(state), realize: false, events: [], diags: [], workspace: opts.workspace });
    scope = res.scope;
  }
  // Igual que Terraform: los recursos se leen del estado, no del código sin aplicar.
  scope = { ...scope, resources: {}, data: {} };
  for (const inst of Object.values(state.resources)) {
    if (inst.module) continue;
    const byName = ((inst.mode === 'managed' ? scope.resources : scope.data)[inst.type] ??= {});
    if (inst.indexKey === undefined) byName[inst.name] = inst.attributes;
    else if (typeof inst.indexKey === 'number') {
      if (!Array.isArray(byName[inst.name])) byName[inst.name] = [];
      (byName[inst.name] as Value[])[inst.indexKey] = inst.attributes;
    } else {
      if (!isMap(byName[inst.name])) byName[inst.name] = {};
      (byName[inst.name] as ValueMap)[inst.indexKey] = inst.attributes;
    }
  }
  try {
    const expr = parseExpressionSource(source, 1);
    return { value: evalExpr(expr, scope), sensitive: isSensitiveExpr(expr, cfg) };
  } catch (e) {
    if (e instanceof EvalError) return { error: { severity: 'error', summary: e.message, hint: e.hint } };
    if (e instanceof Error && 'line' in e) return { error: { severity: 'error', summary: e.message, hint: (e as { hint?: string }).hint } };
    throw e;
  }
}
