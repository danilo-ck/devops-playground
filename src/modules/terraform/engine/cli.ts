import {
  cloudCreate,
  cloudDelete,
  cloudEntries,
  cloudModify,
  CloudError,
  emptyCloud,
  forgetInstance,
  type CloudChanges,
} from './cloud';
import { allModuleCalls, findResource, hasErrors, loadConfig, moduleConfigs, requiredProviderNames, splitAddr, type Config, type Diagnostic, type InstalledModules } from './config';
import { satisfies } from './registry';
import { apply, consoleEval, plan, validate, type Action, type ApplyResult, type PlanResult, type RunOptions } from './evaluate';
import { renderDiagnostics, renderInstance, renderOutputs, renderPlan, renderRefreshing, valueLines, type TermLine, type Tone } from './format';
import { formatHclSource, simpleDiff } from './fmt';
import { buildGraph } from './graph';
import { costAndPolicyLines, DEFAULT_POLICIES, evaluatePolicies, policyOutcome, remoteRunHeader, type Policy } from './hcp';
import { getSchema, PROVIDER_VERSIONS, PROVIDERS, suggest, TF_VERSION } from './providers';
import { cloneState, emptyState, moveInState, toTfStateJson, type TfState } from './state';
import { logLevel, logLines } from './tflog';
import { cloneValue, formatHcl, isMap, toJson, type ValueMap } from './values';

/** Registro de comandos ejecutados: lo usan las lecciones para validar objetivos. */
export interface HistoryEntry {
  command: string;
  ok: boolean;
  at: number;
  summary?: { add: number; change: number; destroy: number; import?: number };
  actions?: Action[];
  args?: string[];
  /** Resultado de las políticas de HCP Terraform (si la ejecución fue remota). */
  policy?: 'pass' | 'advisory' | 'soft' | 'hard';
  /** Workspace en el que se ejecutó. */
  workspace?: string;
  /** Nivel de TF_LOG activo durante el comando. */
  log?: string;
}

/** Bloqueo del estado que tiene otra persona (simulado con el comando team). */
export interface StateLock {
  id: string;
  who: string;
  operation: string;
  created: number;
  /** Clave "<backend>|<workspace>" del estado bloqueado. */
  key: string;
  /** Segundos hasta que el compañero termine; null = bloqueo huérfano (se colgó). */
  releaseAfter: number | null;
}

/** Plan guardado con terraform plan -out=fichero. */
export interface SavedPlan {
  name: string;
  files: Record<string, string>;
  lineage: string;
  serial: number;
  workspace: string;
  opts: { cliVars: Record<string, string>; destroy: boolean; refreshOnly: boolean; refresh: boolean; replace: string[]; varFiles: string[] };
}

export interface CliContext {
  files: Record<string, string>;
  state: TfState;
  initialized: string[];
  consoleMode: boolean;
  /** Cambios hechos fuera de Terraform (la nube real). */
  cloud?: CloudChanges;
  /** Variables de entorno de la sesión (export TF_LOG=DEBUG, TF_VAR_x…). */
  env?: Record<string, string>;
  /** Workspace activo (por defecto "default"). */
  workspace?: string;
  /** Estados que no están activos, por clave "<backend>|<workspace>". */
  stateStore?: Record<string, TfState>;
  lock?: StateLock | null;
  savedPlans?: Record<string, SavedPlan>;
  /** Políticas de HCP Terraform de la organización. */
  policies?: Policy[];
}

export interface PendingApply {
  destroy: boolean;
  refreshOnly?: boolean;
  plan: PlanResult;
  opts: RunOptions;
  /** terraform force-unlock: id del bloqueo a quitar. */
  unlockId?: string;
  /** HCP Terraform: una política soft-mandatory ha fallado y hay que escribir "override". */
  policyOverride?: boolean;
  remote?: boolean;
  /** Argumentos originales del comando (para el historial). */
  args?: string[];
  policy?: HistoryEntry['policy'];
}

/** Cambios de sesión que devuelve un comando, además de las líneas. */
interface SessionChanges {
  history?: HistoryEntry;
  initialized?: string[];
  state?: TfState;
  plan?: PlanResult;
  consoleMode?: boolean;
  cloud?: CloudChanges;
  /** Ficheros nuevos o modificados (p.ej. -generate-config-out o terraform fmt). */
  files?: Record<string, string>;
  env?: Record<string, string>;
  workspace?: string;
  stateStore?: Record<string, TfState>;
  /** null = quitar el bloqueo. */
  lock?: StateLock | null;
  savedPlans?: Record<string, SavedPlan>;
}

export type CliOutcome =
  | ({ kind: 'lines'; lines: TermLine[] } & SessionChanges)
  | ({ kind: 'confirm'; lines: TermLine[]; pending: PendingApply; plan: PlanResult; history: HistoryEntry } & SessionChanges)
  | ({ kind: 'apply'; lines: TermLine[]; result: ApplyResult; history: HistoryEntry } & SessionChanges)
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
  const multi: Record<string, string[]> = { replace: [], 'var-file': [], target: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-var' || a.startsWith('-var=')) {
      const kv = a === '-var' ? args[++i] : a.slice(5);
      const eq = kv?.indexOf('=') ?? -1;
      if (!kv || eq < 1) errors.push(`Invalid -var option "${kv ?? ''}": usa -var="nombre=valor"`);
      else cliVars[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('-')) {
      const f = a.replace(/^--?/, '');
      const eq = f.indexOf('=');
      const name = eq > 0 ? f.slice(0, eq) : f;
      if (name in multi) {
        const v = eq > 0 ? f.slice(eq + 1) : args[++i];
        if (v) multi[name].push(v.replace(/^["']|["']$/g, ''));
      } else flags.add(f);
    } else rest.push(a);
  }
  const value = (name: string) => [...flags].find((f) => f.startsWith(name + '='))?.slice(name.length + 1);
  return { cliVars, flags, rest, errors, multi, value };
}

export const HELP: TermLine[] = [
  L('Comandos disponibles en este simulador:', 'bold'),
  L('  terraform init [-upgrade] [-migrate-state|-reconfigure]   Proveedores, módulos y backend'),
  L('  terraform validate | fmt [-check] [-diff] [-recursive]'),
  L('  terraform plan [-out=tfplan] [-refresh-only] [-refresh=false] [-replace=dir] [-var-file=f]'),
  L('  terraform apply [tfplan] [-auto-approve] [-refresh-only] [-replace=dir]'),
  L('  terraform destroy'),
  L('  terraform output [-json] [-raw nombre]'),
  L('  terraform state list|show|mv|rm|pull'),
  L('  terraform import <dir> <id>   ·   terraform taint|untaint <dir> (obsoletos: usa -replace)'),
  L('  terraform workspace list|show|new|select|delete'),
  L('  terraform providers | version | graph | console | show [tfplan]'),
  L('  terraform force-unlock <id>   ·   terraform login | logout'),
  L(''),
  L('Opciones: -var="nombre=valor", -var-file=f.tfvars, -lock=false, -lock-timeout=60s', 'muted'),
  L('Entorno: export TF_LOG=DEBUG, export TF_LOG_PATH=terraform.log, export TF_VAR_nombre=valor, unset, env', 'muted'),
  L(''),
  L('Simulación (cosas que pasan FUERA de Terraform):', 'bold'),
  L('  cloud ls | modify <id|dir> atr=valor | delete <id|dir> | create <tipo> atr=valor'),
  L('  team apply   Un compañero lanza un apply (bloquea el estado remoto un minuto)'),
  L('  team crash   Un compañero se queda colgado a mitad de apply (bloqueo huérfano)'),
  L('Otros: ls, cat <fichero>, clear, help.  Atajo: "tf" equivale a "terraform".', 'muted'),
];

// ------------------------------------------------------------ lo que guarda terraform init

const MOD = 'module:';
const LOCK = 'lock:';
const BACKEND = 'backend:';
const LOGIN = 'hcp:login';

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

const providersOf = (initialized: string[]) => initialized.filter((x) => !x.includes(':'));
/** Versión fijada en .terraform.lock.hcl (si el proveedor se instaló sin lock explícito, la última). */
export function lockedVersion(initialized: string[], p: string): string | undefined {
  const e = initialized.find((x) => x.startsWith(`${LOCK}${p}=`));
  if (e) return e.split('=')[1];
  return providersOf(initialized).includes(p) ? PROVIDERS[p]?.version : undefined;
}
/** Backend activo: "local", "s3:bucket/key", "cloud:org/workspace"… */
export const currentBackend = (initialized: string[]) => initialized.find((x) => x.startsWith(BACKEND))?.slice(BACKEND.length) ?? 'local';
const loggedIn = (initialized: string[]) => initialized.includes(LOGIN);

export function backendIdOf(cfg: Config): string {
  if (cfg.cloud) return `cloud:${cfg.cloud.organization ?? '?'}/${cfg.cloud.workspaceName ?? (cfg.cloud.workspaceTags ?? []).join(',')}`;
  const b = cfg.backend;
  if (!b || b.type === 'local') return 'local';
  const a = b.attrs;
  return `${b.type}:${a.bucket ?? a.storage_account_name ?? a.address ?? a.organization ?? ''}/${a.key ?? a.prefix ?? a.container_name ?? ''}`;
}
const backendType = (id: string) => id.split(':')[0];
const storeKey = (backend: string, ws: string) => `${backend}|${ws}`;

const shortName = (id: string) => id.replace(/^module\./, '').replace(/\.module\./g, '.');

/** Restricciones de versión de un proveedor en todo el árbol de módulos. */
function constraintsFor(cfg: Config, p: string): string[] {
  return Object.values(moduleConfigs(cfg))
    .map((c) => c.requiredProviders[p]?.version)
    .filter((v): v is string => !!v);
}
const satisfiesAll = (v: string, cs: string[]) => cs.every((c) => satisfies(v, c));

function checkModules(ctx: CliContext, cfg: Config): Diagnostic[] {
  const installed = installedModules(ctx.initialized);
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
  const installed = providersOf(ctx.initialized);
  const missing = needed.filter((p) => !installed.includes(p));
  const diags = checkModules(ctx, cfg);
  if (ctx.initialized.length && backendIdOf(cfg) !== currentBackend(ctx.initialized)) {
    const first = currentBackend(ctx.initialized) === 'local' && backendIdOf(cfg) !== 'local';
    diags.push({
      severity: 'error',
      summary: 'Backend initialization required, please run "terraform init"',
      detail: first ? `Reason: Initial configuration of the requested backend "${backendType(backendIdOf(cfg))}"` : 'Reason: Backend configuration block has changed',
      hint: 'Has cambiado dónde se guarda el estado (backend o cloud). Ejecuta terraform init; si ya hay estado, decide si migrarlo (-migrate-state) o empezar de cero (-reconfigure).',
    });
  }
  const mismatched = needed.filter((p) => installed.includes(p)).map((p) => [p, lockedVersion(ctx.initialized, p)!, constraintsFor(cfg, p)] as const).filter(([, v, cs]) => !satisfiesAll(v, cs));
  if (mismatched.length) {
    diags.push({
      severity: 'error',
      summary: 'Inconsistent dependency lock file',
      detail: mismatched.map(([p, v, cs]) => `- provider registry.terraform.io/${PROVIDERS[p].source}: locked version selection ${v} doesn't match the updated version constraints "${cs.join(', ')}"`).join('\n') + '\n\nTo update the locked dependency selections to match a changed configuration, run:\n  terraform init -upgrade',
      hint: 'Has cambiado la restricción de versión del proveedor y la versión fijada en .terraform.lock.hcl ya no la cumple. terraform init -upgrade elige otra versión.',
    });
  }
  if (missing.length) {
    diags.push({
      severity: 'error',
      summary: installed.length ? 'Inconsistent dependency lock file' : 'Required plugins are not installed',
      detail:
        missing.map((p) => `- provider registry.terraform.io/${PROVIDERS[p].source}: required by this configuration but no version is selected`).join('\n') +
        '\n\nTo make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init',
      hint: installed.length
        ? `Tu configuración usa un proveedor nuevo (${missing.join(', ')}). Ejecuta "terraform init" otra vez para descargarlo.`
        : 'Antes de nada hay que ejecutar "terraform init" para descargar los proveedores (los "plugins" que hablan con la nube).',
    });
  }
  return diags.length ? renderDiagnostics(diags) : null;
}

const actionsOf = (p: PlanResult): Action[] => [...new Set(p.changes.map((c) => c.action).filter((a) => a !== 'noop'))];

// ------------------------------------------------------------ bloqueo del estado

const LOCK_FLAG_HINT = 'Terraform acquires a state lock to protect the state from being written\nby multiple users at the same time. Please resolve the issue above and try\nagain. For most commands, you can disable locking with the "-lock=false"\nflag, but this is not recommended.';

/** Comprueba el bloqueo antes de una operación que escribe (o lee para escribir) el estado. */
function lockGuard(ctx: CliContext, flags: Set<string>, timeout: string | undefined): { error?: TermLine[]; lines: TermLine[]; clear?: boolean } {
  const lock = ctx.lock;
  const key = storeKey(currentBackend(ctx.initialized), ctx.workspace ?? 'default');
  if (!lock || lock.key !== key) return { lines: [] };
  const elapsed = (Date.now() - lock.created) / 1000;
  if (lock.releaseAfter !== null && elapsed >= lock.releaseAfter) return { lines: [], clear: true };
  if (flags.has('lock=false')) return { lines: [L('💡 -lock=false: te saltas el bloqueo. Si tu compañero está escribiendo el estado a la vez, podéis corromperlo.', 'hint')] };
  const secs = timeout ? parseInt(timeout, 10) * (timeout.endsWith('m') ? 60 : 1) : 0;
  if (lock.releaseAfter !== null && secs > 0 && elapsed + secs >= lock.releaseAfter) {
    return { lines: [L('Acquiring state lock. This may take a few moments...', 'muted'), L(`💡 Has esperado ${Math.ceil(lock.releaseAfter - elapsed)}s con -lock-timeout hasta que tu compañero terminó.`, 'hint')], clear: true };
  }
  const created = new Date(lock.created).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  return {
    lines: [],
    error: [
      ...renderDiagnostics([
        {
          severity: 'error',
          summary: 'Error acquiring the state lock',
          detail: `Error message: ConditionalCheckFailedException: The conditional request failed\nLock Info:\n  ID:        ${lock.id}\n  Path:      ${lock.key.split('|')[0].replace(/^[a-z]+:/, '')}\n  Operation: ${lock.operation}\n  Who:       ${lock.who}\n  Version:   ${TF_VERSION}\n  Created:   ${created}\n  Info:\n\n${LOCK_FLAG_HINT}`,
          hint:
            lock.releaseAfter === null
              ? `El apply de ${lock.who.split('@')[0]} se colgó y el bloqueo se quedó huérfano. Si estás seguro de que nadie está usando el estado: terraform force-unlock ${lock.id}`
              : `${lock.who.split('@')[0]} está aplicando ahora mismo. Espera (prueba -lock-timeout=90s) en lugar de saltarte el bloqueo.`,
        },
      ]),
    ],
  };
}

const LOCKING = new Set(['plan', 'apply', 'destroy', 'refresh', 'import', 'taint', 'untaint']);

// ------------------------------------------------------------ lock file

const fakeHash = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  for (let i = 0; i < 43; i++) {
    h = Math.imul(h ^ (h >>> 13), 1103515245) >>> 0;
    out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[h % 64];
  }
  return out;
};

function lockFile(ctx: CliContext): string | undefined {
  const cfg = loadConfig(ctx.files, installedModules(ctx.initialized));
  const ps = providersOf(ctx.initialized);
  if (!ps.length) return undefined;
  const blocks = ps.map((p) => {
    const v = lockedVersion(ctx.initialized, p)!;
    const cs = constraintsFor(cfg, p);
    return [
      `provider "registry.terraform.io/${PROVIDERS[p].source}" {`,
      `  version     = "${v}"`,
      ...(cs.length ? [`  constraints = "${cs.join(', ')}"`] : []),
      '  hashes = [',
      `    "h1:${fakeHash(p + v)}=",`,
      `    "zh:${fakeHash(v + p).toLowerCase().replace(/[^a-z0-9]/g, '0')}",`,
      '  ]',
      '}',
    ].join('\n');
  });
  return `# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\n${blocks.join('\n\n')}\n`;
}

// ------------------------------------------------------------ comandos de shell

const ENV_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function runShell(bin: string, args: string[], ctx: CliContext): CliOutcome | null {
  const env = ctx.env ?? {};
  switch (bin) {
    case 'export': {
      const next = { ...env };
      const set: string[] = [];
      for (const a of args) {
        const m = ENV_RE.exec(a);
        if (!m) return { kind: 'lines', lines: [L(`export: "${a}": usa export NOMBRE=valor`, 'error')] };
        next[m[1]] = m[2];
        set.push(m[1]);
      }
      const hints: TermLine[] = [];
      if (set.includes('TF_LOG')) hints.push(L(`💡 TF_LOG=${next.TF_LOG}: los próximos comandos terraform mostrarán logs detallados (TRACE, DEBUG, INFO, WARN o ERROR). "unset TF_LOG" para quitarlo.`, 'hint'));
      if (set.includes('TF_LOG_PATH')) hints.push(L(`💡 Los logs se escribirán en ${next.TF_LOG_PATH} en lugar de en la terminal (necesita TF_LOG).`, 'hint'));
      for (const k of set.filter((x) => x.startsWith('TF_VAR_'))) hints.push(L(`💡 ${k}: Terraform lo usará como valor de var.${k.slice(7)} (tiene menos prioridad que terraform.tfvars y -var).`, 'hint'));
      return { kind: 'lines', lines: hints, env: next, history: { command: 'export', ok: true, at: Date.now(), args } };
    }
    case 'unset': {
      const next = { ...env };
      for (const a of args) delete next[a];
      return { kind: 'lines', lines: [], env: next, history: { command: 'unset', ok: true, at: Date.now(), args } };
    }
    case 'env':
    case 'printenv': {
      const keys = args.length ? args : Object.keys(env).sort();
      return { kind: 'lines', lines: keys.length ? keys.filter((k) => k in env).map((k) => L(args.length ? env[k] : `${k}=${env[k]}`)) : [L('(no hay variables de entorno definidas)', 'muted')] };
    }
    case 'echo':
      return { kind: 'lines', lines: [L(args.map((a) => a.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, k) => env[k] ?? '')).join(' '))] };
    default:
      return null;
  }
}

// ------------------------------------------------------------ runCommand

export function runCommand(input: string, ctx: CliContext): CliOutcome {
  const trimmed = input.trim();
  if (ctx.consoleMode) {
    if (trimmed === 'exit' || trimmed === 'quit') return { kind: 'lines', lines: [], consoleMode: false };
    if (!trimmed) return { kind: 'lines', lines: [] };
    const r = consoleEval(ctx.files, ctx.state, trimmed, installedModules(ctx.initialized), { env: ctx.env, workspace: ctx.workspace });
    if (r.error) return { kind: 'lines', lines: renderDiagnostics([r.error]) };
    return { kind: 'lines', lines: r.sensitive ? [L('(sensitive value)')] : valueLines(r.value!), history: { command: 'console-eval', ok: true, at: Date.now(), args: [trimmed] } };
  }

  let toks = tokenizeCommand(trimmed);
  // VAR=valor terraform plan  → variables de entorno solo para este comando
  const inlineEnv: Record<string, string> = {};
  while (toks.length > 1 && ENV_RE.test(toks[0]) && toks[0] !== 'export') {
    const m = ENV_RE.exec(toks[0])!;
    inlineEnv[m[1]] = m[2];
    toks = toks.slice(1);
  }
  if (!toks.length) return { kind: 'lines', lines: [] };
  const [bin, ...args] = toks;
  const now = Date.now();
  const shell = runShell(bin, args, ctx);
  if (shell) return shell;

  switch (bin) {
    case 'clear':
    case 'cls':
      return { kind: 'clear' };
    case 'help':
      return { kind: 'lines', lines: HELP };
    case 'ls':
    case 'dir': {
      const extra = [
        ...(ctx.initialized.length ? ['.terraform/', '.terraform.lock.hcl'] : []),
        ...(currentBackend(ctx.initialized) === 'local' && (Object.keys(ctx.state.resources).length || ctx.state.serial) ? ['terraform.tfstate'] : []),
        ...(Object.keys(ctx.stateStore ?? {}).some((k) => k.startsWith('local|') && k !== 'local|default') ? ['terraform.tfstate.d/'] : []),
        ...Object.keys(ctx.savedPlans ?? {}),
      ];
      return { kind: 'lines', lines: [L(Object.keys(ctx.files).sort().join('   '), 'info'), ...(extra.length ? [L(extra.join('   '), 'muted')] : [])] };
    }
    case 'cat': {
      const f = args[0];
      if (f === 'terraform.tfstate') return { kind: 'lines', lines: [L('Consulta la pestaña "Estado" para ver el fichero de estado.', 'muted')] };
      if (f === '.terraform.lock.hcl') {
        const lf = lockFile(ctx);
        return { kind: 'lines', lines: lf ? lf.trimEnd().split('\n').map((t) => L(t)) : [L('cat: .terraform.lock.hcl: No such file or directory (ejecuta terraform init)', 'error')] };
      }
      if (!f || ctx.files[f] === undefined) return { kind: 'lines', lines: [L(`cat: ${f ?? ''}: No such file or directory`, 'error')] };
      return { kind: 'lines', lines: ctx.files[f].split('\n').map((t) => L(t)) };
    }
    case 'cloud':
      return runCloud(args, ctx, now);
    case 'team':
      return runTeam(args, ctx, now);
    case 'terraform':
    case 'tf':
      break;
    default:
      return {
        kind: 'lines',
        lines: [L(`${bin}: command not found`, 'error'), L('💡 Escribe "help" para ver los comandos disponibles. Los comandos empiezan por "terraform".', 'hint')],
      };
  }

  const env = { ...(ctx.env ?? {}), ...inlineEnv };
  const out = runTerraform(args, { ...ctx, env }, now);
  return withLogs(out, args, { ...ctx, env });
}

/** TF_LOG: añade los logs al principio de la salida (o los escribe en TF_LOG_PATH). */
function withLogs(out: CliOutcome, args: string[], ctx: CliContext): CliOutcome {
  if (out.kind === 'clear' || !logLevel(ctx.env)) return out;
  if (out.history) out.history = { ...out.history, log: String(logLevel(ctx.env)) };
  const p = out.kind === 'apply' ? out.result : out.plan;
  const cfg = p?.config;
  const err = p && !p.ok ? p.diagnostics.find((d) => d.severity === 'error')?.summary : undefined;
  const lines = logLines(ctx.env, args, { graph: p?.graph ?? null, providers: cfg ? requiredProviderNames(cfg) : providersOf(ctx.initialized), error: err });
  const path = ctx.env?.TF_LOG_PATH;
  if (path) {
    const files = { ...(out.files ?? ctx.files) };
    files[path] = (files[path] ?? '') + lines.join('\n') + '\n';
    return { ...out, files } as CliOutcome;
  }
  return { ...out, lines: [...lines.map((t) => L(t, 'muted')), ...out.lines] } as CliOutcome;
}

function runTerraform(args: string[], ctx: CliContext, now: number): CliOutcome {
  const [sub, ...rest] = args;
  const { cliVars, flags, rest: positional, errors, multi, value } = parseFlags(rest);
  if (errors.length) return { kind: 'lines', lines: errors.map((e) => L(e, 'error')) };
  const cloud = ctx.cloud ?? emptyCloud();
  const workspace = ctx.workspace ?? 'default';
  const refresh = !flags.has('refresh=false');
  const refreshOnly = flags.has('refresh-only');
  if (refreshOnly && !refresh) return { kind: 'lines', lines: [L('Incompatible refresh options: no puedes usar -refresh-only y -refresh=false a la vez.', 'error')] };
  const runOpts = (destroy: boolean): RunOptions => ({
    modules: installedModules(ctx.initialized),
    cliVars,
    destroy,
    cloud,
    refresh,
    refreshOnly,
    env: ctx.env,
    varFiles: multi['var-file'],
    workspace,
    replace: multi.replace,
  });
  const refreshing = (p: PlanResult) => (refresh && p.ok ? renderRefreshing(p, ctx.state) : []);
  const hist = (command: string, ok: boolean, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ command, ok, at: now, workspace, ...extra });

  // Bloqueo del estado (backend remoto con un compañero trabajando).
  let lockLines: TermLine[] = [];
  let clearLock = false;
  if (LOCKING.has(sub) || (sub === 'state' && ['mv', 'rm', 'push'].includes(positional[0]))) {
    const g = lockGuard(ctx, flags, value('lock-timeout'));
    if (g.error) return { kind: 'lines', lines: g.error, history: hist(sub === 'state' ? `state ${positional[0]}` : sub, false, { args: rest }) };
    lockLines = g.lines;
    clearLock = !!g.clear;
  }
  const lockPatch = clearLock ? { lock: null } : {};

  const cfgNow = () => loadConfig(ctx.files, installedModules(ctx.initialized));
  const remote = () => {
    const c = cfgNow().cloud;
    return c && currentBackend(ctx.initialized).startsWith('cloud:') ? c : undefined;
  };

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
          L(`Terraform v${TF_VERSION} (simulado en el navegador)`),
          L('on browser_wasm'),
          ...providersOf(ctx.initialized).map((p) => L(`+ provider registry.terraform.io/${PROVIDERS[p].source} v${lockedVersion(ctx.initialized, p)}`)),
        ],
        history: hist('version', true),
      };
    case 'login': {
      const host = positional[0] ?? 'app.terraform.io';
      return {
        kind: 'lines',
        lines: [
          L(`Terraform will request an API token for ${host} using your browser.`),
          L(''),
          L('If login is successful, Terraform will store the token in plain text in', 'muted'),
          L('the following file for use by subsequent commands:', 'muted'),
          L('    /home/devops/.terraform.d/credentials.tfrc.json', 'muted'),
          L(''),
          L('(simulado) Se ha abierto el navegador, has creado un token de usuario y Terraform lo ha guardado.', 'info'),
          L(''),
          L('Retrieved token for user devops-lab', 'success'),
          L(''),
          L(`Welcome to HCP Terraform!`, 'success'),
          L('💡 En CI no se usa login: se define la variable de entorno TF_TOKEN_app_terraform_io con un token de equipo.', 'hint'),
        ],
        initialized: [...ctx.initialized.filter((x) => x !== LOGIN), LOGIN],
        history: hist('login', true),
      };
    }
    case 'logout':
      return { kind: 'lines', lines: [L('Removing the stored credentials for app.terraform.io from the following file:'), L('    /home/devops/.terraform.d/credentials.tfrc.json', 'muted'), L('Success! Terraform has removed the stored API token for app.terraform.io.', 'success')], initialized: ctx.initialized.filter((x) => x !== LOGIN), history: hist('logout', true) };
    case 'init':
      return runInit(ctx, flags, now);
    case 'providers': {
      const cfg = cfgNow();
      if (hasErrors(cfg.diagnostics)) return { kind: 'lines', lines: renderDiagnostics(cfg.diagnostics) };
      const lines: TermLine[] = [L(''), L('Providers required by configuration:', 'bold'), L('.')];
      const configs = Object.values(moduleConfigs(cfg));
      const provLines = (c: Config, indent: string) => {
        const names = [...new Set([...Object.keys(c.requiredProviders), ...c.providers.map((p) => p.name), ...Object.values(c.resources).map((r) => r.type.split('_')[0])])].filter((n) => PROVIDERS[n]);
        return names.map((n) => `${indent}provider[registry.terraform.io/${PROVIDERS[n].source}]${c.requiredProviders[n]?.version ? ' ' + c.requiredProviders[n].version : ''}`);
      };
      const root = provLines(cfg, '');
      const children = configs.filter((c) => c.prefix);
      const items = [...root.map((t) => ({ t, kids: [] as string[] })), ...children.map((c) => ({ t: c.prefix.slice(0, -1), kids: provLines(c, '') }))];
      items.forEach((it, i) => {
        const last = i === items.length - 1;
        lines.push(L(`${last ? '└──' : '├──'} ${it.t}`));
        it.kids.forEach((k, j) => lines.push(L(`${last ? '    ' : '│   '}${j === it.kids.length - 1 ? '└──' : '├──'} ${k}`)));
      });
      const inState = [...new Set(Object.values(ctx.state.resources).map((r) => r.type.split('_')[0]))].filter((n) => PROVIDERS[n]);
      if (inState.length) lines.push(L(''), L('Providers required by state:', 'bold'), L(''), ...inState.map((n) => L(`    provider[registry.terraform.io/${PROVIDERS[n].source}]`)));
      return { kind: 'lines', lines, history: hist('providers', true) };
    }
    case 'validate': {
      const notInit = checkInit(ctx);
      const v = validate(ctx.files, installedModules(ctx.initialized));
      if (hasErrors(v.diagnostics)) {
        return { kind: 'lines', lines: renderDiagnostics(v.diagnostics), history: hist('validate', false) };
      }
      return {
        kind: 'lines',
        lines: [...renderDiagnostics(v.diagnostics), L('Success! The configuration is valid.', 'success'), ...(notInit ? [L('💡 Ojo: aún no has ejecutado terraform init.', 'hint')] : [])],
        history: hist('validate', true),
      };
    }
    case 'fmt': {
      const recursive = flags.has('recursive');
      const targets = Object.keys(ctx.files).filter((f) => (f.endsWith('.tf') || f.endsWith('.tfvars')) && (recursive || !f.includes('/'))).sort();
      const changed = targets.filter((f) => formatHclSource(ctx.files[f]) !== ctx.files[f]);
      const lines: TermLine[] = changed.map((f) => L(f));
      if (flags.has('diff')) for (const f of changed) lines.push(...simpleDiff(f, ctx.files[f], formatHclSource(ctx.files[f])).map((t) => L(t, t.startsWith('+') ? 'add' : t.startsWith('-') ? 'destroy' : 'muted')));
      const skipped = !recursive && Object.keys(ctx.files).some((f) => f.includes('/') && f.endsWith('.tf') && formatHclSource(ctx.files[f]) !== ctx.files[f]);
      if (skipped) lines.push(L('💡 Hay ficheros sin formatear en subcarpetas (módulos): terraform fmt solo mira la carpeta actual salvo que uses -recursive.', 'hint'));
      if (flags.has('check')) {
        if (changed.length) lines.push(L('💡 -check no modifica nada: termina con error si algún fichero no tiene el formato canónico. Ideal para CI.', 'hint'));
        return { kind: 'lines', lines: changed.length ? lines : [L('(todo formateado: código de salida 0)', 'muted')], history: hist('fmt', changed.length === 0, { args: ['-check'] }) };
      }
      const files = { ...ctx.files };
      for (const f of changed) files[f] = formatHclSource(ctx.files[f]);
      return { kind: 'lines', lines: changed.length ? lines : [L('(no había nada que formatear)', 'muted')], files: changed.length ? files : undefined, history: hist('fmt', true, { args: [...flags].map((f) => `-${f}`) }) };
    }
    case 'plan': {
      const notInit = checkInit(ctx);
      if (notInit) return { kind: 'lines', lines: notInit, history: hist('plan', false) };
      const genFlag = value('generate-config-out');
      let files = ctx.files;
      const genLines: TermLine[] = [];
      let newFiles: Record<string, string> | undefined;
      if (flags.has('generate-config-out') || genFlag !== undefined) {
        const out = genFlag;
        if (!out || !out.endsWith('.tf')) return { kind: 'lines', lines: [L('Uso: terraform plan -generate-config-out=generated.tf', 'error')] };
        if (ctx.files[out] !== undefined) {
          return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Target generated file already exists', detail: `Terraform can only write generated config into a new file. Either choose a different target location or move all existing configuration out of the target file, delete it and try again.`, hint: `Borra ${out} o elige otro nombre.` }]) };
        }
        const gen = generateConfig(ctx.files, cloud, installedModules(ctx.initialized));
        if (gen.error) return { kind: 'lines', lines: renderDiagnostics([gen.error]), history: hist('plan', false, { args: rest }) };
        if (gen.code) {
          files = { ...ctx.files, [out]: gen.code };
          newFiles = files;
          genLines.push(L(''), L(`Terraform has generated configuration and written it to ${out}. Please review the configuration and edit it as necessary before adding it to version control.`, 'warn'), L(`💡 Se ha creado ${out} con el código de los recursos importados. Revísalo y quita lo que no quieras fijar.`, 'hint'));
        }
      }
      const destroy = flags.has('destroy');
      const p = plan(files, ctx.state, runOpts(destroy));
      const rc = remote();
      const runId = `run-${Math.random().toString(36).slice(2, 18)}`;
      const lines = [...lockLines, ...(rc ? remoteRunHeader('plan', rc.organization ?? '?', rc.workspaceName ?? workspace, runId) : []), ...refreshing(p), ...renderPlan(p), ...genLines];
      let policy: HistoryEntry['policy'];
      if (rc && p.ok) {
        const results = evaluatePolicies(p, ctx.policies ?? DEFAULT_POLICIES);
        policy = policyOutcome(results);
        lines.push(...costAndPolicyLines(p, results, rc.organization ?? 'org'));
      }
      const outName = value('out');
      let savedPlans: Record<string, SavedPlan> | undefined;
      const hasChanges = p.ok && (p.changes.some((c) => c.action !== 'noop' || c.importing || c.movedFrom) || p.drift.length > 0 || p.outputChanges.some((o) => o.action !== 'noop'));
      if (outName && p.ok) {
        if (rc) lines.push(L('Error: Saving a generated plan is currently not supported (HCP Terraform guarda los planes en la propia ejecución remota).', 'error'));
        else {
          savedPlans = { ...(ctx.savedPlans ?? {}), [outName]: { name: outName, files, lineage: ctx.state.lineage, serial: ctx.state.serial, workspace, opts: { cliVars, destroy, refreshOnly, refresh, replace: multi.replace, varFiles: multi['var-file'] } } };
          lines.push(L(''), L('─'.repeat(77), 'muted'), L(''), L(`Saved the plan to: ${outName}`), L(''), L('To perform exactly these actions, run the following command to apply:'), L(`    terraform apply "${outName}"`, 'info'));
        }
      } else if (hasChanges && !rc) {
        lines.push(L(''), L('─'.repeat(77), 'muted'), L(''), L('Note: You didn\'t use the -out option to save this plan, so Terraform can\'t guarantee to take exactly these actions if you run "terraform apply" now.', 'muted'));
      }
      return {
        kind: 'lines',
        lines,
        plan: p,
        files: newFiles,
        savedPlans,
        ...lockPatch,
        history: hist('plan', p.ok, { summary: p.summary, actions: actionsOf(p), args: rest, policy }),
      };
    }
    case 'apply':
    case 'destroy': {
      const destroy = sub === 'destroy' || flags.has('destroy');
      const command = destroy ? 'destroy' : 'apply';
      const notInit = checkInit(ctx);
      if (notInit) return { kind: 'lines', lines: notInit, history: hist(command, false) };
      // terraform apply tfplan: aplica exactamente un plan guardado, sin preguntar.
      const saved = !destroy && positional[0] ? ctx.savedPlans?.[positional[0]] : undefined;
      if (!destroy && positional[0] && !saved) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Failed to load plan file', detail: `Couldn't read plan file "${positional[0]}": no such file.`, hint: 'Primero guarda un plan con terraform plan -out=' + positional[0] }]), history: hist(command, false) };
      if (saved) {
        if (Object.keys(cliVars).length || multi['var-file'].length) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: "Can't set variables when applying a saved plan", detail: 'The -var and -var-file options cannot be used when applying a saved plan file, because a saved plan includes the variable values that were set when it was created.', hint: 'Las variables ya van dentro del plan guardado.' }]), history: hist(command, false) };
        if (saved.lineage !== ctx.state.lineage || saved.serial !== ctx.state.serial || saved.workspace !== workspace) {
          return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Saved plan is stale', detail: 'The given plan file can no longer be applied because the state was changed by another operation after the plan was created.', hint: 'El estado ha cambiado desde que guardaste el plan. Genera uno nuevo con terraform plan -out=' + saved.name }]), history: hist(command, false, { args: rest }) };
        }
        const opts: RunOptions = { ...runOpts(saved.opts.destroy), cliVars: saved.opts.cliVars, refresh: saved.opts.refresh, refreshOnly: saved.opts.refreshOnly, replace: saved.opts.replace, varFiles: saved.opts.varFiles };
        const result = apply(saved.files, ctx.state, opts);
        const savedPlans = { ...(ctx.savedPlans ?? {}) };
        delete savedPlans[saved.name];
        return { kind: 'apply', lines: lockLines, result, savedPlans, ...lockPatch, history: hist(saved.opts.destroy ? 'destroy' : 'apply', result.ok, { summary: result.summary, actions: actionsOf(result), args: [saved.name] }) };
      }
      const opts = runOpts(destroy);
      const p = plan(ctx.files, ctx.state, opts);
      const rc = remote();
      const lines = [...lockLines, ...(rc ? remoteRunHeader('apply', rc.organization ?? '?', rc.workspaceName ?? workspace, `run-${Math.random().toString(36).slice(2, 18)}`) : []), ...refreshing(p), ...renderPlan(p)];
      const history = hist(command, p.ok, { summary: p.summary, actions: actionsOf(p), args: rest });
      if (!p.ok) return { kind: 'lines', lines, plan: p, history, ...lockPatch };
      const hasWork = p.refreshOnly
        ? p.drift.length > 0 || p.outputChanges.some((o) => o.action !== 'noop')
        : p.changes.some((c) => c.action !== 'noop' || c.importing || c.movedFrom) || p.outputChanges.some((o) => o.action !== 'noop');
      if (!hasWork) {
        if (destroy) lines.push(L(''), L('Destroy complete! Resources: 0 destroyed.', 'success'));
        else lines.push(L(''), L('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.', 'success'), ...renderOutputs(ctx.state.outputs));
        return { kind: 'lines', lines, plan: p, history, ...lockPatch };
      }
      let policyOverride = false;
      if (rc) {
        const results = evaluatePolicies(p, ctx.policies ?? DEFAULT_POLICIES);
        const outcome = policyOutcome(results);
        history.policy = outcome;
        lines.push(...costAndPolicyLines(p, results, rc.organization ?? 'org'));
        if (outcome === 'hard') {
          lines.push(...renderDiagnostics([{ severity: 'error', summary: 'Organization policy check hard failed.', hint: 'Una política hard-mandatory no se puede saltar: corrige el código para cumplirla.' }]));
          return { kind: 'lines', lines, plan: p, history: { ...history, ok: false }, ...lockPatch };
        }
        if (outcome === 'soft') policyOverride = true;
      }
      if (flags.has('auto-approve') && !policyOverride) {
        const result = apply(ctx.files, ctx.state, opts);
        return { kind: 'apply', lines, result, history, ...lockPatch };
      }
      if (policyOverride) {
        lines.push(L(''), L('Do you want to override the soft failed policy check?', 'bold'), L("  Only 'override' will be accepted to override."), L(''));
      } else {
        lines.push(
          L(''),
          L(destroy ? 'Do you really want to destroy all resources?' : refreshOnly ? 'Would you like to update the Terraform state to reflect these detected changes?' : rc ? `Do you want to perform these actions in workspace "${rc.workspaceName ?? workspace}"?` : workspace !== 'default' ? `Do you want to perform these actions in workspace "${workspace}"?` : 'Do you want to perform these actions?', 'bold'),
          L(destroy ? '  Terraform will destroy all your managed infrastructure, as shown above.' : refreshOnly ? '  Terraform will write these changes to the state without modifying any real infrastructure.' : '  Terraform will perform the actions described above.'),
          L(destroy || refreshOnly ? "  There is no undo. Only 'yes' will be accepted to confirm." : "  Only 'yes' will be accepted to approve."),
          L(''),
        );
      }
      return { kind: 'confirm', lines, plan: p, pending: { destroy, refreshOnly, plan: p, opts, policyOverride, remote: !!rc, args: rest, policy: history.policy }, history: { ...history, ok: true }, ...lockPatch };
    }
    case 'refresh': {
      const notInit = checkInit(ctx);
      if (notInit) return { kind: 'lines', lines: notInit, history: hist('refresh', false) };
      const opts = { ...runOpts(false), refreshOnly: true };
      const p = plan(ctx.files, ctx.state, opts);
      if (!p.ok) return { kind: 'lines', lines: renderDiagnostics(p.diagnostics), history: hist('refresh', false) };
      const result = apply(ctx.files, ctx.state, opts);
      return {
        kind: 'lines',
        lines: [
          ...lockLines,
          ...renderRefreshing(p, ctx.state),
          ...renderDiagnostics([{ severity: 'warning', summary: 'The terraform refresh command is deprecated', detail: 'Use "terraform apply -refresh-only" instead: it shows the changes and asks for confirmation before updating the state.', hint: 'refresh actualiza el estado sin enseñarte antes qué va a cambiar. Por eso se recomienda terraform plan/apply -refresh-only.' }]),
          ...renderOutputs(result.state.outputs),
        ],
        state: result.state,
        cloud: result.cloud,
        ...lockPatch,
        history: hist('refresh', true),
      };
    }
    case 'import': {
      const notInit = checkInit(ctx);
      if (notInit) return { kind: 'lines', lines: notInit, history: hist('import', false) };
      const [addr, id] = positional;
      if (!addr || !id) return { kind: 'lines', lines: [L('Uso: terraform import <dirección> <id>, p.ej. terraform import aws_s3_bucket.logs mi-bucket', 'error')] };
      const r = importInstance(ctx, cloud, addr, id);
      if ('error' in r) return { kind: 'lines', lines: renderDiagnostics([r.error]), history: hist('import', false, { args: [addr, id] }) };
      return {
        kind: 'lines',
        lines: [
          ...lockLines,
          L(`${addr}: Importing from ID "${id}"...`, 'info'),
          L(`${addr}: Import prepared!`, 'info'),
          L(`  Prepared ${r.type} for import`, 'info'),
          L(`${addr}: Refreshing state... [id=${id}]`, 'muted'),
          L(''),
          L('Import successful!', 'success'),
          L(''),
          L('The resources that were imported are shown above. These resources are now in your Terraform state and will henceforth be managed by Terraform.', 'success'),
          L('💡 Haz terraform plan: si tu código no coincide exactamente con el objeto real, verás los cambios que Terraform haría.', 'hint'),
        ],
        state: r.state,
        cloud: r.cloud,
        ...lockPatch,
        history: hist('import', true, { args: [addr, id] }),
      };
    }
    case 'taint':
    case 'untaint': {
      const addr = positional[0];
      const inst = addr ? ctx.state.resources[addr] : undefined;
      if (!inst || inst.mode !== 'managed') return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'No such resource instance', detail: `There is no resource instance in the state with the address ${addr ?? ''}.`, hint: 'Usa terraform state list para ver las direcciones.' }]), history: hist(sub, false) };
      if (sub === 'untaint' && !inst.tainted) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Resource instance is not tainted', detail: `Resource instance ${addr} is not currently tainted, and so it cannot be untainted.` }]), history: hist(sub, false) };
      const next = cloneState(ctx.state);
      next.resources[addr] = { ...inst, tainted: sub === 'taint' };
      next.serial++;
      return {
        kind: 'lines',
        lines: [
          ...lockLines,
          ...(sub === 'taint' ? renderDiagnostics([{ severity: 'warning', summary: 'Command "terraform taint" is deprecated', detail: 'Use "terraform apply -replace" instead.', hint: 'taint marca el recurso en el estado y otro compañero podría aplicarlo sin darse cuenta. -replace forma parte del plan: lo ves y lo confirmas.' }]) : []),
          L(sub === 'taint' ? `Resource instance ${addr} has been marked as tainted.` : `Resource instance ${addr} has been successfully untainted.`, 'success'),
        ],
        state: next,
        ...lockPatch,
        history: hist(sub, true, { args: [addr] }),
      };
    }
    case 'force-unlock': {
      const id = positional[0];
      if (!id) return { kind: 'lines', lines: [L('Uso: terraform force-unlock LOCK_ID', 'error')] };
      if (currentBackend(ctx.initialized) === 'local' && !ctx.lock) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Failed to unlock state', detail: 'Local state cannot be unlocked by another process', hint: 'No hay ningún bloqueo que quitar.' }]), history: hist('force-unlock', false) };
      if (!ctx.lock) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Failed to unlock state', detail: 'failed to retrieve lock info: no lock found', hint: 'No hay ningún bloqueo activo.' }]), history: hist('force-unlock', false) };
      if (ctx.lock.id !== id) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Failed to unlock state', detail: `lock ID "${id}" does not match existing lock ID "${ctx.lock.id}"`, hint: 'Copia el ID exacto del mensaje "Error acquiring the state lock".' }]), history: hist('force-unlock', false) };
      const unlocked: TermLine[] = [L('Terraform state has been successfully unlocked!', 'success'), L(''), L('The state has been unlocked, and Terraform commands should now be able to', 'muted'), L('obtain a new lock on the remote state.', 'muted')];
      if (flags.has('force')) return { kind: 'lines', lines: unlocked, lock: null, history: hist('force-unlock', true, { args: [id] }) };
      const lines = [
        L('Do you really want to force-unlock?', 'bold'),
        L('  Terraform will remove the lock on the remote state.'),
        L('  This will allow local Terraform commands to modify this state, even though it'),
        L('  may still be in use. Only \'yes\' will be accepted to confirm.'),
        L(''),
      ];
      const dummy = plan({}, emptyState());
      return { kind: 'confirm', lines, plan: dummy, pending: { destroy: false, plan: dummy, opts: {}, unlockId: id }, history: hist('force-unlock', true, { args: [id] }) };
    }
    case 'workspace':
      return runWorkspace(positional, flags, ctx, now);
    case 'output': {
      const outs = ctx.state.outputs;
      const json = flags.has('json');
      const raw = flags.has('raw');
      const name = positional[0];
      if (name && !outs[name])
        return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: `Output "${name}" not found`, detail: 'The output variable requested could not be found in the state file.', hint: 'Los outputs aparecen en el estado después de hacer apply.' }]), history: hist('output', false) };
      if (json) {
        const obj = name ? toJson(outs[name].value) : Object.fromEntries(Object.entries(outs).map(([k, o]) => [k, { sensitive: o.sensitive, type: Array.isArray(o.value) ? 'list' : typeof o.value === 'object' && o.value !== null ? 'object' : typeof o.value, value: toJson(o.value) }]));
        const hasSens = Object.values(outs).some((o) => o.sensitive);
        return { kind: 'lines', lines: [...JSON.stringify(obj, null, 2).split('\n').map((t) => L(t)), ...(hasSens ? [L('💡 Ojo: -json muestra también los valores sensitive en claro. sensitive solo oculta el valor en la salida normal; el estado lo guarda igualmente.', 'hint')] : [])], history: hist('output', true, { args: ['-json', ...(name ? [name] : [])] }) };
      }
      if (raw) {
        if (!name) return { kind: 'lines', lines: [L('Uso: terraform output -raw <nombre>', 'error')] };
        const v = outs[name].value;
        if (typeof v === 'object' && v !== null) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Unsupported value for raw output', detail: `The -raw option only supports strings, numbers, and boolean values, but output value "${name}" is ${Array.isArray(v) ? 'a list' : 'an object'}.`, hint: 'Usa -json para valores complejos.' }]), history: hist('output', false) };
        return { kind: 'lines', lines: [L(String(v))], history: hist('output', true, { args: ['-raw', name] }) };
      }
      if (name) return { kind: 'lines', lines: [L(outs[name].sensitive ? '(sensitive value)' : formatHcl(outs[name].value))], history: hist('output', true, { args: [name] }) };
      const lines = renderOutputs(outs).slice(3);
      if (!lines.length)
        return {
          kind: 'lines',
          lines: renderDiagnostics([{ severity: 'warning', summary: 'No outputs found', detail: 'The state file either has no outputs defined, or all the defined outputs are empty.', hint: 'Define bloques output y ejecuta terraform apply.' }]),
          history: hist('output', true),
        };
      return { kind: 'lines', lines, history: hist('output', true) };
    }
    case 'show': {
      const saved = positional[0] ? ctx.savedPlans?.[positional[0]] : undefined;
      if (positional[0] && !saved) return { kind: 'lines', lines: [L(`Error: Failed to read the given file as a state or plan file: ${positional[0]}`, 'error')] };
      if (saved) {
        const p = plan(saved.files, ctx.state, { ...runOpts(saved.opts.destroy), cliVars: saved.opts.cliVars, refreshOnly: saved.opts.refreshOnly, replace: saved.opts.replace });
        return { kind: 'lines', lines: renderPlan(p), history: hist('show', true, { args: [saved.name] }) };
      }
      const insts = Object.values(ctx.state.resources).sort((a, b) => a.addr.localeCompare(b.addr));
      if (!insts.length) return { kind: 'lines', lines: [L('The state file is empty. No resources are represented.', 'muted')], history: hist('show', true) };
      return { kind: 'lines', lines: [...insts.flatMap((i) => [...renderInstance(i), L('')]), ...renderOutputs(ctx.state.outputs)], history: hist('show', true) };
    }
    case 'state':
      return runState(positional, flags, ctx, now, cloud, lockLines, lockPatch);
    case 'graph': {
      const cfg = cfgNow();
      if (hasErrors(cfg.diagnostics)) return { kind: 'lines', lines: renderDiagnostics(cfg.diagnostics) };
      const g = buildGraph(cfg);
      const lines = [L('digraph {'), L('  rankdir = "RL"')];
      for (const [id, deps] of Object.entries(g.deps)) for (const d of deps) lines.push(L(`  "${id}" -> "${d}"`));
      lines.push(L('}'), L('💡 Mira la pestaña "Grafo" para verlo dibujado.', 'hint'));
      return { kind: 'lines', lines, history: hist('graph', true) };
    }
    case 'console':
      return {
        kind: 'lines',
        lines: [L('Consola de Terraform. Escribe expresiones como var.nombre, upper("hola") o cidrsubnet("10.0.0.0/16", 8, 1).', 'info'), L('Escribe "exit" para salir.', 'muted')],
        consoleMode: true,
        history: hist('console', true),
      };
    default: {
      const s = suggest(sub, ['init', 'validate', 'plan', 'apply', 'destroy', 'output', 'state', 'show', 'graph', 'console', 'version', 'fmt', 'import', 'refresh', 'workspace', 'providers', 'taint', 'untaint', 'force-unlock', 'login', 'logout']);
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

// ------------------------------------------------------------ terraform init

function runInit(ctx: CliContext, flags: Set<string>, now: number): CliOutcome {
  const upgrade = flags.has('upgrade');
  const installed = installedModules(ctx.initialized);
  const cfg = loadConfig(ctx.files, upgrade ? {} : installed);
  const workspace = ctx.workspace ?? 'default';
  const hist = (ok: boolean): HistoryEntry => ({ command: 'init', ok, at: now, workspace, args: [...flags].map((f) => `-${f}`) });
  const fail = (lines: TermLine[]): CliOutcome => ({ kind: 'lines', lines, history: hist(false) });

  // ---- backend
  const oldId = ctx.initialized.length ? currentBackend(ctx.initialized) : 'local';
  const newId = backendIdOf(cfg);
  const lines: TermLine[] = [L(cfg.cloud ? 'Initializing HCP Terraform...' : 'Initializing the backend...', 'bold')];
  let state: TfState | undefined;
  let stateStore: Record<string, TfState> | undefined;
  if (cfg.cloud && !hasErrors(cfg.diagnostics) && !loggedIn(ctx.initialized)) {
    return fail([
      ...lines,
      ...renderDiagnostics([{ severity: 'error', summary: 'Required token could not be found', detail: `Run the following command to generate a token for ${cfg.cloud.hostname}:\n    terraform login`, hint: 'Para usar HCP Terraform primero hay que autenticarse con terraform login.' }]),
    ]);
  }
  if (newId !== oldId && !hasErrors(cfg.diagnostics)) {
    const store = { ...(ctx.stateStore ?? {}) };
    const oldWs = Object.keys(store).filter((k) => k.startsWith(oldId + '|')).map((k) => k.split('|')[1]);
    const hasState = Object.keys(ctx.state.resources).length > 0 || oldWs.some((w) => Object.keys(store[storeKey(oldId, w)].resources).length > 0);
    const migrate = flags.has('migrate-state');
    const reconfigure = flags.has('reconfigure');
    if (hasState && ctx.initialized.length && !migrate && !reconfigure) {
      return fail([
        ...lines,
        ...renderDiagnostics([
          {
            severity: 'error',
            summary: oldId === 'local' ? `Backend configuration changed` : 'Backend configuration changed',
            detail: 'A change in the backend configuration has been detected, which may require migrating existing state.\n\nIf you wish to attempt automatic migration of the state, use "terraform init -migrate-state".\nIf you wish to store the current configuration with no changes to the state, use "terraform init -reconfigure".',
            hint: 'Ya tienes estado guardado. -migrate-state lo copia al nuevo backend; -reconfigure cambia de backend SIN copiarlo (empezarías con un estado vacío y Terraform querría crearlo todo otra vez).',
          },
        ]),
      ]);
    }
    store[storeKey(oldId, workspace)] = ctx.state;
    if (migrate) {
      for (const k of Object.keys(store).filter((x) => x.startsWith(oldId + '|'))) {
        store[storeKey(newId, k.split('|')[1])] = cloneState(store[k]);
        delete store[k];
      }
      lines.push(L(`Terraform detected that the backend type changed from "${backendType(oldId)}" to "${backendType(newId)}".`), L(''), L('Acquiring state lock. This may take a few moments...', 'muted'), L('Successfully migrated the existing state to the new backend.', 'success'));
    }
    const key = storeKey(newId, workspace);
    state = store[key] ?? emptyState();
    delete store[key];
    stateStore = store;
    if (newId !== 'local') lines.push(L(cfg.cloud ? `HCP Terraform has been successfully initialized!` : `Successfully configured the backend "${backendType(newId)}"! Terraform will automatically use this backend unless the backend configuration changes.`, 'success'));
    if (reconfigure && hasState) lines.push(L('💡 Con -reconfigure no se ha copiado el estado: en este backend empiezas con el estado vacío.', 'hint'));
    if (newId !== 'local' && !cfg.cloud) lines.push(L(`💡 El estado ahora vive en ${newId.replace(/^[a-z]+:/, '')} (${backendType(newId)}), con bloqueo para que dos personas no hagan apply a la vez.`, 'hint'));
  }

  // ---- módulos
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
      if (!prev || prev.source !== c.source || prev.version !== c.resolvedVersion) lines.push(L(`Downloading registry.terraform.io/${c.source} ${c.resolvedVersion} for ${n}...`, 'info'));
      lines.push(L(`- ${n} in .terraform/modules/${n}`));
    }
  }
  lines.push(L('Initializing provider plugins...', 'bold'));
  if (hasErrors(cfg.diagnostics)) return fail([...lines, ...renderDiagnostics(cfg.diagnostics)]);

  // ---- proveedores y lock file
  const needed = requiredProviderNames(cfg);
  const lockEntries: string[] = [];
  let lockChanged = false;
  const hadLock = providersOf(ctx.initialized).length > 0;
  for (const p of needed) {
    const info = PROVIDERS[p];
    const cs = constraintsFor(cfg, p);
    const locked = lockedVersion(ctx.initialized, p);
    const versions = PROVIDER_VERSIONS[p] ?? [info.version];
    let v: string | undefined;
    if (locked && !upgrade) {
      if (!satisfiesAll(locked, cs)) {
        return fail([
          ...lines,
          ...renderDiagnostics([
            {
              severity: 'error',
              summary: 'Failed to query available provider packages',
              detail: `Could not retrieve the list of available versions for provider ${info.source}: locked provider registry.terraform.io/${info.source} ${locked} does not match configured version constraint ${cs.join(', ')}; must use terraform init -upgrade to allow selection of new versions`,
              hint: `.terraform.lock.hcl fija ${info.source} en ${locked}. Al cambiar la restricción, tienes que permitir que init elija otra versión: terraform init -upgrade.`,
            },
          ]),
        ]);
      }
      v = locked;
      lines.push(L(`- Reusing previous version of ${info.source} from the dependency lock file`), L(`- Using previously-installed ${info.source} v${v}`));
    } else {
      v = [...versions].reverse().find((x) => satisfiesAll(x, cs));
      lines.push(L(`- Finding ${info.source} versions matching "${cs.join(', ') || '*'}"...`));
      if (!v) {
        return fail([
          ...lines,
          ...renderDiagnostics([
            {
              severity: 'error',
              summary: 'Failed to query available provider packages',
              detail: `Could not retrieve the list of available versions for provider ${info.source}: no available releases match the given constraints ${cs.join(', ')}`,
              hint: `Versiones publicadas de ${info.source}: ${versions.join(', ')}.`,
            },
          ]),
        ]);
      }
      if (v !== locked) lockChanged = true;
      lines.push(L(`- Installing ${info.source} v${v}...`), L(`- Installed ${info.source} v${v} (signed by HashiCorp)`));
    }
    lockEntries.push(`${LOCK}${p}=${v}`);
  }
  if (!needed.length) lines.push(L('No se necesita ningún proveedor todavía: la configuración no declara recursos.', 'muted'));
  if (needed.length && !hadLock) lines.push(L(''), L('Terraform has created a lock file .terraform.lock.hcl to record the provider selections it made above. Include this file in your version control repository so that Terraform can guarantee to make the same selections by default when you run "terraform init" in the future.', 'muted'));
  else if (lockChanged) lines.push(L(''), L('Terraform has made some changes to the provider dependency selections recorded in the .terraform.lock.hcl file. Review those changes and commit them to your version control system if they represent changes you intended to make.', 'muted'));
  lines.push(
    L(''),
    L(cfg.cloud ? 'HCP Terraform has been successfully initialized!' : 'Terraform has been successfully initialized!', 'success'),
    L(''),
    L(cfg.cloud ? 'You may now begin working with HCP Terraform. Try running "terraform plan" to see any changes that are required for your infrastructure.' : 'You may now begin working with Terraform. Try running "terraform plan" to see any changes that are required for your infrastructure.', 'success'),
  );
  return {
    kind: 'lines',
    lines,
    initialized: [
      ...[...new Set([...providersOf(ctx.initialized), ...needed])].sort(),
      ...lockEntries,
      ...ctx.initialized.filter((x) => x.startsWith(LOCK) && !needed.includes(x.slice(LOCK.length).split('=')[0])),
      ...calls.filter((c) => c.kind === 'local' || c.resolvedVersion).map((c) => `${MOD}${c.id}=${c.source}@${c.resolvedVersion ?? ''}`),
      ...(newId !== 'local' ? [`${BACKEND}${newId}`] : []),
      ...(loggedIn(ctx.initialized) ? [LOGIN] : []),
    ],
    state,
    stateStore,
    history: hist(true),
  };
}

// ------------------------------------------------------------ terraform workspace

function runWorkspace(positional: string[], flags: Set<string>, ctx: CliContext, now: number): CliOutcome {
  const [op, name] = positional;
  const backend = currentBackend(ctx.initialized);
  const current = ctx.workspace ?? 'default';
  const store = ctx.stateStore ?? {};
  const all = [...new Set(['default', current, ...Object.keys(store).filter((k) => k.startsWith(backend + '|')).map((k) => k.split('|')[1])])].sort();
  const hist = (ok: boolean): HistoryEntry => ({ command: `workspace ${op ?? ''}`.trim(), ok, at: now, args: name ? [name] : [], workspace: current });
  const err = (summary: string, detail?: string, hint?: string): CliOutcome => ({ kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary, detail, hint }]), history: hist(false) });
  const switchTo = (target: string, created: boolean): CliOutcome => {
    const next = { ...store, [storeKey(backend, current)]: ctx.state };
    const st = next[storeKey(backend, target)] ?? emptyState();
    delete next[storeKey(backend, target)];
    return {
      kind: 'lines',
      lines: created
        ? [
            L(`Created and switched to workspace "${target}"!`, 'success'),
            L(''),
            L("You're now on a new, empty workspace. Workspaces isolate their state,", 'muted'),
            L('so if you run "terraform plan" Terraform will not see any existing state', 'muted'),
            L('for this configuration.', 'muted'),
          ]
        : [L(`Switched to workspace "${target}".`, 'success')],
      workspace: target,
      state: st,
      stateStore: next,
      history: hist(true),
    };
  };
  if (backend.startsWith('cloud:') && op && ['new', 'select', 'delete'].includes(op))
    return err('Workspaces are managed in HCP Terraform', undefined, 'Con el bloque cloud, los workspaces son los de HCP Terraform: se eligen con workspaces { name / tags } o se crean en la organización.');
  switch (op) {
    case undefined:
    case 'list':
      return { kind: 'lines', lines: all.map((w) => L(`${w === current ? '*' : ' '} ${w}`, w === current ? 'success' : undefined)), history: hist(true) };
    case 'show':
      return { kind: 'lines', lines: [L(current)], history: hist(true) };
    case 'new':
      if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return err('Invalid workspace name', 'Workspace names must be URL-safe.', 'Usa letras, números, "-" o "_": terraform workspace new dev');
      if (all.includes(name)) return err(`Workspace "${name}" already exists`, undefined, `Para cambiar a él: terraform workspace select ${name}`);
      return switchTo(name, true);
    case 'select':
      if (!name) return err('Expected a single argument: NAME.');
      if (name === current) return { kind: 'lines', lines: [L(`Already on workspace "${name}"`)], history: hist(true) };
      if (!all.includes(name)) {
        if (flags.has('or-create')) return switchTo(name, true);
        return err(`Workspace "${name}" doesn't exist.`, 'You can create this workspace with the "new" subcommand\nor include the "-or-create" flag with the "select" subcommand.', `terraform workspace new ${name}`);
      }
      return switchTo(name, false);
    case 'delete': {
      if (!name) return err('Expected a single argument: NAME.');
      if (name === 'default') return err("Can't delete default workspace", undefined, 'El workspace default siempre existe.');
      if (!all.includes(name)) return err(`Workspace "${name}" doesn't exist.`);
      if (name === current) return err(`Workspace "${name}" is your active workspace.`, 'You cannot delete the currently active workspace. Please switch\nto another workspace and try again.', 'Cambia antes a otro: terraform workspace select default');
      const st = store[storeKey(backend, name)];
      const tracked = Object.values(st?.resources ?? {}).filter((r) => r.mode === 'managed');
      if (tracked.length && !flags.has('force')) {
        return err(
          'Workspace is not empty',
          `Workspace "${name}" is currently tracking the following resource instances:\n${tracked.map((r) => `  - ${r.addr}`).join('\n')}\n\nDeleting this workspace would cause Terraform to lose track of any associated remote objects, which would then require you to delete them manually outside of Terraform. You should destroy these objects with Terraform before deleting the workspace.\n\nIf you want to delete this workspace anyway, and have Terraform forget about these managed objects, use the -force option to disable this safety check.`,
          `Primero: terraform workspace select ${name} && terraform destroy. Después bórralo.`,
        );
      }
      const next = { ...store };
      delete next[storeKey(backend, name)];
      let cloud = ctx.cloud ?? emptyCloud();
      for (const r of tracked) cloud = forgetInstance(cloud, r);
      return {
        kind: 'lines',
        lines: [L(`Deleted workspace "${name}"!`, 'success'), ...(tracked.length ? [L(`💡 Con -force, los ${tracked.length} recursos de "${name}" siguen existiendo en la nube sin que nadie los gestione (míralos con cloud ls).`, 'hint')] : [])],
        stateStore: next,
        cloud,
        history: hist(true),
      };
    }
    default:
      return err(`Unknown workspace subcommand "${op}"`, undefined, 'Subcomandos: list, show, new, select, delete');
  }
}

// ------------------------------------------------------------ terraform state …

function runState(positional: string[], flags: Set<string>, ctx: CliContext, now: number, cloud: CloudChanges, lockLines: TermLine[], lockPatch: { lock?: null }): CliOutcome {
  const [op, target, dest] = positional;
  const insts = Object.values(ctx.state.resources).sort((a, b) => a.addr.localeCompare(b.addr, 'en', { numeric: true }));
  const hist = (ok: boolean, args: string[] = []): HistoryEntry => ({ command: `state ${op}`, ok, at: now, args, workspace: ctx.workspace ?? 'default' });
  const notFound = (addr: string): CliOutcome => ({
    kind: 'lines',
    lines: renderDiagnostics([{ severity: 'error', summary: 'No instance found for the given address!', detail: `This command requires that the address references one specific instance (${addr}).`, hint: 'Usa "terraform state list" para ver las direcciones exactas. Con count se escribe así: aws_instance.web[0]' }]),
    history: hist(false, [addr]),
  });
  switch (op) {
    case 'list': {
      const shown = target ? insts.filter((i) => i.addr === target || i.addr.startsWith(target + '.') || i.addr.startsWith(target + '[') || i.resourceAddr === target || i.addr.startsWith(target)) : insts;
      return { kind: 'lines', lines: shown.length ? shown.map((i) => L(i.addr)) : [L('(el estado está vacío)', 'muted')], history: { ...hist(true, target ? [target] : []), command: 'state list' } };
    }
    case 'show': {
      if (!target) return { kind: 'lines', lines: [L('Uso: terraform state show <dirección>, p.ej. terraform state show aws_vpc.main', 'error')] };
      const inst = ctx.state.resources[target];
      if (!inst) return notFound(target);
      return { kind: 'lines', lines: [...(inst.tainted ? [L(`# ${inst.addr}: (tainted)`, 'warn')] : []), ...renderInstance(inst)], history: hist(true, [target]) };
    }
    case 'pull':
      return { kind: 'lines', lines: JSON.stringify(toTfStateJson(ctx.state), null, 2).split('\n').map((t) => L(t)), history: hist(true) };
    case 'rm': {
      if (!target) return { kind: 'lines', lines: [L('Uso: terraform state rm <dirección>', 'error')] };
      const matched = insts.filter((i) => i.addr === target || i.resourceAddr === target);
      if (!matched.length) return notFound(target);
      if (flags.has('dry-run')) return { kind: 'lines', lines: matched.map((i) => L(`Would remove ${i.addr}`)), history: hist(true, [target]) };
      const next = cloneState(ctx.state);
      let c = cloud;
      for (const i of matched) {
        delete next.resources[i.addr];
        c = forgetInstance(c, i);
      }
      next.serial++;
      return {
        kind: 'lines',
        lines: [
          ...lockLines,
          ...matched.map((i) => L(`Removed ${i.addr}`, 'success')),
          L(`Successfully removed ${matched.length} resource instance(s).`, 'success'),
          L('💡 El recurso sigue existiendo en la nube (míralo con "cloud ls"), pero Terraform ya no lo gestiona. Si haces plan, querrá crearlo de nuevo; para recuperarlo, impórtalo. Desde Terraform 1.7 también puedes usar un bloque removed { from = …  lifecycle { destroy = false } }.', 'hint'),
        ],
        state: next,
        cloud: c,
        ...lockPatch,
        history: hist(true, [target]),
      };
    }
    case 'mv': {
      if (!target || !dest) return { kind: 'lines', lines: [L('Uso: terraform state mv <origen> <destino>, p.ej. terraform state mv aws_instance.web aws_instance.app', 'error')] };
      const exists = (a: string) => insts.some((i) => i.addr === a || i.resourceAddr === a || i.addr.startsWith(a + '.'));
      if (!exists(target)) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Invalid source address', detail: `Cannot move ${target}: does not match anything in the current state.`, hint: 'Usa terraform state list para ver las direcciones exactas.' }]), history: hist(false, [target, dest]) };
      if (exists(dest)) return { kind: 'lines', lines: renderDiagnostics([{ severity: 'error', summary: 'Invalid target address', detail: `Cannot move to ${dest}: there is already a resource instance at that address in the current state.`, hint: 'El destino ya existe en el estado.' }]), history: hist(false, [target, dest]) };
      const next = cloneState(ctx.state);
      const moves = moveInState(next, target, dest);
      if (flags.has('dry-run')) return { kind: 'lines', lines: moves.map((m) => L(`Would move "${m.from}" to "${m.to}"`)), history: hist(true, [target, dest]) };
      next.serial++;
      return {
        kind: 'lines',
        lines: [
          ...lockLines,
          ...moves.map((m) => L(`Move "${m.from}" to "${m.to}"`)),
          L(`Successfully moved ${moves.length} object(s).`, 'success'),
          L('💡 state mv solo cambia el estado: acuérdate de renombrar también el bloque en el código. Un bloque moved { from = …  to = … } hace lo mismo pero queda en el código y se revisa en el plan.', 'hint'),
        ],
        state: next,
        ...lockPatch,
        history: hist(true, [target, dest]),
      };
    }
    default:
      return { kind: 'lines', lines: [L('Uso: terraform state <list|show|mv|rm|pull> [dirección]', 'error')] };
  }
}

// ------------------------------------------------------------ simulación del equipo

function runTeam(args: string[], ctx: CliContext, now: number): CliOutcome {
  const [op] = args;
  const backend = currentBackend(ctx.initialized);
  const ws = ctx.workspace ?? 'default';
  if (op === 'status' || !op) {
    return { kind: 'lines', lines: [L(ctx.lock ? `🔒 ${ctx.lock.who} tiene el bloqueo del estado (${ctx.lock.operation}, id ${ctx.lock.id}).` : '🔓 Nadie tiene bloqueado el estado.', 'info'), L('Uso: team apply | team crash | team status', 'muted')] };
  }
  if (backend === 'local') {
    return {
      kind: 'lines',
      lines: [L('👥 Tu compañera Ana intenta hacer apply… pero tu estado está en TU portátil (backend local).', 'warn'), L('💡 Con backend local nadie más ve tu estado: por eso los equipos lo guardan en un backend remoto (s3, azurerm, gcs, HCP Terraform…) con bloqueo.', 'hint')],
      history: { command: `team ${op}`, ok: false, at: now },
    };
  }
  if (op !== 'apply' && op !== 'crash') return { kind: 'lines', lines: [L('Uso: team apply | team crash | team status', 'error')] };
  const id = `${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 6)}-${Math.random().toString(16).slice(2, 6)}-${Math.random().toString(16).slice(2, 14)}`;
  const lock: StateLock = { id, who: 'ana@portatil-ana', operation: 'OperationTypeApply', created: now, key: storeKey(backend, ws), releaseAfter: op === 'apply' ? 60 : null };
  return {
    kind: 'lines',
    lines: [
      L(op === 'apply' ? '👥 Ana acaba de lanzar terraform apply sobre el mismo estado (tardará ~1 minuto).' : '👥 Ana lanzó terraform apply y se le cerró el portátil a mitad: el bloqueo se ha quedado colgado.', 'warn'),
      L('💡 Prueba ahora terraform plan para ver qué pasa cuando el estado está bloqueado.', 'hint'),
    ],
    lock,
    history: { command: `team ${op}`, ok: true, at: now },
  };
}

/** Ejecuta un apply ya confirmado ('yes'). */
export function confirmApply(pending: PendingApply, ctx: CliContext): ApplyResult {
  return apply(ctx.files, ctx.state, { ...pending.opts, cloud: ctx.cloud });
}

export function applySummaryLines(r: ApplyResult): TermLine[] {
  const warnings = renderDiagnostics(r.applyWarnings ?? []);
  if (!r.ok) return [...warnings, ...renderDiagnostics(r.diagnostics.filter((d) => d.severity === 'error'))];
  if (r.destroy) return [L(''), L(`Destroy complete! Resources: ${r.summary.destroy} destroyed.`, 'success')];
  return [
    ...warnings,
    L(''),
    L(`Apply complete! Resources: ${r.summary.import ? `${r.summary.import} imported, ` : ''}${r.summary.add} added, ${r.summary.change} changed, ${r.summary.destroy} destroyed.`, 'success'),
    ...renderOutputs(r.state.outputs),
  ];
}

// ------------------------------------------------------------ terraform import

function importInstance(ctx: CliContext, cloud: CloudChanges, addr: string, id: string): { state: TfState; cloud: CloudChanges; type: string } | { error: Diagnostic } {
  const cfg = loadConfig(ctx.files, installedModules(ctx.initialized));
  if (hasErrors(cfg.diagnostics)) return { error: cfg.diagnostics.find((d) => d.severity === 'error')! };
  const m = /^(.*?)(?:\[(\d+|"[^"]*")\])?$/.exec(addr)!;
  const resourceAddr = m[1];
  const indexKey = m[2] === undefined ? undefined : m[2].startsWith('"') ? m[2].slice(1, -1) : Number(m[2]);
  const rc = findResource(cfg, resourceAddr);
  const local = splitAddr(resourceAddr).local;
  if (!rc || rc.mode !== 'managed') {
    const [type, name] = local.split('.');
    return {
      error: {
        severity: 'error',
        summary: `resource address "${addr}" does not exist in the configuration.`,
        detail: `Before importing this resource, please create its configuration in the root module. For example:\n\nresource "${type ?? 'tipo'}" "${name ?? 'nombre'}" {\n  # (resource arguments)\n}`,
        hint: 'terraform import solo trae el objeto al estado: el bloque resource tienes que escribirlo tú antes.',
      },
    };
  }
  if ((indexKey !== undefined) !== (!!rc.count || !!rc.forEach)) {
    return { error: { severity: 'error', summary: 'Invalid address', detail: `The address ${addr} does not match the count/for_each of ${resourceAddr}.`, hint: rc.count ? `Usa un índice: ${resourceAddr}[0]` : rc.forEach ? `Usa una clave: ${resourceAddr}["clave"]` : `Quita el índice: ${resourceAddr}` } };
  }
  if (ctx.state.resources[addr]) {
    return { error: { severity: 'error', summary: 'Resource already managed by Terraform', detail: `Terraform is already managing a remote object for ${addr}. To import to this address you must first remove the existing object from the state.`, hint: 'Esa dirección ya está en el estado. Si quieres apuntarla a otro objeto, primero terraform state rm.' } };
  }
  const obj = cloud.unmanaged[id];
  if (!obj || obj.type !== rc.type) {
    const owner = Object.values(ctx.state.resources).find((r) => r.attributes.id === id);
    return {
      error: {
        severity: 'error',
        summary: 'Cannot import non-existent remote object',
        detail: `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`,
        hint: owner ? `Ese objeto ya está en el estado como ${owner.addr}.` : obj ? `El objeto "${id}" es de tipo ${obj.type}, no ${rc.type}.` : 'Usa "cloud ls" para ver qué objetos existen en la nube y sus ids.',
      },
    };
  }
  const schema = getSchema('managed', rc.type)!;
  const { prefix } = splitAddr(resourceAddr);
  const state = cloneState(ctx.state);
  state.resources[addr] = {
    addr,
    resourceAddr,
    module: prefix ? prefix.slice(0, -1) : undefined,
    mode: 'managed',
    type: rc.type,
    name: rc.name,
    indexKey,
    attributes: cloneValue(obj.attributes),
    sensitiveAttrs: Object.entries(schema.args).filter(([, a]) => a.sensitive).map(([n]) => n),
    dependencies: [],
  };
  state.serial++;
  const unmanaged = { ...cloud.unmanaged };
  delete unmanaged[id];
  return { state, cloud: { ...cloud, unmanaged }, type: rc.type };
}

/** terraform plan -generate-config-out: escribe el bloque resource de cada import sin configuración. */
function generateConfig(files: Record<string, string>, cloud: CloudChanges, modules: InstalledModules): { code?: string; error?: Diagnostic } {
  const cfg: Config = loadConfig(files, modules);
  const blocking = cfg.diagnostics.filter((d) => d.severity === 'error' && d.summary !== 'Configuration for import target does not exist');
  if (blocking.length) return { error: blocking[0] };
  const blocks: string[] = [];
  for (const imp of cfg.imports) {
    if (findResource(cfg, imp.resourceAddr)) continue;
    const { prefix, local } = splitAddr(imp.resourceAddr);
    if (prefix) return { error: { severity: 'error', summary: 'Cannot generate configuration for module resources', hint: 'Solo se puede generar código para recursos del módulo raíz.', file: imp.file, line: imp.line } };
    const [type, name] = local.split('.');
    const id = imp.id.kind === 'literal' && typeof imp.id.value === 'string' ? imp.id.value : undefined;
    const obj = id ? cloud.unmanaged[id] : undefined;
    const schema = getSchema('managed', type);
    if (!schema) return { error: { severity: 'error', summary: `Invalid resource type "${type}"`, file: imp.file, line: imp.line } };
    if (!obj || obj.type !== type) {
      return { error: { severity: 'error', summary: 'Cannot import non-existent remote object', detail: `No object of type ${type} exists with id "${id ?? '?'}".`, hint: 'Comprueba el id con "cloud ls".', file: imp.file, line: imp.line } };
    }
    const lines = [`# __generated__ by Terraform from "${id}"`, `resource "${type}" "${name}" {`];
    const attrs = Object.entries(schema.args).filter(([n, a]) => a.type !== 'block' && obj.attributes[n] !== null && obj.attributes[n] !== undefined);
    const w = Math.max(0, ...attrs.map(([n]) => n.length));
    for (const [n] of attrs) lines.push(`  ${n.padEnd(w)} = ${formatHcl(obj.attributes[n])}`);
    for (const [n, a] of Object.entries(schema.args)) {
      if (a.type !== 'block' || !Array.isArray(obj.attributes[n])) continue;
      for (const item of obj.attributes[n] as ValueMap[]) {
        if (!isMap(item)) continue;
        lines.push('', `  ${n} {`);
        for (const [k, v] of Object.entries(item)) if (v !== null) lines.push(`    ${k} = ${formatHcl(v)}`);
        lines.push('  }');
      }
    }
    lines.push('}');
    blocks.push(lines.join('\n'));
  }
  if (!blocks.length) return {};
  return { code: `# __generated__ by Terraform\n# Please review these resources and move them into your main configuration files.\n\n${blocks.join('\n\n')}\n` };
}

// ------------------------------------------------------------ consola web simulada

const STATUS_LABEL: Record<string, string> = {
  managed: 'gestionado',
  drifted: '⚠ cambiado a mano',
  deleted: '✖ borrado a mano',
  unmanaged: '✋ no gestionado',
};

function runCloud(args: string[], ctx: CliContext, now: number): CliOutcome {
  const cloud = ctx.cloud ?? emptyCloud();
  const [op, ...rest] = args;
  const region = 'eu-west-1';
  try {
    switch (op) {
      case 'ls':
      case 'list': {
        const entries = cloudEntries(ctx.state, cloud).filter((e) => e.type.startsWith('aws_') && e.status !== 'deleted');
        const lines: TermLine[] = [L('☁️  Consola de AWS (simulada): lo que existe de verdad en tu cuenta', 'bold')];
        if (!entries.length) lines.push(L('(no hay recursos)', 'muted'));
        const w = Math.max(10, ...entries.map((e) => e.id.length));
        const wt = Math.max(10, ...entries.map((e) => e.type.length));
        if (entries.length) lines.push(L(`${'ID'.padEnd(w)}  ${'TIPO'.padEnd(wt)}  TERRAFORM`, 'muted'));
        for (const e of entries) {
          const tone = e.status === 'unmanaged' ? 'warn' : e.status === 'drifted' ? 'change' : undefined;
          const tf = e.addr ? `${e.addr}${e.status === 'drifted' ? `  (${STATUS_LABEL.drifted}: ${e.changed.join(', ')})` : ''}` : STATUS_LABEL.unmanaged;
          lines.push(L(`${e.id.padEnd(w)}  ${e.type.padEnd(wt)}  ${tf}`, tone));
        }
        const gone = cloudEntries(ctx.state, cloud).filter((e) => e.status === 'deleted');
        for (const e of gone) lines.push(L(`💡 ${e.addr} está en el estado, pero ya no existe en la nube: alguien lo borró a mano.`, 'hint'));
        return { kind: 'lines', lines, history: { command: 'cloud ls', ok: true, at: now } };
      }
      case 'modify':
      case 'set': {
        const [ref, ...assigns] = rest;
        if (!ref) return { kind: 'lines', lines: [L('Uso: cloud modify <id|dirección> atributo=valor', 'error')] };
        const r = cloudModify(ctx.state, cloud, ref, assigns);
        return {
          kind: 'lines',
          lines: [L(`✋ ${r.type} ${r.id} modificado a mano desde la consola.`, 'warn'), L('💡 Terraform no se ha enterado: el estado sigue con los valores antiguos. Lo descubrirá en el próximo refresh (terraform plan).', 'hint')],
          cloud: r.cloud,
          history: { command: 'cloud modify', ok: true, at: now, args: [ref, ...assigns] },
        };
      }
      case 'delete':
      case 'rm': {
        const [ref] = rest;
        if (!ref) return { kind: 'lines', lines: [L('Uso: cloud delete <id|dirección>', 'error')] };
        const r = cloudDelete(ctx.state, cloud, ref);
        return {
          kind: 'lines',
          lines: [
            L(`✋ ${r.type} ${r.id} borrado a mano desde la consola.`, 'warn'),
            L(r.addr ? `💡 ${r.addr} sigue en el estado. En el próximo plan, el refresh verá que ya no existe y Terraform propondrá crearlo de nuevo.` : '💡 Terraform no lo gestionaba, así que no notará nada.', 'hint'),
          ],
          cloud: r.cloud,
          history: { command: 'cloud delete', ok: true, at: now, args: [ref] },
        };
      }
      case 'create': {
        const [type, ...assigns] = rest;
        if (!type) return { kind: 'lines', lines: [L('Uso: cloud create <tipo> atributo=valor …, p.ej. cloud create aws_s3_bucket bucket=mi-bucket-manual', 'error')] };
        const r = cloudCreate(ctx.state, cloud, type, assigns, region);
        return {
          kind: 'lines',
          lines: [L(`✋ ${type} creado a mano: id = ${r.id}`, 'warn'), L('💡 Terraform no sabe que existe. Para gestionarlo, impórtalo con un bloque import o con terraform import.', 'hint')],
          cloud: r.cloud,
          history: { command: 'cloud create', ok: true, at: now, args: [type, ...assigns] },
        };
      }
      default:
        return { kind: 'lines', lines: HELP.slice(HELP.findIndex((l) => l.text.startsWith('Consola web'))) };
    }
  } catch (e) {
    if (e instanceof CloudError) return { kind: 'lines', lines: [L(`Error: ${e.message}`, 'error'), ...(e.hint ? [L(`💡 ${e.hint}`, 'hint')] : [])], history: { command: `cloud ${op}`, ok: false, at: now } };
    throw e;
  }
}
