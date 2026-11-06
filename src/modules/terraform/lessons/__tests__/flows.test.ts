import { describe, expect, it } from 'vitest';
import { apply, installedModules, runCommand, validate, type CliContext, type HistoryEntry, type PendingApply } from '../../engine';
import { terraformLessons } from '..';
import { lessonStart } from '../start';
import type { TerraformLesson, TfLessonContext } from '../types';

/**
 * Simula a un alumno en la app: misma lógica de sesión que useWorkspace
 * (estado, historial, confirmaciones), pero sin React.
 */
function student(lesson: TerraformLesson) {
  const start = lessonStart(lesson);
  const ctx: CliContext = { files: { ...lesson.files }, state: start.state, initialized: start.initialized, consoleMode: false, cloud: start.cloud, policies: lesson.policies };
  const history: HistoryEntry[] = [];
  let pending: PendingApply | null = null;
  const out: string[] = [];

  const run = (cmd: string): string => {
    if (pending) {
      const p = pending;
      pending = null;
      if (p.unlockId) {
        if (cmd === 'yes') {
          ctx.lock = null;
          history.push({ command: 'force-unlock', ok: true, at: Date.now(), args: [p.unlockId] });
        }
        return '';
      }
      if (cmd !== (p.policyOverride ? 'override' : 'yes')) return 'cancelled';
      const r = apply(ctx.files, ctx.state, { ...p.opts, cloud: ctx.cloud });
      ctx.state = r.state;
      ctx.cloud = r.cloud;
      history.push({ command: p.destroy ? 'destroy' : 'apply', ok: r.ok, at: Date.now(), summary: p.plan.summary, actions: [...new Set(p.plan.changes.map((c) => c.action).filter((a) => a !== 'noop'))], args: p.args, workspace: ctx.workspace, policy: p.policy });
      return r.ok ? 'applied' : r.diagnostics.map((d) => d.summary).join('\n');
    }
    const o = runCommand(cmd, ctx);
    if (o.kind === 'clear') return '';
    if (o.initialized) ctx.initialized = o.initialized;
    if (o.state) ctx.state = o.state;
    if (o.cloud) ctx.cloud = o.cloud;
    if (o.files) ctx.files = o.files;
    if (o.env) ctx.env = o.env;
    if (o.workspace) ctx.workspace = o.workspace;
    if (o.stateStore) ctx.stateStore = o.stateStore;
    if (o.lock !== undefined) ctx.lock = o.lock;
    if (o.savedPlans) ctx.savedPlans = o.savedPlans;
    if (o.kind === 'confirm') pending = o.pending;
    if (o.kind === 'apply') {
      ctx.state = o.result.state;
      ctx.cloud = o.result.cloud;
      history.push({ ...o.history, ok: o.result.ok, at: Date.now() });
    } else if (o.kind === 'lines' && o.history) history.push(o.history);
    const text = o.lines.map((l) => l.text).join('\n');
    out.push(`$ ${cmd}\n${text}`);
    return text;
  };

  const edit = (file: string, fn: (src: string) => string) => {
    ctx.files = { ...ctx.files, [file]: fn(ctx.files[file] ?? '') };
  };

  const check = () => {
    const v = validate(ctx.files, installedModules(ctx.initialized));
    const c: TfLessonContext = { files: ctx.files, state: ctx.state, history, initialized: ctx.initialized, config: v.config, graph: v.graph, cloud: ctx.cloud!, env: ctx.env, workspace: ctx.workspace, stateStore: ctx.stateStore, lock: ctx.lock };
    return lesson.objectives.filter((o) => !o.check(c)).map((o) => o.id);
  };
  return { ctx, run, edit, check, log: () => out.join('\n\n') };
}

const L = (id: string) => terraformLessons.find((l) => l.id === id)!;

describe('misiones completas (como las haría un alumno)', () => {
  it('11 proveedores', () => {
    const s = student(L('proveedores'));
    s.run('terraform version');
    expect(s.run('cat .terraform.lock.hcl')).toContain('4.67.0');
    s.edit('main.tf', () => L('proveedores').solution!['main.tf']);
    expect(s.run('terraform plan')).toContain('Inconsistent dependency lock file');
    expect(s.run('terraform init')).toContain('-upgrade');
    expect(s.run('terraform init -upgrade')).toContain('Installed hashicorp/aws v5.72.1');
    s.run('terraform apply');
    expect(s.run('yes')).toBe('applied');
    expect(s.check()).toEqual([]);
  });

  it('12 dynamic y condiciones', () => {
    const s = student(L('dynamic-condiciones'));
    s.run('terraform init');
    s.edit('main.tf', () => L('dynamic-condiciones').solution!['main.tf']);
    expect(s.run('terraform plan -var="instance_type=m5.large"')).toContain('Resource precondition failed');
    s.run('terraform apply');
    expect(s.run('yes')).toBe('applied');
    s.edit('main.tf', (src) => src.replace('[80, 443, 8080]', '[22, 80, 443, 8080]'));
    expect(s.run('terraform plan')).toContain('Check block assertion failed');
    expect(s.check()).toEqual([]);
  });

  it('13 secretos', () => {
    const s = student(L('secretos'));
    s.run('terraform init');
    expect(s.run('terraform plan')).toContain('No value for required variable');
    s.run('export TF_VAR_db_password=SuperSecreta123');
    s.edit('main.tf', (src) => src.replace('variable "db_password" {\n  type = string\n}', 'variable "db_password" {\n  type      = string\n  sensitive = true\n}'));
    expect(s.run('terraform plan')).toContain('Output refers to sensitive values');
    s.edit('main.tf', () => L('secretos').solution!['main.tf']);
    expect(s.run('terraform plan -var-file=prod.tfvars')).toContain('password_wo');
    s.run('terraform apply -var-file=prod.tfvars');
    expect(s.run('yes')).toBe('applied');
    expect(s.check()).toEqual([]);
  });

  it('14 refactorizar', () => {
    const s = student(L('refactorizar'));
    s.run('terraform init');
    expect(s.run('terraform fmt -check')).toContain('main.tf');
    s.run('terraform fmt');
    s.edit('main.tf', () => L('refactorizar').solution!['main.tf']);
    expect(s.run('terraform plan -out=tfplan')).toContain('has moved to aws_instance.app');
    expect(s.run('terraform apply tfplan')).not.toContain('Error');
    s.run('terraform apply -replace=aws_instance.app');
    expect(s.run('yes')).toBe('applied');
    s.run('export TF_LOG=DEBUG');
    expect(s.run('terraform plan')).toContain('ReferenceTransformer');
    expect(s.check()).toEqual([]);
  });

  it('15 backends, bloqueo y workspaces', () => {
    const s = student(L('backends'));
    s.edit('main.tf', () => L('backends').solution!['main.tf'].replace('"red-${terraform.workspace}"', '"red-principal"'));
    expect(s.run('terraform plan')).toContain('Backend initialization required');
    expect(s.run('terraform init')).toContain('-migrate-state');
    s.run('terraform init -migrate-state');
    s.run('team crash');
    const err = s.run('terraform plan');
    const id = /ID:\s+(\S+)/.exec(err)![1];
    s.run(`terraform force-unlock ${id}`);
    s.run('yes');
    s.edit('main.tf', () => L('backends').solution!['main.tf']);
    s.run('terraform workspace new dev');
    s.run('terraform apply');
    expect(s.run('yes')).toBe('applied');
    s.run('terraform workspace select default');
    expect(s.check()).toEqual([]);
  });

  it('16 HCP Terraform', () => {
    const s = student(L('hcp-terraform'));
    s.run('terraform login');
    s.edit('main.tf', (src) => `terraform {\n  cloud {\n    organization = "devopslab"\n\n    workspaces {\n      name = "tienda-prod"\n    }\n  }\n}\n\n${src}`);
    expect(s.run('terraform init')).toContain('HCP Terraform has been successfully initialized!');
    expect(s.run('terraform plan')).toContain('restrict-instance-types (hard-mandatory)');
    s.edit('main.tf', () => L('hcp-terraform').solution!['main.tf']);
    s.run('terraform apply');
    expect(s.run('yes')).toBe('applied');
    expect(s.check()).toEqual([]);
  });
});
