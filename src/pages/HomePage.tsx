import { Link } from 'react-router-dom';
import { modules } from '@/modules';
import { useProgress } from '@/core/progress';

export function HomePage() {
  const completed = useProgress((s) => s.completed);
  const available = modules.filter((m) => m.status === 'available');
  const first = available[0];

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-text">
          <span className="eyebrow">Aprende DevOps haciendo</span>
          <h1>
            Escribe código.
            <br />
            <span className="grad">Mira cómo cobra vida.</span>
          </h1>
          <p className="lead">
            Laboratorios interactivos donde cada línea que escribes se convierte en una representación visual: redes,
            servidores, dependencias y estado. Sin cuentas en la nube, sin costes, sin miedo a romper nada.
          </p>
          {first && (
            <div className="hero-cta">
              <Link className="btn btn-primary btn-lg" to={`/m/${first.id}/${first.lessons[0].id}`}>
                Empezar con {first.title} →
              </Link>
              <Link className="btn btn-ghost btn-lg" to={`/m/${first.id}`}>
                Ver el temario
              </Link>
            </div>
          )}
        </div>
        <HeroVisual />
      </section>

      <section className="how">
        <div className="how-step">
          <span className="how-n">1</span>
          <h3>Lee el concepto</h3>
          <p>Explicaciones cortas, con analogías y ejemplos reales.</p>
        </div>
        <div className="how-step">
          <span className="how-n">2</span>
          <h3>Escribe y ejecuta</h3>
          <p>Un editor y una terminal que se comportan como las herramientas de verdad.</p>
        </div>
        <div className="how-step">
          <span className="how-n">3</span>
          <h3>Observa el resultado</h3>
          <p>Diagramas que se actualizan en vivo para que entiendas qué está pasando.</p>
        </div>
      </section>

      <h2 className="section-title">Módulos</h2>
      <section className="module-grid">
        {modules.map((m) => {
          const counted = m.lessons.filter((l) => !l.freeform);
          const done = counted.filter((l) => completed[`${m.id}/${l.id}`]).length;
          const card = (
            <article className={`module-card ${m.status}`} style={{ ['--mod' as string]: m.accent }}>
              <div className="module-card-top">
                <span className="module-icon">{m.icon}</span>
                {m.status === 'coming-soon' ? <span className="pill">Próximamente</span> : <span className="pill pill-live">Disponible</span>}
              </div>
              <h3>{m.title}</h3>
              <p className="module-tagline">{m.tagline}</p>
              <p className="muted small">{m.description}</p>
              <div className="topics">
                {m.topics.map((t) => (
                  <span key={t} className="topic">
                    {t}
                  </span>
                ))}
              </div>
              {m.status === 'available' && (
                <div className="module-progress">
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${counted.length ? (done / counted.length) * 100 : 0}%` }} />
                  </div>
                  <span className="small muted">
                    {done}/{counted.length} lecciones
                  </span>
                </div>
              )}
            </article>
          );
          return m.status === 'available' ? (
            <Link key={m.id} to={`/m/${m.id}`} className="card-link">
              {card}
            </Link>
          ) : (
            <div key={m.id}>{card}</div>
          );
        })}
      </section>
    </div>
  );
}

function HeroVisual() {
  return (
    <div className="hero-visual" aria-hidden>
      <pre className="hero-code">
        <span className="hl-kw">resource</span> <span className="hl-str">"aws_vpc"</span> <span className="hl-str">"main"</span> {'{'}
        {'\n  '}
        <span className="hl-attr">cidr_block</span> = <span className="hl-str">"10.0.0.0/16"</span>
        {'\n}'}
        {'\n\n'}
        <span className="hl-kw">resource</span> <span className="hl-str">"aws_subnet"</span> <span className="hl-str">"web"</span> {'{'}
        {'\n  '}
        <span className="hl-attr">vpc_id</span> = <span className="hl-ref">aws_vpc.main.id</span>
        {'\n}'}
      </pre>
      <div className="hero-arrow">→</div>
      <div className="hero-cloud">
        <div className="hc-region">aws · eu-west-1</div>
        <div className="hc-vpc">
          <span className="hc-label">🌐 VPC main · 10.0.0.0/16</span>
          <div className="hc-subnet">
            <span className="hc-label">▦ subnet web</span>
            <div className="hc-server pop">🖥️</div>
            <div className="hc-server pop d2">🖥️</div>
          </div>
        </div>
      </div>
    </div>
  );
}
