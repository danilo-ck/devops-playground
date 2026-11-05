import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import type { Diagnostic } from '../engine';
import { highlightHcl } from './highlight';

export interface CodeEditorHandle {
  goToLine: (line: number) => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  diagnostics: Diagnostic[];
  onRunShortcut?: () => void;
  readOnly?: boolean;
}

/** Editor ligero: textarea transparente sobre un <pre> resaltado. */
export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor({ value, onChange, diagnostics, onRunShortcut, readOnly }, ref) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  /** Selección a restaurar justo después de que React aplique el nuevo valor. */
  const pendingSel = useRef<[number, number] | null>(null);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (ta && pendingSel.current) {
      ta.setSelectionRange(pendingSel.current[0], pendingSel.current[1]);
      pendingSel.current = null;
    }
  }, [value]);

  const setValue = (next: string, selStart: number, selEnd = selStart) => {
    pendingSel.current = [selStart, selEnd];
    onChange(next);
  };

  const html = useMemo(() => highlightHcl(value) + '\n', [value]);
  const lines = value.split('\n').length;
  const errorLines = useMemo(() => {
    const m = new Map<number, Diagnostic>();
    for (const d of diagnostics) if (d.line && !m.has(d.line)) m.set(d.line, d);
    return m;
  }, [diagnostics]);

  useImperativeHandle(ref, () => ({
    goToLine(line: number) {
      const ta = taRef.current;
      if (!ta) return;
      const ls = value.split('\n');
      const start = ls.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(start, start + (ls[line - 1]?.length ?? 0));
      ta.scrollTop = Math.max(0, (line - 5) * 20);
    },
  }));

  const syncScroll = () => {
    const ta = taRef.current!;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  const replaceSelection = (text: string, caretOffset = text.length) => {
    const ta = taRef.current!;
    const { selectionStart: s, selectionEnd: e } = ta;
    setValue(value.slice(0, s) + text + value.slice(e), s + caretOffset);
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = ev.currentTarget;
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      onRunShortcut?.();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const { selectionStart: s, selectionEnd: e } = ta;
      if (s === e) {
        replaceSelection('  ');
        return;
      }
      // indentar / desindentar varias líneas
      const startLine = value.lastIndexOf('\n', s - 1) + 1;
      const block = value.slice(startLine, e);
      const changed = ev.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
      setValue(value.slice(0, startLine) + changed + value.slice(e), startLine, startLine + changed.length);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const s = ta.selectionStart;
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const line = value.slice(lineStart, s);
      const indent = line.match(/^\s*/)![0];
      const opens = /[{[(]\s*$/.test(line);
      const closesNext = /^\s*[}\])]/.test(value.slice(s, value.indexOf('\n', s) === -1 ? undefined : value.indexOf('\n', s)));
      if (opens && closesNext) {
        const inner = `\n${indent}  `;
        replaceSelection(`${inner}\n${indent}`, inner.length);
      } else replaceSelection(`\n${indent}${opens ? '  ' : ''}`);
      return;
    }
    const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')', '"': '"' };
    if (pairs[ev.key] && ta.selectionStart === ta.selectionEnd) {
      const nextCh = value[ta.selectionStart];
      if (ev.key === '"' && nextCh === '"') {
        ev.preventDefault();
        ta.selectionStart = ta.selectionEnd = ta.selectionStart + 1;
        return;
      }
      if (!nextCh || /[\s)\]}]/.test(nextCh)) {
        ev.preventDefault();
        replaceSelection(ev.key + pairs[ev.key], 1);
        return;
      }
    }
    if (['}', ']', ')'].includes(ev.key) && value[ta.selectionStart] === ev.key) {
      ev.preventDefault();
      ta.selectionStart = ta.selectionEnd = ta.selectionStart + 1;
      return;
    }
    if (ev.key === 'Backspace' && ta.selectionStart === ta.selectionEnd) {
      const s = ta.selectionStart;
      const pair = value.slice(s - 1, s + 1);
      if (['{}', '[]', '()', '""'].includes(pair)) {
        ev.preventDefault();
        setValue(value.slice(0, s - 1) + value.slice(s + 1), s - 1);
      }
    }
  };

  return (
    <div className="code-editor">
      <div className="ce-gutter" ref={gutterRef} aria-hidden>
        {Array.from({ length: lines }, (_, i) => {
          const d = errorLines.get(i + 1);
          return (
            <div key={i} className={`ce-ln ${d ? `ce-ln-${d.severity}` : ''}`} title={d ? `${d.summary}${d.hint ? `\n💡 ${d.hint}` : ''}` : undefined}>
              {d ? '●' : i + 1}
            </div>
          );
        })}
      </div>
      <div className="ce-body">
        <pre className="ce-highlight" ref={preRef} aria-hidden>
          {Array.from(errorLines.keys()).map((l) => (
            <div key={l} className={`ce-errline ce-errline-${errorLines.get(l)!.severity}`} style={{ top: `calc(${l - 1} * var(--ce-lh) + var(--ce-pad))` }} />
          ))}
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
        <textarea
          ref={taRef}
          className="ce-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          aria-label="Editor de código Terraform"
        />
      </div>
    </div>
  );
});
