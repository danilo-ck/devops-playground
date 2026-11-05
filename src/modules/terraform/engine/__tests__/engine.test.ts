import { describe, expect, it } from 'vitest';
import { apply, plan, emptyState, runCommand, isUnknown, buildGraph, loadConfig, type TfState } from '../index';

const PROVIDER = 'provider "aws" {\n  region = "us-east-1"\n}\n';

function applyOk(files: Record<string, string>, state: TfState = emptyState()) {
  const r = apply(files, state);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
  return r;
}

describe('parser y configuración', () => {
  it('detecta errores de sintaxis con línea', () => {
    const cfg = loadConfig({ 'main.tf': 'resource "aws_vpc" "x" {\n  cidr_block = "10.0.0.0/16\n}' });
    expect(cfg.diagnostics[0].summary).toBe('Syntax error');
    expect(cfg.diagnostics[0].line).toBe(2);
  });

  it('sugiere tipos de recurso mal escritos', () => {
    const cfg = loadConfig({ 'main.tf': 'resource "aws_vcp" "x" {\n  cidr_block = "10.0.0.0/16"\n}' });
    expect(cfg.diagnostics[0].hint).toContain('aws_vpc');
  });

  it('detecta argumentos obligatorios ausentes y desconocidos', () => {
    const cfg = loadConfig({ 'main.tf': 'resource "aws_subnet" "x" {\n  cidr_blok = "10.0.0.0/24"\n}' });
    const s = cfg.diagnostics.map((d) => d.summary);
    expect(s).toContain('Unsupported argument');
    expect(s).toContain('Missing required argument');
  });

  it('construye el grafo de dependencias implícitas', () => {
    const cfg = loadConfig({
      'main.tf': `${PROVIDER}
variable "cidr" { default = "10.0.0.0/16" }
resource "aws_vpc" "main" { cidr_block = var.cidr }
resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = cidrsubnet(var.cidr, 8, 1)
}
output "subnet" { value = aws_subnet.a.id }`,
    });
    const g = buildGraph(cfg);
    expect(g.deps['aws_subnet.a']).toEqual(['aws_vpc.main', 'var.cidr']);
    expect(g.order.indexOf('aws_vpc.main')).toBeLessThan(g.order.indexOf('aws_subnet.a'));
  });

  it('detecta ciclos', () => {
    const cfg = loadConfig({ 'main.tf': 'locals {\n  a = local.b\n  b = local.a\n}' });
    expect(buildGraph(cfg).diagnostics[0].summary).toBe('Cycle');
  });
});

describe('plan / apply', () => {
  const files = {
    'main.tf': `${PROVIDER}
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = { Name = "principal" }
}
resource "aws_subnet" "public" {
  count      = 2
  vpc_id     = aws_vpc.main.id
  cidr_block = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
}
output "vpc_id" { value = aws_vpc.main.id }`,
  };

  it('planifica creaciones con valores desconocidos', () => {
    const p = plan(files, emptyState());
    expect(p.ok).toBe(true);
    expect(p.summary).toEqual({ add: 3, change: 0, destroy: 0 });
    const sub = p.changes.find((c) => c.addr === 'aws_subnet.public[1]')!;
    expect(sub.after!.cidr_block).toBe('10.0.1.0/24');
    expect(isUnknown(sub.after!.vpc_id)).toBe(true);
    expect((sub.after!.vpc_id as { source?: string }).source).toBe('aws_vpc.main');
  });

  it('aplica y después no hay cambios', () => {
    const r = applyOk(files);
    expect(Object.keys(r.state.resources).sort()).toEqual(['aws_subnet.public[0]', 'aws_subnet.public[1]', 'aws_vpc.main']);
    expect(r.state.outputs.vpc_id.value).toMatch(/^vpc-/);
    expect(r.state.resources['aws_subnet.public[0]'].dependencies).toEqual(['aws_vpc.main']);
    const p2 = plan(files, r.state);
    expect(p2.changes.every((c) => c.action === 'noop')).toBe(true);
  });

  it('distingue update in-place de replace (con cascada)', () => {
    const r = applyOk(files);
    const tagged = { 'main.tf': files['main.tf'].replace('"principal"', '"otra"') };
    expect(plan(tagged, r.state).changes.find((c) => c.addr === 'aws_vpc.main')!.action).toBe('update');
    const recidr = { 'main.tf': files['main.tf'].replace('cidr_block = "10.0.0.0/16"', 'cidr_block = "10.1.0.0/16"') };
    const p = plan(recidr, r.state);
    expect(p.changes.find((c) => c.addr === 'aws_vpc.main')!.action).toBe('replace');
    expect(p.changes.find((c) => c.addr === 'aws_subnet.public[0]')!.action).toBe('replace');
    const r2 = applyOk(recidr, r.state);
    expect(r2.state.resources['aws_subnet.public[0]'].attributes.cidr_block).toBe('10.1.0.0/24');
    const destroys = r2.events.filter((e) => e.phase === 'destroying' && e.kind === 'start').map((e) => e.addr);
    expect(destroys.indexOf('aws_vpc.main')).toBe(destroys.length - 1);
  });

  it('reducir count destruye las instancias sobrantes', () => {
    const r = applyOk(files);
    const one = { 'main.tf': files['main.tf'].replace('count      = 2', 'count      = 1') };
    const p = plan(one, r.state);
    expect(p.changes.find((c) => c.addr === 'aws_subnet.public[1]')!.action).toBe('delete');
  });

  it('destroy elimina todo en orden inverso', () => {
    const r = applyOk(files);
    const d = apply(files, r.state, { destroy: true });
    expect(d.ok).toBe(true);
    expect(Object.keys(d.state.resources)).toHaveLength(0);
    const order = d.events.filter((e) => e.kind === 'start').map((e) => e.addr);
    expect(order[order.length - 1]).toBe('aws_vpc.main');
  });

  it('for_each exige map o set', () => {
    const bad = { 'main.tf': 'resource "aws_s3_bucket" "b" {\n  for_each = ["a-logs", "b-logs"]\n  bucket = each.key\n}' };
    const p = plan(bad, emptyState());
    expect(p.ok).toBe(false);
    expect(p.diagnostics[0].hint).toContain('toset');
    const good = { 'main.tf': 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["a-logs", "b-logs"])\n  bucket = "empresa-${each.key}"\n}' };
    const r = applyOk(good);
    expect(r.state.resources['aws_s3_bucket.b["a-logs"]'].attributes.bucket).toBe('empresa-a-logs');
  });

  it('valida variables y tfvars', () => {
    const f = { 'main.tf': 'variable "name" {\n  type = string\n}\nresource "aws_s3_bucket" "b" {\n  bucket = var.name\n}' };
    expect(plan(f, emptyState()).diagnostics[0].summary).toBe('No value for required variable');
    const withVars = { ...f, 'terraform.tfvars': 'name = "mi-bucket-123"' };
    expect(applyOk(withVars).state.resources['aws_s3_bucket.b'].attributes.bucket).toBe('mi-bucket-123');
    const p = plan(f, emptyState(), { cliVars: { name: 'cli-bucket-1' } });
    expect(p.changes[0].after!.bucket).toBe('cli-bucket-1');
  });

  it('error de apply parcial: subred fuera de la VPC', () => {
    const f = {
      'main.tf': 'resource "aws_vpc" "v" { cidr_block = "10.0.0.0/16" }\nresource "aws_subnet" "s" {\n  vpc_id     = aws_vpc.v.id\n  cidr_block = "192.168.1.0/24"\n}',
    };
    const r = apply(f, emptyState());
    expect(r.ok).toBe(false);
    expect(Object.keys(r.state.resources)).toEqual(['aws_vpc.v']);
    expect(r.diagnostics.at(-1)!.summary).toContain('InvalidSubnet.Range');
  });

  it('expresiones: for, splat, condicional, funciones', () => {
    const f = {
      'main.tf': `
locals {
  envs  = ["dev", "prod"]
  names = [for e in local.envs : upper(e)]
  m     = { for e in local.envs : e => length(e) }
}
resource "aws_instance" "web" {
  count         = 2
  ami           = "ami-0abc1234"
  instance_type = count.index == 0 ? "t3.micro" : "t3.small"
  tags          = { Name = format("web-%02d", count.index + 1) }
}
output "names" { value = local.names }
output "m" { value = local.m }
output "ids" { value = aws_instance.web[*].id }
output "types" { value = join(",", aws_instance.web[*].instance_type) }`,
    };
    const r = applyOk(f);
    expect(r.state.outputs.names.value).toEqual(['DEV', 'PROD']);
    expect(r.state.outputs.m.value).toEqual({ dev: 3, prod: 4 });
    expect((r.state.outputs.ids.value as string[]).length).toBe(2);
    expect(r.state.outputs.types.value).toBe('t3.micro,t3.small');
    expect(r.state.resources['aws_instance.web[1]'].attributes.tags).toEqual({ Name: 'web-02' });
  });
});

describe('CLI', () => {
  it('exige init antes de plan y pide confirmación en apply', () => {
    const ctx = { files: { 'main.tf': 'resource "random_pet" "p" {}' }, state: emptyState(), initialized: [] as string[], consoleMode: false };
    const o1 = runCommand('terraform plan', ctx);
    expect(o1.kind === 'lines' && o1.history?.ok).toBe(false);
    const o2 = runCommand('terraform init', ctx);
    expect(o2.kind === 'lines' && o2.initialized).toEqual(['random']);
    const o3 = runCommand('terraform apply', { ...ctx, initialized: ['random'] });
    expect(o3.kind).toBe('confirm');
    const o4 = runCommand('tf apply -auto-approve', { ...ctx, initialized: ['random'] });
    expect(o4.kind).toBe('apply');
  });
});
