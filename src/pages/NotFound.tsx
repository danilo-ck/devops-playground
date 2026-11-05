import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="page narrow center">
      <h1>404</h1>
      <p className="muted">Esta página no existe (todavía).</p>
      <Link className="btn btn-primary" to="/">
        Volver al inicio
      </Link>
    </div>
  );
}
