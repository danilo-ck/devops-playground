import type { DepGraph } from './graph';
import type { TermLine } from './format';
import { PROVIDERS, TF_VERSION } from './providers';

/** Niveles de TF_LOG, de más a menos detallado. */
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
type Level = (typeof LEVELS)[number];

export function logLevel(env: Record<string, string> | undefined): Level | 'JSON' | null {
  const v = (env?.TF_LOG ?? '').toUpperCase();
  if (!v || v === 'OFF') return null;
  if (v === 'JSON') return 'JSON';
  return (LEVELS as readonly string[]).includes(v) ? (v as Level) : 'TRACE';
}

let tick = 0;
const stamp = () => {
  const d = new Date(Date.now() + tick++);
  return d.toISOString().replace('Z', '+0000').replace(/\.(\d{3})/, '.$1');
};

/**
 * Líneas de log simuladas para un comando terraform. Se basan en lo que ocurre de verdad:
 * versión, argumentos, arranque de proveedores y el recorrido del grafo de dependencias.
 */
export function logLines(env: Record<string, string> | undefined, args: string[], ctx: { graph?: DepGraph | null; providers: string[]; error?: string }): string[] {
  const lvl = logLevel(env);
  if (!lvl) return [];
  const min = lvl === 'JSON' ? 0 : LEVELS.indexOf(lvl);
  const out: string[] = [];
  const log = (l: Level, msg: string) => {
    if (LEVELS.indexOf(l) < min) return;
    out.push(lvl === 'JSON' ? JSON.stringify({ '@level': l.toLowerCase(), '@message': msg, '@timestamp': stamp() }) : `${stamp()} [${l}]${l.length < 5 ? ' ' : ''} ${msg}`);
  };
  log('INFO', `Terraform version: ${TF_VERSION}`);
  log('DEBUG', 'using github.com/hashicorp/go-tfe v1.74.1');
  log('INFO', 'Go runtime version: go1.24.4');
  log('INFO', `CLI args: []string{${['terraform', ...args].map((a) => JSON.stringify(a)).join(', ')}}`);
  log('DEBUG', 'Attempting to open CLI config file: /home/devops/.terraformrc');
  log('INFO', 'Loading CLI configuration from /home/devops/.terraform.d/credentials.tfrc.json');
  log('DEBUG', 'checking for credentials in "/home/devops/.terraform.d/plugins"');
  log('INFO', 'CLI command args: ' + JSON.stringify(args));
  for (const p of ctx.providers) {
    const info = PROVIDERS[p];
    if (!info) continue;
    log('DEBUG', `provider: starting plugin: path=.terraform/providers/registry.terraform.io/${info.source}/${info.version}/linux_amd64/terraform-provider-${p}_v${info.version}_x5 args=[".terraform/providers/registry.terraform.io/${info.source}/${info.version}/linux_amd64/terraform-provider-${p}_v${info.version}_x5"]`);
    log('DEBUG', `provider: plugin started: path=.terraform/providers/registry.terraform.io/${info.source}/${info.version}/linux_amd64/terraform-provider-${p}_v${info.version}_x5 pid=${4000 + p.length * 37}`);
    log('TRACE', `GRPCProvider: GetProviderSchema`);
  }
  if (ctx.graph) {
    log('INFO', 'backend/local: starting Plan operation');
    for (const id of ctx.graph.order) {
      const deps = ctx.graph.deps[id] ?? [];
      log('DEBUG', `ReferenceTransformer: "${id}" references: [${deps.join(' ')}]`);
    }
    for (const id of ctx.graph.order) {
      const kind = ctx.graph.nodes[id]?.kind;
      log('TRACE', `vertex "${id}": starting visit (*terraform.${kind === 'resource' ? 'NodePlannableResourceInstance' : kind === 'data' ? 'NodePlannableResourceInstance' : kind === 'output' ? 'nodeExpandOutput' : kind === 'local' ? 'nodeExpandLocal' : 'nodeExpandModuleVariable'})`);
      if (kind === 'resource') log('TRACE', `GRPCProvider: PlanResourceChange`);
      log('TRACE', `vertex "${id}": visit complete`);
    }
  }
  if (ctx.error) {
    log('ERROR', `vertex error: ${ctx.error}`);
    log('WARN', 'Provider produced an unexpected error; see the diagnostics above');
  }
  log('DEBUG', 'provider: plugin process exited');
  log('INFO', 'backend/local: plan operation completed');
  return out;
}

export const logTermLines = (lines: string[]): TermLine[] => lines.map((text) => ({ text, tone: 'muted' as const }));
