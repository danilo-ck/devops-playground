import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TermLine } from '../engine';

export interface TerminalLine extends TermLine {
  id: number;
}

interface Props {
  lines: TerminalLine[];
  onSubmit: (cmd: string) => void;
  busy: boolean;
  awaitingConfirm: boolean;
  consoleMode: boolean;
}

const QUICK = [
  { label: 'init', cmd: 'terraform init' },
  { label: 'validate', cmd: 'terraform validate' },
  { label: 'plan', cmd: 'terraform plan' },
  { label: 'apply', cmd: 'terraform apply' },
  { label: 'destroy', cmd: 'terraform destroy' },
  { label: 'state list', cmd: 'terraform state list' },
  { label: 'output', cmd: 'terraform output' },
  { label: 'console', cmd: 'terraform console' },
];

export function Terminal({ lines, onSubmit, busy, awaitingConfirm, consoleMode }: Props) {
  const [input, setInput] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, busy]);

  useEffect(() => {
    if (awaitingConfirm) inputRef.current?.focus();
  }, [awaitingConfirm]);

  const submit = (cmd: string) => {
    if (busy) return;
    onSubmit(cmd);
    if (cmd.trim() && !awaitingConfirm) setHist((h) => [...h.filter((x) => x !== cmd), cmd]);
    setHIdx(-1);
    setInput('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit(input);
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const i = hIdx < 0 ? hist.length - 1 : Math.max(0, hIdx - 1);
      if (hist[i] !== undefined) {
        setHIdx(i);
        setInput(hist[i]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hIdx < 0) return;
      const i = hIdx + 1;
      if (i >= hist.length) {
        setHIdx(-1);
        setInput('');
      } else {
        setHIdx(i);
        setInput(hist[i]);
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      submit('clear');
    }
  };

  const prompt = awaitingConfirm ? '  Enter a value:' : consoleMode ? '>' : '$';

  return (
    <div className="terminal" onClick={() => window.getSelection()?.isCollapsed && inputRef.current?.focus()}>
      <div className="term-toolbar">
        <span className="term-title">▍ Terminal</span>
        <div className="term-quick">
          {awaitingConfirm ? (
            <>
              <button className="qbtn qbtn-yes" disabled={busy} onClick={() => submit('yes')}>
                yes · confirmar
              </button>
              <button className="qbtn" disabled={busy} onClick={() => submit('no')}>
                no · cancelar
              </button>
            </>
          ) : consoleMode ? (
            <button className="qbtn" onClick={() => submit('exit')}>
              exit
            </button>
          ) : (
            QUICK.map((q) => (
              <button key={q.label} className="qbtn" disabled={busy} title={q.cmd} onClick={() => submit(q.cmd)}>
                {q.label}
              </button>
            ))
          )}
          <button className="qbtn qbtn-dim" disabled={busy} onClick={() => submit('clear')} title="Limpiar (Ctrl+L)">
            ⌫
          </button>
        </div>
      </div>
      <div className="term-body" ref={bodyRef}>
        {lines.map((l) => (
          <div key={l.id} className={`tl ${l.tone ? `tl-${l.tone}` : ''}`}>
            {l.text || ' '}
          </div>
        ))}
        {busy && <div className="tl tl-muted term-busy">⠋ trabajando…</div>}
        <div className="term-input-row">
          <span className={`term-prompt ${awaitingConfirm ? 'confirm' : ''}`}>{prompt}</span>
          <input
            ref={inputRef}
            className="term-input"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={awaitingConfirm ? 'escribe yes para confirmar' : consoleMode ? 'expresión, p.ej. upper("hola")' : 'escribe un comando, p.ej. terraform plan'}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-label="Entrada de la terminal"
          />
        </div>
      </div>
    </div>
  );
}
