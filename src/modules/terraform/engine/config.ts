import { parseHcl, type Attribute, type Body, type Expr } from './parser';
import { getSchema, PROVIDERS, providerOf, RESOURCE_SCHEMAS, DATA_SCHEMAS, suggest, TF_VERSION, type ArgSpec } from './providers';
import type { Value } from './values';
import { isLocalSource, isRegistrySource, isValidConstraint, joinPath, REGISTRY, resolveVersion, satisfies } from './registry';

export interface Diagnostic {
  severity: 'error' | 'warning';
  summary: string;
  detail?: string;
  /** Explicación didáctica en español. */
  hint?: string;
  file?: string;
  line?: number;
}

/** precondition / postcondition / assert: condición + mensaje de error. */
export interface Condition {
  condition: Expr;
  errorMessage: Expr;
  file: string;
  line: number;
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
  /** Configuración de proveedor que usa: "aws" o "aws.virginia" (meta-argumento provider). */
  provider: string;
  preconditions: Condition[];
  postconditions: Condition[];
  file: string;
  line: number;
}

export interface VariableConfig {
  name: string;
  type?: Expr;
  default?: Expr;
  description?: string;
  sensitive: boolean;
  /** ephemeral = true: el valor nunca se guarda en el plan ni en el estado. */
  ephemeral: boolean;
  validations: { condition: Expr; errorMessage: string; line: number }[];
  file: string;
  line: number;
}

export interface OutputConfig {
  name: string;
  value: Expr;
  description?: string;
  sensitive: boolean;
  ephemeral: boolean;
  preconditions: Condition[];
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
  /** alias = "virginia" → se usa como provider = aws.virginia */
  alias?: string;
  body: Body;
  file: string;
  line: number;
}

export interface ModuleCallConfig {
  /** Dirección completa de la llamada: module.network (o module.app.module.db). */
  id: string;
  name: string;
  source: string;
  /** Restricción de versión escrita por el usuario (solo registro). */
  version?: string;
  kind: 'local' | 'registry';
  /** Carpeta del módulo local, relativa a la raíz del proyecto. */
  dir?: string;
  /** Versión del registro que se ha cargado. */
  resolvedVersion?: string;
  args: Attribute[];
  dependsOn: string[];
  file: string;
  line: number;
}

/** terraform { backend "s3" { ... } } */
export interface BackendConfig {
  type: string;
  attrs: Record<string, Value>;
  file: string;
  line: number;
}

/** terraform { cloud { organization = "..." workspaces { name = "..." } } } */
export interface CloudBlockConfig {
  organization?: string;
  hostname: string;
  workspaceName?: string;
  workspaceTags?: string[];
  project?: string;
  file: string;
  line: number;
}

/** moved { from = aws_instance.a  to = aws_instance.b } */
export interface MovedConfig {
  from: string;
  to: string;
  file: string;
  line: number;
}

/** check "nombre" { assert { condition = ...  error_message = "..." } } */
export interface CheckConfig {
  name: string;
  asserts: Condition[];
  file: string;
  line: number;
}

/** Bloque import { to = aws_s3_bucket.logs  id = "mi-bucket" } (Terraform >= 1.5). */
export interface ImportConfig {
  /** Dirección de la instancia destino: aws_s3_bucket.logs, aws_instance.web[0], module.x.aws_vpc.this */
  to: string;
  /** Dirección del recurso (sin índice). */
  resourceAddr: string;
  indexKey?: string | number;
  id: Expr;
  file: string;
  line: number;
}

/** Versión instalada por `terraform init` para cada llamada a módulo. */
export type InstalledModules = Record<string, { source: string; version: string }>;

export interface Config {
  /** '' en el módulo raíz; 'module.network.' en un módulo hijo. */
  prefix: string;
  resources: Record<string, ResourceConfig>;
  variables: Record<string, VariableConfig>;
  locals: Record<string, LocalConfig>;
  outputs: Record<string, OutputConfig>;
  providers: ProviderConfig[];
  requiredProviders: Record<string, { source?: string; version?: string }>;
  moduleCalls: Record<string, ModuleCallConfig>;
  /** Bloques import (solo en el módulo raíz). */
  imports: ImportConfig[];
  moved: MovedConfig[];
  checks: CheckConfig[];
  requiredVersion?: { constraint: string; file: string; line: number };
  backend?: BackendConfig;
  cloud?: CloudBlockConfig;
  children: Record<string, Config>;
  /** En el módulo raíz incluye también los diagnósticos de todos los hijos. */
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
    if (b.type === 'dynamic') {
      const label = b.labels[0];
      const spec = label ? args[label] : undefined;
      const blockNames = Object.entries(args).filter(([, a]) => a.type === 'block').map(([n]) => n);
      if (!spec || spec.type !== 'block') {
        diags.push({
          severity: 'error',
          summary: 'Unsupported block type',
          detail: `Blocks of type "${label ?? ''}" are not expected here.`,
          hint: blockNames.length
            ? `dynamic "<tipo>" genera bloques anidados del recurso. ${where} admite: ${blockNames.join(', ')}.`
            : `${where} no tiene bloques anidados que generar con dynamic.`,
          file,
          line: b.line,
        });
        continue;
      }
      const content = b.body.blocks.find((x) => x.type === 'content');
      if (!b.body.attributes.some((a) => a.name === 'for_each'))
        diags.push({ severity: 'error', summary: 'Missing required argument', detail: 'The argument "for_each" is required, but no definition was found.', hint: 'Un bloque dynamic necesita for_each con la colección a recorrer.', file, line: b.line });
      if (!content)
        diags.push({ severity: 'error', summary: 'Missing required block', detail: 'A block of type "content" is required here.', hint: `Dentro de dynamic va un bloque content { ... } con los argumentos de cada ${label}.`, file, line: b.line });
      for (const a of b.body.attributes)
        if (!['for_each', 'iterator', 'labels'].includes(a.name))
          diags.push({ severity: 'error', summary: 'Unsupported argument', detail: `An argument named "${a.name}" is not expected here.`, hint: 'dynamic solo admite for_each, iterator y el bloque content.', file, line: a.line });
      present.add(label);
      if (content) validateArgs(content.body, spec.block ?? {}, `el bloque "${label}"`, file, diags, false, content.line);
      continue;
    }
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

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

interface LoadCtx {
  allFiles: Record<string, string>;
  installed: InstalledModules;
  diags: Diagnostic[];
}

/**
 * Carga la configuración del módulo raíz (ficheros .tf sin carpeta) y, de forma
 * recursiva, la de los módulos que llama (carpetas locales o registro simulado).
 */
export function loadConfig(files: Record<string, string>, installed: InstalledModules = {}): Config {
  const ctx: LoadCtx = { allFiles: files, installed, diags: [] };
  const rootFiles = Object.fromEntries(Object.entries(files).filter(([f]) => !f.includes('/')));
  const root = loadModule(rootFiles, ctx, '', '', 0);
  for (const c of Object.values(moduleConfigs(root))) {
    for (const r of Object.values(c.resources)) {
      if (!r.provider.includes('.')) continue;
      const [name, alias] = r.provider.split('.');
      if (!root.providers.some((p) => p.name === name && p.alias === alias))
        ctx.diags.push({
          severity: 'error',
          summary: 'Provider configuration not present',
          detail: `To work with ${c.prefix}${r.addr} its original provider configuration at provider["registry.terraform.io/hashicorp/${name}"].${alias} is required, but it has been removed.`,
          hint: `Declara provider "${name}" { alias = "${alias}" ... } en el módulo raíz.`,
          file: r.file,
          line: r.line,
        });
    }
  }
  for (const m of root.moved) {
    const toCfg = m.to.startsWith('module.') && !/\.(aws|random|local)_/.test(m.to) ? undefined : findResource(root, m.to.replace(/\[[^\]]*\]$/, ''));
    if (findResource(root, m.from.replace(/\[[^\]]*\]$/, '')))
      ctx.diags.push({ severity: 'error', summary: 'Moved object still exists', detail: `This statement declares a move from ${m.from}, but that resource is still declared in configuration.`, hint: `Al renombrar, el bloque resource debe llamarse ya como el destino (${m.to}); from es el nombre antiguo.`, file: m.file, line: m.line });
    else if (!toCfg && !m.to.startsWith('module.'))
      ctx.diags.push({ severity: 'error', summary: 'Moved target does not exist', detail: `The move target ${m.to} is not declared in configuration.`, hint: `Declara el recurso ${m.to} (el nombre nuevo).`, file: m.file, line: m.line });
  }
  for (const imp of root.imports) {
    const rc = findResource(root, imp.resourceAddr);
    if (rc && rc.mode === 'managed') {
      if (imp.indexKey !== undefined && !rc.count && !rc.forEach)
        ctx.diags.push({ severity: 'error', summary: 'Invalid import address', detail: `${imp.resourceAddr} does not use count or for_each, so the address cannot have an index.`, hint: `Quita el índice: to = ${imp.resourceAddr}`, file: imp.file, line: imp.line });
      continue;
    }
    const [type, name] = imp.resourceAddr.replace(/^(module.[^.]+.)*/, '').split('.');
    ctx.diags.push({
      severity: 'error',
      summary: 'Configuration for import target does not exist',
      detail: `The configuration for the given import ${imp.to} does not exist. All target instances must have an associated configuration to be imported.`,
      hint: `Declara el bloque resource "${type}" "${name}" { ... } con los mismos valores que el objeto real, o deja que Terraform lo escriba por ti: terraform plan -generate-config-out=generated.tf`,
      file: imp.file,
      line: imp.line,
    });
  }
  return root;
}

/** Convierte la expresión de "to" (aws_instance.web[0]) en una dirección. */
export function exprToInstanceAddr(e: Expr): { to: string; resourceAddr: string; indexKey?: string | number } | undefined {
  const parts: string[] = [];
  let indexKey: string | number | undefined;
  let cur: Expr = e;
  if (cur.kind === 'index') {
    if (cur.key.kind !== 'literal' || (typeof cur.key.value !== 'number' && typeof cur.key.value !== 'string')) return undefined;
    indexKey = cur.key.value;
    cur = cur.target;
  }
  while (cur.kind === 'getattr') {
    parts.unshift(cur.name);
    cur = cur.target;
  }
  if (cur.kind !== 'variable') return undefined;
  parts.unshift(cur.name);
  const mods: string[] = [];
  while (parts[0] === 'module' && parts.length > 2) mods.push(`module.${parts.splice(0, 2)[1]}.`);
  if (parts.length !== 2 || parts[0] === 'data' || parts[0] === 'var' || parts[0] === 'local') return undefined;
  const resourceAddr = mods.join('') + parts.join('.');
  const to = indexKey === undefined ? resourceAddr : typeof indexKey === 'number' ? `${resourceAddr}[${indexKey}]` : `${resourceAddr}["${indexKey}"]`;
  return { to, resourceAddr, indexKey };
}

function loadModule(files: Record<string, string>, ctx: LoadCtx, prefix: string, dir: string, depth: number): Config {
  const cfg: Config = {
    prefix,
    resources: {},
    variables: {},
    locals: {},
    outputs: {},
    providers: [],
    requiredProviders: {},
    moduleCalls: {},
    imports: [],
    moved: [],
    checks: [],
    children: {},
    diagnostics: ctx.diags,
  };
  const diags = ctx.diags;
  const pendingCalls: ModuleCallConfig[] = [];

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
          parseTerraformBlock(b, cfg, file, diags, !prefix);
          const rp = b.body.blocks.find((x) => x.type === 'required_providers');
          for (const a of rp?.body.attributes ?? []) {
            const obj = a.expr.kind === 'object' ? a.expr : undefined;
            const get = (k: string) =>
              literalString(obj?.items.find((i) => (i.key.kind === 'literal' || i.key.kind === 'variable') && ((i.key as { value?: unknown }).value ?? (i.key as { name?: string }).name) === k)?.value);
            cfg.requiredProviders[a.name] = { source: get('source'), version: get('version') };
            const v = get('version');
            if (v !== undefined && !isValidConstraint(v))
              diags.push({ severity: 'error', summary: 'Invalid version constraint', detail: `"${v}" is not a valid version constraint.`, hint: 'Ejemplos: "~> 5.0", ">= 5.30, < 6.0", "5.72.1".', file, line: a.line });
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
          const aliasAttr = attr('alias');
          const alias = literalString(aliasAttr?.expr);
          if (aliasAttr && (alias === undefined || !NAME_RE.test(alias))) {
            diags.push({ severity: 'error', summary: 'Invalid provider configuration alias', detail: 'An alias must be a valid name.', hint: 'alias es un texto fijo, p.ej. alias = "virginia".', file, line: aliasAttr.line });
            break;
          }
          const dup = cfg.providers.find((p) => p.name === b.labels[0] && p.alias === alias);
          if (dup) {
            diags.push({
              severity: 'error',
              summary: 'Duplicate provider configuration',
              detail: alias ? `A provider configuration for "${b.labels[0]}" with alias "${alias}" was already given at ${dup.file}:${dup.line}.` : `A default (non-aliased) provider configuration for "${b.labels[0]}" was already given at ${dup.file}:${dup.line}.`,
              hint: alias ? 'Cada alias debe ser único.' : `Solo puede haber un provider "${b.labels[0]}" sin alias. Para usar otra región, añade alias = "nombre" al segundo y apúntalo con provider = ${b.labels[0]}.nombre.`,
              file,
              line: b.line,
            });
            break;
          }
          cfg.providers.push({ name: b.labels[0], alias, body: b.body, file, line: b.line });
          break;
        }
        case 'variable': {
          if (!need(1, 'variable "nombre" { ... }')) break;
          const name = b.labels[0];
          if (cfg.variables[name]) {
            diags.push({ severity: 'error', summary: 'Duplicate variable declaration', detail: `A variable named "${name}" was already declared.`, hint: 'Cada variable solo puede declararse una vez.', file, line: b.line });
            break;
          }
          const allowed = new Set(['default', 'type', 'description', 'sensitive', 'nullable', 'ephemeral']);
          for (const a of b.body.attributes) {
            if (!allowed.has(a.name))
              diags.push({ severity: 'error', summary: 'Unsupported argument', detail: `An argument named "${a.name}" is not expected here.`, hint: 'Un bloque variable admite: type, default, description, sensitive, nullable, ephemeral y bloques validation.', file, line: a.line });
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
            sensitive: litTrue(attr('sensitive')?.expr),
            ephemeral: litTrue(attr('ephemeral')?.expr),
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
          for (const a of b.body.attributes)
            if (!['value', 'description', 'sensitive', 'depends_on', 'ephemeral'].includes(a.name))
              diags.push({ severity: 'error', summary: 'Unsupported argument', detail: `An argument named "${a.name}" is not expected here.`, hint: 'Un output admite: value, description, sensitive, ephemeral, depends_on y bloques precondition.', file, line: a.line });
          const ephemeral = litTrue(attr('ephemeral')?.expr);
          if (ephemeral && !prefix)
            diags.push({ severity: 'error', summary: 'Ephemeral output not allowed', detail: 'Ephemeral outputs are not allowed in context of a root module.', hint: 'Un output ephemeral solo tiene sentido en un módulo hijo: el raíz guardaría el valor y dejaría de ser efímero.', file, line: attr('ephemeral')!.line });
          cfg.outputs[name] = {
            name,
            value: value.expr,
            description: literalString(attr('description')?.expr),
            sensitive: litTrue(attr('sensitive')?.expr),
            ephemeral,
            preconditions: conditionsOf(b.body, 'precondition', file, diags),
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
          let provider = prov;
          const provAttr = attr('provider');
          if (provAttr) {
            const ref = traversalToAddr(provAttr.expr) ?? (provAttr.expr.kind === 'variable' ? provAttr.expr.name : undefined);
            const [pname] = (ref ?? '').split('.');
            if (!ref) diags.push({ severity: 'error', summary: 'Invalid provider reference', detail: 'Provider argument requires a provider name followed by an optional alias, like "aws.foo".', hint: 'Sin comillas: provider = aws.virginia', file, line: provAttr.line });
            else if (pname !== prov) diags.push({ severity: 'error', summary: 'Invalid provider reference', detail: `Resource type "${type}" belongs to provider "${prov}", not "${pname}".`, hint: `Un recurso ${type} solo puede usar una configuración del proveedor ${prov}.`, file, line: provAttr.line });
            else provider = ref;
          }
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
            provider,
            preconditions: lc ? conditionsOf(lc.body, 'precondition', file, diags) : [],
            postconditions: lc ? conditionsOf(lc.body, 'postcondition', file, diags) : [],
            file,
            line: b.line,
          };
          break;
        }
        case 'moved': {
          const fromAttr = attr('from');
          const toAttr = attr('to');
          if (!fromAttr || !toAttr) {
            diags.push({ severity: 'error', summary: 'Missing required argument', detail: `The argument "${!fromAttr ? 'from' : 'to'}" is required, but no definition was found.`, hint: 'moved { from = aws_instance.viejo  to = aws_instance.nuevo }', file, line: b.line });
            break;
          }
          const from = movedAddr(fromAttr.expr);
          const to = movedAddr(toAttr.expr);
          if (!from || !to) {
            diags.push({ severity: 'error', summary: 'Invalid "moved" address', detail: 'Expected a resource or module address.', hint: 'from y to son direcciones sin comillas: aws_instance.web, aws_instance.web[0] o module.red.', file, line: (from ? toAttr : fromAttr).line });
            break;
          }
          if (from.startsWith('module.') !== to.startsWith('module.') || (from.split('.')[0] !== to.split('.')[0] && !from.startsWith('module.'))) {
            diags.push({ severity: 'error', summary: 'Invalid "moved" addresses', detail: `Cannot move ${from} to ${to}: the resource types must match.`, hint: 'Un moved solo puede renombrar: el tipo de recurso no puede cambiar.', file, line: b.line });
            break;
          }
          cfg.moved.push({ from: prefix + from, to: prefix + to, file, line: b.line });
          break;
        }
        case 'check': {
          if (!need(1, 'check "nombre" { assert { condition = ...  error_message = "..." } }')) break;
          const asserts = conditionsOf(b.body, 'assert', file, diags);
          if (!asserts.length) diags.push({ severity: 'error', summary: 'Missing required block', detail: 'A check block must contain at least one assert block.', hint: 'Añade assert { condition = ...  error_message = "..." }', file, line: b.line });
          if (b.body.blocks.some((x) => x.type === 'data'))
            diags.push({ severity: 'warning', summary: 'Scoped data sources not simulated', detail: 'El simulador ignora los data sources declarados dentro de un check.', hint: 'En Terraform real, un data dentro de check solo se usa en sus assert y sus errores son avisos.', file, line: b.line });
          cfg.checks.push({ name: b.labels[0], asserts, file, line: b.line });
          break;
        }
        case 'module': {
          if (!need(1, 'module "nombre" { source = "./modules/red" }')) break;
          const name = b.labels[0];
          if (cfg.moduleCalls[name] || pendingCalls.some((c) => c.name === name)) {
            diags.push({ severity: 'error', summary: 'Duplicate module call', detail: `A module call named "${name}" was already defined.`, hint: 'Cada llamada a un módulo necesita un nombre distinto.', file, line: b.line });
            break;
          }
          const srcAttr = attr('source');
          const source = literalString(srcAttr?.expr);
          if (!srcAttr) {
            diags.push({ severity: 'error', summary: 'Missing required argument', detail: 'The argument "source" is required, but no definition was found.', hint: 'Todo módulo necesita source: una ruta local ("./modules/red") o una dirección del registro ("devopslab/vpc/aws").', file, line: b.line });
            break;
          }
          if (source === undefined) {
            diags.push({ severity: 'error', summary: 'Variables not allowed', detail: 'Variables may not be used here.', hint: 'source debe ser un texto fijo: Terraform necesita conocerlo en "terraform init", antes de evaluar variables.', file, line: srcAttr.line });
            break;
          }
          const verAttr = attr('version');
          const version = literalString(verAttr?.expr);
          for (const meta of ['count', 'for_each']) {
            if (attr(meta)) {
              diags.push({ severity: 'error', summary: `"${meta}" on modules not supported yet`, detail: `El simulador todavía no admite ${meta} en bloques module.`, hint: `En Terraform real sí puedes usar ${meta} en un module para crear varias copias del módulo.`, file, line: attr(meta)!.line });
            }
          }
          const dependsOn: string[] = [];
          const dep = attr('depends_on');
          if (dep?.expr.kind === 'tuple') for (const item of dep.expr.items) {
            const ref = traversalToAddr(item);
            if (ref) dependsOn.push(ref);
          }
          const reserved = new Set(['source', 'version', 'count', 'for_each', 'depends_on', 'providers']);
          pendingCalls.push({
            id: `${prefix}module.${name}`,
            name,
            source,
            version,
            kind: isLocalSource(source) ? 'local' : 'registry',
            args: b.body.attributes.filter((a) => !reserved.has(a.name)),
            dependsOn,
            file,
            line: verAttr?.line ?? b.line,
          });
          if (version !== undefined && !isValidConstraint(version)) {
            diags.push({ severity: 'error', summary: 'Invalid version constraint', detail: `"${version}" is not a valid version constraint.`, hint: 'Ejemplos válidos: "1.2.0", "~> 1.2", ">= 1.0, < 2.0".', file, line: verAttr!.line });
          }
          break;
        }
        case 'import': {
          if (b.labels.length) {
            diags.push({ severity: 'error', summary: 'Extraneous label for import', detail: 'No labels are expected for import blocks.', hint: 'El bloque import no lleva nombre: import { to = ...  id = "..." }', file, line: b.line });
            break;
          }
          if (prefix) {
            diags.push({ severity: 'error', summary: 'Invalid import configuration', detail: 'An import block was detected in a module. Import blocks are only allowed in the root module.', hint: 'Los bloques import solo pueden ir en el módulo raíz. Para importar un recurso de un módulo usa to = module.<nombre>.<tipo>.<nombre>.', file, line: b.line });
            break;
          }
          const toAttr = attr('to');
          const idAttr = attr('id');
          if (!toAttr || !idAttr) {
            diags.push({ severity: 'error', summary: 'Missing required argument', detail: `The argument "${!toAttr ? 'to' : 'id'}" is required, but no definition was found.`, hint: 'Un bloque import necesita to (la dirección del recurso en tu código) e id (el identificador del objeto en la nube).', file, line: b.line });
            break;
          }
          const target = exprToInstanceAddr(toAttr.expr);
          if (!target) {
            diags.push({ severity: 'error', summary: 'Invalid import address', detail: 'The "to" argument must be a resource instance address.', hint: 'to es una referencia sin comillas: to = aws_s3_bucket.logs', file, line: toAttr.line });
            break;
          }
          if (cfg.imports.some((i) => i.to === target.to)) {
            diags.push({ severity: 'error', summary: 'Duplicate import configuration', detail: `An import block for the resource "${target.to}" was already declared.`, hint: 'Cada recurso solo se puede importar una vez.', file, line: b.line });
            break;
          }
          cfg.imports.push({ ...target, id: idAttr.expr, file, line: b.line });
          break;
        }
        default: {
          const s = suggest(b.type, ['resource', 'variable', 'output', 'locals', 'provider', 'terraform', 'data', 'module', 'import', 'moved', 'check']);
          diags.push({
            severity: 'error',
            summary: 'Unsupported block type',
            detail: `Blocks of type "${b.type}" are not expected here.${s ? ` Did you mean "${s}"?` : ''}`,
            hint: s ? `¿Querías escribir "${s}"?` : 'Bloques válidos: terraform, provider, resource, data, variable, locals, output, module, import, moved, check.',
            file,
            line: b.line,
          });
        }
      }
    }
  }

  for (const call of pendingCalls) loadChild(cfg, call, ctx, dir, depth);
  return cfg;
}

/** Resuelve el source de una llamada a módulo, carga el hijo y valida sus argumentos. */
function loadChild(parent: Config, call: ModuleCallConfig, ctx: LoadCtx, dir: string, depth: number) {
  const diags = ctx.diags;
  const err = (summary: string, detail: string, hint: string) => diags.push({ severity: 'error', summary, detail, hint, file: call.file, line: call.line });
  parent.moduleCalls[call.name] = call;
  if (depth >= 4) return err('Module nesting too deep', 'Too many levels of nested modules.', 'El simulador admite como máximo 4 niveles de módulos anidados.');

  let childFiles: Record<string, string>;
  let childDir = '';
  if (call.kind === 'local') {
    if (call.version !== undefined) {
      return err('Invalid version constraint', `Cannot apply a version constraint to module "${call.name}" because it has a relative local path.`, 'version solo tiene sentido en módulos del registro: un módulo local siempre usa el código que hay en la carpeta.');
    }
    const resolved = joinPath(dir, call.source);
    if (resolved === null) return err('Invalid module source', `The path "${call.source}" leaves the project directory.`, 'La ruta del módulo debe quedar dentro del proyecto.');
    childDir = resolved;
    call.dir = resolved;
    childFiles = Object.fromEntries(Object.entries(ctx.allFiles).filter(([f]) => f.endsWith('.tf') && dirOf(f) === resolved));
    if (!Object.keys(childFiles).length) {
      return err(
        'Unreadable module directory',
        `Unable to evaluate directory symlink: lstat ${call.source}: no such file or directory`,
        `No hay ficheros .tf en "${resolved}". Crea por ejemplo ${resolved}/main.tf con el botón + del editor, o revisa la ruta.`,
      );
    }
  } else if (isRegistrySource(call.source)) {
    const mod = REGISTRY[call.source];
    if (!mod) {
      return err(
        'Module not found',
        `Could not find module "${call.source}" in registry.terraform.io.`,
        `Módulos disponibles en el registro simulado: ${Object.keys(REGISTRY).join(', ')} (pestaña Docs → Módulos).`,
      );
    }
    const versions = Object.keys(mod.versions);
    const inst = ctx.installed[call.id];
    const usable = inst && inst.source === call.source && versions.includes(inst.version) && (!call.version || satisfies(inst.version, call.version));
    const v = usable ? inst!.version : resolveVersion(versions, call.version);
    if (!v) {
      return err(
        'Unresolvable module version constraint',
        `There is no available version of module "${call.source}" which matches the given version constraint "${call.version}".`,
        `Versiones publicadas: ${versions.join(', ')}.`,
      );
    }
    call.resolvedVersion = v;
    const shortName = call.id.replace(/^module\./, '').replace(/\.module\./g, '.');
    childFiles = Object.fromEntries(Object.entries(mod.versions[v]).map(([f, src]) => [`.terraform/modules/${shortName}/${f}`, src]));
  } else {
    return err(
      'Module source not supported',
      `El simulador no puede descargar módulos desde "${call.source}".`,
      'En Terraform real también se usan fuentes como "github.com/org/repo", "git::https://…" o "s3::…". Aquí usa una ruta local ("./modules/…") o el registro simulado ("devopslab/vpc/aws").',
    );
  }

  const child = loadModule(childFiles, ctx, `${call.id}.`, childDir, depth + 1);
  parent.children[call.name] = child;

  const declared = Object.keys(child.variables);
  for (const a of call.args) {
    if (!child.variables[a.name]) {
      const s = suggest(a.name, declared);
      diags.push({
        severity: 'error',
        summary: 'Unsupported argument',
        detail: `An argument named "${a.name}" is not expected here.${s ? ` Did you mean "${s}"?` : ''}`,
        hint: `El módulo "${call.name}" no declara la variable "${a.name}". ${s ? `¿Querías escribir "${s}"? ` : ''}Entradas disponibles: ${declared.join(', ') || '(ninguna)'}.`,
        file: call.file,
        line: a.line,
      });
    }
  }
  for (const v of Object.values(child.variables)) {
    if (!v.default && !call.args.some((a) => a.name === v.name)) {
      diags.push({
        severity: 'error',
        summary: 'Missing required argument',
        detail: `The argument "${v.name}" is required, but no definition was found.`,
        hint: `La variable "${v.name}" del módulo "${call.name}" no tiene valor por defecto: pásala en el bloque module (${v.name} = ...).`,
        file: call.file,
        line: call.line,
      });
    }
  }
}

/** Todas las configuraciones del árbol, indexadas por prefijo ('' = raíz). */
export function moduleConfigs(root: Config): Record<string, Config> {
  const out: Record<string, Config> = {};
  const visit = (c: Config) => {
    out[c.prefix] = c;
    Object.values(c.children).forEach(visit);
  };
  visit(root);
  return out;
}

/** Todas las llamadas a módulos del árbol (incluidas las anidadas). */
export function allModuleCalls(root: Config): ModuleCallConfig[] {
  return Object.values(moduleConfigs(root)).flatMap((c) => Object.values(c.moduleCalls));
}

/** Separa "module.a.aws_vpc.x" en prefijo ("module.a.") y dirección local ("aws_vpc.x"). */
export function splitAddr(full: string): { prefix: string; local: string } {
  const m = /^((?:module\.[^.[\]]+\.)*)(.*)$/.exec(full)!;
  return { prefix: m[1], local: m[2] };
}

export function findResource(root: Config, fullAddr: string): ResourceConfig | undefined {
  const { prefix, local } = splitAddr(fullAddr);
  return moduleConfigs(root)[prefix]?.resources[local];
}

export const hasErrors = (d: Diagnostic[]) => d.some((x) => x.severity === 'error');

/** Proveedores que necesita una configuración (para `terraform init`). */
export function requiredProviderNames(cfg: Config): string[] {
  const names = new Set<string>();
  for (const c of Object.values(moduleConfigs(cfg))) {
    Object.keys(c.requiredProviders).forEach((n) => names.add(n));
    for (const p of c.providers) names.add(p.name);
    for (const r of Object.values(c.resources)) names.add(providerOf(r.type));
  }
  return [...names].filter((n) => PROVIDERS[n]).sort();
}

const litTrue = (e: Expr | undefined) => !!e && e.kind === 'literal' && e.value === true;

function conditionsOf(body: Body, kind: string, file: string, diags: Diagnostic[]): Condition[] {
  const out: Condition[] = [];
  for (const b of body.blocks.filter((x) => x.type === kind)) {
    const cond = b.body.attributes.find((a) => a.name === 'condition');
    const msg = b.body.attributes.find((a) => a.name === 'error_message');
    if (!cond || !msg) {
      diags.push({ severity: 'error', summary: 'Missing required argument', detail: `The argument "${!cond ? 'condition' : 'error_message'}" is required, but no definition was found.`, hint: `Un bloque ${kind} necesita condition (expresión booleana) y error_message.`, file, line: b.line });
      continue;
    }
    out.push({ condition: cond.expr, errorMessage: msg.expr, file, line: b.line });
  }
  return out;
}

/** Dirección de un moved: aws_instance.web, aws_instance.web[0], module.red */
function movedAddr(e: Expr): string | undefined {
  const t = exprToInstanceAddr(e);
  if (t) return t.to;
  const parts: string[] = [];
  let cur: Expr = e;
  while (cur.kind === 'getattr') {
    parts.unshift(cur.name);
    cur = cur.target;
  }
  if (cur.kind !== 'variable') return undefined;
  parts.unshift(cur.name);
  if (parts.length % 2 === 0 && parts.every((p, i) => (i % 2 === 0 ? p === 'module' : true))) return parts.join('.');
  return undefined;
}

const BACKENDS: Record<string, string[]> = {
  local: [],
  s3: ['bucket', 'key', 'region'],
  azurerm: ['storage_account_name', 'container_name', 'key'],
  gcs: ['bucket'],
  consul: [],
  pg: [],
  http: ['address'],
  kubernetes: ['secret_suffix'],
  remote: [],
};

function parseTerraformBlock(b: { body: Body; line: number }, cfg: Config, file: string, diags: Diagnostic[], isRoot: boolean) {
  const rv = b.body.attributes.find((a) => a.name === 'required_version');
  if (rv) {
    const c = literalString(rv.expr);
    if (c === undefined || !isValidConstraint(c)) diags.push({ severity: 'error', summary: 'Invalid required_version constraint', detail: 'required_version must be a version constraint string.', hint: 'Ejemplo: required_version = ">= 1.5.0"', file, line: rv.line });
    else {
      cfg.requiredVersion = { constraint: c, file, line: rv.line };
      if (!satisfies(TF_VERSION, c))
        diags.push({
          severity: 'error',
          summary: 'Unsupported Terraform Core version',
          detail: `This configuration does not support Terraform version ${TF_VERSION}. To proceed, either choose another supported Terraform version or update this version constraint. Version constraints are normally set for good reason, so updating the constraint may lead to other errors or unexpected behavior.`,
          hint: `El simulador es Terraform ${TF_VERSION} y la configuración pide "${c}". required_version protege de usar una versión de Terraform con la que el código no se ha probado.`,
          file,
          line: rv.line,
        });
    }
  }
  const backends = b.body.blocks.filter((x) => x.type === 'backend');
  const cloud = b.body.blocks.find((x) => x.type === 'cloud');
  if ((backends.length || cloud) && !isRoot) {
    diags.push({ severity: 'warning', summary: 'Backend configuration ignored', detail: 'Any selected backend applies to the entire configuration, so Terraform expects provider configurations only in the root module.', hint: 'El backend solo se configura en el módulo raíz: en un módulo hijo se ignora.', file, line: (backends[0] ?? cloud)!.line });
    return;
  }
  if (backends.length > 1) diags.push({ severity: 'error', summary: 'Duplicate backend configuration', detail: 'A module may have only one backend configuration.', file, line: backends[1].line });
  if (backends.length && cloud) {
    diags.push({ severity: 'error', summary: 'Both a backend and HCP Terraform configuration are present', detail: 'A module may declare either one \'cloud\' block or one \'backend\' block configuring a state backend.', hint: 'Usa backend "…" o cloud { … }, no los dos.', file, line: cloud.line });
    return;
  }
  const be = backends[0];
  if (be) {
    const type = be.labels[0];
    if (!type || !(type in BACKENDS)) {
      diags.push({ severity: 'error', summary: 'Unsupported backend type', detail: `There is no backend type named "${type ?? ''}".`, hint: `Tipos disponibles: ${Object.keys(BACKENDS).join(', ')}.`, file, line: be.line });
      return;
    }
    const attrs: Record<string, Value> = {};
    for (const a of be.body.attributes) {
      if (a.expr.kind !== 'literal') {
        diags.push({ severity: 'error', summary: 'Variables not allowed', detail: 'Variables may not be used here.', hint: 'La configuración del backend se lee en terraform init, antes de evaluar variables: solo admite valores fijos (o -backend-config).', file, line: a.line });
        continue;
      }
      attrs[a.name] = a.expr.value as Value;
    }
    for (const req of BACKENDS[type]) if (!(req in attrs)) diags.push({ severity: 'error', summary: 'Missing required argument', detail: `The argument "${req}" is required, but no definition was found.`, hint: `El backend "${type}" necesita: ${BACKENDS[type].join(', ')}.`, file, line: be.line });
    cfg.backend = { type, attrs, file, line: be.line };
  }
  if (cloud) {
    const ws = cloud.body.blocks.find((x) => x.type === 'workspaces');
    const lit = (body: Body | undefined, n: string) => literalString(body?.attributes.find((a) => a.name === n)?.expr);
    const tagsExpr = ws?.body.attributes.find((a) => a.name === 'tags')?.expr;
    const tags = tagsExpr?.kind === 'tuple' ? tagsExpr.items.map((i) => literalString(i)).filter((x): x is string => !!x) : undefined;
    const c: CloudBlockConfig = {
      organization: lit(cloud.body, 'organization'),
      hostname: lit(cloud.body, 'hostname') ?? 'app.terraform.io',
      workspaceName: lit(ws?.body, 'name'),
      workspaceTags: tags,
      project: lit(ws?.body, 'project'),
      file,
      line: cloud.line,
    };
    if (!c.organization) diags.push({ severity: 'error', summary: 'Invalid or missing required argument', detail: '"organization" must be set in the cloud configuration or as an environment variable: TF_CLOUD_ORGANIZATION.', hint: 'cloud { organization = "mi-empresa"  workspaces { name = "red-prod" } }', file, line: cloud.line });
    if (!ws || (!c.workspaceName && !c.workspaceTags)) diags.push({ severity: 'error', summary: 'Invalid workspaces configuration', detail: 'Missing workspace mapping strategy. Either workspace "tags" or "name" is required.', hint: 'Dentro de cloud añade workspaces { name = "…" } (un workspace) o workspaces { tags = ["…"] } (varios).', file, line: cloud.line });
    cfg.cloud = c;
  }
}
