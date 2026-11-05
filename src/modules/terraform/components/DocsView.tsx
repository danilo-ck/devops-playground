import { useMemo, useState } from 'react';
import { DATA_SCHEMAS, FUNCTIONS, RESOURCE_SCHEMAS, type ResourceSchema } from '../engine';
import { CATEGORY_COLOR, ResIcon } from './icons';

/** Referencia rápida de recursos, data sources y funciones del simulador. */
export function DocsView() {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'resources' | 'functions'>('resources');
  const query = q.trim().toLowerCase();

  const schemas = useMemo(
    () =>
      [...Object.values(RESOURCE_SCHEMAS), ...Object.values(DATA_SCHEMAS)].filter(
        (s) => !query || s.type.includes(query) || s.title.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
      ),
    [query],
  );
  const fns = Object.entries(FUNCTIONS).filter(([n, f]) => !query || n.includes(query) || f.description.toLowerCase().includes(query));

  return (
    <div className="docs">
      <div className="docs-head">
        <div className="seg">
          <button className={tab === 'resources' ? 'active' : ''} onClick={() => setTab('resources')}>
            Recursos
          </button>
          <button className={tab === 'functions' ? 'active' : ''} onClick={() => setTab('functions')}>
            Funciones
          </button>
        </div>
        <input className="input" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {tab === 'resources' ? (
        <div className="docs-list">
          {schemas.map((s) => (
            <SchemaDoc key={s.mode + s.type} s={s} />
          ))}
        </div>
      ) : (
        <div className="docs-list">
          {fns.map(([name, f]) => (
            <div key={name} className="fn-doc">
              <code>{f.signature}</code>
              <span className="muted small">{f.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SchemaDoc({ s }: { s: ResourceSchema }) {
  return (
    <details className="schema-doc">
      <summary>
        <span style={{ color: CATEGORY_COLOR[s.category] }}>
          <ResIcon type={s.type} kind={s.mode === 'data' ? 'data' : undefined} size={16} />
        </span>
        <code>
          {s.mode === 'data' ? 'data ' : ''}
          {s.type}
        </code>
        <span className="muted small">{s.title}</span>
      </summary>
      <p className="small">{s.description}</p>
      <table className="args">
        <tbody>
          {Object.entries(s.args).map(([n, a]) => (
            <tr key={n}>
              <td>
                <code>{n}</code>
              </td>
              <td className="small">
                {a.type}
                {a.required && <span className="req"> obligatorio</span>}
                {a.forceNew && <span className="fn-mark" title="Cambiarlo obliga a recrear el recurso">
                  {' '}
                  ⚠ reemplaza
                </span>}
              </td>
              <td className="small muted">{a.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">
        Atributos calculados: <code>{s.computed.join(', ')}</code>
      </p>
      <pre className="md-code small">{exampleOf(s)}</pre>
    </details>
  );
}

function exampleOf(s: ResourceSchema): string {
  const req = Object.entries(s.args).filter(([, a]) => a.required && a.type !== 'block');
  const sample = (t: string, n: string) =>
    t === 'number' ? '1' : t === 'bool' ? 'true' : t === 'list' ? '["..."]' : t === 'map' ? '{ Name = "..." }' : n.endsWith('_id') ? 'aws_xxx.nombre.id' : '"..."';
  const lines = req.map(([n, a]) => `  ${n} = ${sample(a.type, n)}`);
  return `${s.mode === 'data' ? 'data' : 'resource'} "${s.type}" "ejemplo" {\n${lines.join('\n')}\n}`;
}
