import type { Body, Expr } from './parser';
import type { Config, Diagnostic } from './config';
import { providerOf, suggest } from './providers';

export type NodeKind = 'variable' | 'local' | 'resource' | 'data' | 'output';

export interface GraphNode {
  id: string;
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

export function bodyRefs(body: Body, out: Ref[] = []): Ref[] {
  for (const a of body.attributes) if (a.name !== 'depends_on') exprRefs(a.expr, new Set(), out);
  for (const b of body.blocks) if (b.type !== 'lifecycle') bodyRefs(b.body, out);
  return out;
}

export function buildGraph(cfg: Config): DepGraph {
  const nodes: Record<string, GraphNode> = {};
  const deps: Record<string, string[]> = {};
  const diagnostics: Diagnostic[] = [];

  for (const v of Object.values(cfg.variables))
    nodes[`var.${v.name}`] = { id: `var.${v.name}`, kind: 'variable', label: v.name, file: v.file, line: v.line };
  for (const l of Object.values(cfg.locals))
    nodes[`local.${l.name}`] = { id: `local.${l.name}`, kind: 'local', label: l.name, file: l.file, line: l.line };
  for (const r of Object.values(cfg.resources))
    nodes[r.addr] = {
      id: r.addr,
      kind: r.mode === 'managed' ? 'resource' : 'data',
      label: r.name,
      type: r.type,
      file: r.file,
      line: r.line,
      multi: r.count ? 'count' : r.forEach ? 'for_each' : undefined,
    };
  for (const o of Object.values(cfg.outputs))
    nodes[`output.${o.name}`] = { id: `output.${o.name}`, kind: 'output', label: o.name, file: o.file, line: o.line };

  const resourceAddrs = Object.keys(cfg.resources);
  const addDeps = (id: string, refs: Ref[], file: string) => {
    const set = new Set<string>();
    for (const { ref, line } of refs) {
      if (nodes[ref]) {
        if (ref === id) {
          diagnostics.push({
            severity: 'error',
            summary: 'Self-referential block',
            detail: `Configuration for ${id} may not refer to itself.`,
            hint: 'Un recurso no puede usar sus propios atributos en su configuración.',
            file,
            line,
          });
          continue;
        }
        set.add(ref);
        continue;
      }
      if (ref.startsWith('var.')) {
        const name = ref.slice(4);
        diagnostics.push({
          severity: 'error',
          summary: 'Reference to undeclared input variable',
          detail: `An input variable with the name "${name}" has not been declared.`,
          hint: `Declara la variable con: variable "${name}" { ... }`,
          file,
          line,
        });
      } else if (ref.startsWith('local.')) {
        const name = ref.slice(6);
        diagnostics.push({
          severity: 'error',
          summary: 'Reference to undeclared local value',
          detail: `A local value with the name "${name}" has not been declared.`,
          hint: `Defínelo dentro de un bloque locals { ${name} = ... }`,
          file,
          line,
        });
      } else if (ref.startsWith('module.')) {
        diagnostics.push({ severity: 'error', summary: 'Reference to undeclared module', detail: `No module call named "${ref.slice(7)}" is declared.`, file, line });
      } else {
        const s = suggest(ref, resourceAddrs);
        const [type, name] = ref.startsWith('data.') ? ref.slice(5).split('.') : ref.split('.');
        diagnostics.push({
          severity: 'error',
          summary: 'Reference to undeclared resource',
          detail: `A ${ref.startsWith('data.') ? 'data' : 'managed'} resource "${type}" "${name}" has not been declared in the root module.`,
          hint: s ? `¿Querías referirte a ${s}?` : `No existe ningún recurso "${ref}". Comprueba el tipo y el nombre.`,
          file,
          line,
        });
      }
    }
    deps[id] = [...set].sort();
  };

  for (const v of Object.values(cfg.variables)) deps[`var.${v.name}`] = [];
  for (const l of Object.values(cfg.locals)) addDeps(`local.${l.name}`, exprRefs(l.expr), l.file);
  for (const r of Object.values(cfg.resources)) {
    const refs = bodyRefs(r.body);
    // Un recurso depende también de la configuración de su proveedor (p.ej. region = var.region).
    for (const p of cfg.providers) if (p.name === providerOf(r.type)) bodyRefs(p.body, refs);
    for (const d of r.dependsOn) refs.push({ ref: d, line: r.line });
    addDeps(r.addr, refs, r.file);
  }
  for (const o of Object.values(cfg.outputs)) addDeps(`output.${o.name}`, exprRefs(o.value), o.file);

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
