import { Link, NavLink, Outlet } from 'react-router-dom';
import { modules } from '@/modules';

export function AppShell({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`shell ${compact ? 'shell-compact' : ''}`}>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-logo" aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22">
              <rect width="32" height="32" rx="8" fill="var(--accent)" />
              <path d="M9 8l6 3.5v7L9 15zM16.5 11.5l6-3.5v7l-6 3.5zM16.5 20l6-3.5v7L16.5 27z" fill="#fff" />
            </svg>
          </span>
          DevOps<span className="brand-light">Lab</span>
        </Link>
        <nav className="topnav">
          {modules.map((m) =>
            m.status === 'available' ? (
              <NavLink key={m.id} to={`/m/${m.id}`}>
                {m.icon} {m.title}
              </NavLink>
            ) : (
              <span key={m.id} className="topnav-soon" title="Próximamente">
                {m.icon} {m.title}
              </span>
            ),
          )}
        </nav>
      </header>
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}
