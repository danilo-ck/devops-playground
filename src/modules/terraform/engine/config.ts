import { parseHcl, type Body, type Expr } from './parser';
import { getSchema, PROVIDERS, providerOf, RESOURCE_SCHEMAS, DATA_SCHEMAS, suggest, type ArgSpec } from './providers';

export interface Diagnostic {
  severity: 'error' | 'warning';
  summary: string;
  detail?: string;
  /** Explicación didáctica en español. */
  hint?: string;
  file?: string;
  line?: number;
}

export interface ResourceConfig {
  mode: 'managed' | 'data';
  type: string;
  name: string;
  /** aws_vpc.main  /  data.aws_ami.ubuntu */
  addr: string;
  body: Body;
  count?: Expr;
  forEach?: Expr;
  dependsOn: string[];
  lifecycle: { preventDestroy: boolean; createBeforeDestroy: boolean; ignoreChanges: string[] };
  file: string;
  line: number;
}

export interface VariableConfig {
  name: string;
  type?: Expr;
  default?: Expr;
  description?: string;
  sensitive: boolean;
  validations: { condition: Expr; errorMessage: string; line: number }[];
  file: string;
  line: number;
}

export interface OutputConfig {
  name: string;
  value: Expr;
  description?: string;
  sensitive: boolean;
  file: string;
  line: number;
}

export interface LocalConfig {
  name: string;
  expr: Expr;
  file: string;
  line: number;
}

export interface ProviderConfig {
  name: string;
  body: Body;
  file: string;
  line: number;
}

export interface Config {
  resources: Record<string, ResourceConfig>;
  variables: Record<string, VariableConfig>;
  locals: Record<string, LocalConfig>;
  outputs: Record<string, OutputConfig>;
  providers: ProviderConfig[];
  requiredProviders: Record<string, { source?: string; version?: string }>;
  diagnostics: Diagnostic[];
}

const META_ARGS = new Set(['count', 'for_each', 'depends_on', 'provider']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const literalString = (e: Expr | undefined): string | undefined =>
  e && e.kind === 'literal' && typeof e.value === 'string' ? e.value : undefined;

/** Convierte una referencia (aws_vpc.main / data.x.y) en su dirección. */
export function traversalToAddr(e: Expr): string | undefined {
  const names: string[] = [];
  let cur: Expr = e;
  while (cur.kind === 'getattr' || cur.kind === 'index') {
    if (cur.kind === 'getattr') names.unshift(cur.name);
    cur = cur.target;
  }
  if (cur.kind !== 'variable') return undefined;
  names.unshift(cur.name);
  if (names[0] === 'data') return names.length >= 3 ? `data.${names[1]}.${names[2]}` : undefined;
  if (names[0] === 'var' || names[0] === 'local' || names[0] === 'module') return names.length >= 2 ? `${names[0]}.${names[1]}` : undefined;
  return names.length >= 2 ? `${names[0]}.${names[1]}` : undefined;
}

function validateArgs(
  body: Body,
  args: Record<string, ArgSpec>,
  where: string,
  file: string,
  diags: Diagnostic[],
  allowMeta: boolean,
  blockLine: number,
) {
  const present = new Set<string>();
  for (const a of body.attributes) {
    if (allowMeta && META_ARGS.has(a.name)) continue;
    const spec = args[a.name];
    if (!spec) {
      const s = suggest(a.name, Object.keys(args));
      diags.push({
        severity: 'error',
        summary: 'Unsupported argument',
        detail: `An argument named "${a.name}" is not expected here.${s ? ` Did you mean "${s}"?` : ''}`,
        hint: s
          ? `"${a.name}" no existe en ${where}. ¿Querías escribir "${s}"?`
          : `${where} no acepta el argumento "${a.name}". Revisa la documentación del recurso.`,
        file,
        line: a.line,
      });
      continue;
    }
    if (spec.type === 'block') {
      diags.push({
        severity: 'error',
        summary: 'Unsupported argument',
        detail: `An argument named "${a.name}" is not expected here. Did you mean to define a block of type "${a.name}"?`,
        hint: `"${a.name}" es un bloque, no un argumento: escríbelo sin "=", así: ${a.name} { ... }`,
        file,
        line: a.line,
      });
      continue;
    }
    present.add(a.name);
  }
  for (const b of body.blocks) {
    if (allowMeta && (b.type === 'lifecycle' || b.type === 'provisioner' || b.type === 'connection')) continue;
    const spec = args[b.type];
    if (!spec || spec.type !== 'block') {
      diags.push({
        severity: 'error',
        summary: 'Unsupported block type',
        detail: `Blocks of type "${b.type}" are not expected here.`,
        hint: spec ? `"${b.type}" es un argumento: escríbelo como ${b.type} = valor` : `${where} no admite bloques "${b.type}".`,
        file,
        line: b.line,
      });
      continue;
    }
    present.add(b.type);
    validateArgs(b.body, spec.block ?? {}, `el bloque "${b.type}"`, file, diags, false, b.line);
  }
  for (const [name, spec] of Object.entries(args)) {
    if (spec.required && !present.has(name)) {
      diags.push({
        severity: 'error',
        summary: 'Missing required argument',
        detail: `The argument "${name}" is required, but no definition was found.`,
        hint: `${where} necesita obligatoriamente el argumento "${name}" (${spec.description}).`,
        file,
        line: blockLine,
      });
    }
  }
}

export function loadConfig(files: Record<string, string>): Config {
  const cfg: Config = {
    resources: {},
    variables: {},
    locals: {},
    outputs: {},
    providers: [],
    requiredProviders: {},
    diagnostics: [],
  };
  const diags = cfg.diagnostics;

  for (const [file, src] of Object.entries(files)) {
    if (!file.endsWith('.tf')) continue;
    const { body, error } = parseHcl(src);
    if (!body) {
      diags.push({
        severity: 'error',
        summary: 'Syntax error',
        detail: error!.message,
        hint: error!.hint,
        file,
        line: error!.line,
      });
      continue;
    }
    for (const a of body.attributes) {
      diags.push({
        severity: 'error',
        summary: 'Unsupported argument',
        detail: `An argument named "${a.name}" is not expected here.`,
        hint: 'Los argumentos deben ir dentro de un bloque (resource, variable, output…).',
        file,
        line: a.line,
      });
    }
    for (const b of body.blocks) {
      const need = (n: number, usage: string) => {
        if (b.labels.length !== n) {
          diags.push({
            severity: 'error',
            summary: `Missing name for ${b.type}`,
            detail: `All ${b.type} blocks must have ${n} label(s).`,
            hint: `La sintaxis correcta es: ${usage}`,
            file,
            line: b.line,
          });
          return false;
        }
        const bad = b.labels.find((l) => !NAME_RE.test(l));
        if (bad) {
          diags.push({
            severity: 'error',
            summary: 'Invalid name',
            detail: `"${bad}" is not a valid name.`,
            hint: 'Los nombres solo pueden contener letras, números, "_" y "-", y empezar por letra.',
            file,
            line: b.line,
          });
          return false;
        }
        return true;
      };
      const attr = (name: string) => b.body.attributes.find((a) => a.name === name);

      switch (b.type) {
        case 'terraform': {
          const rp = b.body.blocks.find((x) => x.type === 'required_providers');
          for (const a of rp?.body.attributes ?? []) {
            const obj = a.expr.kind === 'object' ? a.expr : undefined;
            const get = (k: string) =>
              literalString(obj?.items.find((i) => i.key.kind === 'literal' && i.key.value === k)?.value);
            cfg.requiredProviders[a.name] = { source: get('source'), version: get('version') };
            if (!PROVIDERS[a.name]) {
              diags.push({
                severity: 'error',
                summary: 'Provider not available',
                detail: `El simulador no incluye el proveedor "${a.name}".`,
                hint: `Proveedores disponibles: ${Object.keys(PROVIDERS).join(', ')}.`,
                file,
                line: a.line,
              });
            }
          }
          break;
        }
        case 'provider': {
          if (!need(1, 'provider "aws" { ... }')) break;
          if (!PROVIDERS[b.labels[0]]) {
            diags.push({
              severity: 'error',
              summary: 'Provider not available',
              detail: `El simulador no incluye el proveedor "${b.labels[0]}".`,
              hint: `Proveedores disponibles: ${Object.keys(PROVIDERS).join(', ')}.`,
              file,
              line: b.line,
            });
          }
          cfg.providers.push({ name: b.labels[0], body: b.body, file, line: b.line });
          break;
        }
        case 'variable': {
          if (!need(1, 'variable "nombre" { ... }')) break;
          const name = b.labels[0];
          if (cfg.variables[name]) {
            diags.push({ severity: 'error', summary: 'Duplicate variable declaration', detail: `A variable named "${name}" was already declared.`, hint: 'Cada variable solo puede declararse una vez.', file, line: b.line });
            break;
          }
          const allowed = new Set(['default', 'type', 'description', 'sensitive', 'nullable']);
          for (const a of b.body.attributes) {
            if (!allowed.has(a.name))
              diags.push({ severity: 'error', summary: 'Unsupported argument', detail: `An argument named "${a.name}" is not expected here.`, hint: 'Un bloque variable admite: type, default, description, sensitive y bloques validation.', file, line: a.line });
          }
          const validations = b.body.blocks
            .filter((x) => x.type === 'validation')
            .map((v) => ({
              condition: v.body.attributes.find((a) => a.name === 'condition')?.expr ?? { kind: 'literal' as const, value: true, line: v.line },
              errorMessage: literalString(v.body.attributes.find((a) => a.name === 'error_message')?.expr) ?? 'Invalid value for variable',
              line: v.line,
            }));
          cfg.variables[name] = {
            name,
            type: attr('type')?.expr,
            default: attr('default')?.expr,
            description: literalString(attr('description')?.expr),
            sensitive: attr('sensitive')?.expr.kind === 'literal' && (attr('sensitive')!.expr as { value: unknown }).value === true,
            validations,
            file,
            line: b.line,
          };
          break;
        }
        case 'locals': {
          for (const a of b.body.attributes) {
            if (cfg.locals[a.name]) {
              diags.push({ severity: 'error', summary: 'Duplicate local value definition', detail: `A local value named "${a.name}" was already defined.`, file, line: a.line });
              continue;
            }
            cfg.locals[a.name] = { name: a.name, expr: a.expr, file, line: a.line };
          }
          break;
        }
        case 'output': {
          if (!need(1, 'output "nombre" { value = ... }')) break;
          const name = b.labels[0];
          const value = attr('value');
          if (!value) {
            diags.push({ severity: 'error', summary: 'Missing required argument', detail: 'The argument "value" is required.', hint: 'Un output necesita un "value", p.ej. value = aws_vpc.main.id', file, line: b.line });
            break;
          }
          if (cfg.outputs[name]) {
            diags.push({ severity: 'error', summary: 'Duplicate output definition', detail: `An output named "${name}" was already defined.`, file, line: b.line });
            break;
          }
          cfg.outputs[name] = {
            name,
            value: value.expr,
            description: literalString(attr('description')?.expr),
            sensitive: attr('sensitive')?.expr.kind === 'literal' && (attr('sensitive')!.expr as { value: unknown }).value === true,
            file,
            line: b.line,
          };
          break;
        }
        case 'resource':
        case 'data': {
          const mode = b.type === 'resource' ? 'managed' : 'data';
          if (!need(2, `${b.type} "tipo" "nombre" { ... }`)) break;
          const [type, name] = b.labels;
          const addr = mode === 'managed' ? `${type}.${name}` : `data.${type}.${name}`;
          if (cfg.resources[addr]) {
            diags.push({ severity: 'error', summary: `Duplicate ${b.type} "${type}" configuration`, detail: `A ${type} ${b.type} named "${name}" was already declared.`, hint: 'Dos recursos del mismo tipo no pueden tener el mismo nombre.', file, line: b.line });
            break;
          }
          const prov = providerOf(type);
          const schema = getSchema(mode, type);
          if (!schema) {
            const pool = Object.keys(mode === 'managed' ? RESOURCE_SCHEMAS : DATA_SCHEMAS);
            const s = suggest(type, pool);
            diags.push({
              severity: 'error',
              summary: `Invalid ${mode === 'managed' ? 'resource' : 'data source'} type`,
              detail: PROVIDERS[prov]
                ? `The provider hashicorp/${prov} does not support ${mode === 'managed' ? 'resource' : 'data source'} type "${type}".${s ? ` Did you mean "${s}"?` : ''}`
                : `El simulador no incluye el proveedor "${prov}".`,
              hint: s ? `¿Querías escribir "${s}"?` : `Tipos disponibles: ${pool.join(', ')}`,
              file,
              line: b.line,
            });
            break;
          }
          const count = attr('count')?.expr;
          const forEach = attr('for_each')?.expr;
          if (count && forEach) {
            diags.push({ severity: 'error', summary: 'Invalid combination of "count" and "for_each"', detail: 'The "count" and "for_each" meta-arguments are mutually-exclusive.', hint: 'Usa count o for_each, pero no los dos a la vez.', file, line: b.line });
          }
          const dependsOn: string[] = [];
          const dep = attr('depends_on');
          if (dep) {
            if (dep.expr.kind !== 'tuple') {
              diags.push({ severity: 'error', summary: 'Invalid depends_on', detail: 'depends_on must be a list of references.', hint: 'Ejemplo: depends_on = [aws_internet_gateway.gw]', file, line: dep.line });
            } else {
              for (const item of dep.expr.items) {
                const ref = traversalToAddr(item);
                if (!ref || ref.startsWith('var.') || ref.startsWith('local.')) {
                  diags.push({ severity: 'error', summary: 'Invalid depends_on reference', detail: 'References in depends_on must be to a whole resource.', hint: 'Ejemplo: depends_on = [aws_internet_gateway.gw]', file, line: dep.line });
                } else dependsOn.push(ref);
              }
            }
          }
          const lc = b.body.blocks.find((x) => x.type === 'lifecycle');
          const lcBool = (n: string) => {
            const e = lc?.body.attributes.find((a) => a.name === n)?.expr;
            return !!e && e.kind === 'literal' && e.value === true;
          };
          const ignore = lc?.body.attributes.find((a) => a.name === 'ignore_changes')?.expr;
          validateArgs(b.body, schema.args, `El recurso "${type}"`, file, diags, true, b.line);
          cfg.resources[addr] = {
            mode,
            type,
            name,
            addr,
            body: b.body,
            count,
            forEach,
            dependsOn,
            lifecycle: {
              preventDestroy: lcBool('prevent_destroy'),
              createBeforeDestroy: lcBool('create_before_destroy'),
              ignoreChanges:
                ignore?.kind === 'tuple'
                  ? ignore.items.map((i) => (i.kind === 'variable' ? i.name : '')).filter(Boolean)
                  : [],
            },
            file,
            line: b.line,
          };
          break;
        }
        case 'module':
          diags.push({
            severity: 'error',
            summary: 'Modules not supported yet',
            detail: 'Los bloques module todavía no están disponibles en este simulador.',
            hint: 'Los módulos llegarán en una próxima lección. De momento declara los recursos directamente.',
            file,
            line: b.line,
          });
          break;
        default: {
          const s = suggest(b.type, ['resource', 'variable', 'output', 'locals', 'provider', 'terraform', 'data']);
          diags.push({
            severity: 'error',
            summary: 'Unsupported block type',
            detail: `Blocks of type "${b.type}" are not expected here.${s ? ` Did you mean "${s}"?` : ''}`,
            hint: s ? `¿Querías escribir "${s}"?` : 'Bloques válidos: terraform, provider, resource, data, variable, locals, output.',
            file,
            line: b.line,
          });
        }
      }
    }
  }
  return cfg;
}

export const hasErrors = (d: Diagnostic[]) => d.some((x) => x.severity === 'error');

/** Proveedores que necesita una configuración (para `terraform init`). */
export function requiredProviderNames(cfg: Config): string[] {
  const names = new Set<string>(Object.keys(cfg.requiredProviders));
  for (const p of cfg.providers) names.add(p.name);
  for (const r of Object.values(cfg.resources)) names.add(providerOf(r.type));
  return [...names].filter((n) => PROVIDERS[n]).sort();
}
