import { findResource, hasErrors, loadConfig, moduleConfigs, type Config, type Diagnostic, type InstalledModules, type ResourceConfig } from './config';
import { callFunction, FunctionError } from './functions';
import { buildGraph, nodePrefix, resourceDependencies, type DepGraph } from './graph';
import { parseExpressionSource, parseHcl, type Body, type Expr } from './parser';
import { getSchema, providerOf, type ArgSpec, type GenCtx, type ResourceSchema } from './providers';
import { cloneState, instanceAddr, type InstanceState, type TfState } from './state';
import {
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
}

export interface OutputChange {
  name: string;
  action: 'create' | 'update' | 'delete' | 'noop';
  before?: Value;
  after?: Value;
  sensitive: boolean;
}

export interface PlanResult {
  ok: boolean;
  destroy: boolean;
  diagnostics: Diagnostic[];
  config: Config;
  graph: DepGraph | null;
  changes: ResourceChange[];
  outputChanges: OutputChange[];
  outputs: Record<string, { value: Value; sensitive: boolean }>;
  summary: { add: number; change: number; destroy: number };
}

export type Phase = 'creating' | 'modifying' | 'destroying' | 'reading';

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
}

export interface RunOptions {
  /** Valores pasados con -var "nombre=valor". */
  cliVars?: Record<string, string>;
  /** Versiones de módulos instaladas por terraform init. */
  modules?: InstalledModules;
  destroy?: boolean;
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
          return { workspace: 'default' };
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
    const bs = spec[b.type];
    if (!bs || bs.type !== 'block') continue;
    ((out[b.type] ??= []) as Value[]).push(evalBody(b.body, bs.block ?? {}, s));
  }
  return out;
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

function resolveVariables(cfg: Config, files: Record<string, string>, cliVars: Record<string, string>, diags: Diagnostic[]): ValueMap | null {
  const tfvars: ValueMap = {};
  for (const [file, src] of Object.entries(files)) {
    if (!file.endsWith('.tfvars') || file.includes('/')) continue;
    const { body, error } = parseHcl(src);
    if (!body) {
      diags.push({ severity: 'error', summary: 'Syntax error', detail: error!.message, hint: error!.hint, file, line: error!.line });
      return null;
    }
    for (const a of body.attributes) {
      try {
        tfvars[a.name] = evalExpr(a.expr, emptyScope());
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
  }
  for (const name of Object.keys(cliVars)) {
    if (!cfg.variables[name]) {
      diags.push({ severity: 'error', summary: 'Value for undeclared variable', detail: `A variable named "${name}" was assigned on the command line, but the root module does not declare a variable of that name.`, hint: `Declara primero: variable "${name}" {}` });
      return null;
    }
  }

  const vars: ValueMap = {};
  for (const v of Object.values(cfg.variables)) {
    const type = typeConstraint(v.type);
    let val: Value | undefined;
    try {
      if (v.name in cliVars) {
        const raw = cliVars[v.name];
        val = ['list', 'set', 'map', 'object', 'tuple'].includes(type) ? evalExpr(parseExpressionSource(raw, 1), emptyScope()) : raw;
      } else if (v.name in tfvars) val = tfvars[v.name];
      else if (v.default) val = evalExpr(v.default, emptyScope());
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
  /** Acciones planificadas (solo apply): para saber qué era un reemplazo. */
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
    scopes[p] = { ...emptyScope(), vars: p === '' ? ctx.vars : {} };
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
    const p = cfg.providers.find((x) => x.name === provider);
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
    const region = providerOf(rc.type) === 'aws' ? regionOf('aws') : 'local';
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
      expanded.add(addr);
      const prior = cur.resources[addr];
      const sens = sensitiveAttrs(schema);
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
          if (action === 'replace' && rc.lifecycle.preventDestroy) {
            throw new EvalError(
              'Instance cannot be destroyed',
              rc.line,
              `${addr} tiene lifecycle { prevent_destroy = true } y el cambio en ${reasons.join(', ')} obliga a destruirlo. Quita prevent_destroy si de verdad quieres reemplazarlo.`,
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
          changes.push({ ...base, action, before: prior?.attributes ?? null, after: value, diffs, replaceReasons: reasons });
        } else {
          // ----- apply real
          const gctx = genCtx(addr, region);
          if (action === 'create' || action === 'replace') {
            if (action === 'replace') {
              // Solo llega aquí con create_before_destroy (los demás reemplazos se destruyeron antes).
            }
            const secs = fakeSeconds('creating', rc.type);
            events.push({ kind: 'start', addr, phase: 'creating', seconds: 0, state: snapshot() });
            const err = schema.applyCheck?.(effective, gctx);
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
  return { changes, outputs, expanded, failed: false, scope, scopes };
}

function prepare(files: Record<string, string>, opts: RunOptions) {
  const cfg = loadConfig(files, opts.modules);
  const diags: Diagnostic[] = [...cfg.diagnostics];
  if (hasErrors(diags)) return { cfg, diags, graph: null, vars: null };
  const graph = buildGraph(cfg);
  diags.push(...graph.diagnostics);
  if (hasErrors(diags)) return { cfg, diags, graph, vars: null };
  const vars = resolveVariables(cfg, files, opts.cliVars ?? {}, diags);
  return { cfg, diags, graph, vars };
}

const sortChanges = (cs: ResourceChange[]) => cs.sort((a, b) => a.addr.localeCompare(b.addr, 'en', { numeric: true }));

function summarize(changes: ResourceChange[]) {
  const s = { add: 0, change: 0, destroy: 0 };
  for (const c of changes) {
    if (c.mode !== 'managed') continue;
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
  const { cfg, diags, graph, vars } = prepare(files, opts);
  const fail = (): PlanResult => ({
    ok: false,
    destroy,
    diagnostics: diags,
    config: cfg,
    graph,
    changes: [],
    outputChanges: [],
    outputs: {},
    summary: { add: 0, change: 0, destroy: 0 },
  });
  if (!graph || !vars || hasErrors(diags)) return fail();

  if (destroy) {
    const changes: ResourceChange[] = [];
    for (const inst of destroyOrder(Object.values(prior.resources).filter((r) => r.mode === 'managed'))) {
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
      diagnostics: diags,
      config: cfg,
      graph,
      changes,
      outputChanges: outputChanges(prior, {}, true),
      outputs: {},
      summary: summarize(changes),
    };
  }

  const res = walk({ cfg, graph, vars, cur: prior, realize: false, events: [], diags });
  if (res.failed) return fail();

  for (const inst of Object.values(prior.resources)) {
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
    diagnostics: diags,
    config: cfg,
    graph,
    changes: sortChanges(res.changes),
    outputChanges: outputChanges(prior, res.outputs, false),
    outputs: res.outputs,
    summary: summarize(res.changes),
  };
}

/** terraform apply (o destroy si opts.destroy). */
export function apply(files: Record<string, string>, prior: TfState, opts: RunOptions = {}): ApplyResult {
  const p = plan(files, prior, opts);
  if (!p.ok) return { ...p, state: prior, events: [], applied: false };

  const working = cloneState(prior);
  const events: ApplyEvent[] = [];
  const diags = [...p.diagnostics];

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
    return { ...p, diagnostics: diags, state: working, events, applied: true };
  }

  const cfg = p.config;
  const graph = p.graph!;
  const vars = prepare(files, opts).vars!;
  const res = walk({ cfg, graph, vars, cur: working, realize: true, events, diags });
  working.serial++;
  if (res.failed) {
    return { ...p, ok: false, diagnostics: diags, state: working, events, applied: true };
  }
  // Quitar data sources que ya no están en la configuración.
  for (const inst of Object.values(working.resources)) {
    if (inst.mode === 'data' && !res.expanded.has(inst.addr)) delete working.resources[inst.addr];
  }
  working.outputs = res.outputs;
  return { ...p, diagnostics: diags, outputs: res.outputs, state: working, events, applied: true };
}

/** terraform validate: sintaxis, esquema y referencias, sin evaluar valores. */
export function validate(files: Record<string, string>, modules?: InstalledModules): { diagnostics: Diagnostic[]; config: Config; graph: DepGraph | null } {
  const cfg = loadConfig(files, modules);
  if (hasErrors(cfg.diagnostics)) return { diagnostics: cfg.diagnostics, config: cfg, graph: null };
  const graph = buildGraph(cfg);
  return { diagnostics: [...cfg.diagnostics, ...graph.diagnostics], config: cfg, graph };
}

/** terraform console: evalúa una expresión con las variables, locals y recursos actuales. */
export function consoleEval(files: Record<string, string>, state: TfState, source: string, modules?: InstalledModules): { value?: Value; error?: Diagnostic } {
  const { cfg, diags, graph, vars } = prepare(files, { modules });
  let scope: Scope = { ...emptyScope(), vars: vars ?? {} };
  if (graph && vars && !hasErrors(diags)) {
    const res = walk({ cfg, graph, vars, cur: cloneState(state), realize: false, events: [], diags: [] });
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
    return { value: evalExpr(expr, scope) };
  } catch (e) {
    if (e instanceof EvalError) return { error: { severity: 'error', summary: e.message, hint: e.hint } };
    if (e instanceof Error && 'line' in e) return { error: { severity: 'error', summary: e.message, hint: (e as { hint?: string }).hint } };
    throw e;
  }
}
