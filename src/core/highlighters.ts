/**
 * Registro de resaltadores de sintaxis. Cada módulo registra los lenguajes
 * que necesita (hcl, yaml, dockerfile…) y el renderizador Markdown los usa
 * en los bloques de código de las lecciones.
 */
export type Highlighter = (code: string) => string; // devuelve HTML escapado

const registry = new Map<string, Highlighter>();

export function registerHighlighter(lang: string, fn: Highlighter) {
  registry.set(lang, fn);
}

export function getHighlighter(lang: string): Highlighter | undefined {
  return registry.get(lang);
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
