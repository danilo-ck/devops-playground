import { findResource, type Diagnostic } from './config';
import type { ApplyEvent, PlanResult, ResourceChange } from './evaluate';
import type { InstanceState, TfState } from './state';
import { formatHcl, isMap, isUnknown, type Value, type ValueMap } from './values';

export type Tone =
  | 'add'
  | 'change'
  | 'destroy'
  | 'replace'
  | 'read'
  | 'muted'
  | 'error'
  | 'warn'
  | 'success'
  | 'bold'
  | 'info'
  | 'cmd'
  | 'hint';

export interface TermLine {
  text: string;
  tone?: Tone;
}

const L = (text: string, tone?: Tone): TermLine => ({ text, tone });

export function renderDiagnostics(diags: Diagnostic[]): TermLine[] {
  const out: TermLine[] = [];
  for (const d of diags) {
    const tone: Tone = d.severity === 'error' ? 'error' : 'warn';
    out.push(L(''), L('╷', tone), L(`│ ${d.severity === 'error' ? 'Error' : 'Warning'}: ${d.summary}`, tone), L('│', tone));
    if (d.file) out.push(L(`│   on ${d.file}${d.line ? ` line ${d.line}` : ''}:`, tone), L('│', tone));
    if (d.detail) for (const line of d.detail.split('\n')) out.push(L(`│ ${line}`, tone));
    out.push(L('╵', tone));
    if (d.hint) out.push(L(`💡 ${d.hint}`, 'hint'));
  }
  return out;
}

const SYMBOL: Record<string, { sym: string; tone: Tone; legend: string }> = {
  create: { sym: '  +', tone: 'add', legend: 'create' },
  update: { sym: '  ~', tone: 'change', legend: 'update in-place' },
  replace: { sym: '-/+', tone: 'replace', legend: 'destroy and then create replacement' },
  delete: { sym: '  -', tone: 'destroy', legend: 'destroy' },
  read: { sym: ' <=', tone: 'read', legend: 'read (data resources)' },
};

const isEmpty = (v: Value | undefined) =>
  v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (isMap(v) && Object.keys(v).length === 0);

function fmt(v: Value | undefined, name: string, sensitive: string[]) {
  return formatHcl(v, sensitive.includes(name) && v !== null && !isUnknown(v));
}

function changeBlock(c: ResourceChange, cfgHas: (addr: string) => boolean): TermLine[] {
  const s = SYMBOL[c.action];
  const out: TermLine[] = [];
  const kind = c.mode === 'data' ? 'data' : 'resource';
  const head = `${s.sym} ${kind} "${c.type}" "${c.name}" {`;
  const comment = {
    create: 'will be created',
    update: 'will be updated in-place',
    replace: 'must be replaced',
    delete: 'will be destroyed',
    read: 'will be read during apply',
    noop: '',
  }[c.action];
  out.push(L(''), L(`  # ${c.addr} ${comment}`, 'bold'));
  if (c.action === 'delete') {
    if (!cfgHas(c.resourceAddr)) out.push(L(`  # (because ${c.resourceAddr} is not in configuration)`, 'muted'));
    else if (c.indexKey !== undefined) out.push(L(`  # (because index ${typeof c.indexKey === 'number' ? `[${c.indexKey}] is out of range for count` : `["${c.indexKey}"] is not in for_each map`})`, 'muted'));
  }
  if (c.action === 'replace' && c.createBeforeDestroy) out.push(L('  # (create_before_destroy: se crea el nuevo antes de borrar el viejo)', 'muted'));
  out.push(L(head, s.tone));

  const pad = (names: string[]) => Math.max(0, ...names.map((n) => n.length));

  if (c.action === 'create' || c.action === 'read') {
    const attrs = Object.entries(c.after ?? {}).filter(([, v]) => !isEmpty(v)).sort(([a], [b]) => a.localeCompare(b));
    const w = pad(attrs.map(([n]) => n));
    for (const [n, v] of attrs) out.push(L(`      ${c.action === 'read' ? '+' : '+'} ${n.padEnd(w)} = ${fmt(v, n, c.sensitiveAttrs)}`, s.tone));
  } else if (c.action === 'delete') {
    const attrs = Object.entries(c.before ?? {}).filter(([, v]) => !isEmpty(v)).sort(([a], [b]) => a.localeCompare(b));
    const w = pad(attrs.map(([n]) => n));
    for (const [n, v] of attrs) out.push(L(`      - ${n.padEnd(w)} = ${fmt(v, n, c.sensitiveAttrs)} -> null`, 'destroy'));
  } else {
    const diffs = [...c.diffs].sort((a, b) => a.name.localeCompare(b.name));
    const w = pad([...diffs.map((d) => d.name), 'id']);
    const changed = new Set(diffs.map((d) => d.name));
    if (!changed.has('id') && c.before?.id) out.push(L(`        ${'id'.padEnd(w)} = ${formatHcl(c.before.id)}`, 'muted'));
    for (const d of diffs) {
      const b = d.before;
      const a = d.after;
      let sym = '~';
      let tone: Tone = 'change';
      let text: string;
      if (isEmpty(b)) {
        sym = '+';
        tone = 'add';
        text = fmt(a, d.name, c.sensitiveAttrs);
      } else if (isEmpty(a)) {
        sym = '-';
        tone = 'destroy';
        text = `${fmt(b, d.name, c.sensitiveAttrs)} -> null`;
      } else text = `${fmt(b, d.name, c.sensitiveAttrs)} -> ${fmt(a, d.name, c.sensitiveAttrs)}`;
      out.push(L(`      ${sym} ${d.name.padEnd(w)} = ${text}${d.forcesReplacement ? ' # forces replacement' : ''}`, d.forcesReplacement ? 'replace' : tone));
    }
    const hidden = Object.entries(c.before ?? {}).filter(([n, v]) => !changed.has(n) && n !== 'id' && !isEmpty(v)).length;
    if (hidden) out.push(L(`        # (${hidden} unchanged attribute${hidden === 1 ? '' : 's'} hidden)`, 'muted'));
  }
  out.push(L('    }', s.tone));
  return out;
}

function renderOutputChanges(p: PlanResult): TermLine[] {
  const ch = p.outputChanges.filter((o) => o.action !== 'noop');
  if (!ch.length) return [];
  const out: TermLine[] = [L(''), L('Changes to Outputs:', 'bold')];
  const w = Math.max(...ch.map((o) => o.name.length));
  for (const o of ch) {
    const v = (x: Value | undefined) => formatHcl(x, o.sensitive);
    if (o.action === 'create') out.push(L(`  + ${o.name.padEnd(w)} = ${v(o.after)}`, 'add'));
    else if (o.action === 'delete') out.push(L(`  - ${o.name.padEnd(w)} = ${v(o.before)} -> null`, 'destroy'));
    else out.push(L(`  ~ ${o.name.padEnd(w)} = ${v(o.before)} -> ${v(o.after)}`, 'change'));
  }
  return out;
}

export function renderPlan(p: PlanResult): TermLine[] {
  if (!p.ok) return renderDiagnostics(p.diagnostics);
  const out: TermLine[] = [...renderDiagnostics(p.diagnostics.filter((d) => d.severity === 'warning'))];
  const actionable = p.changes.filter((c) => c.action !== 'noop');
  const outCh = p.outputChanges.filter((o) => o.action !== 'noop');
  if (!actionable.length) {
    if (outCh.length) {
      out.push(...renderOutputChanges(p));
      out.push(L(''), L('You can apply this plan to save these new output values to the Terraform state, without changing any real infrastructure.', 'muted'));
      return out;
    }
    out.push(
      L(''),
      L('No changes. Your infrastructure matches the configuration.', 'success'),
      L(''),
      L('Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.', 'muted'),
    );
    return out;
  }
  out.push(L(''), L('Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:'));
  const used = new Set(actionable.map((c) => c.action));
  for (const a of ['create', 'update', 'replace', 'delete', 'read']) if (used.has(a as never)) out.push(L(`${SYMBOL[a].sym} ${SYMBOL[a].legend}`, SYMBOL[a].tone));
  out.push(L(''), L('Terraform will perform the following actions:'));
  const cfgHas = (addr: string) => !!findResource(p.config, addr) && !p.destroy;
  for (const c of actionable) out.push(...changeBlock(c, cfgHas));
  out.push(L(''), L(`Plan: ${p.summary.add} to add, ${p.summary.change} to change, ${p.summary.destroy} to destroy.`, 'bold'));
  out.push(...renderOutputChanges(p));
  return out;
}

export function renderApplyEvent(e: ApplyEvent): TermLine | null {
  const id = e.id ? ` [id=${e.id}]` : '';
  if (e.kind === 'error') return null;
  if (e.kind === 'start') {
    switch (e.phase) {
      case 'creating':
        return L(`${e.addr}: Creating...`, 'add');
      case 'modifying':
        return L(`${e.addr}: Modifying...${id}`, 'change');
      case 'destroying':
        return L(`${e.addr}: Destroying...${e.message === 'deposed' ? ` (deposed object)` : ''}${id}`, 'destroy');
      case 'reading':
        return L(`${e.addr}: Reading...`, 'read');
    }
  }
  switch (e.phase) {
    case 'creating':
      return L(`${e.addr}: Creation complete after ${e.seconds}s${id}`, 'add');
    case 'modifying':
      return L(`${e.addr}: Modifications complete after ${e.seconds}s${id}`, 'change');
    case 'destroying':
      return L(`${e.addr}: Destruction complete after ${e.seconds}s`, 'destroy');
    default:
      return L(`${e.addr}: Read complete after 0s${id}`, 'read');
  }
}

export function renderOutputs(outputs: TfState['outputs']): TermLine[] {
  const names = Object.keys(outputs).sort();
  if (!names.length) return [];
  return [
    L(''),
    L('Outputs:', 'success'),
    L(''),
    ...names.map((n) => L(`${n} = ${formatHcl(outputs[n].value, outputs[n].sensitive)}`)),
  ];
}

export function renderInstance(inst: InstanceState): TermLine[] {
  const attrs = Object.entries(inst.attributes)
    .filter(([, v]) => !isEmpty(v))
    .sort(([a], [b]) => a.localeCompare(b));
  const w = Math.max(0, ...attrs.map(([n]) => n.length));
  return [
    L(`# ${inst.addr}:`, 'bold'),
    L(`${inst.mode === 'data' ? 'data' : 'resource'} "${inst.type}" "${inst.name}" {`),
    ...attrs.map(([n, v]) => L(`    ${n.padEnd(w)} = ${formatHcl(v, inst.sensitiveAttrs.includes(n))}`)),
    L('}'),
  ];
}

export const valueLines = (v: Value): TermLine[] => formatPretty(v).split('\n').map((t) => L(t));

/** Formato multilínea para `terraform console`. */
export function formatPretty(v: Value, indent = ''): string {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => `${indent}  ${formatPretty(x, indent + '  ')},`).join('\n')}\n${indent}]`;
  }
  if (isMap(v)) {
    const keys = Object.keys(v as ValueMap);
    if (!keys.length) return '{}';
    const w = Math.max(...keys.map((k) => k.length));
    return `{\n${keys.map((k) => `${indent}  "${k}"${' '.repeat(w - k.length)} = ${formatPretty((v as ValueMap)[k], indent + '  ')}`).join('\n')}\n${indent}}`;
  }
  return formatHcl(v);
}
