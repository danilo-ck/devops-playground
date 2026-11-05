import { useMemo, useState } from 'react';
import type { Action, DepGraph, GraphNode, PlanResult, TfState } from '../engine';
import { RESOURCE_SCHEMAS } from '../engine';
import { CATEGORY_COLOR, SvgIcon } from './icons';

interface Props {
  graph: DepGraph | null;
  plan: PlanResult | null;
  state: TfState;
  active: string | null;
}

type Status = Action | 'live' | 'pending' | 'none';

const W = 196;
const H = 56;
const GX = 70;
const GY = 18;
const PAD = 24;

const ACTION_PRIORITY: Status[] = ['replace', 'delete', 'create', 'update', 'read'];
const labelOf = (s: Status, kind: string) => (kind === 'data' && s === 'live' ? '✓ leído' : STATUS_LABEL[s]!);

const STATUS_LABEL: Partial<Record<Status, string>> = {
  create: '+ crear',
  update: '~ modificar',
  replace: '-/+ reemplazar',
  delete: '- destruir',
  read: '<= leer',
  live: '✓ desplegado',
  pending: 'sin desplegar',
};

const KIND_COLOR: Record<string, string> = {
  variable: 'var(--c-var)',
  local: 'var(--c-local)',
  output: 'var(--c-output)',
  data: 'var(--c-data)',
};

const KIND_LABEL: Record<string, string> = {
  variable: 'variable',
  local: 'local',
  output: 'output',
};

interface LaidNode extends GraphNode {
  x: number;
  y: number;
  status: Status;
  count: number;
  ghost?: boolean;
}

export function ResourceGraph({ graph, plan, state, active }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [fit, setFit] = useState(false);
  const activeRes = active ? active.replace(/\[.*\]$/, '') : null;

  const layout = useMemo(() => {
    if (!graph) return null;
    const nodes: Record<string, GraphNode & { ghost?: boolean }> = { ...graph.nodes };
    const deps: Record<string, string[]> = { ...graph.deps };

    // Recursos que se van a destruir porque ya no están en el código.
    for (const c of plan?.changes ?? []) {
      if (c.action === 'delete' && !nodes[c.resourceAddr]) {
        nodes[c.resourceAddr] = { id: c.resourceAddr, kind: 'resource', label: c.name, type: c.type, ghost: true };
        deps[c.resourceAddr] = [];
      }
    }

    const ids = Object.keys(nodes);
    const layer: Record<string, number> = {};
    const visiting = new Set<string>();
    const depth = (id: string): number => {
      if (layer[id] !== undefined) return layer[id];
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const ds = (deps[id] ?? []).filter((d) => nodes[d]);
      layer[id] = ds.length ? 1 + Math.max(...ds.map(depth)) : 0;
      return layer[id];
    };
    ids.forEach(depth);
    // Los outputs siempre en la última columna.
    const maxLayer = Math.max(0, ...ids.map((id) => layer[id]));
    for (const id of ids) if (nodes[id].kind === 'output') layer[id] = maxLayer + (ids.some((x) => nodes[x].kind !== 'output' && layer[x] === maxLayer) ? 1 : 0);

    const layers: string[][] = [];
    for (const id of ids) (layers[layer[id]] ??= []).push(id);
    const kindOrder = { variable: 0, local: 1, data: 2, resource: 3, output: 4 };
    const pos: Record<string, number> = {};
    layers.forEach((col, li) => {
      if (!col) return;
      if (li === 0) col.sort((a, b) => kindOrder[nodes[a].kind] - kindOrder[nodes[b].kind] || a.localeCompare(b));
      else {
        const bary = (id: string) => {
          const ds = (deps[id] ?? []).filter((d) => pos[d] !== undefined);
          return ds.length ? ds.reduce((s, d) => s + pos[d], 0) / ds.length : 999;
        };
        col.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
      }
      col.forEach((id, i) => (pos[id] = i));
    });

    const maxRows = Math.max(1, ...layers.map((c) => c?.length ?? 0));
    const height = PAD * 2 + maxRows * H + (maxRows - 1) * GY;
    const width = PAD * 2 + layers.length * W + Math.max(0, layers.length - 1) * GX;

    const statusOf = (n: GraphNode & { ghost?: boolean }): { status: Status; count: number } => {
      if (n.kind !== 'resource' && n.kind !== 'data') return { status: 'none', count: 0 };
      const ch = (plan?.changes ?? []).filter((c) => c.resourceAddr === n.id);
      const inState = Object.values(state.resources).filter((r) => r.resourceAddr === n.id);
      const planned = ch.filter((c) => c.action !== 'delete').length;
      const count = plan && ch.length ? planned : inState.length;
      for (const a of ACTION_PRIORITY) if (ch.some((c) => c.action === a)) return { status: a, count };
      return { status: inState.length ? 'live' : n.kind === 'data' ? 'none' : 'pending', count };
    };

    const laid: Record<string, LaidNode> = {};
    layers.forEach((col, li) => {
      if (!col) return;
      const colH = col.length * H + (col.length - 1) * GY;
      const offset = (height - colH) / 2;
      col.forEach((id, i) => {
        laid[id] = { ...nodes[id], x: PAD + li * (W + GX), y: offset + i * (H + GY), ...statusOf(nodes[id]) };
      });
    });
    const edges = ids.flatMap((id) => (deps[id] ?? []).filter((d) => laid[d]).map((d) => ({ from: d, to: id })));
    return { laid, edges, width, height };
  }, [graph, plan, state]);

  if (!graph || !layout) {
    return (
      <div className="viz-empty">
        <div className="viz-empty-icon">⚠️</div>
        <p>Corrige los errores del código para ver el grafo de dependencias.</p>
      </div>
    );
  }
  if (!Object.keys(layout.laid).length) {
    return (
      <div className="viz-empty">
        <div className="viz-empty-icon">🕸️</div>
        <p>Aquí aparecerá el grafo de dependencias en cuanto declares recursos, variables u outputs.</p>
      </div>
    );
  }

  const related = new Set<string>();
  if (hover) {
    related.add(hover);
    for (const e of layout.edges) {
      if (e.from === hover) related.add(e.to);
      if (e.to === hover) related.add(e.from);
    }
  }

  return (
    <div className="graph-wrap">
      <div className="graph-legend">
        <span>
          <i style={{ background: 'var(--c-var)' }} /> variable
        </span>
        <span>
          <i style={{ background: 'var(--c-local)' }} /> local
        </span>
        <span>
          <i style={{ background: 'var(--c-data)' }} /> data
        </span>
        <span>
          <i style={{ background: 'var(--c-network)' }} /> recurso
        </span>
        <span>
          <i style={{ background: 'var(--c-output)' }} /> output
        </span>
        <span className="muted">Flechas: de la dependencia al recurso que la usa (orden de creación →)</span>
        <button className="link graph-tools" onClick={() => setFit((f) => !f)}>
          {fit ? '🔍 Tamaño real' : '⤢ Ajustar a la vista'}
        </button>
      </div>
      <div className="graph-scroll">
        <svg className={`graph ${fit ? 'fit' : ''}`} width={fit ? undefined : layout.width} height={fit ? undefined : layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)" />
            </marker>
            <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent-2)" />
            </marker>
          </defs>
          {layout.edges.map(({ from, to }) => {
            const a = layout.laid[from];
            const b = layout.laid[to];
            const x1 = a.x + W;
            const y1 = a.y + H / 2;
            const x2 = b.x - 2;
            const y2 = b.y + H / 2;
            const mx = (x1 + x2) / 2;
            const hl = hover && (from === hover || to === hover);
            const flowing = activeRes && to === activeRes;
            return (
              <path
                key={`${from}->${to}`}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                className={`edge ${hl ? 'edge-hl' : ''} ${hover && !hl ? 'edge-dim' : ''} ${flowing ? 'edge-flow' : ''}`}
                markerEnd={`url(#${hl ? 'arrow-hl' : 'arrow'})`}
              />
            );
          })}
          {Object.values(layout.laid).map((n) => {
            const schema = n.type ? RESOURCE_SCHEMAS[n.type] : undefined;
            const color = n.kind === 'resource' ? CATEGORY_COLOR[schema?.category ?? 'utility'] : KIND_COLOR[n.kind];
            const isActive = activeRes === n.id;
            const dim = hover && !related.has(n.id);
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                className={`gnode gnode-${n.kind} st-${n.status} ${isActive ? 'gnode-active' : ''} ${dim ? 'gnode-dim' : ''} ${n.ghost ? 'gnode-ghost' : ''}`}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
              >
                <title>{`${n.id}${n.file ? `\n${n.file}:${n.line}` : ''}`}</title>
                <rect className="gnode-box" width={W} height={H} rx={10} />
                <rect width={5} height={H} rx={2} fill={color} />
                <g style={{ color }}>
                  <SvgIcon type={n.type} kind={n.kind} x={14} y={H / 2 - 10} size={20} />
                </g>
                <text x={44} y={23} className="gnode-title">
                  {truncate(n.label, 17)}
                  {n.multi && n.count > 0 ? ` ×${n.count}` : ''}
                </text>
                <text x={44} y={41} className="gnode-sub">
                  {truncate(n.type ?? KIND_LABEL[n.kind] ?? n.kind, 22)}
                </text>
                {n.status !== 'none' && (
                  <g transform={`translate(${W - 10},-9)`} className={`gbadge gbadge-${n.status}`}>
                    <rect x={-(labelOf(n.status, n.kind).length * 6.1 + 14)} width={labelOf(n.status, n.kind).length * 6.1 + 14} height={18} rx={9} />
                    <text x={-7} y={12.5} textAnchor="end">
                      {labelOf(n.status, n.kind)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
