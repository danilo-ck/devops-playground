import type { Body, Expr } from './parser';
import { moduleConfigs, type Config, type Diagnostic } from './config';
import { providerOf, suggest } from './providers';

export type NodeKind = 'variable' | 'local' | 'resource' | 'data' | 'output';

export interface GraphNode {
  /** Id único en todo el árbol: module.red.aws_vpc.this */
  id: string;
  /** Id dentro de su módulo: aws_vpc.this, var.cidr, output.vpc_id… */
  key: string;
  /** Módulo al que pertenece (module.red), o undefined en la raíz. */
  module?: string;
  kind: NodeKind;
  /** Texto corto para mostrar (nombre). */
  label: string;
  /** Tipo de recurso, si aplica. */
  type?: string;
  file?: string;
  line?: number;
  /** El recurso usa count / for_each. */
  multi?: 'count' | 'for_each';
}

export interface DepGraph {
  nodes: Record<string, GraphNode>;
  /** deps[id] = nodos de los que depende id. */
  deps: Record<string, string[]>;
  /** Orden topológico (dependencias primero). Vacío si hay ciclos. */
  order: string[];
  diagnostics: Diagnostic[];
}

const SPECIAL_ROOTS = new Set(['count', 'each', 'self', 'path', 'terraform']);

export interface Ref {
  ref: string;
  line: number;
}

/** Extrae las referencias (var.x, local.y, aws_vpc.main, data.a.b) de una expresión. */
export function exprRefs(e: Expr, bound: Set<string> = new Set(), out: Ref[] = []): Ref[] {
  switch (e.kind) {
    case 'literal':
    case 'splatItem':
    case 'variable':
      return out;
    case 'template':
      for (const p of e.parts) if (typeof p !== 'string') exprRefs(p, bound, out);
      return out;
    case 'getattr':
    case 'index':
    case 'splat': {
      const names: string[] = [];
      let cur: Expr = e;
      for (;;) {
        if (cur.kind === 'getattr') {
          names.unshift(cur.name);
          cur = cur.target;
        } else if (cur.kind === 'index') {
          exprRefs(cur.key, bound, out);
          names.unshift('[]');
          cur = cur.target;
        } else if (cur.kind === 'splat') {
          exprRefs(cur.chain, bound, out);
          names.unshift('[*]');
          cur = cur.target;
        } else break;
      }
      if (cur.kind !== 'variable') {
        exprRefs(cur, bound, out);
        return out;
      }
      const root = cur.name;
      if (bound.has(root) || SPECIAL_ROOTS.has(root)) return out;
      const first = names[0];
      if (!first || first.startsWith('[')) return out;
      if (root === 'data') {
        const second = names[1];
        if (second && !second.startsWith('[')) out.push({ ref: `data.${first}.${second}`, line: e.line });
        return out;
      }
      if (root === 'module') {
        // module.red.vpc_id → referencia a un output concreto del módulo
        const second = names[1];
        out.push({ ref: second && !second.startsWith('[') ? `module.${first}.${second}` : `module.${first}`, line: e.line });
        return out;
      }
      out.push({ ref: `${root}.${first}`, line: e.line });
      return out;
    }
    case 'call':
      for (const a of e.args) exprRefs(a, bound, out);
      return out;
    case 'unary':
      return exprRefs(e.operand, bound, out);
    case 'binary':
      exprRefs(e.left, bound, out);
      return exprRefs(e.right, bound, out);
    case 'conditional':
      exprRefs(e.cond, bound, out);
      exprRefs(e.then, bound, out);
      return exprRefs(e.else, bound, out);
    case 'tuple':
      for (const i of e.items) exprRefs(i, bound, out);
      return out;
    case 'object':
      for (const i of e.items) {
        exprRefs(i.key, bound, out);
        exprRefs(i.value, bound, out);
      }
      return out;
    case 'for': {
      exprRefs(e.coll, bound, out);
      const inner = new Set(bound);
      inner.add(e.valVar);
      if (e.keyVar) inner.add(e.keyVar);
      if (e.keyExpr) exprRefs(e.keyExpr, inner, out);
      exprRefs(e.valExpr, inner, out);
      if (e.cond) exprRefs(e.cond, inner, out);
      return out;
    }
  }
}

export function bodyRefs(body: Body, out: Ref[] = [], bound: Set<string> = new Set()): Ref[] {
  for (const a of body.attributes) if (a.name !== 'depends_on' && a.name !== 'provider') exprRefs(a.expr, bound, out);
  for (const b of body.blocks) {
    if (b.type === 'lifecycle') continue;
    if (b.type === 'dynamic') {
      // dynamic "ingress" { for_each = ...  content { ... ingress.value ... } }
      const it = b.body.attributes.find((a) => a.name === 'iterator')?.expr;
      const name = it?.kind === 'variable' ? it.name : b.labels[0];
      const fe = b.body.attributes.find((a) => a.name === 'for_each');
      if (fe) exprRefs(fe.expr, bound, out);
      const inner = new Set(bound);
      if (name) inner.add(name);
      for (const c of b.body.blocks) bodyRefs(c.body, out, inner);
      continue;
    }
    bodyRefs(b.body, out, bound);
  }
  return out;
}

/** Referencias de las condiciones (precondition / postcondition / assert). */
export function conditionRefs(conds: { condition: Expr; errorMessage: Expr }[], out: Ref[] = []): Ref[] {
  for (const c of conds) {
    exprRefs(c.condition, new Set(), out);
    exprRefs(c.errorMessage, new Set(), out);
  }
  return out;
}

/** Recorre las referencias completas (raíz + atributos) de una expresión: var.x, aws_db.main.password… */
export function exprPaths(e: Expr, out: string[][] = []): string[][] {
  const visit = (x: Expr): void => {
    switch (x.kind) {
      case 'getattr':
      case 'index':
      case 'splat': {
        const names: string[] = [];
        let cur: Expr = x;
        for (;;) {
          if (cur.kind === 'getattr') {
            names.unshift(cur.name);
            cur = cur.target;
          } else if (cur.kind === 'index') {
            visit(cur.key);
            cur = cur.target;
          } else if (cur.kind === 'splat') {
            cur = cur.target;
          } else break;
        }
        if (cur.kind === 'variable') out.push([cur.name, ...names]);
        else visit(cur);
        if (x.kind === 'splat') {
          const chainNames: string[] = [];
          let c: Expr = x.chain;
          while (c.kind === 'getattr') {
            chainNames.unshift(c.name);
            c = c.target;
          }
          if (out.length && cur.kind === 'variable') out[out.length - 1].push(...chainNames);
        }
        return;
      }
      case 'variable':
        out.push([x.name]);
        return;
      case 'template':
        x.parts.forEach((p) => typeof p !== 'string' && visit(p));
        return;
      case 'call':
        x.args.forEach(visit);
        return;
      case 'unary':
        visit(x.operand);
        return;
      case 'binary':
        visit(x.left);
        visit(x.right);
        return;
      case 'conditional':
        visit(x.cond);
        visit(x.then);
        visit(x.else);
        return;
      case 'tuple':
        x.items.forEach(visit);
        return;
      case 'object':
        x.items.forEach((i) => (visit(i.key), visit(i.value)));
        return;
      case 'for':
        visit(x.coll);
        if (x.keyExpr) visit(x.keyExpr);
        visit(x.valExpr);
        if (x.cond) visit(x.cond);
        return;
      default:
        return;
    }
  };
  visit(e);
  return out;
}

/** Prefijo de módulo de un nodo: '' en la raíz, 'module.red.' en un hijo. */
export const nodePrefix = (n: GraphNode) => (n.module ? `${n.module}.` : '');

/**
 * Construye el grafo de dependencias de todo el árbol de módulos. Los nodos de un
 * módulo hijo llevan su prefijo: module.red.var.cidr, module.red.aws_vpc.this,
 * module.red.output.vpc_id. Las variables de un hijo dependen de las expresiones
 * que el padre escribe en el bloque module.
 */
export function buildGraph(root: Config): DepGraph {
  const nodes: Record<string, GraphNode> = {};
  const deps: Record<string, string[]> = {};
  const diagnostics: Diagnostic[] = [];
  const configs = moduleConfigs(root);

  // ---------------------------------------------------------- nodos
  for (const [prefix, cfg] of Object.entries(configs)) {
    const module = prefix ? prefix.slice(0, -1) : undefined;
    const add = (local: string, n: Omit<GraphNode, 'id' | 'key' | 'module'>) => {
      nodes[prefix + local] = { ...n, id: prefix + local, key: local, module };
    };
    for (const v of Object.values(cfg.variables)) add(`var.${v.name}`, { kind: 'variable', label: v.name, file: v.file, line: v.line });
    for (const l of Object.values(cfg.locals)) add(`local.${l.name}`, { kind: 'local', label: l.name, file: l.file, line: l.line });
    for (const r of Object.values(cfg.resources))
      add(r.addr, {
        kind: r.mode === 'managed' ? 'resource' : 'data',
        label: r.name,
        type: r.type,
        file: r.file,
        line: r.line,
        multi: r.count ? 'count' : r.forEach ? 'for_each' : undefined,
      });
    for (const o of Object.values(cfg.outputs)) add(`output.${o.name}`, { kind: 'output', label: o.name, file: o.file, line: o.line });
  }

  const subtree = (modPrefix: string) => Object.keys(nodes).filter((id) => id.startsWith(modPrefix));

  /** Traduce una referencia escrita en el módulo `prefix` a ids de nodos. */
  const resolve = (prefix: string, ref: string, line: number, file: string, from: string): string[] => {
    const cfg = configs[prefix];
    if (ref.startsWith('module.')) {
      const [, name, out] = ref.split('.');
      const child = cfg.children[name];
      if (!child) {
        const s = suggest(name, Object.keys(cfg.moduleCalls));
        diagnostics.push({
          severity: 'error',
          summary: 'Reference to undeclared module',
          detail: `No module call named "${name}" is declared in ${prefix ? prefix.slice(0, -1) : 'the root module'}.`,
          hint: s ? `¿Querías referirte a module.${s}?` : `Declara antes el módulo con: module "${name}" { source = "..." }`,
          file,
          line,
        });
        return [];
      }
      if (out === undefined) return subtree(`${prefix}module.${name}.`).filter((id) => nodes[id].module === `${prefix}module.${name}` && nodes[id].kind !== 'variable');
      const id = `${prefix}module.${name}.output.${out}`;
      if (nodes[id]) return [id];
      const outs = Object.keys(child.outputs);
      const s = suggest(out, outs);
      diagnostics.push({
        severity: 'error',
        summary: 'Unsupported attribute',
        detail: `This object does not have an attribute named "${out}".`,
        hint: `El módulo "${name}" solo expone sus outputs${outs.length ? `: ${outs.join(', ')}` : ' (y no tiene ninguno)'}.${s ? ` ¿Querías decir "${s}"?` : ''} Desde fuera no se puede acceder a sus recursos ni variables.`,
        file,
        line,
      });
      return [];
    }
    const id = prefix + ref;
    if (nodes[id]) {
      if (id === from) {
        diagnostics.push({ severity: 'error', summary: 'Self-referential block', detail: `Configuration for ${id} may not refer to itself.`, hint: 'Un recurso no puede usar sus propios atributos en su configuración.', file, line });
        return [];
      }
      return [id];
    }
    const where = prefix ? ` (dentro del módulo ${prefix.slice(0, -1)})` : '';
    if (ref.startsWith('var.')) {
      const name = ref.slice(4);
      diagnostics.push({
        severity: 'error',
        summary: 'Reference to undeclared input variable',
        detail: `An input variable with the name "${name}" has not been declared.`,
        hint: prefix
          ? `Cada módulo tiene su propio ámbito: declara variable "${name}" en los ficheros del módulo y pásale el valor desde el bloque module.`
          : `Declara la variable con: variable "${name}" { ... }`,
        file,
        line,
      });
    } else if (ref.startsWith('local.')) {
      diagnostics.push({ severity: 'error', summary: 'Reference to undeclared local value', detail: `A local value with the name "${ref.slice(6)}" has not been declared${where}.`, hint: `Defínelo dentro de un bloque locals { ${ref.slice(6)} = ... }${where}.`, file, line });
    } else {
      const s = suggest(ref, Object.keys(cfg.resources));
      const [type, name] = ref.startsWith('data.') ? ref.slice(5).split('.') : ref.split('.');
      const elsewhere = Object.entries(configs).find(([p, c]) => p !== prefix && c.resources[ref]);
      diagnostics.push({
        severity: 'error',
        summary: 'Reference to undeclared resource',
        detail: `A ${ref.startsWith('data.') ? 'data' : 'managed'} resource "${type}" "${name}" has not been declared in ${prefix ? prefix.slice(0, -1) : 'the root module'}.`,
        hint: elsewhere
          ? `${ref} existe, pero dentro de ${elsewhere[0] ? elsewhere[0].slice(0, -1) : 'el módulo raíz'}. Los recursos de otro módulo no se ven: expón el valor con un output y úsalo como module.<nombre>.<output>.`
          : s
            ? `¿Querías referirte a ${s}?`
            : `No existe ningún recurso "${ref}". Comprueba el tipo y el nombre.`,
        file,
        line,
      });
    }
    return [];
  };

  const setDeps = (id: string, prefix: string, refs: Ref[], file: string, extra: string[] = []) => {
    const set = new Set(extra);
    for (const { ref, line } of refs) for (const d of resolve(prefix, ref, line, file, id)) set.add(d);
    set.delete(id);
    deps[id] = [...set].sort();
  };

  // ---------------------------------------------------------- dependencias
  // Todo recurso depende de la configuración de su proveedor (p.ej. region = var.region),
  // que se declara en el módulo raíz y la heredan los hijos.
  const providerDeps: Record<string, string[]> = {};
  for (const p of root.providers) {
    const key = p.alias ? `${p.name}.${p.alias}` : p.name;
    providerDeps[key] = [...(providerDeps[key] ?? []), ...bodyRefs(p.body).flatMap((r) => resolve('', r.ref, r.line, p.file, `provider.${key}`))];
  }

  const visit =(cfg: Config, inherited: string[]) => {
    const prefix = cfg.prefix;
    for (const v of Object.values(cfg.variables)) deps[`${prefix}var.${v.name}`] = [];
    for (const l of Object.values(cfg.locals)) setDeps(`${prefix}local.${l.name}`, prefix, exprRefs(l.expr), l.file);
    for (const r of Object.values(cfg.resources)) {
      const refs = bodyRefs(r.body);
      for (const d of r.dependsOn) refs.push({ ref: d, line: r.line });
      conditionRefs([...r.preconditions, ...r.postconditions], refs);
      setDeps(prefix + r.addr, prefix, refs, r.file, [...inherited, ...(providerDeps[r.provider] ?? providerDeps[providerOf(r.type)] ?? [])]);
    }
    for (const o of Object.values(cfg.outputs)) setDeps(`${prefix}output.${o.name}`, prefix, conditionRefs(o.preconditions, exprRefs(o.value)), o.file);
    for (const call of Object.values(cfg.moduleCalls)) {
      const child = cfg.children[call.name];
      if (!child) continue;
      const callDeps = call.dependsOn.flatMap((d) => resolve(prefix, d, call.line, call.file, call.id));
      for (const v of Object.values(child.variables)) {
        const arg = call.args.find((a) => a.name === v.name);
        setDeps(`${child.prefix}var.${v.name}`, prefix, arg ? exprRefs(arg.expr) : [], call.file, callDeps);
      }
      visit(child, [...inherited, ...callDeps]);
    }
  };
  visit(root, []);
  // Los check no son nodos del grafo (se evalúan al final), pero sus referencias deben existir.
  for (const c of root.checks) for (const r of conditionRefs(c.asserts)) resolve('', r.ref, r.line, c.file, `check.${c.name}`);

  // Orden topológico (Kahn) determinista.
  const indeg: Record<string, number> = {};
  const rev: Record<string, string[]> = {};
  for (const id of Object.keys(nodes)) {
    indeg[id] = deps[id]?.length ?? 0;
    for (const d of deps[id] ?? []) (rev[d] ??= []).push(id);
  }
  const ready = Object.keys(nodes).filter((id) => indeg[id] === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const n of rev[id] ?? []) {
      if (--indeg[n] === 0) {
        ready.push(n);
        ready.sort();
      }
    }
  }
  if (order.length < Object.keys(nodes).length) {
    const cyc = Object.keys(nodes).filter((id) => !order.includes(id));
    diagnostics.push({
      severity: 'error',
      summary: 'Cycle',
      detail: `Cycle: ${cyc.join(', ')}`,
      hint: 'Hay una dependencia circular: A depende de B y B depende de A. Terraform no sabe qué crear primero.',
      file: nodes[cyc[0]]?.file,
      line: nodes[cyc[0]]?.line,
    });
    return { nodes, deps, order: [], diagnostics };
  }
  return { nodes, deps, order, diagnostics };
}


/** Recursos (managed/data) de los que depende un nodo, atravesando variables y locals. */
export function resourceDependencies(g: DepGraph, id: string): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (n: string) => {
    for (const d of g.deps[n] ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      const k = g.nodes[d]?.kind;
      if (k === 'resource' || k === 'data') out.add(d);
      else visit(d);
    }
  };
  visit(id);
  return [...out].sort();
}
