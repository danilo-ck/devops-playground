import { useMemo, useState, type ReactNode } from 'react';
import type { PlanResult, TfState, Value, ValueMap } from '../engine';
import { formatHcl, isMap, isUnknown, RESOURCE_SCHEMAS } from '../engine';
import { CATEGORY_COLOR, ResIcon } from './icons';

type ItemStatus = 'live' | 'create' | 'update' | 'replace' | 'delete';

interface Item {
  addr: string;
  type: string;
  name: string;
  attrs: ValueMap;
  status: ItemStatus;
  /** module.red si el recurso pertenece a un módulo. */
  module?: string;
}

interface Props {
  state: TfState;
  plan: PlanResult | null;
  active: string | null;
  /** true mientras se anima un apply: no se superpone el plan. */
  busy: boolean;
}

const STATUS_TEXT: Record<ItemStatus, string> = {
  live: '',
  create: '+ se creará',
  update: '~ se modificará',
  replace: '-/+ se reemplazará',
  delete: '- se destruirá',
};

const str = (v: Value | undefined): string => (v === undefined || v === null ? '' : isUnknown(v) ? '(tras apply)' : typeof v === 'object' ? formatHcl(v) : String(v));
const nameTag = (it: Item) => {
  const tags = it.attrs.tags;
  return isMap(tags) && typeof tags.Name === 'string' ? tags.Name : null;
};

export function CloudCanvas({ state, plan, active, busy }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  const model = useMemo(() => {
    const items = new Map<string, Item>();
    for (const r of Object.values(state.resources)) {
      if (r.mode !== 'managed') continue;
      items.set(r.addr, { addr: r.addr, type: r.type, name: r.name, attrs: r.attributes, status: 'live', module: r.module });
    }
    if (plan && !busy) {
      for (const c of plan.changes) {
        if (c.mode !== 'managed' || c.action === 'noop' || c.action === 'read') continue;
        if (c.action === 'create') items.set(c.addr, { addr: c.addr, type: c.type, name: c.name, attrs: c.after!, status: 'create', module: c.module });
        else {
          const it = items.get(c.addr);
          if (it) items.set(c.addr, { ...it, status: c.action as ItemStatus, attrs: c.action === 'delete' ? it.attrs : { ...it.attrs, ...(c.after ?? {}) } });
        }
      }
    }
    const all = [...items.values()];

    const resolve = (v: Value | undefined): Item | undefined => {
      if (v === undefined || v === null) return undefined;
      if (isUnknown(v)) return v.source ? items.get(v.source) : undefined;
      if (typeof v === 'string') return all.find((i) => i.attrs.id === v && i.status !== 'create') ?? all.find((i) => i.attrs.id === v);
      return undefined;
    };
    const parentOf = (it: Item, key: string) => resolve(it.attrs[key]);

    const vpcs = all.filter((i) => i.type === 'aws_vpc');
    const byParent = (type: string, key: string, parent: Item) => all.filter((i) => i.type === type && parentOf(i, key)?.addr === parent.addr);

    // subred pública = asociada a una tabla de rutas con ruta a un IGW
    const publicSubnets = new Set<string>();
    for (const a of all.filter((i) => i.type === 'aws_route_table_association')) {
      const sn = parentOf(a, 'subnet_id');
      const rt = parentOf(a, 'route_table_id');
      const routes = Array.isArray(rt?.attrs.route) ? (rt!.attrs.route as ValueMap[]) : [];
      if (sn && routes.some((r) => resolve(r.gateway_id)?.type === 'aws_internet_gateway')) publicSubnets.add(sn.addr);
    }

    const sgNames = (inst: Item) => {
      const ids = inst.attrs.vpc_security_group_ids;
      if (!Array.isArray(ids)) return [] as Item[];
      return ids.map((x) => resolve(x)).filter(Boolean) as Item[];
    };

    const placed = new Set<string>();
    const vpcModels = vpcs.map((vpc) => {
      placed.add(vpc.addr);
      const subnets = byParent('aws_subnet', 'vpc_id', vpc).map((sn) => {
        placed.add(sn.addr);
        const instances = byParent('aws_instance', 'subnet_id', sn);
        instances.forEach((i) => placed.add(i.addr));
        return { sn, instances, isPublic: publicSubnets.has(sn.addr) };
      });
      const igws = byParent('aws_internet_gateway', 'vpc_id', vpc);
      const rts = byParent('aws_route_table', 'vpc_id', vpc);
      const sgs = byParent('aws_security_group', 'vpc_id', vpc);
      [...igws, ...rts, ...sgs].forEach((i) => placed.add(i.addr));
      return { vpc, subnets, igws, rts, sgs };
    });
    all.filter((i) => i.type === 'aws_route_table_association').forEach((i) => placed.add(i.addr));

    const looseInstances = all.filter((i) => i.type === 'aws_instance' && !placed.has(i.addr));
    looseInstances.forEach((i) => placed.add(i.addr));
    const looseNet = all.filter((i) => i.type.startsWith('aws_') && !placed.has(i.addr) && ['aws_subnet', 'aws_internet_gateway', 'aws_route_table', 'aws_security_group'].includes(i.type));
    looseNet.forEach((i) => placed.add(i.addr));
    const services = all.filter((i) => i.type.startsWith('aws_') && !placed.has(i.addr));
    services.forEach((i) => placed.add(i.addr));
    const others = all.filter((i) => !placed.has(i.addr));

    const regionArn = all.map((i) => i.attrs.arn).find((a) => typeof a === 'string' && a.split(':')[3]) as string | undefined;
    const region = (regionArn?.split(':')[3] || (typeof all.find((i) => i.type === 'aws_s3_bucket')?.attrs.region === 'string' && (all.find((i) => i.type === 'aws_s3_bucket')!.attrs.region as string))) || planRegion(plan) || 'us-east-1';

    return { all, vpcModels, looseInstances, looseNet, services, others, sgNames, region, assocCount: all.filter((i) => i.type === 'aws_route_table_association').length };
  }, [state, plan, busy]);

  const sel = selected ? model.all.find((i) => i.addr === selected) : undefined;
  const hasAws = model.vpcModels.length + model.looseInstances.length + model.services.length + model.looseNet.length > 0;

  if (!model.all.length) {
    return (
      <div className="viz-empty">
        <div className="viz-empty-icon">☁️</div>
        <p>
          Tu nube está vacía. Declara recursos en el código y ejecuta <code>terraform plan</code> para verlos aquí como
          borrador, o <code>terraform apply</code> para crearlos.
        </p>
      </div>
    );
  }

  const card = (it: Item, extra?: ReactNode, compact = false) => (
    <ResourceCard key={it.addr} item={it} active={active === it.addr} selected={selected === it.addr} onSelect={() => setSelected(selected === it.addr ? null : it.addr)} compact={compact}>
      {extra}
    </ResourceCard>
  );

  return (
    <div className="cloud">
      <div className="cloud-scroll">
        {hasAws && (
          <section className="region">
            <header className="region-head">
              <span className="aws-badge">aws</span> Región <strong>{model.region}</strong>
            </header>
            <div className="region-body">
              {model.vpcModels.map(({ vpc, subnets, igws, rts, sgs }) => (
                <div key={vpc.addr} className={`vpc box st-${vpc.status} ${active === vpc.addr ? 'is-active' : ''}`} onClick={(e) => (e.stopPropagation(), setSelected(vpc.addr))}>
                  <div className="box-head">
                    <span className="box-icon" style={{ color: CATEGORY_COLOR.network }}>
                      <ResIcon type="aws_vpc" size={16} />
                    </span>
                    <span className="box-title">VPC {nameTag(vpc) ?? vpc.name}</span>
                    <ModChip module={vpc.module} />
                    <span className="box-cidr">{str(vpc.attrs.cidr_block)}</span>
                    <StatusTag status={vpc.status} />
                  </div>
                  {igws.length > 0 && (
                    <div className="igw-row">
                      {igws.map((g) => (
                        <div key={g.addr} className={`igw chip st-${g.status} ${active === g.addr ? 'is-active' : ''}`} onClick={(e) => (e.stopPropagation(), setSelected(g.addr))}>
                          <ResIcon type="aws_internet_gateway" size={14} /> Internet Gateway <StatusTag status={g.status} />
                          <span className="igw-line" />
                        </div>
                      ))}
                    </div>
                  )}
                  {(rts.length > 0 || sgs.length > 0) && (
                    <div className="chip-row">
                      {rts.map((rt) => (
                        <div key={rt.addr} className={`chip st-${rt.status} ${active === rt.addr ? 'is-active' : ''}`} onClick={(e) => (e.stopPropagation(), setSelected(rt.addr))}>
                          <ResIcon type="aws_route_table" size={14} /> Rutas: {rt.name}
                          {Array.isArray(rt.attrs.route) && rt.attrs.route.length > 0 && <span className="chip-sub">{(rt.attrs.route as ValueMap[]).map((r) => str(r.cidr_block)).join(', ')} → igw</span>}
                          <StatusTag status={rt.status} />
                        </div>
                      ))}
                      {sgs.map((sg) => (
                        <div key={sg.addr} className={`chip chip-sg st-${sg.status} ${active === sg.addr ? 'is-active' : ''}`} onClick={(e) => (e.stopPropagation(), setSelected(sg.addr))}>
                          <ResIcon type="aws_security_group" size={14} /> SG {str(sg.attrs.name) || sg.name}
                          <span className="chip-sub">{portsOf(sg)}</span>
                          <StatusTag status={sg.status} />
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="subnets">
                    {subnets.map(({ sn, instances, isPublic }) => (
                      <div key={sn.addr} className={`subnet box st-${sn.status} ${isPublic ? 'is-public' : ''} ${active === sn.addr ? 'is-active' : ''}`} onClick={(e) => (e.stopPropagation(), setSelected(sn.addr))}>
                        <div className="box-head">
                          <span className="box-icon" style={{ color: CATEGORY_COLOR.network }}>
                            <ResIcon type="aws_subnet" size={14} />
                          </span>
                          <span className="box-title">{nameTag(sn) ?? sn.name}</span>
                          <ModChip module={sn.module} />
                          <StatusTag status={sn.status} />
                        </div>
                        <div className="subnet-meta">
                          <span>{str(sn.attrs.cidr_block)}</span>
                          <span>{str(sn.attrs.availability_zone) || 'AZ auto'}</span>
                          <span className={isPublic ? 'tag-public' : 'tag-private'}>{isPublic ? '🌐 pública' : '🔒 privada'}</span>
                        </div>
                        <div className="instances">
                          {instances.map((i) => card(i, <InstanceExtra item={i} sgs={model.sgNames(i)} />))}
                          {!instances.length && <span className="muted small">sin servidores</span>}
                        </div>
                      </div>
                    ))}
                    {!subnets.length && <div className="muted small empty-note">Esta VPC aún no tiene subredes.</div>}
                  </div>
                </div>
              ))}

              {(model.looseInstances.length > 0 || model.looseNet.length > 0) && (
                <div className="vpc box default-vpc">
                  <div className="box-head">
                    <span className="box-title">VPC por defecto</span>
                    <span className="muted small">recursos sin red explícita</span>
                  </div>
                  <div className="instances">
                    {model.looseNet.map((i) => card(i))}
                    {model.looseInstances.map((i) => card(i, <InstanceExtra item={i} sgs={model.sgNames(i)} />))}
                  </div>
                </div>
              )}

              {model.services.length > 0 && (
                <div className="services">
                  <div className="services-title">Servicios regionales</div>
                  <div className="instances">{model.services.map((i) => card(i, <ServiceExtra item={i} />))}</div>
                </div>
              )}
            </div>
          </section>
        )}

        {model.others.length > 0 && (
          <section className="region region-local">
            <header className="region-head">
              <span className="aws-badge alt">local</span> Otros proveedores (random, local)
            </header>
            <div className="region-body">
              <div className="instances">{model.others.map((i) => card(i, <ServiceExtra item={i} />, true))}</div>
            </div>
          </section>
        )}
      </div>

      <footer className="cloud-foot">
        {sel ? (
          <Details item={sel} onClose={() => setSelected(null)} />
        ) : (
          <div className="cloud-legend">
            <span className="lg lg-live">desplegado</span>
            <span className="lg lg-create">+ se creará</span>
            <span className="lg lg-update">~ se modificará</span>
            <span className="lg lg-replace">-/+ se reemplazará</span>
            <span className="lg lg-delete">- se destruirá</span>
            <span className="muted small">Haz clic en un recurso para ver sus atributos</span>
          </div>
        )}
      </footer>
    </div>
  );
}

function planRegion(plan: PlanResult | null): string | undefined {
  const p = plan?.config.providers.find((x) => x.name === 'aws');
  const a = p?.body.attributes.find((x) => x.name === 'region');
  return a?.expr.kind === 'literal' && typeof a.expr.value === 'string' ? a.expr.value : undefined;
}

function portsOf(sg: Item) {
  const ing = Array.isArray(sg.attrs.ingress) ? (sg.attrs.ingress as ValueMap[]) : [];
  if (!ing.length) return 'sin reglas de entrada';
  return '⬇ ' + ing.map((r) => (r.from_port === r.to_port ? str(r.from_port) : `${str(r.from_port)}-${str(r.to_port)}`)).join(', ');
}

/** Etiqueta que indica el módulo al que pertenece un recurso. */
function ModChip({ module }: { module?: string }) {
  if (!module) return null;
  return (
    <span className="mod-chip" title={module}>
      📦 {module.replace(/^module\./, '').replace(/\.module\./g, ' › ')}
    </span>
  );
}

function StatusTag({ status }: { status: ItemStatus }) {
  if (status === 'live') return null;
  return <span className={`status-tag stt-${status}`}>{STATUS_TEXT[status]}</span>;
}

function ResourceCard({ item, active, selected, onSelect, children, compact }: { item: Item; active: boolean; selected: boolean; onSelect: () => void; children?: ReactNode; compact?: boolean }) {
  const schema = RESOURCE_SCHEMAS[item.type];
  const color = CATEGORY_COLOR[schema?.category ?? 'utility'];
  return (
    <div
      className={`rcard st-${item.status} ${active ? 'is-active' : ''} ${selected ? 'is-selected' : ''} ${compact ? 'compact' : ''}`}
      style={{ ['--cat' as string]: color }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      title={item.addr}
    >
      <div className="rcard-icon">
        <ResIcon type={item.type} size={22} />
      </div>
      <div className="rcard-body">
        <div className="rcard-title">{nameTag(item) ?? item.name}</div>
        <div className="rcard-type">
          {schema?.title ?? item.type} <ModChip module={item.module} />
        </div>
        {children}
      </div>
      <StatusTag status={item.status} />
    </div>
  );
}

function InstanceExtra({ item, sgs }: { item: Item; sgs: Item[] }) {
  return (
    <div className="rcard-extra">
      <span className="kv">{str(item.attrs.instance_type)}</span>
      {item.attrs.private_ip !== undefined && <span className="kv">🔒 {str(item.attrs.private_ip)}</span>}
      {item.attrs.public_ip !== null && item.attrs.public_ip !== undefined && <span className="kv kv-pub">🌐 {str(item.attrs.public_ip)}</span>}
      {sgs.map((s) => (
        <span key={s.addr} className="kv kv-sg">
          🛡 {str(s.attrs.name) || s.name}
        </span>
      ))}
    </div>
  );
}

function ServiceExtra({ item }: { item: Item }) {
  const a = item.attrs;
  let text = '';
  switch (item.type) {
    case 'aws_s3_bucket':
      text = str(a.bucket);
      break;
    case 'aws_db_instance':
      text = `${str(a.engine)} · ${str(a.instance_class)} · ${str(a.allocated_storage)} GB`;
      break;
    case 'random_pet':
    case 'random_id':
      text = str(item.type === 'random_id' ? a.hex : a.id);
      break;
    case 'random_password':
      text = '••••••••';
      break;
    case 'local_file':
      text = str(a.filename);
      break;
    default:
      text = str(a.id);
  }
  return <div className="rcard-extra">{text && <span className="kv mono">{text}</span>}</div>;
}

function Details({ item, onClose }: { item: Item; onClose: () => void }) {
  const schema = RESOURCE_SCHEMAS[item.type];
  const entries = Object.entries(item.attrs)
    .filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length))
    .sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="details">
      <div className="details-head">
        <ResIcon type={item.type} size={16} />
        <code>{item.addr}</code>
        <StatusTag status={item.status} />
        <button className="link" onClick={onClose}>
          cerrar ✕
        </button>
      </div>
      {schema && <p className="muted small">{schema.description}</p>}
      <div className="details-grid">
        {entries.map(([k, v]) => (
          <div key={k} className="dg-row">
            <span className="dg-k">
              {k}
              {schema?.args[k]?.forceNew && <span title="Cambiar este argumento obliga a reemplazar el recurso" className="fn-mark">⚠</span>}
            </span>
            <span className={`dg-v ${isUnknown(v) ? 'unknown' : ''}`}>{schema?.args[k]?.sensitive ? '(sensitive)' : isUnknown(v) ? '(known after apply)' : formatHcl(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
