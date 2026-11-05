export type TokType = 'ident' | 'number' | 'string' | 'punct' | 'newline' | 'eof';

export interface Token {
  type: TokType;
  value: string;
  line: number;
  col: number;
  /** Para cadenas: true si proviene de un heredoc (<<EOF). */
  heredoc?: boolean;
}

export class HclSyntaxError extends Error {
  constructor(
    message: string,
    public line: number,
    public col = 1,
    public hint?: string,
  ) {
    super(message);
  }
}

const PUNCTS = [
  '...', '==', '!=', '<=', '>=', '&&', '||', '=>',
  '{', '}', '[', ']', '(', ')', '=', ',', '.', ':', '?', '+', '-', '*', '/', '%', '!', '<', '>',
];

export function tokenize(src: string, lineOffset = 0): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1 + lineOffset;
  let col = 1;
  const n = src.length;

  const adv = (k = 1) => {
    for (let j = 0; j < k && i < n; j++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };

  /** Avanza desde justo después de `${` hasta la llave de cierre (incluida). */
  const skipInterpolation = (sl: number, sc: number) => {
    let depth = 1;
    while (depth > 0) {
      if (i >= n) throw new HclSyntaxError('Interpolación "${" sin cerrar', sl, sc);
      const d = src[i];
      if (d === '"') {
        adv();
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\') adv();
          adv();
        }
        adv();
        continue;
      }
      if (d === '{') depth++;
      else if (d === '}') depth--;
      adv();
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      adv();
      continue;
    }
    if (c === '\n') {
      toks.push({ type: 'newline', value: '\n', line, col });
      adv();
      continue;
    }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < n && src[i] !== '\n') adv();
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const sl = line;
      const sc = col;
      adv(2);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) adv();
      if (i >= n) throw new HclSyntaxError('Comentario /* sin cerrar', sl, sc);
      adv(2);
      continue;
    }
    if (c === '"') {
      const sl = line;
      const sc = col;
      adv();
      const start = i;
      for (;;) {
        if (i >= n || src[i] === '\n') {
          throw new HclSyntaxError(
            'Unterminated template string',
            sl,
            sc,
            'Falta la comilla de cierre (") en esta cadena.',
          );
        }
        const ch = src[i];
        if (ch === '\\') {
          adv(2);
          continue;
        }
        if (ch === '"') break;
        if (ch === '$' && src[i + 1] === '$' && src[i + 2] === '{') {
          adv(3);
          continue;
        }
        if ((ch === '$' || ch === '%') && src[i + 1] === '{') {
          const il = line;
          const ic = col;
          adv(2);
          skipInterpolation(il, ic);
          continue;
        }
        adv();
      }
      const raw = src.slice(start, i);
      adv();
      toks.push({ type: 'string', value: raw, line: sl, col: sc });
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && /[-A-Za-z_]/.test(src[i + 2] ?? '')) {
      const sl = line;
      const sc = col;
      adv(2);
      let indent = false;
      if (src[i] === '-') {
        indent = true;
        adv();
      }
      const ms = i;
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) adv();
      const marker = src.slice(ms, i);
      while (i < n && src[i] !== '\n') adv();
      adv();
      const lines: string[] = [];
      let closed = false;
      while (i < n) {
        const ls = i;
        while (i < n && src[i] !== '\n') adv();
        const text = src.slice(ls, i);
        adv();
        if (text.trim() === marker) {
          closed = true;
          break;
        }
        lines.push(text);
      }
      if (!closed) throw new HclSyntaxError(`Heredoc sin cerrar: falta la línea "${marker}"`, sl, sc);
      let body = lines;
      if (indent) {
        const min = Math.min(
          ...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length),
        );
        body = lines.map((l) => l.slice(Number.isFinite(min) ? min : 0));
      }
      toks.push({ type: 'string', value: body.join('\n') + '\n', line: sl, col: sc, heredoc: true });
      // El heredoc consume el salto de línea final: lo restituimos como separador.
      toks.push({ type: 'newline', value: '\n', line: line - 1, col: 1 });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const sl = line;
      const sc = col;
      const start = i;
      while (i < n && /[0-9]/.test(src[i])) adv();
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        adv();
        while (i < n && /[0-9]/.test(src[i])) adv();
      }
      toks.push({ type: 'number', value: src.slice(start, i), line: sl, col: sc });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const sl = line;
      const sc = col;
      const start = i;
      while (i < n && /[A-Za-z0-9_-]/.test(src[i])) adv();
      toks.push({ type: 'ident', value: src.slice(start, i), line: sl, col: sc });
      continue;
    }
    const p = PUNCTS.find((punct) => src.startsWith(punct, i));
    if (p) {
      toks.push({ type: 'punct', value: p, line, col });
      adv(p.length);
      continue;
    }
    throw new HclSyntaxError(`Invalid character "${c}"`, line, col, 'Este carácter no es válido en HCL.');
  }
  toks.push({ type: 'eof', value: '', line, col });
  return toks;
}
