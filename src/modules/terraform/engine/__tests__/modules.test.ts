import { describe, expect, it } from 'vitest';
import { apply, buildGraph, emptyState, loadConfig, plan, runCommand, satisfies, resolveVersion } from '../index';

const network = {
  'modules/network/variables.tf': 'variable "name" {\n  type = string\n}\n\nvariable "cidr" {\n  type    = string\n  default = "10.0.0.0/16"\n}\n',
  'modules/network/main.tf':
    'resource "aws_vpc" "this" {\n  cidr_block = var.cidr\n  tags       = { Name = var.name }\n}\n\nresource "aws_subnet" "a" {\n  vpc_id     = aws_vpc.this.id\n  cidr_block = cidrsubnet(var.cidr, 8, 1)\n}\n',
  'modules/network/outputs.tf': 'output "vpc_id" {\n  value = aws_vpc.this.id\n}\n',
};

const root = (body: string) => ({ ...network, 'main.tf': `provider "aws" {\n  region = "eu-west-1"\n}\n\n${body}` });

describe('versiones', () => {
  it('evalúa restricciones', () => {
    expect(satisfies('1.2.0', '~> 1.0')).toBe(true);
    expect(satisfies('2.0.0', '~> 1.0')).toBe(false);
    expect(satisfies('1.2.5', '~> 1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~> 1.2.0')).toBe(false);
    expect(satisfies('1.2.0', '>= 1.0, < 1.2')).toBe(false);
    expect(resolveVersion(['1.0.0', '1.2.0', '2.0.0'], '~> 1.0')).toBe('1.2.0');
    expect(resolveVersion(['1.0.0', '1.2.0', '2.0.0'])).toBe('2.0.0');
  });
});

describe('módulos', () => {
  const files = root('module "network" {\n  source = "./modules/network"\n  name   = "principal"\n}\n\noutput "vpc_id" {\n  value = module.network.vpc_id\n}\n');

  it('carga el módulo local y espacia los nombres en el grafo', () => {
    const cfg = loadConfig(files);
    expect(cfg.diagnostics).toEqual([]);
    const g = buildGraph(cfg);
    expect(g.diagnostics).toEqual([]);
    expect(g.deps['module.network.var.name']).toEqual([]);
    expect(g.deps['module.network.aws_subnet.a']).toEqual(['module.network.aws_vpc.this', 'module.network.var.cidr']);
    expect(g.deps['output.vpc_id']).toEqual(['module.network.output.vpc_id']);
  });

  it('aplica con direcciones de módulo y propaga los outputs', () => {
    const r = apply(files, emptyState());
    expect(r.ok).toBe(true);
    expect(Object.keys(r.state.resources).sort()).toEqual(['module.network.aws_subnet.a', 'module.network.aws_vpc.this']);
    expect(r.state.resources['module.network.aws_vpc.this'].module).toBe('module.network');
    expect(r.state.resources['module.network.aws_vpc.this'].attributes.tags).toEqual({ Name: 'principal' });
    expect(r.state.outputs.vpc_id.value).toBe(r.state.resources['module.network.aws_vpc.this'].attributes.id);
    expect(plan(files, r.state).changes.every((c) => c.action === 'noop')).toBe(true);
  });

  it('el ámbito de un módulo es privado', () => {
    const bad = root('module "network" {\n  source = "./modules/network"\n  name   = "x"\n}\n\noutput "id" {\n  value = aws_vpc.this.id\n}\n');
    const g = buildGraph(loadConfig(bad));
    expect(g.diagnostics[0].summary).toBe('Reference to undeclared resource');
    expect(g.diagnostics[0].hint).toContain('module.network');
    const badOut = root('module "network" {\n  source = "./modules/network"\n  name   = "x"\n}\n\noutput "id" {\n  value = module.network.subnet_id\n}\n');
    expect(buildGraph(loadConfig(badOut)).diagnostics[0].hint).toContain('vpc_id');
  });

  it('valida los argumentos del bloque module', () => {
    const cfg = loadConfig(root('module "network" {\n  source = "./modules/network"\n  nombre = "x"\n}\n'));
    const s = cfg.diagnostics.map((d) => d.summary);
    expect(s).toContain('Unsupported argument');
    expect(s).toContain('Missing required argument');
    const missing = loadConfig(root('module "x" {\n  source = "./modules/nada"\n}\n'));
    expect(missing.diagnostics[0].summary).toBe('Unreadable module directory');
  });

  it('resuelve módulos del registro por versión', () => {
    const reg = root('module "vpc" {\n  source  = "devopslab/vpc/aws"\n  version = "~> 1.0"\n  name    = "red"\n  cidr    = "10.1.0.0/16"\n  azs     = ["eu-west-1a", "eu-west-1b"]\n  public_subnets = ["10.1.1.0/24", "10.1.2.0/24"]\n}\n');
    const cfg = loadConfig(reg);
    expect(cfg.diagnostics).toEqual([]);
    expect(cfg.moduleCalls.vpc.resolvedVersion).toBe('1.2.0');
    const r = apply(reg, emptyState());
    expect(r.ok).toBe(true);
    expect(Object.keys(r.state.resources).filter((a) => a.startsWith('module.vpc.aws_subnet.public')).length).toBe(2);
    // sin versión → 2.0.0, que renombró "cidr"
    const latest = loadConfig({ ...reg, 'main.tf': reg['main.tf'].replace('  version = "~> 1.0"\n', '') });
    expect(latest.moduleCalls.vpc.resolvedVersion).toBe('2.0.0');
    expect(latest.diagnostics[0].hint).toContain('cidr_block');
  });

  it('init instala los módulos y plan exige reinstalar si cambian', () => {
    const reg = root('module "logs" {\n  source  = "devopslab/s3-bucket/aws"\n  version = "1.0.0"\n  bucket_name = "logs-equipo-2026"\n}\n');
    const ctx = { files: reg, state: emptyState(), initialized: [] as string[], consoleMode: false };
    const p0 = runCommand('terraform plan', ctx);
    expect(p0.kind === 'lines' && p0.lines.some((l) => l.text.includes('Module not installed'))).toBe(true);
    const init = runCommand('terraform init', ctx);
    if (init.kind !== 'lines') throw new Error();
    expect(init.lines.some((l) => l.text.includes('Downloading registry.terraform.io/devopslab/s3-bucket/aws 1.0.0'))).toBe(true);
    const ctx2 = { ...ctx, initialized: init.initialized! };
    const p1 = runCommand('terraform plan', ctx2);
    expect(p1.kind === 'lines' && p1.history?.ok).toBe(true);
    const bumped = { ...ctx2, files: { ...reg, 'main.tf': reg['main.tf'].replace('"1.0.0"', '"~> 1.1"') } };
    const p2 = runCommand('terraform plan', bumped);
    expect(p2.kind === 'lines' && p2.lines.some((l) => l.text.includes('Module version requirements have changed'))).toBe(true);
  });
});
