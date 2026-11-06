import { describe, expect, it } from 'vitest';
import { apply, cloudCreate, cloudDelete, cloudEntries, cloudModify, emptyCloud, plan, renderPlan, runCommand, type CloudChanges, type TfState } from '..';
import { emptyState } from '../state';

const files = {
  'main.tf': `provider "aws" {
  region = "eu-west-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0abc1234"
  instance_type = "t3.micro"
  tags          = { Name = "web" }
}

resource "aws_s3_bucket" "assets" {
  bucket = "assets-equipo-2026"
}
`,
};

const deploy = () => {
  const r = apply(files, emptyState());
  expect(r.ok).toBe(true);
  return r.state;
};

const idOf = (s: TfState, addr: string) => String(s.resources[addr].attributes.id);
const text = (lines: { text: string }[]) => lines.map((l) => l.text).join('\n');

describe('drift (cambios fuera de Terraform)', () => {
  it('el refresh detecta un cambio manual y el plan propone deshacerlo', () => {
    const state = deploy();
    const { cloud } = cloudModify(state, emptyCloud(), 'aws_instance.web', ['instance_type=t3.large', 'tags.Owner=ana']);
    const p = plan(files, state, { cloud });
    expect(p.drift).toHaveLength(1);
    expect(p.drift[0].diffs.map((d) => d.name).sort()).toEqual(['instance_type', 'tags']);
    const web = p.changes.find((c) => c.addr === 'aws_instance.web')!;
    expect(web.action).toBe('update');
    expect(web.diffs.find((d) => d.name === 'instance_type')).toMatchObject({ before: 't3.large', after: 't3.micro' });
    const out = text(renderPlan(p));
    expect(out).toContain('Objects have changed outside of Terraform');
    expect(out).toContain('"t3.micro" -> "t3.large"');
  });

  it('-refresh=false no ve el drift', () => {
    const state = deploy();
    const { cloud } = cloudModify(state, emptyCloud(), 'aws_instance.web', ['instance_type=t3.large']);
    const p = plan(files, state, { cloud, refresh: false });
    expect(p.drift).toEqual([]);
    expect(p.changes.every((c) => c.action === 'noop')).toBe(true);
  });

  it('apply -refresh-only actualiza el estado sin tocar la nube', () => {
    const state = deploy();
    const { cloud } = cloudModify(state, emptyCloud(), 'aws_instance.web', ['instance_type=t3.large']);
    const p = plan(files, state, { cloud, refreshOnly: true });
    expect(p.changes).toEqual([]);
    expect(text(renderPlan(p))).toContain('refresh-only plan');
    const r = apply(files, state, { cloud, refreshOnly: true });
    expect(r.state.resources['aws_instance.web'].attributes.instance_type).toBe('t3.large');
    expect(r.cloud.modified).toEqual({});
    // ahora el código y el estado difieren: el siguiente plan quiere volver a t3.micro
    expect(plan(files, r.state, { cloud: r.cloud }).summary.change).toBe(1);
  });

  it('ignore_changes evita deshacer el cambio manual', () => {
    const state = deploy();
    const { cloud } = cloudModify(state, emptyCloud(), 'aws_instance.web', ['tags.Owner=ana']);
    const ignoring = { 'main.tf': files['main.tf'].replace('tags          = { Name = "web" }', 'tags          = { Name = "web" }\n  lifecycle {\n    ignore_changes = [tags]\n  }') };
    const p = plan(ignoring, state, { cloud });
    expect(p.drift).toHaveLength(1);
    expect(p.changes.find((c) => c.addr === 'aws_instance.web')!.action).toBe('noop');
  });

  it('un recurso borrado a mano se vuelve a crear', () => {
    const state = deploy();
    const { cloud } = cloudDelete(state, emptyCloud(), 'aws_s3_bucket.assets');
    const p = plan(files, state, { cloud });
    expect(p.drift[0]).toMatchObject({ addr: 'aws_s3_bucket.assets', action: 'delete' });
    expect(p.changes.find((c) => c.addr === 'aws_s3_bucket.assets')!.action).toBe('create');
    const r = apply(files, state, { cloud });
    expect(r.ok).toBe(true);
    expect(r.cloud.deleted).toEqual([]);
  });

  it('no se puede cambiar a mano un atributo que fuerza reemplazo', () => {
    const state = deploy();
    expect(() => cloudModify(state, emptyCloud(), 'aws_instance.web', ['ami=ami-0999'])).toThrow(/OperationNotPermitted/);
  });
});

describe('import', () => {
  const withBucket = (state: TfState): CloudChanges => cloudCreate(state, emptyCloud(), 'aws_s3_bucket', ['bucket=logs-legacy', 'tags.Equipo=datos']).cloud;
  const importFiles = {
    'main.tf': `${files['main.tf']}
import {
  to = aws_s3_bucket.logs
  id = "logs-legacy"
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs-legacy"
  tags   = { Equipo = "datos" }
}
`,
  };

  it('un bloque import trae el objeto al estado sin recrearlo', () => {
    const state = deploy();
    const cloud = withBucket(state);
    const p = plan(importFiles, state, { cloud });
    expect(p.ok).toBe(true);
    expect(p.summary).toEqual({ add: 0, change: 0, destroy: 0, import: 1 });
    expect(text(renderPlan(p))).toContain('Plan: 1 to import, 0 to add, 0 to change, 0 to destroy.');
    const r = apply(importFiles, state, { cloud });
    expect(r.ok).toBe(true);
    expect(r.state.resources['aws_s3_bucket.logs'].attributes.id).toBe('logs-legacy');
    expect(r.cloud.unmanaged).toEqual({});
    // el import ya está hecho: el siguiente plan no hace nada
    expect(plan(importFiles, r.state, { cloud: r.cloud }).summary).toEqual({ add: 0, change: 0, destroy: 0, import: 0 });
  });

  it('si el código no coincide, el import incluye un update', () => {
    const state = deploy();
    const cloud = withBucket(state);
    const p = plan({ 'main.tf': importFiles['main.tf'].replace('tags   = { Equipo = "datos" }', '') }, state, { cloud });
    const c = p.changes.find((x) => x.addr === 'aws_s3_bucket.logs')!;
    expect(c).toMatchObject({ action: 'update', importing: 'logs-legacy' });
  });

  it('errores: sin configuración y objeto inexistente', () => {
    const state = deploy();
    const cloud = withBucket(state);
    const noCfg = plan({ 'main.tf': `${files['main.tf']}\nimport {\n  to = aws_s3_bucket.logs\n  id = "logs-legacy"\n}\n` }, state, { cloud });
    expect(noCfg.diagnostics[0].summary).toBe('Configuration for import target does not exist');
    const missing = plan({ 'main.tf': importFiles['main.tf'].replace('id = "logs-legacy"', 'id = "no-existe"') }, state, { cloud });
    expect(missing.diagnostics[0].summary).toBe('Cannot import non-existent remote object');
  });

  it('crear un bucket con el nombre de uno no gestionado falla en el apply', () => {
    const state = deploy();
    const cloud = withBucket(state);
    const dup = { 'main.tf': `${files['main.tf']}\nresource "aws_s3_bucket" "logs" {\n  bucket = "logs-legacy"\n}\n` };
    const r = apply(dup, state, { cloud });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.severity === 'error')!.summary).toContain('BucketAlreadyOwnedByYou');
  });

  it('CLI: terraform import, state rm y -generate-config-out', () => {
    const state = deploy();
    let cloud = withBucket(state);
    const ctx = { files: importFiles, state, initialized: ['aws'], consoleMode: false, cloud };

    const noCfg = runCommand('terraform import aws_s3_bucket.otro logs-legacy', ctx);
    expect(noCfg.kind === 'lines' && text(noCfg.lines)).toContain('does not exist in the configuration');

    const ok = runCommand('terraform import aws_s3_bucket.logs logs-legacy', ctx);
    expect(ok.kind).toBe('lines');
    if (ok.kind !== 'lines') return;
    expect(text(ok.lines)).toContain('Import successful!');
    expect(ok.state!.resources['aws_s3_bucket.logs']).toBeDefined();
    cloud = ok.cloud!;
    expect(cloud.unmanaged).toEqual({});

    // state rm: Terraform lo olvida, pero sigue existiendo en la nube
    const rm = runCommand('terraform state rm aws_s3_bucket.logs', { ...ctx, state: ok.state!, cloud });
    if (rm.kind !== 'lines') throw new Error();
    expect(Object.keys(rm.cloud!.unmanaged)).toEqual(['logs-legacy']);
    expect(cloudEntries(rm.state!, rm.cloud!).find((e) => e.id === 'logs-legacy')!.status).toBe('unmanaged');

    // generar el código del recurso a partir del objeto real
    const onlyImport = { 'main.tf': `${files['main.tf']}\nimport {\n  to = aws_s3_bucket.logs\n  id = "logs-legacy"\n}\n` };
    const gen = runCommand('terraform plan -generate-config-out=generated.tf', { ...ctx, files: onlyImport, state, cloud: withBucket(state) });
    if (gen.kind !== 'lines') throw new Error();
    expect(gen.files!['generated.tf']).toContain('resource "aws_s3_bucket" "logs"');
    expect(gen.files!['generated.tf']).toContain('bucket        = "logs-legacy"');
    expect(gen.plan!.ok).toBe(true);
    expect(gen.plan!.summary.import).toBe(1);
    expect(gen.plan!.summary.change).toBe(0);
  });

  it('CLI: cloud ls muestra lo gestionado y lo no gestionado', () => {
    const state = deploy();
    const cloud = withBucket(state);
    const out = runCommand('cloud ls', { files, state, initialized: ['aws'], consoleMode: false, cloud });
    if (out.kind !== 'lines') throw new Error();
    const t = text(out.lines);
    expect(t).toContain('aws_instance.web');
    expect(t).toContain('logs-legacy');
    expect(t).toContain('no gestionado');
  });
});
