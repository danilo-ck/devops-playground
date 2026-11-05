import { allModuleCalls, hasErrors, loadConfig, requiredProviderNames, type Diagnostic, type InstalledModules } from './config';
import { satisfies } from './registry';
import { apply, consoleEval, plan, validate, type Action, type ApplyResult, type PlanResult } from './evaluate';
import { renderDiagnostics, renderInstance, renderOutputs, renderPlan, valueLines, type TermLine, type Tone } from './format';
import { buildGraph } from './graph';
import { PROVIDERS, suggest } from './providers';
import { cloneState, type TfState } from './state';
import { formatHcl } from './values';

/** Registro de comandos ejecutados: lo usan las lecciones para validar objetivos. */
export interface HistoryEntry {
  command: string;
  ok: boolean;
  at: number;
  summary?: { add: number; change: number; destroy: number };
  actions?: Action[];
  args?: string[];
}

export interface CliContext {
  files: Record<string, string>;
  state: TfState;
  initialized: string[];
  consoleMode: boolean;
}

export interface PendingApply {
  destroy: boolean;
  cliVars: Record<string, string>;
  plan: PlanResult;
}

export type CliOutcome =
  | { kind: 'lines'; lines: TermLine[]; history?: HistoryEntry; initialized?: string[]; state?: TfState; plan?: PlanResult; consoleMode?: boolean }
  | { kind: 'confirm'; lines: TermLine[]; pending: PendingApply; plan: PlanResult; history: HistoryEntry }
  | { kind: 'apply'; lines: TermLine[]; result: ApplyResult; history: HistoryEntry }
  | { kind: 'clear' };

const L = (text: string, tone?: Tone): TermLine => ({ text, tone });

export function tokenizeCommand(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    let tok = m[1] ?? m[2] ?? m[3];
    // -var="a=b" → -var=a=b
    tok = tok.replace(/^(-var=)["'](.*)["']$/, '$1$2');
    out.push(tok);
  }
  return out;
}

function parseFlags(args: string[]) {
  const cliVars: Record<string, string> = {};
  const flags = new Set<string>();
  const rest: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-var' || a.startsWith('-var=')) {
      const kv = a === '-var' ? args[++i] : a.slice(5);
      const eq = kv?.indexOf('=') ?? -1;
      if (!kv || eq < 1) errors.push(`Invalid -var option "${kv ?? ''}": usa -var="nombre=valor"`);
      else cliVars[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('-')) flags.add(a.replace(/^--?/, ''));
    else rest.push(a);
  }
  return { cliVars, flags, rest, errors };
}

export const HELP: TermLine[] = [
  L('Comandos disponibles en este simulador:', 'bold'),
  L('  terraform init [-upgrade]      Descarga proveedores y módulos'),
  L('  terraform validate             Comprueba que la configuración es válida'),
  L('  terraform plan                 Muestra qué cambios se harían'),
  L('  terraform apply                Aplica los cambios (pide confirmación)'),
  L('  terraform destroy              Destruye toda la infraestructura'),
  L('  terraform output [nombre]      Muestra los outputs'),
  L('  terraform state list           Lista los recursos del estado'),
  L('  terraform state show <recurso> Muestra un recurso del estado'),
  L('  terraform state rm <recurso>   Olvida un recurso (sin destruirlo)'),
  L('  terraform show                 Muestra todo el estado'),
  L('  terraform graph                Grafo de dependencias en formato DOT'),
  L('  terraform console              Consola para probar expresiones'),
  L('  terraform version              Versión de Terraform'),
  L(''),
  L('Opciones: -var="nombre=valor", -auto-approve, -destroy (en plan)', 'muted'),
  L('Otros: ls, cat <fichero>, clear, help.  Atajo: "tf" equivale a "terraform".', 'muted'),
];

const MOD = 'module:';

/** Módulos instalados: entradas "module:<id>=<source>@<versión>" de la lista de init. */
export function installedModules(initialized: string[]): InstalledModules {
  const out: InstalledModules = {};
  for (const e of initialized) {
    if (!e.startsWith(MOD)) continue;
    const [id, rest] = e.slice(MOD.length).split('=');
    const at = rest.lastIndexOf('@');
    out[id] = { source: rest.slice(0, at), version: rest.slice(at + 1) };
  }
  return out;
}

const providersOf = (initialized: string[]) => initialized.filter((x) => !x.startsWith(MOD));
const shortName = (id: string) => id.replace(/^module\./, '').replace(/\.module\./g, '.');

function checkModules(ctx: CliContext): Diagnostic[] {
  const installed = installedModules(ctx.initialized);
  const cfg = loadConfig(ctx.files, installed);
  const diags: Diagnostic[] = [];
  for (const call of allModuleCalls(cfg)) {
    const inst = installed[call.id];
    const base = { severity: 'error' as const, file: call.file, line: call.line };
    if (!inst) {
      diags.push({
        ...base,
        summary: 'Module not installed',
        detail: 'This module is not yet installed. Run "terraform init" to install all modules required by this configuration.',
        hint: `Has añadido el módulo "${shortName(call.id)}": terraform init lo instala (lo descarga del registro o enlaza la carpeta local) antes de poder usarlo.`,
      });
    } else if (inst.source !== call.source) {
      diags.push({ ...base, summary: 'Module source has changed', detail: 'The source address was changed since this module was installed. Run "terraform init" to install all modules required by this configuration.', hint: 'Has cambiado el source del módulo: vuelve a ejecutar terraform init.' });
    } else if (call.kind === 'registry' && call.version && !satisfies(inst.version, call.version)) {
      diags.push({
        ...base,
        summary: 'Module version requirements have changed',
        detail: `The version requirements have changed since this module was installed and the installed version (${inst.version}) is no longer acceptable. Run "terraform init" to install all modules required by this configuration.`,
        hint: `La versión instalada (${inst.version}) no cumple "${call.version}". Ejecuta terraform init para descargar una compatible.`,
      });
    }
  }
  return diags;
}

function checkInit(ctx: CliContext): TermLine[] | null {
  const cfg = loadConfig(ctx.files, installedModules(ctx.initialized));
  const needed = requiredProviderNames(cfg);
  const missing = needed.filter((p) => !providersOf(ctx.initialized).includes(p));
  const modDiags = checkModules(ctx);
  if (!missing.length) return modDiags.length ? renderDiagnostics(modDiags) : null;
  return renderDiagnostics([...modDiags, 
    {
      severity: 'error',
      summary: providersOf(ctx.initialized).length ? 'Inconsistent dependency lock file' : 'Required plugins are not installed',
      detail: missing
        .map((p) => `- provider registry.terraform.io/${PROVIDERS[p].source}: required by this configuration but no version is selected`)
        .join('\n') + '\n\nTo make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init',
      hint: providersOf(ctx.initialized).length
        ? `Tu configuración usa un proveedor nuevo (${missing.join(', ')}). Ejecuta "terraform init" otra vez para descargarlo.`
        : 'Antes de nada hay que ejecutar "terraform init" para descargar los proveedores (los "plugins" que hablan con la nube).',
    },
  ]);
}

const actionsOf = (p: PlanResult): Action[] => [...new Set(p.changes.map((c) => c.action).filter((a) => a !== 'noop'))];

export function runCommand(input: string, ctx: CliContext): CliOutcome {
  const trimmed = input.trim();
  if (ctx.consoleMode) {
    if (trimmed === 'exit' || trimmed === 'quit') return { kind: 'lines', lines: [], consoleMode: false };
    if (!trimmed) return { kind: 'lines', lines: [] };
    const r = consoleEval(ctx.files, ctx.state, trimmed, installedModules(ctx.initialized));
    if (r.error) return { kind: 'lines', lines: renderDiagnostics([r.error]) };
    return { kind: 'lines', lines: valueLines(r.value!), history: { command: 'console-eval', ok: true, at: Date.now(), args: [trimmed] } };
  }

  const toks = tokenizeCommand(trimmed);
  if (!toks.length) return { kind: 'lines', lines: [] };
  const [bin, ...args] = toks;
  const now = Date.now();

  switch (bin) {
    case 'clear':
    case 'cls':
      return { kind: 'clear' };
    case 'help':
      return { kind: 'lines', lines: HELP };
    case 'ls':
    case 'dir':
      return {
        kind: 'lines',
        lines: [
          L(Object.keys(ctx.files).sort().join('   '), 'info'),
          ...(ctx.initialized.length ? [L('.terraform/   .terraform.lock.hcl' + (Object.keys(ctx.state.resources).length || ctx.state.serial ? '   terraform.tfstate' : ''), 'muted')] : []),
        ],
      };
    case 'cat': {
      const f = args[0];
      if (f === 'terraform.tfstate') return { kind: 'lines', lines: [L('Consulta la pestaña "Estado" para ver el fichero de estado.', 'muted')] };
      if (!f || ctx.files[f] === undefined) return { kind: 'lines', lines: [L(`cat: ${f ?? ''}: No such file or directory`, 'error')] };
      return { kind: 'lines', lines: ctx.files[f].split('\n').map((t) => L(t)) };
    }
    case 'terraform':
    case 'tf':
      break;
    default:
      return {
        kind: 'lines',
        lines: [L(`${bin}: command not found`, 'error'), L('💡 Escribe "help" para ver los comandos disponibles. Los comandos empiezan por "terraform".', 'hint')],
      };
  }

  const [sub, ...rest] = args;
  const { cliVars, flags, rest: positional, errors } = parseFlags(rest);
  if (errors.length) return { kind: 'lines', lines: errors.map((e) => L(e, 'error')) };

  switch (sub) {
    case undefined:
    case '-help':
    case 'help':
      return { kind: 'lines', lines: HELP };
    case 'version':
    case '-version':
      return {
        kind: 'lines',
        lines: [
          L('Terraform v1.9.8 (simulado en el navegador)'),
          L('on browser_wasm'),
          ...providersOf(ctx.initialized).map((p) => L(`+ provider registry.terraform.io/${PROVIDERS[p].source} v${PROVIDERS[p].version}`)),
        ],
      };
    case 'init': {
      const upgrade = flags.has('upgrade');
      const installed = installedModules(ctx.initialized);
      const cfg = loadConfig(ctx.files, upgrade ? {} : installed);
      const lines: TermLine[] = [L('Initializing the backend...', 'bold')];
      const calls = allModuleCalls(cfg);
      if (calls.length) {
        lines.push(L(upgrade ? 'Upgrading modules...' : 'Initializing modules...', 'bold'));
        for (const c of calls) {
          const n = shortName(c.id);
          if (c.kind === 'local') {
            if (c.dir !== undefined) lines.push(L(`- ${n} in ${c.dir}`));
            continue;
          }
          if (!c.resolvedVersion) continue;
          const prev = installed[c.id];
          if (!prev || prev.source !== c.source || prev.version !== c.resolvedVersion)
            lines.push(L(`Downloading registry.terraform.io/${c.source} ${c.resolvedVersion} for ${n}...`, 'info'));
          lines.push(L(`- ${n} in .terraform/modules/${n}`));
        }
      }
      lines.push(L('Initializing provider plugins...', 'bold'));
      if (hasErrors(cfg.diagnostics)) {
        return {
          kind: 'lines',
          lines: [...lines, ...renderDiagnostics(cfg.diagnostics)],
          history: { command: 'init', ok: false, at: now },
        };
      }
      const needed = requiredProviderNames(cfg);
      for (const p of needed) {
        const info = PROVIDERS[p];
        const v = cfg.requiredProviders[p]?.version;
        if (providersOf(ctx.initialized).includes(p)) {
          lines.push(L(`- Reusing previous version of ${info.source} from the dependency lock file`));
          lines.push(L(`- Using previously-installed ${info.source} v${info.version}`));
        } else {
          lines.push(L(`- Finding ${info.source} versions matching "${v ?? '*'}"...`));
          lines.push(L(`- Installing ${info.source} v${info.version}...`));
          lines.push(L(`- Installed ${info.source} v${info.version} (signed by HashiCorp)`));
        }
      }
      if (!needed.length) lines.push(L('No se necesita ningún proveedor todavía: la configuración no declara recursos.', 'muted'));
      lines.push(
        L(''),
        L('Terraform has created a lock file .terraform.lock.hcl to record the provider selections it made above.', 'muted'),
        L(''),
        L('Terraform has been successfully initialized!', 'success'),
        L(''),
        L('You may now begin working with Terraform. Try running "terraform plan" to see any changes that are required for your infrastructure.', 'success'),
      );
      return {
        kind: 'lines',
        lines,
        initialized: [
          ...[...new Set([...providersOf(ctx.initialized), ...needed])].sort(),
          ...calls.filter((c) => c.kind === 'local' || c.resolvedVersion).map((c) => `${MOD}${c.id}=${c.source}@${c.resolvedVersion ?? ''}`),
        ],
        history: { command: 'init', ok: true, at: now },
      };
    }
    case 'validate': {
      const notInit = checkInit(ctx);
      const v = validate(ctx.files, installedModules(ctx.initialized));
      if (hasErrors(v.diagnostics)) {
        return { kind: 'lines', lines: renderDiagnostics(v.diagnostics), history: { command: 'validate', ok: false, at: now } };
      }
      return {
        kind: 'lines',
        lines: [
          ...renderDiagnostics(v.diagnostics),
          L('Success! The configuration is valid.', 'success'),
          ...(notInit ? [L('💡 Ojo: aún no has ejecutado terraform init.', 'hint')] : []),
        ],
        history: { command: 'validate', ok: true, at: now },
      };
    }
    case 'plan': {
      const notInit = checkInit(ctx);
      if (notInit) return { kind: 'lines', lines: notInit, history: { command: 'plan', ok: false, at: now } };
      const p = plan(ctx.files, ctx.state, { modules: installedModules(ctx.initialized), cliVars, destroy: flags.has('destroy') });
      return {
        kind: 'lines',
        lines: renderPlan(p),
        plan: p,
        history: { command: 'plan', ok: p.ok, at: now, summary: p.summary, actions: actionsOf(p), args: rest },
      };
    }
    case 'apply':
    case 'destroy': {
      const destroy = sub === 'destroy' || flags.has('destroy');
      const notInit = checkInit(ctx);
      const command = destroy ? 'destroy' : 'apply';
      if (notInit) return { kind: 'lines', lines: notInit, history: { command, ok: false, at: now } };
      const p = plan(ctx.files, ctx.state, { modules: installedModules(ctx.initialized), cliVars, destroy });
      const lines = renderPlan(p);
      const history: HistoryEntry = { command, ok: p.ok, at: now, summary: p.summary, actions: actionsOf(p), args: rest };
      if (!p.ok) return { kind: 'lines', lines, plan: p, history };
      const hasWork = p.changes.some((c) => c.action !== 'noop') || p.outputChanges.some((o) => o.action !== 'noop');
      if (!hasWork) {
        if (destroy) lines.push(L(''), L('Destroy complete! Resources: 0 destroyed.', 'success'));
        else lines.push(L(''), L('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.', 'success'), ...renderOutputs(ctx.state.outputs));
        return { kind: 'lines', lines, plan: p, history };
      }
      if (flags.has('auto-approve')) {
        const result = apply(ctx.files, ctx.state, { modules: installedModules(ctx.initialized), cliVars, destroy });
        return { kind: 'apply', lines, result, history };
      }
      lines.push(
        L(''),
        L(destroy ? 'Do you really want to destroy all resources?' : 'Do you want to perform these actions?', 'bold'),
        L(destroy ? '  Terraform will destroy all your managed infrastructure, as shown above.' : '  Terraform will perform the actions described above.'),
        L(destroy ? '  There is no undo. Only \'yes\' will be accepted to confirm.' : "  Only 'yes' will be accepted to approve."),
        L(''),
      );
      return { kind: 'confirm', lines, plan: p, pending: { destroy, cliVars, plan: p }, history: { ...history, ok: true } };
    }
    case 'output': {
      const outs = ctx.state.outputs;
      if (positional[0]) {
        const o = outs[positional[0]];
        if (!o) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: `Output "${positional[0]}" not found`, detail: 'The output variable requested could not be found in the state file.', hint: 'Los outputs aparecen en el estado después de hacer apply.' }]), history: { command: 'output', ok: false, at: now } };
        return { kind: 'lines', lines: [L(o.sensitive ? '(sensitive value)' : formatHcl(o.value))], history: { command: 'output', ok: true, at: now, args: positional } };
      }
      const lines = renderOutputs(outs).slice(3);
      if (!lines.length)
        return {
          kind: 'lines',
          lines: renderDiagnostics([{ severity: 'warning', summary: 'No outputs found', detail: 'The state file either has no outputs defined, or all the defined outputs are empty.', hint: 'Define bloques output y ejecuta terraform apply.' }]),
          history: { command: 'output', ok: true, at: now },
        };
      return { kind: 'lines', lines, history: { command: 'output', ok: true, at: now } };
    }
    case 'show': {
      const insts = Object.values(ctx.state.resources).sort((a, b) => a.addr.localeCompare(b.addr));
      if (!insts.length) return { kind: 'lines', lines: [L('The state file is empty. No resources are represented.', 'muted')], history: { command: 'show', ok: true, at: now } };
      return { kind: 'lines', lines: [...insts.flatMap((i) => [...renderInstance(i), L('')]), ...renderOutputs(ctx.state.outputs)], history: { command: 'show', ok: true, at: now } };
    }
    case 'state': {
      const [op, target] = positional;
      const insts = Object.values(ctx.state.resources).sort((a, b) => a.addr.localeCompare(b.addr, 'en', { numeric: true }));
      if (op === 'list') {
        return {
          kind: 'lines',
          lines: insts.length ? insts.map((i) => L(i.mode === 'data' ? `data.${i.addr.replace(/^data\./, '')}` : i.addr)) : [L('(el estado está vacío)', 'muted')],
          history: { command: 'state list', ok: true, at: now },
        };
      }
      if (op === 'show' || op === 'rm') {
        if (!target) return { kind: 'lines', lines: [L(`Uso: terraform state ${op} <dirección>, p.ej. terraform state ${op} aws_vpc.main`, 'error')] };
        const inst = ctx.state.resources[target];
        if (!inst) {
          return {
            kind: 'lines',
            lines: renderDiagnostics([{ severity: 'error', summary: `No instance found for the given address!`, detail: `This command requires that the address references one specific instance.`, hint: 'Usa "terraform state list" para ver las direcciones exactas. Con count se escribe así: aws_instance.web[0]' }]),
            history: { command: `state ${op}`, ok: false, at: now },
          };
        }
        if (op === 'show') return { kind: 'lines', lines: renderInstance(inst), history: { command: 'state show', ok: true, at: now, args: [target] } };
        const next = cloneState(ctx.state);
        delete next.resources[target];
        next.serial++;
        return {
          kind: 'lines',
          lines: [L(`Removed ${target}`, 'success'), L('Successfully removed 1 resource instance(s).', 'success'), L('💡 El recurso sigue existiendo en la nube, pero Terraform ya no lo gestiona. Si haces plan, querrá crearlo de nuevo.', 'hint')],
          state: next,
          history: { command: 'state rm', ok: true, at: now, args: [target] },
        };
      }
      return { kind: 'lines', lines: [L('Uso: terraform state <list|show|rm> [dirección]', 'error')] };
    }
    case 'graph': {
      const cfg = loadConfig(ctx.files, installedModules(ctx.initialized));
      if (hasErrors(cfg.diagnostics)) return { kind: 'lines', lines: renderDiagnostics(cfg.diagnostics) };
      const g = buildGraph(cfg);
      const lines = [L('digraph {'), L('  rankdir = "RL"')];
      for (const [id, deps] of Object.entries(g.deps)) for (const d of deps) lines.push(L(`  "${id}" -> "${d}"`));
      lines.push(L('}'), L('💡 Mira la pestaña "Grafo" para verlo dibujado.', 'hint'));
      return { kind: 'lines', lines, history: { command: 'graph', ok: true, at: now } };
    }
    case 'console':
      return {
        kind: 'lines',
        lines: [L('Consola de Terraform. Escribe expresiones como var.nombre, upper("hola") o cidrsubnet("10.0.0.0/16", 8, 1).', 'info'), L('Escribe "exit" para salir.', 'muted')],
        consoleMode: true,
        history: { command: 'console', ok: true, at: now },
      };
    case 'fmt':
      return { kind: 'lines', lines: [L('💡 terraform fmt reformatea el código con el estilo estándar. En el simulador no modifica ficheros.', 'hint')] };
    default: {
      const s = suggest(sub, ['init', 'validate', 'plan', 'apply', 'destroy', 'output', 'state', 'show', 'graph', 'console', 'version', 'fmt']);
      return {
        kind: 'lines',
        lines: [
          L(`Terraform has no command named "${sub}".${s ? ` Did you mean "${s}"?` : ''}`, 'error'),
          L(s ? `💡 ¿Querías escribir "terraform ${s}"?` : '💡 Escribe "terraform help" para ver los comandos disponibles.', 'hint'),
        ],
      };
    }
  }
}

/** Ejecuta un apply ya confirmado ('yes'). */
export function confirmApply(pending: PendingApply, ctx: CliContext): ApplyResult {
  return apply(ctx.files, ctx.state, { modules: installedModules(ctx.initialized), cliVars: pending.cliVars, destroy: pending.destroy });
}

export function applySummaryLines(r: ApplyResult): TermLine[] {
  if (!r.ok) return renderDiagnostics(r.diagnostics.filter((d) => d.severity === 'error'));
  if (r.destroy) return [L(''), L(`Destroy complete! Resources: ${r.summary.destroy} destroyed.`, 'success')];
  return [
    L(''),
    L(`Apply complete! Resources: ${r.summary.add} added, ${r.summary.change} changed, ${r.summary.destroy} destroyed.`, 'success'),
    ...renderOutputs(r.state.outputs),
  ];
}
