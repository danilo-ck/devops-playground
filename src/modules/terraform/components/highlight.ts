import { escapeHtml } from '@/core/highlighters';

const BLOCK_KW = new Set(['resource', 'data', 'variable', 'output', 'locals', 'provider', 'terraform', 'module', 'lifecycle', 'required_providers', 'validation']);
const REF_ROOTS = new Set(['var', 'local', 'each', 'count', 'data', 'self', 'path', 'module']);
const LITERALS = new Set(['true', 'false', 'null']);
const KEYWORDS = new Set(['for', 'in', 'if']);

const span = (cls: string, text: string) => `<span class="hl-${cls}">${escapeHtml(text)}</span>`;

function highlightString(s: string): string {
  // s incluye las comillas
  let out = '';
  let i = 0;
  let buf = '';
  while (i < s.length) {
    if (s[i] === '\\') {
      buf += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
        j++;
      }
      if (buf) out += span('str', buf);
      buf = '';
      out += `<span class="hl-interp">\${</span>${highlightHcl(s.slice(i + 2, j - 1))}<span class="hl-interp">}</span>`;
      i = j;
      continue;
    }
    buf += s[i++];
  }
  if (buf) out += span('str', buf);
  return out;
}

/** Resaltado de HCL para el editor y los bloques de código. Devuelve HTML. */
export function highlightHcl(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  let lineStart = true;
  while (i < n) {
    const c = code[i];
    if (c === '\n') {
      out += '\n';
      i++;
      lineStart = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      out += c;
      i++;
      continue;
    }
    if (c === '#' || (c === '/' && code[i + 1] === '/')) {
      let j = i;
      while (j < n && code[j] !== '\n') j++;
      out += span('comment', code.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      let j = code.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out += span('comment', code.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let depth = 0;
      while (j < n && code[j] !== '\n') {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === '$' && code[j + 1] === '{') {
          depth++;
          j += 2;
          continue;
        }
        if (depth > 0 && code[j] === '}') depth--;
        else if (depth === 0 && code[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      out += highlightString(code.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.]/.test(code[j])) j++;
      out += span('num', code.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_-]/.test(code[j])) j++;
      const word = code.slice(i, j);
      let k = j;
      while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
      const nextCh = code[k];
      const prevCh = out.length ? code[i - 1] : '';
      let cls = 'ident';
      if (lineStart && BLOCK_KW.has(word) && (nextCh === '"' || nextCh === '{')) cls = 'kw';
      else if (LITERALS.has(word)) cls = 'bool';
      else if (KEYWORDS.has(word)) cls = 'kw2';
      else if (nextCh === '(') cls = 'fn';
      else if (lineStart && nextCh === '=' && code[k + 1] !== '=') cls = 'attr';
      else if (lineStart && nextCh === '{') cls = 'block';
      else if (prevCh === '.') cls = 'prop';
      else if (REF_ROOTS.has(word) || code[j] === '.') cls = 'ref';
      out += span(cls, word);
      i = j;
      lineStart = false;
      continue;
    }
    out += span('punct', c);
    i++;
    lineStart = false;
  }
  return out;
}
