import type { PlanResult, ResourceChange } from './evaluate';
import type { TermLine, Tone } from './format';
import { isMap, type ValueMap } from './values';

/**
 * Simulación de HCP Terraform (antes Terraform Cloud): ejecuciones remotas,
 * estimación de costes y políticas (Sentinel / OPA) con niveles de obligatoriedad.
 */

export type Enforcement = 'advisory' | 'soft-mandatory' | 'hard-mandatory';

export interface Policy {
  name: string;
  description: string;
  enforcement: Enforcement;
  /** Devuelve las infracciones (vacío = cumple). */
  check: (changes: ResourceChange[]) => string[];
}

export interface PolicyResult {
  policy: Policy;
  violations: string[];
}

const live = (changes: ResourceChange[]) => changes.filter((c) => c.mode === 'managed' && c.after && c.action !== 'delete');

export const DEFAULT_POLICIES: Policy[] = [
  {
    name: 'restrict-instance-types',
    description: 'Solo se permiten instancias t3.micro, t3.small o t3.medium.',
    enforcement: 'hard-mandatory',
    check: (cs) =>
      live(cs)
        .filter((c) => c.type === 'aws_instance' && typeof c.after!.instance_type === 'string' && !['t3.micro', 't3.small', 't3.medium'].includes(c.after!.instance_type as string))
        .map((c) => `${c.addr}: instance_type = "${c.after!.instance_type}" no está permitido`),
  },
  {
    name: 'require-owner-tag',
    description: 'Los recursos de AWS con etiquetas deben llevar la etiqueta Owner.',
    enforcement: 'soft-mandatory',
    check: (cs) =>
      live(cs)
        .filter((c) => c.type.startsWith('aws_') && 'tags' in c.after! && !(isMap(c.after!.tags) && 'Owner' in (c.after!.tags as ValueMap)))
        .map((c) => `${c.addr}: falta la etiqueta Owner`),
  },
  {
    name: 'prefer-eu-regions',
    description: 'Aviso: los datos deberían quedarse en regiones de la UE.',
    enforcement: 'advisory',
    check: (cs) => live(cs).filter((c) => c.region && !c.region.startsWith('eu-')).map((c) => `${c.addr}: región ${c.region}`),
  },
];

export function evaluatePolicies(plan: PlanResult, policies: Policy[] = DEFAULT_POLICIES): PolicyResult[] {
  return policies.map((policy) => ({ policy, violations: policy.check(plan.changes) }));
}

/** ¿Bloquea el apply? hard-mandatory nunca se puede saltar; soft-mandatory necesita que alguien lo apruebe (override). */
export function policyOutcome(results: PolicyResult[]): 'pass' | 'advisory' | 'soft' | 'hard' {
  const failed = results.filter((r) => r.violations.length);
  if (failed.some((r) => r.policy.enforcement === 'hard-mandatory')) return 'hard';
  if (failed.some((r) => r.policy.enforcement === 'soft-mandatory')) return 'soft';
  return failed.length ? 'advisory' : 'pass';
}

const INSTANCE_COST: Record<string, number> = { 't3.nano': 3.8, 't3.micro': 7.59, 't3.small': 15.18, 't3.medium': 30.37, 't3.large': 60.74, 't3.xlarge': 121.47 };

/** Coste mensual orientativo (USD) de un recurso, para la "Cost Estimation". */
export function monthlyCost(c: { type: string; after: ValueMap | null }): number {
  const a = c.after ?? {};
  switch (c.type) {
    case 'aws_instance':
      return INSTANCE_COST[String(a.instance_type)] ?? 140;
    case 'aws_db_instance':
      return 25 + Number(a.allocated_storage ?? 20) * 0.115;
    case 'aws_s3_bucket':
      return 0.5;
    default:
      return 0;
  }
}

const L = (text: string, tone?: Tone): TermLine => ({ text, tone });
const SEP = L('------------------------------------------------------------------------', 'muted');

export function remoteRunHeader(kind: 'plan' | 'apply', org: string, workspace: string, runId: string): TermLine[] {
  return [
    L(`Running ${kind} in HCP Terraform. Output will stream here. Pressing Ctrl-C`, 'info'),
    L(`will stop streaming the logs, but will not stop the ${kind} running remotely.`, 'info'),
    L(''),
    L(`Preparing the remote ${kind}...`, 'muted'),
    L(''),
    L('To view this run in a browser, visit:', 'muted'),
    L(`https://app.terraform.io/app/${org}/${workspace}/runs/${runId}`, 'muted'),
    L(''),
    L('Waiting for the plan to start...', 'muted'),
    L(''),
    L('Terraform v1.12.2 · ejecutándose en un agente remoto de HCP Terraform', 'muted'),
    L(`Initializing plugins and modules...`, 'muted'),
  ];
}

export function costAndPolicyLines(plan: PlanResult, results: PolicyResult[], org: string): TermLine[] {
  const changed = plan.changes.filter((c) => c.mode === 'managed');
  const total = changed.filter((c) => c.action !== 'delete').reduce((s, c) => s + monthlyCost(c), 0);
  const prior = changed.filter((c) => c.before).reduce((s, c) => s + monthlyCost({ type: c.type, after: c.before }), 0);
  const delta = total - prior;
  const out: TermLine[] = [
    L(''),
    SEP,
    L(''),
    L('Cost Estimation:', 'bold'),
    L(''),
    L(`Resources: ${changed.length} of ${changed.length} estimated`),
    L(`           $${total.toFixed(2)}/mo ${delta >= 0 ? '+' : '-'}$${Math.abs(delta).toFixed(2)}`),
    L(''),
    SEP,
    L(''),
    L('Organization Policy Check:', 'bold'),
    L(''),
  ];
  const outcome = policyOutcome(results);
  out.push(L(`Sentinel Result: ${outcome === 'pass' || outcome === 'advisory'}`, outcome === 'pass' ? 'success' : outcome === 'advisory' ? 'warn' : 'error'));
  out.push(L(''));
  if (outcome !== 'pass') out.push(L('This result means that one or more Sentinel policies failed. More than likely, this was due to the discovery of violations by the main rule and other sub rules.', 'muted'), L(''));
  out.push(L(`${results.length} policies evaluated.`));
  results.forEach((r, i) => {
    const ok = !r.violations.length;
    out.push(L(''), L(`## Policy ${i + 1}: ${org}/${r.policy.name} (${r.policy.enforcement})`, 'bold'), L(`Result: ${ok}`, ok ? 'success' : r.policy.enforcement === 'advisory' ? 'warn' : 'error'));
    out.push(L(`  ${r.policy.description}`, 'muted'));
    for (const v of r.violations) out.push(L(`  - ${v}`, ok ? undefined : 'error'));
  });
  out.push(L(''), SEP);
  return out;
}
