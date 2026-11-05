import { useMemo, useState } from 'react';
import { escapeHtml } from '@/core/highlighters';
import type { TfState } from '../engine';
import { formatHcl, toTfStateJson } from '../engine';
import { ResIcon } from './icons';

function highlightJson(json: string) {
  return escapeHtml(json).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,
    (_m, str, colon, lit, num) => {
      if (str) return colon ? `<span class="hl-attr">${str}</span>${colon}` : `<span class="hl-str">${str}</span>`;
      if (lit) return `<span class="hl-bool">${lit}</span>`;
      return `<span class="hl-num">${num}</span>`;
    },
  );
}

export function StateView({ state }: { state: TfState }) {
  const [mode, setMode] = useState<'cards' | 'json'>('cards');
  const json = useMemo(() => JSON.stringify(toTfStateJson(state), null, 2), [state]);
  const insts = Object.values(state.resources).sort((a, b) => a.addr.localeCompare(b.addr, 'en', { numeric: true }));
  const outputs = Object.entries(state.outputs);

  return (
    <div className="stateview">
      <div className="state-head">
        <div>
          <strong>terraform.tfstate</strong>
          <span className="muted small">
            {' '}
            · serial {state.serial} · {insts.length} instancia{insts.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="seg">
          <button className={mode === 'cards' ? 'active' : ''} onClick={() => setMode('cards')}>
            Recursos
          </button>
          <button className={mode === 'json' ? 'active' : ''} onClick={() => setMode('json')}>
            JSON
          </button>
        </div>
      </div>
      <p className="muted small state-help">
        El estado es la <strong>memoria de Terraform</strong>: relaciona cada recurso de tu código con el objeto real en la
        nube (su <code>id</code>). Gracias a él, Terraform sabe qué existe ya y qué tiene que cambiar.
      </p>
      {mode === 'json' ? (
        <pre className="json" dangerouslySetInnerHTML={{ __html: highlightJson(json) }} />
      ) : !insts.length ? (
        <div className="viz-empty small-empty">
          <p>El estado está vacío: Terraform todavía no gestiona ningún recurso.</p>
        </div>
      ) : (
        <div className="state-cards">
          {insts.map((i) => (
            <details key={i.addr} className="state-card">
              <summary>
                <ResIcon type={i.type} kind={i.mode === 'data' ? 'data' : undefined} size={16} />
                <code>{i.mode === 'data' ? i.addr : i.addr}</code>
                <span className="muted small mono">{String(i.attributes.id ?? '')}</span>
              </summary>
              <div className="details-grid">
                {Object.entries(i.attributes)
                  .filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length))
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => (
                    <div key={k} className="dg-row">
                      <span className="dg-k">{k}</span>
                      <span className="dg-v">{i.sensitiveAttrs.includes(k) ? '(sensitive)' : formatHcl(v)}</span>
                    </div>
                  ))}
                {i.dependencies.length > 0 && (
                  <div className="dg-row">
                    <span className="dg-k dg-meta">depende de</span>
                    <span className="dg-v">{i.dependencies.join(', ')}</span>
                  </div>
                )}
              </div>
            </details>
          ))}
          {outputs.length > 0 && (
            <div className="state-outputs">
              <h4>Outputs</h4>
              {outputs.map(([k, o]) => (
                <div key={k} className="dg-row">
                  <span className="dg-k">{k}</span>
                  <span className="dg-v">{formatHcl(o.value, o.sensitive)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
