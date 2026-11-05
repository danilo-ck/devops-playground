import { Fragment, useMemo, type ReactNode } from 'react';
import { escapeHtml, getHighlighter } from '@/core/highlighters';

/**
 * Renderizador Markdown mínimo para el contenido de las lecciones.
 * Soporta: títulos, párrafos, listas, tablas, bloques de código (con
 * resaltado por lenguaje), avisos "> [!TIP]" y formato en línea.
 */

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'code'; lang: string; code: string }
  | { t: 'callout'; kind: string; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'hr' };

function parse(md: string): Block[] {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push({ t: 'code', lang: fence[1], code: buf.join('\n') });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      let kind = 'note';
      const m = /^\[!(\w+)\]\s*/.exec(buf[0]);
      if (m) {
        kind = m[1].toLowerCase();
        buf[0] = buf[0].slice(m[0].length);
      }
      out.push({ t: 'callout', kind, text: buf.join('\n').trim() });
      continue;
    }
    if (line.trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      out.push({ t: 'table', head: rows[0] ?? [], rows: rows.slice(1) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
        items.push(lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ''));
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        }
      }
      out.push({ t: ordered ? 'ol' : 'ul', items });
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|>|\s*[-*]\s+|\s*\d+\.\s+|\s*\|)/.test(lines[i])
    )
      buf.push(lines[i++]);
    out.push({ t: 'p', text: buf.join(' ') });
  }
  return out;
}

export function Inline({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) nodes.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) nodes.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('[')) {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      nodes.push(
        <a key={k++} href={lm[2]} target="_blank" rel="noreferrer">
          {lm[1]}
        </a>,
      );
    } else nodes.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

const CALLOUT: Record<string, { icon: string; label: string }> = {
  tip: { icon: '💡', label: 'Consejo' },
  note: { icon: '📝', label: 'Nota' },
  info: { icon: 'ℹ️', label: 'Info' },
  warning: { icon: '⚠️', label: 'Cuidado' },
  important: { icon: '❗', label: 'Importante' },
  analogy: { icon: '🧠', label: 'Analogía' },
};

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const hl = getHighlighter(lang);
  const html = hl ? hl(code) : escapeHtml(code);
  return (
    <pre className={`md-code lang-${lang || 'text'}`}>
      {lang && <span className="md-code-lang">{lang}</span>}
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parse(source), [source]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const Tag = `h${Math.min(6, b.level + 1)}` as 'h2';
            return (
              <Tag key={i}>
                <Inline text={b.text} />
              </Tag>
            );
          }
          case 'p':
            return (
              <p key={i}>
                <Inline text={b.text} />
              </p>
            );
          case 'ul':
          case 'ol': {
            const Tag = b.t;
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </Tag>
            );
          }
          case 'code':
            return <CodeBlock key={i} code={b.code} lang={b.lang} />;
          case 'callout': {
            const c = CALLOUT[b.kind] ?? CALLOUT.note;
            return (
              <div key={i} className={`md-callout md-callout-${b.kind}`}>
                <div className="md-callout-title">
                  {c.icon} {c.label}
                </div>
                {b.text.split('\n').map((l, j) => (
                  <Fragment key={j}>
                    <Inline text={l} />
                    <br />
                  </Fragment>
                ))}
              </div>
            );
          }
          case 'table':
            return (
              <div key={i} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j}>
                          <Inline text={h} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>
                            <Inline text={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={i} />;
        }
      })}
    </div>
  );
}
