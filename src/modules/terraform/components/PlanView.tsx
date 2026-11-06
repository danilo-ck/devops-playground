import type { PlanResult, ResourceChange, Value } from '../engine';
import { formatHcl, isUnknown } from '../engine';
import { ResIcon } from './icons';

const ACTION: Record<string, { sym: string; label: string; cls: string }> = {
  create: { sym: '+', label: 'se creará', cls: 'create' },
  update: { sym: '~', label: 'se modificará sin recrearse', cls: 'update' },
  replace: { sym: '-/+', label: 'se destruirá y se creará de nuevo', cls: 'replace' },
  delete: { sym: '-', label: 'se destruirá', cls: 'delete' },
  read: { sym: '<=', label: 'se leerá durante el apply', cls: 'read' },
};

const fmt = (v: Value | undefined, sensitive: boolean) =>
  v === undefined || v === null ? 'null' : isUnknown(v) ? '(known after apply)' : sensitive ? '(sensitive)' : formatHcl(v);

export function PlanView({ plan, stale }: { plan: PlanResult | null; stale: boolean }) {
  if (!plan) {
    return (
      <div className="viz-empty">
        <div className="viz-empty-icon">📋</div>
        <p>
          Ejecuta <code>terraform plan</code> para ver aquí, de forma visual, qué cambios haría Terraform en tu
          infraestructura.
        </p>
      </div>
    );
  }
  if (!plan.ok) {
    return (
      <div className="viz-empty">
        <div className="viz-empty-icon">❌</div>
        <p>El último plan falló. Revisa el error en la terminal.</p>
      </div>
    );
  }
  const changes = plan.changes.filter((c) => c.action !== 'noop' || c.importing || c.movedFrom);
  const unchanged = plan.changes.filter((c) => c.action === 'noop' && !c.importing && !c.movedFrom).length;
  const outCh = plan.outputChanges.filter((o) => o.action !== 'noop');

  return (
    <div className="planview">
      {stale && <div className="banner warn">✏️ Has cambiado el código desde este plan. Vuelve a ejecutar <code>terraform plan</code>.</div>}
      {plan.destroy && <div className="banner danger">💣 Plan de destrucción: se eliminará toda la infraestructura gestionada.</div>}
      {plan.refreshOnly && (
        <div className="banner info">
          🔄 Plan <code>-refresh-only</code>: solo compara el estado con la nube real. No propone cambios en la infraestructura; un <code>apply -refresh-only</code> guardaría en el estado lo que hay en la nube.
        </div>
      )}
      {plan.drift.length > 0 && <DriftList plan={plan} />}
      {plan.refreshOnly ? (
        !plan.drift.length && <div className="banner ok">✅ Sin drift: la nube real coincide con el estado.</div>
      ) : (
      <>
      <div className="plan-summary">
        {plan.summary.import > 0 && (
          <div className="ps ps-import">
            <strong>{plan.summary.import}</strong> a importar
          </div>
        )}
        <div className="ps ps-add">
          <strong>{plan.summary.add}</strong> a crear
        </div>
        <div className="ps ps-change">
          <strong>{plan.summary.change}</strong> a modificar
        </div>
        <div className="ps ps-destroy">
          <strong>{plan.summary.destroy}</strong> a destruir
        </div>
        <div className="ps ps-noop">
          <strong>{unchanged}</strong> sin cambios
        </div>
      </div>
      {!changes.length && !outCh.length && <div className="banner ok">✅ No hay cambios: la infraestructura real coincide con tu código.</div>}
      <div className="plan-list">
        {changes.map((c) => (
          <ChangeCard key={c.addr} c={c} />
        ))}
      </div>
      </>
      )}
      {outCh.length > 0 && (
        <div className="plan-outputs">
          <h4>Outputs</h4>
          {outCh.map((o) => (
            <div key={o.name} className={`po po-${o.action}`}>
              <span className="po-sym">{o.action === 'create' ? '+' : o.action === 'delete' ? '-' : '~'}</span>
              <code>{o.name}</code>
              <span className="po-val">
                {o.action === 'delete' ? fmt(o.before, o.sensitive) : o.action === 'update' ? `${fmt(o.before, o.sensitive)} → ${fmt(o.after, o.sensitive)}` : fmt(o.after, o.sensitive)}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="muted small plan-help">
        💡 Los atributos marcados con <span className="fn-mark">⚠ fuerza reemplazo</span> no se pueden cambiar en un recurso existente: Terraform tiene que destruirlo y crearlo de nuevo.
        <em> (known after apply)</em> significa que el valor lo decidirá la nube al crear el recurso.
      </p>
    </div>
  );
}

function DriftList({ plan }: { plan: PlanResult }) {
  return (
    <div className="drift-box">
      <h4>✋ Cambios hechos fuera de Terraform</h4>
      <p className="muted small">
        El <strong>refresh</strong> ha leído la nube real y no coincide con el estado.
        {plan.refreshOnly ? ' Este plan no hará nada para deshacerlos.' : ' El plan de abajo propone volver a lo que dice tu código (salvo lo que ignores con ignore_changes).'}
      </p>
      {plan.drift.map((d) => (
        <div key={d.addr} className="drift-item">
          <div className="change-head">
            <ResIcon type={d.type} size={16} />
            <code>{d.addr}</code>
            <span className="change-label">{d.action === 'delete' ? 'ya no existe: lo borraron a mano' : 'cambiado a mano'}</span>
          </div>
          {d.diffs.length > 0 && (
            <table className="diff">
              <tbody>
                {d.diffs.map((x) => (
                  <tr key={x.name}>
                    <td className="diff-k">{x.name}</td>
                    <td className="diff-before">{fmt(x.before, false)}</td>
                    <td className="diff-after">→ {fmt(x.after, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

const MOVED_NOOP = { sym: '→', label: 'solo cambia de nombre (moved): no se toca el recurso real', cls: 'import' };
const IMPORT_NOOP = { sym: '⇩', label: 'se importará tal cual (el código coincide con el objeto real)', cls: 'import' };

function ChangeCard({ c }: { c: ResourceChange }) {
  const a = c.importing && c.action === 'noop' ? IMPORT_NOOP : c.movedFrom && c.action === 'noop' ? MOVED_NOOP : ACTION[c.action];
  const sens = (n: string) => c.sensitiveAttrs.includes(n);
  let rows: { name: string; before?: Value; after?: Value; force?: boolean; kind: 'add' | 'del' | 'chg' }[] = [];
  if (c.action === 'create' || c.action === 'read') {
    rows = Object.entries(c.after ?? {})
      .filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length))
      .map(([name, after]) => ({ name, after, kind: 'add' as const }));
  } else if (c.action === 'delete') {
    rows = [];
  } else {
    rows = c.diffs.map((d) => ({ name: d.name, before: d.before, after: d.after, force: d.forcesReplacement, kind: 'chg' as const }));
  }
  rows.sort((x, y) => Number(!!y.force) - Number(!!x.force) || x.name.localeCompare(y.name));
  return (
    <div className={`change change-${a.cls}`}>
      <div className="change-head">
        <span className="change-sym">{a.sym}</span>
        <ResIcon type={c.type} size={16} />
        <code>{c.addr}</code>
        <span className="change-label">{a.label}</span>
        {c.importing && c.action !== 'noop' && <span className="import-chip">⇩ importa "{c.importing}"</span>}
      </div>
      {c.importing && c.action === 'noop' && <div className="change-why">ID en la nube: {c.importing}</div>}
      {c.movedFrom && <div className="change-why">Antes se llamaba <code>{c.movedFrom}</code> (bloque moved).</div>}
      {c.reason === 'requested' && <div className="change-why">Reemplazo pedido con <code>-replace</code>, aunque el código no haya cambiado.</div>}
      {c.reason === 'tainted' && <div className="change-why">Está marcado como <em>tainted</em> en el estado: se recrea.</div>}
      {c.writeOnlyAttrs?.length ? <div className="change-why">Write-only: <code>{c.writeOnlyAttrs.join(', ')}</code> se envía a la nube pero no queda en el plan ni en el estado.</div> : null}
      {c.action === 'replace' && c.replaceReasons.length > 0 && (
        <div className="change-why">
          Motivo: cambia <strong>{c.replaceReasons.join(', ')}</strong>, que no se puede modificar en caliente.
        </div>
      )}
      {c.action === 'delete' && <div className="change-why">{c.before?.id ? `ID actual: ${String(c.before.id)}` : ''}</div>}
      {rows.length > 0 && (
        <table className="diff">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className={r.force ? 'force' : ''}>
                <td className="diff-k">{r.name}</td>
                {r.kind === 'add' ? (
                  <td className={`diff-v ${isUnknown(r.after) ? 'unknown' : ''}`} colSpan={2}>
                    {fmt(r.after, sens(r.name))}
                  </td>
                ) : (
                  <>
                    <td className="diff-before">{fmt(r.before, sens(r.name))}</td>
                    <td className={`diff-after ${isUnknown(r.after) ? 'unknown' : ''}`}>
                      → {fmt(r.after, sens(r.name))}
                      {r.force && <span className="fn-mark"> ⚠ fuerza reemplazo</span>}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
