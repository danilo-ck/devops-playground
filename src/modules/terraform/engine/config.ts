import { parseHcl, type Attribute, type Body, type Expr } from './parser';
import { getSchema, PROVIDERS, providerOf, RESOURCE_SCHEMAS, DATA_SCHEMAS, suggest, type ArgSpec } from './providers';
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
  return loadModule(rootFiles, ctx, '', '', 0);
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
        default: {
          const s = suggest(b.type, ['resource', 'variable', 'output', 'locals', 'provider', 'terraform', 'data', 'module']);
          diags.push({
            severity: 'error',
            summary: 'Unsupported block type',
            detail: `Blocks of type "${b.type}" are not expected here.${s ? ` Did you mean "${s}"?` : ''}`,
            hint: s ? `¿Querías escribir "${s}"?` : 'Bloques válidos: terraform, provider, resource, data, variable, locals, output, module.',
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
