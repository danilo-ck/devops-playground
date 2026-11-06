/**
 * terraform fmt: formato canónico de HCL.
 *  - sangría de 2 espacios según la profundidad de { [ (
 *  - un espacio alrededor de "=" y alineación de los "=" en líneas consecutivas
 *  - cabeceras de bloque normalizadas: resource "a" "b" {
 *  - sin espacios al final de línea, heredocs intactos
 */

interface ScanResult {
  opens: number;
  closes: number;
  /** Cierres al principio de la línea (antes de cualquier otro token). */
  leadingCloses: number;
  heredoc?: string;
  /** El "=" de asignación (fuera de strings) está en esta posición. */
  assignAt: number;
  /** La línea es (o termina en) un comentario de bloque abierto. */
  inBlockComment: boolean;
}

function scan(line: string, startInComment: boolean): ScanResult {
  let opens = 0;
  let closes = 0;
  let leadingCloses = 0;
  let sawToken = false;
  let assignAt = -1;
  let heredoc: string | undefined;
  let inComment = startInComment;
  // pila de contextos: 's' = dentro de string, 'i' = dentro de ${ } de un string
  const stack: ('s' | 'i')[] = [];
  let interpDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = line[i + 1];
    if (inComment) {
      if (c === '*' && n === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === 's') {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') stack.pop();
      else if ((c === '$' || c === '%') && n === '{') {
        stack.push('i');
        interpDepth = 0;
        i++;
      }
      continue;
    }
    if (top === 'i') {
      if (c === '"') stack.push('s');
      else if (c === '{') interpDepth++;
      else if (c === '}') {
        if (interpDepth === 0) stack.pop();
        else interpDepth--;
      }
      continue;
    }
    if (c === '#' || (c === '/' && n === '/')) break;
    if (c === '/' && n === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') continue;
    if (c === '"') {
      stack.push('s');
      sawToken = true;
      continue;
    }
    if (c === '<' && n === '<') {
      const m = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/.exec(line.slice(i));
      if (m) {
        heredoc = m[1];
        i += m[0].length - 1;
        sawToken = true;
        continue;
      }
    }
    if (c === '{' || c === '[' || c === '(') opens++;
    else if (c === '}' || c === ']' || c === ')') {
      if (!sawToken) leadingCloses++;
      else if (opens > 0) opens--;
      else closes++;
      continue;
    } else if (c === '=' && n !== '=' && line[i - 1] !== '=' && line[i - 1] !== '!' && line[i - 1] !== '<' && line[i - 1] !== '>' && n !== '>' && assignAt < 0 && opens === 0) {
      assignAt = i;
    }
    sawToken = true;
  }
  return { opens, closes, leadingCloses, heredoc, assignAt, inBlockComment: inComment };
}

const HEADER_RE = /^([A-Za-z_][\w-]*)((?:\s+(?:"[^"]*"|[A-Za-z_][\w-]*))*)\s*\{\s*$/;
const KEY_RE = /^([A-Za-z_][\w-]*|"[^"]*")$/;

/** Formatea un fichero .tf o .tfvars. Es idempotente: fmt(fmt(x)) === fmt(x). */
export function formatHclSource(src: string): string {
  const input = src.replace(/\r\n/g, '\n').replace(/\t/g, '  ').split('\n');
  type Out = { text: string; depth: number; key?: string; value?: string };
  const out: Out[] = [];
  let depth = 0;
  let heredoc: string | undefined;
  let inComment = false;
  for (const raw of input) {
    if (heredoc) {
      out.push({ text: raw, depth: -1 });
      if (raw.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const trimmed = raw.trim();
    if (inComment) {
      out.push({ text: raw.trimEnd(), depth: -1 });
      inComment = scan(trimmed, true).inBlockComment;
      continue;
    }
    if (!trimmed) {
      out.push({ text: '', depth });
      continue;
    }
    const r = scan(trimmed, false);
    const lineDepth = Math.max(0, depth - r.leadingCloses);
    let text = trimmed;
    let key: string | undefined;
    let value: string | undefined;
    const header = HEADER_RE.exec(trimmed);
    if (header && r.assignAt < 0) {
      const labels = header[2].trim() ? ' ' + header[2].trim().split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/).join(' ') : '';
      text = `${header[1]}${labels} {`;
    } else if (r.assignAt > 0) {
      const k = trimmed.slice(0, r.assignAt).trim();
      if (KEY_RE.test(k)) {
        value = trimmed.slice(r.assignAt + 1).trim();
        text = `${k} = ${value}`;
        // Como hclwrite: si el valor abre una expresión multilínea, no se alinea y corta el grupo.
        if (r.opens <= r.closes) key = k;
      }
    }
    out.push({ text, depth: lineDepth, key, value });
    depth = Math.max(0, depth - r.leadingCloses + r.opens - r.closes);
    if (r.heredoc) heredoc = r.heredoc;
    inComment = r.inBlockComment;
  }

  // Alinear los "=" de asignaciones consecutivas con la misma sangría.
  for (let i = 0; i < out.length; ) {
    if (!out[i].key) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j].key && out[j].depth === out[i].depth) j++;
    const w = Math.max(...out.slice(i, j).map((l) => l.key!.length));
    for (let k = i; k < j; k++) out[k].text = `${out[k].key!.padEnd(w)} = ${out[k].value}`;
    i = j;
  }

  const lines = out.map((l) => (l.depth < 0 ? l.text : l.text ? '  '.repeat(l.depth) + l.text : ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

/** Líneas de diferencia sencillas (para terraform fmt -diff). */
export function simpleDiff(file: string, before: string, after: string): string[] {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.split('\n');
  const out = [`--- old/${file}`, `+++ new/${file}`];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`-${a[i]}`);
    if (b[i] !== undefined) out.push(`+${b[i]}`);
  }
  return out;
}
