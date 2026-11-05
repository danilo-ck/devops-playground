import type { ReactNode } from 'react';

const P = (d: ReactNode) => d;

/** Iconos sencillos (24x24, trazo) para cada tipo de recurso. */
const ICONS: Record<string, ReactNode> = {
  vpc: P(<><path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z" /><path d="M9 14h6M12 11v6" /></>),
  subnet: P(<><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>),
  igw: P(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>),
  route: P(<><path d="M4 7h11l-3-3M20 17H9l3 3" /><circle cx="18" cy="7" r="2" /><circle cx="6" cy="17" r="2" /></>),
  sg: P(<><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>),
  instance: P(<><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" /></>),
  bucket: P(<><path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" /><path d="M4 6l2 13c.2 1.2 2.8 2 6 2s5.8-.8 6-2l2-13" /></>),
  db: P(<><ellipse cx="12" cy="5.5" rx="8" ry="2.5" /><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" /></>),
  random: P(<><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1.2" /><circle cx="15" cy="15" r="1.2" /><circle cx="15" cy="9" r="1.2" /><circle cx="9" cy="15" r="1.2" /></>),
  file: P(<><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5M8 13h8M8 17h5" /></>),
  variable: P(<><path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2-1 3-3 3" /><path d="M10 9l4 6M14 9l-4 6" /></>),
  local: P(<><path d="M5 4v16h14" /><path d="M9 14l3-3 3 3 4-4" /></>),
  output: P(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>),
  data: P(<><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>),
  assoc: P(<><path d="M9 15l6-6" /><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1M13 18l-1 1a4 4 0 0 1-6-6l1-1" /></>),
  cloud: P(<path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z" />),
};

export function iconKeyFor(type: string | undefined, kind?: string): string {
  if (kind === 'variable') return 'variable';
  if (kind === 'local') return 'local';
  if (kind === 'output') return 'output';
  if (kind === 'data') return 'data';
  switch (type) {
    case 'aws_vpc':
      return 'vpc';
    case 'aws_subnet':
      return 'subnet';
    case 'aws_internet_gateway':
      return 'igw';
    case 'aws_route_table':
      return 'route';
    case 'aws_route_table_association':
      return 'assoc';
    case 'aws_security_group':
      return 'sg';
    case 'aws_instance':
      return 'instance';
    case 'aws_s3_bucket':
      return 'bucket';
    case 'aws_db_instance':
      return 'db';
    case 'local_file':
      return 'file';
    default:
      return type?.startsWith('random_') ? 'random' : 'cloud';
  }
}

export function ResIcon({ type, kind, size = 18 }: { type?: string; kind?: string; size?: number }) {
  return (
    <svg className="res-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[iconKeyFor(type, kind)]}
    </svg>
  );
}

/** Versión para incrustar dentro de un <svg> ya existente. */
export function SvgIcon({ type, kind, x, y, size = 18 }: { type?: string; kind?: string; x: number; y: number; size?: number }) {
  return (
    <svg x={x} y={y} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[iconKeyFor(type, kind)]}
    </svg>
  );
}

export const CATEGORY_COLOR: Record<string, string> = {
  network: 'var(--c-network)',
  compute: 'var(--c-compute)',
  storage: 'var(--c-storage)',
  database: 'var(--c-database)',
  security: 'var(--c-security)',
  utility: 'var(--c-utility)',
  data: 'var(--c-data)',
};
