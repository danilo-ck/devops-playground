import { describe, expect, it } from 'vitest';
import { apply, emptyState, formatHclSource, plan, renderPlan, runCommand, validate, type CliContext, type CliOutcome, type TfState } from '..';

const text = (o: CliOutcome) => (o.kind === 'clear' ? '' : o.lines.map((l) => l.text).join('\n'));
const errors = (files: Record<string, string>) => validate(files).diagnostics.filter((d) => d.severity === 'error').map((d) => d.summary);

const AWS = `provider "aws" {
  region = "eu-west-1"
}
`;

/** Pequeño "shell" que aplica los cambios de sesión de cada comando, como hace la app. */
function session(files: Record<string, string>, extra: Partial<CliContext> = {}) {
  const ctx: CliContext = { files, state: emptyState(), initialized: [], consoleMode: false, ...extra };
  let pending: Extract<CliOutcome, { kind: 'confirm' }>['pending'] | null = null;
  const run = (cmd: string): CliOutcome => {
    if (pending) {
      const p = pending;
      pending = null;
      if (p.unlockId && cmd === 'yes') {
        ctx.lock = null;
        return { kind: 'lines', lines: [{ text: 'unlocked' }] };
      }
      if (cmd !== (p.policyOverride ? 'override' : 'yes')) return { kind: 'lines', lines: [{ text: 'cancelled' }] };
      const r = apply(ctx.files, ctx.state, { ...p.opts, cloud: ctx.cloud });
      ctx.state = r.state;
      ctx.cloud = r.cloud;
      return { kind: 'apply', lines: [], result: r, history: { command: 'apply', ok: r.ok, at: 0 } };
    }
    const o = runCommand(cmd, ctx);
    if (o.kind === 'clear') return o;
    if (o.initialized) ctx.initialized = o.initialized;
    if (o.state) ctx.state = o.state;
    if (o.cloud) ctx.cloud = o.cloud;
    if (o.files) ctx.files = o.files;
    if (o.env) ctx.env = o.env;
    if (o.workspace) ctx.workspace = o.workspace;
    if (o.stateStore) ctx.stateStore = o.stateStore;
    if (o.lock !== undefined) ctx.lock = o.lock;
    if (o.savedPlans) ctx.savedPlans = o.savedPlans;
    if (o.kind === 'apply') {
      ctx.state = o.result.state;
      ctx.cloud = o.result.cloud;
    }
    if (o.kind === 'confirm') pending = o.pending;
    return o;
  };
  return { ctx, run };
}

describe('proveedores', () => {
  const withConstraint = (c: string) => ({ 'main.tf': `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "${c}"\n    }\n  }\n}\n\n${AWS}\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n` });

  it('init elige la versión más nueva que cumple y la fija en el lock file', () => {
    const s = session(withConstraint('~> 4.0'));
    expect(text(s.run('terraform init'))).toContain('Installed hashicorp/aws v4.67.0');
    expect(text(s.run('cat .terraform.lock.hcl'))).toContain('version     = "4.67.0"');
    // cambiar la restricción: el lock ya no vale
    s.ctx.files = withConstraint('~> 5.0');
    expect(text(s.run('terraform plan'))).toContain('Inconsistent dependency lock file');
    expect(text(s.run('terraform init'))).toContain('must use terraform init -upgrade');
    expect(text(s.run('terraform init -upgrade'))).toContain('Installed hashicorp/aws v5.72.1');
    expect(text(s.run('terraform version'))).toContain('v5.72.1');
  });

  it('required_version incompatible', () => {
    expect(errors({ 'main.tf': 'terraform {\n  required_version = "< 1.5"\n}\n' })).toContain('Unsupported Terraform Core version');
  });

  it('alias de proveedor: cada recurso en su región', () => {
    const files = {
      'main.tf': `${AWS}
provider "aws" {
  alias  = "virginia"
  region = "us-east-1"
}

resource "aws_s3_bucket" "eu" {
  bucket = "datos-eu-2026"
}

resource "aws_s3_bucket" "us" {
  provider = aws.virginia
  bucket   = "datos-us-2026"
}
`,
    };
    const r = apply(files, emptyState());
    expect(r.ok).toBe(true);
    expect(r.state.resources['aws_s3_bucket.eu'].attributes.region).toBe('eu-west-1');
    expect(r.state.resources['aws_s3_bucket.us'].attributes.region).toBe('us-east-1');
    expect(errors({ 'main.tf': files['main.tf'].replace('alias  = "virginia"', 'alias  = "ohio"') })).toContain('Provider configuration not present');
    expect(errors({ 'main.tf': `${AWS}\n${AWS}` })).toContain('Duplicate provider configuration');
  });
});

describe('dynamic y condiciones', () => {
  const sg = `${AWS}
variable "ports" {
  type    = list(number)
  default = [80, 443]
}

resource "aws_security_group" "web" {
  name = "web"

  dynamic "ingress" {
    for_each = var.ports
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}
`;
  it('dynamic genera un bloque por elemento', () => {
    const r = apply({ 'main.tf': sg }, emptyState());
    expect(r.ok).toBe(true);
    const ing = r.state.resources['aws_security_group.web'].attributes.ingress as { from_port: number }[];
    expect(ing.map((i) => i.from_port)).toEqual([80, 443]);
    expect(errors({ 'main.tf': sg.replace('dynamic "ingress"', 'dynamic "entrada"') })).toContain('Unsupported block type');
  });

  const inst = (type: string, extra = '') => `${AWS}
resource "aws_instance" "web" {
  ami           = "ami-0abc1234"
  instance_type = "${type}"

  lifecycle {
    precondition {
      condition     = startswith(var_type, "t3.")
      error_message = "Solo instancias t3."
    }
    postcondition {
      condition     = self.public_ip != null
      error_message = "La instancia necesita IP pública."
    }
  }
}
${extra}`.replace('var_type', `"${type}"`);

  it('precondition y postcondition', () => {
    const bad = plan({ 'main.tf': inst('m5.large') }, emptyState());
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics[0].summary).toBe('Resource precondition failed');
    expect(bad.diagnostics[0].detail).toBe('Solo instancias t3.');
    // en el plan la IP aún no se conoce: la postcondition se comprueba en el apply
    expect(plan({ 'main.tf': inst('t3.micro') }, emptyState()).ok).toBe(true);
  });

  it('check solo avisa', () => {
    const files = { 'main.tf': `${AWS}\nresource "aws_s3_bucket" "b" {\n  bucket = "check-demo-2026"\n}\n\ncheck "nombre" {\n  assert {\n    condition     = length(aws_s3_bucket.b.bucket) < 10\n    error_message = "Nombre demasiado largo"\n  }\n}\n` };
    const p = plan(files, emptyState());
    expect(p.ok).toBe(true);
    expect(p.diagnostics.find((d) => d.summary === 'Check block assertion failed')?.detail).toBe('Nombre demasiado largo');
    const r = apply(files, emptyState());
    expect(r.ok).toBe(true);
  });
});

describe('valores sensibles y efímeros', () => {
  const db = (pwd: string, out: string) => `${AWS}
variable "db_password" {
  type      = string
  sensitive = true
  ${pwd}
}

resource "aws_db_instance" "main" {
  engine              = "postgres"
  instance_class      = "db.t3.micro"
  allocated_storage   = 20
  username            = "admin"
  skip_final_snapshot = true
  ${out}
}
`;
  it('un output con un valor sensible exige sensitive = true', () => {
    const files = { 'main.tf': db('default = "s3cr3t"', 'password = var.db_password') + '\noutput "pwd" {\n  value = var.db_password\n}\n' };
    expect(errors(files)).toContain('Output refers to sensitive values');
    const ok = { 'main.tf': files['main.tf'].replace('value = var.db_password', 'value     = var.db_password\n  sensitive = true') };
    expect(errors(ok)).toEqual([]);
    const p = plan(ok, emptyState());
    expect(renderPlan(p).map((l) => l.text).join('\n')).toContain('password            = (sensitive value)');
  });

  it('ephemeral solo en argumentos write-only, que no se guardan', () => {
    const eph = 'default   = "s3cr3t"\n  ephemeral = true';
    expect(errors({ 'main.tf': db(eph, 'password = var.db_password') })).toContain('Invalid use of ephemeral value');
    const files = { 'main.tf': db(eph, 'password_wo         = var.db_password\n  password_wo_version = 1') };
    expect(errors(files)).toEqual([]);
    const r = apply(files, emptyState());
    expect(r.ok).toBe(true);
    expect(r.state.resources['aws_db_instance.main'].attributes.password_wo).toBeNull();
    expect(plan(files, r.state).summary.change).toBe(0);
  });
});

describe('precedencia de variables', () => {
  const files = {
    'main.tf': `variable "env" {\n  default = "default"\n}\n\noutput "env" {\n  value = var.env\n}\n`,
  };
  const out = (f: Record<string, string>, opts = {}) => apply(f, emptyState(), opts).state.outputs.env.value;
  it('default < TF_VAR_ < terraform.tfvars < *.auto.tfvars < -var-file < -var', () => {
    expect(out(files)).toBe('default');
    expect(out(files, { env: { TF_VAR_env: 'entorno' } })).toBe('entorno');
    const f2 = { ...files, 'terraform.tfvars': 'env = "tfvars"\n' };
    expect(out(f2, { env: { TF_VAR_env: 'entorno' } })).toBe('tfvars');
    const f3 = { ...f2, 'prod.auto.tfvars': 'env = "auto"\n', 'prod.tfvars': 'env = "fichero"\n' };
    expect(out(f3)).toBe('auto');
    expect(out(f3, { varFiles: ['prod.tfvars'] })).toBe('fichero');
    expect(out(f3, { varFiles: ['prod.tfvars'], cliVars: { env: 'cli' } })).toBe('cli');
  });
});

describe('refactorizar y mantener', () => {
  const v1 = `${AWS}\nresource "aws_instance" "web" {\n  ami           = "ami-0abc1234"\n  instance_type = "t3.micro"\n}\n`;
  const deploy = () => apply({ 'main.tf': v1 }, emptyState()).state;

  it('moved renombra sin destruir', () => {
    const st = deploy();
    const v2 = { 'main.tf': `${v1.replace('"web"', '"app"')}\nmoved {\n  from = aws_instance.web\n  to   = aws_instance.app\n}\n` };
    const p = plan(v2, st);
    expect(p.summary).toEqual({ add: 0, change: 0, destroy: 0, import: 0 });
    expect(renderPlan(p).map((l) => l.text).join('\n')).toContain('aws_instance.web has moved to aws_instance.app');
    const r = apply(v2, st);
    expect(Object.keys(r.state.resources)).toEqual(['aws_instance.app']);
    expect(r.state.resources['aws_instance.app'].attributes.id).toBe(st.resources['aws_instance.web'].attributes.id);
    // sin moved, el renombrado destruiría y crearía
    expect(plan({ 'main.tf': v1.replace('"web"', '"app"') }, st).summary).toMatchObject({ add: 1, destroy: 1 });
    expect(errors({ 'main.tf': `${v1}\nmoved {\n  from = aws_instance.web\n  to   = aws_instance.app\n}\n` })).toContain('Moved object still exists');
  });

  it('-replace y taint fuerzan el reemplazo', () => {
    const st = deploy();
    const p = plan({ 'main.tf': v1 }, st, { replace: ['aws_instance.web'] });
    expect(p.changes[0]).toMatchObject({ action: 'replace', reason: 'requested' });
    expect(renderPlan(p).map((l) => l.text).join('\n')).toContain('will be replaced, as requested');
    const s = session({ 'main.tf': v1 }, { state: st, initialized: ['aws'] });
    expect(text(s.run('terraform taint aws_instance.web'))).toContain('has been marked as tainted');
    expect(text(s.run('terraform plan'))).toContain('is tainted, so must be replaced');
  });

  it('state mv, plan -out y planes caducados', () => {
    const s = session({ 'main.tf': v1 }, { initialized: ['aws'] });
    s.run('terraform apply -auto-approve');
    expect(text(s.run('terraform state mv aws_instance.web aws_instance.app'))).toContain('Successfully moved 1 object(s).');
    s.ctx.files = { 'main.tf': v1.replace('"web"', '"app"').replace('t3.micro', 't3.small') };
    expect(text(s.run('terraform plan -out=tfplan'))).toContain('terraform apply "tfplan"');
    const ap = s.run('terraform apply tfplan');
    expect(ap.kind).toBe('apply');
    expect(s.ctx.state.resources['aws_instance.app'].attributes.instance_type).toBe('t3.small');
    s.run('terraform plan -out=viejo');
    s.run('terraform taint aws_instance.app');
    expect(text(s.run('terraform apply viejo'))).toContain('Saved plan is stale');
  });

  it('fmt formatea y -check no toca nada', () => {
    const ugly = 'resource   "aws_vpc"   "main"{\ncidr_block="10.0.0.0/16"\n    enable_dns_support = true\n}\n';
    expect(formatHclSource(ugly)).toBe('resource "aws_vpc" "main" {\n  cidr_block         = "10.0.0.0/16"\n  enable_dns_support = true\n}\n');
    const s = session({ 'main.tf': ugly });
    const chk = s.run('terraform fmt -check');
    expect(chk.kind === 'lines' && chk.history?.ok).toBe(false);
    expect(s.ctx.files['main.tf']).toBe(ugly);
    expect(text(s.run('terraform fmt'))).toContain('main.tf');
    expect(s.ctx.files['main.tf']).toBe(formatHclSource(ugly));
  });

  it('TF_LOG muestra logs y TF_LOG_PATH los escribe en un fichero', () => {
    const s = session({ 'main.tf': v1 }, { initialized: ['aws'] });
    s.run('export TF_LOG=DEBUG');
    const t = text(s.run('terraform plan'));
    expect(t).toMatch(/\[INFO\] {2}Terraform version: 1\.12\.2/);
    expect(t).toContain('ReferenceTransformer: "aws_instance.web"');
    expect(t).not.toContain('[TRACE]');
    s.run('export TF_LOG_PATH=terraform.log');
    s.run('terraform validate');
    expect(s.ctx.files['terraform.log']).toContain('[INFO]');
    expect(text(s.run('TF_LOG=TRACE terraform plan'))).not.toContain('[TRACE]'); // va al fichero
  });
});

describe('backends, bloqueo y workspaces', () => {
  const local = `${AWS}\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  tags       = { Name = "red-\${terraform.workspace}" }\n}\n`;
  const s3 = `terraform {\n  backend "s3" {\n    bucket       = "empresa-tfstate"\n    key          = "red/terraform.tfstate"\n    region       = "eu-west-1"\n    use_lockfile = true\n  }\n}\n\n${local}`;

  it('cambiar de backend exige migrar o reconfigurar', () => {
    const s = session({ 'main.tf': local });
    s.run('terraform init');
    s.run('terraform apply -auto-approve');
    const id = s.ctx.state.resources['aws_vpc.main'].attributes.id;
    s.ctx.files = { 'main.tf': s3 };
    expect(text(s.run('terraform plan'))).toContain('Backend initialization required');
    expect(text(s.run('terraform init'))).toContain('-migrate-state');
    expect(text(s.run('terraform init -migrate-state'))).toContain('Successfully configured the backend "s3"');
    expect(s.ctx.state.resources['aws_vpc.main'].attributes.id).toBe(id);
    expect(errors({ 'main.tf': s3.replace('"empresa-tfstate"', 'var.bucket') })).toContain('Variables not allowed');
  });

  it('-reconfigure empieza con el estado vacío', () => {
    const s = session({ 'main.tf': local });
    s.run('terraform init');
    s.run('terraform apply -auto-approve');
    s.ctx.files = { 'main.tf': s3 };
    s.run('terraform init -reconfigure');
    expect(Object.keys(s.ctx.state.resources)).toEqual([]);
  });

  it('bloqueo del estado: esperar o force-unlock', () => {
    const s = session({ 'main.tf': s3 });
    s.run('terraform init');
    expect(text(s.run('team crash'))).toContain('colgado');
    const t = text(s.run('terraform plan'));
    expect(t).toContain('Error acquiring the state lock');
    const id = /ID:\s+(\S+)/.exec(t)![1];
    expect(text(s.run('terraform plan -lock=false'))).toContain('-lock=false');
    expect(text(s.run('terraform force-unlock nope'))).toContain('does not match');
    expect(s.run(`terraform force-unlock ${id}`).kind).toBe('confirm');
    s.run('yes');
    expect(s.ctx.lock).toBeNull();
    expect(text(s.run('terraform plan'))).toContain('Plan: 1 to add');
    s.run('team apply');
    expect(text(s.run('terraform plan -lock-timeout=90s'))).toContain('Acquiring state lock');
  });

  it('con backend local no hay compañero que bloquee', () => {
    const s = session({ 'main.tf': local });
    s.run('terraform init');
    expect(text(s.run('team apply'))).toContain('backend local');
  });

  it('workspaces: estados separados y terraform.workspace', () => {
    const s = session({ 'main.tf': local });
    s.run('terraform init');
    s.run('terraform apply -auto-approve');
    expect(text(s.run('terraform workspace new dev'))).toContain('Created and switched to workspace "dev"');
    expect(Object.keys(s.ctx.state.resources)).toEqual([]);
    s.run('terraform apply -auto-approve');
    expect((s.ctx.state.resources['aws_vpc.main'].attributes.tags as Record<string, string>).Name).toBe('red-dev');
    expect(text(s.run('terraform workspace list'))).toContain('* dev');
    expect(text(s.run('terraform workspace delete dev'))).toContain('active workspace');
    s.run('terraform workspace select default');
    expect((s.ctx.state.resources['aws_vpc.main'].attributes.tags as Record<string, string>).Name).toBe('red-default');
    expect(text(s.run('terraform workspace delete dev'))).toContain('Workspace is not empty');
    expect(text(s.run('terraform workspace delete -force dev'))).toContain('Deleted workspace "dev"');
    expect(Object.keys(s.ctx.cloud!.unmanaged).length).toBe(1);
  });
});

describe('HCP Terraform', () => {
  const files = (type: string, owner = true) => ({
    'main.tf': `terraform {\n  cloud {\n    organization = "devopslab"\n    workspaces {\n      name = "web-prod"\n    }\n  }\n}\n\n${AWS}\nresource "aws_instance" "web" {\n  ami           = "ami-0abc1234"\n  instance_type = "${type}"\n  tags          = { Name = "web"${owner ? ', Owner = "plataforma"' : ''} }\n}\n`,
  });

  it('login, ejecución remota y políticas', () => {
    const s = session(files('t3.large'));
    expect(text(s.run('terraform init'))).toContain('Required token could not be found');
    s.run('terraform login');
    expect(text(s.run('terraform init'))).toContain('HCP Terraform has been successfully initialized!');
    const p = s.run('terraform plan');
    expect(text(p)).toContain('Running plan in HCP Terraform');
    expect(text(p)).toContain('Cost Estimation');
    expect(p.kind === 'lines' && p.history?.policy).toBe('hard');
    expect(text(s.run('terraform apply'))).toContain('Organization policy check hard failed');
    s.ctx.files = files('t3.small', false);
    const soft = s.run('terraform apply');
    expect(soft.kind).toBe('confirm');
    expect(text(soft)).toContain("Only 'override' will be accepted");
    s.ctx.files = files('t3.small');
    s.run('no');
    expect(s.run('terraform apply').kind).toBe('confirm');
    s.run('yes');
    expect(s.ctx.state.resources['aws_instance.web']).toBeDefined();
  });
});

export type _Unused = TfState;
