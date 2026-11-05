import { HclSyntaxError, tokenize, type Token } from './lexer';
import type { Value } from './values';

// ---------------------------------------------------------------- AST

export type Expr =
  | { kind: 'literal'; value: Value; line: number }
  | { kind: 'template'; parts: (string | Expr)[]; line: number }
  | { kind: 'variable'; name: string; line: number }
  | { kind: 'getattr'; target: Expr; name: string; line: number }
  | { kind: 'index'; target: Expr; key: Expr; line: number }
  | { kind: 'splat'; target: Expr; chain: Expr; line: number }
  | { kind: 'splatItem'; line: number }
  | { kind: 'call'; name: string; args: Expr[]; expand: boolean; line: number }
  | { kind: 'unary'; op: string; operand: Expr; line: number }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; line: number }
  | { kind: 'conditional'; cond: Expr; then: Expr; else: Expr; line: number }
  | { kind: 'tuple'; items: Expr[]; line: number }
  | { kind: 'object'; items: { key: Expr; value: Expr }[]; line: number }
  | {
      kind: 'for';
      isObject: boolean;
      keyVar?: string;
      valVar: string;
      coll: Expr;
      keyExpr?: Expr;
      valExpr: Expr;
      cond?: Expr;
      grouping: boolean;
      line: number;
    };

export interface Attribute {
  name: string;
  expr: Expr;
  line: number;
}

export interface Block {
  type: string;
  labels: string[];
  body: Body;
  line: number;
}

export interface Body {
  attributes: Attribute[];
  blocks: Block[];
}

// ---------------------------------------------------------------- Parser

const PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

const describe = (t: Token) =>
  t.type === 'eof' ? 'el final del fichero' : t.type === 'newline' ? 'un salto de línea' : `"${t.value}"`;

class Parser {
  pos = 0;
  /** >0 cuando estamos dentro de (), [] o {} de una expresión: los saltos de línea se ignoran. */
  skipNl = 0;

  constructor(private toks: Token[]) {}

  peekRaw(): Token {
    return this.toks[this.pos];
  }

  peek(): Token {
    if (this.skipNl > 0) while (this.toks[this.pos].type === 'newline') this.pos++;
    return this.toks[this.pos];
  }

  next(): Token {
    const t = this.peek();
    if (t.type !== 'eof') this.pos++;
    return t;
  }

  isPunct(v: string, t: Token = this.peek()) {
    return t.type === 'punct' && t.value === v;
  }

  err(msg: string, t: Token, hint?: string): never {
    throw new HclSyntaxError(msg, t.line, t.col, hint);
  }

  expectPunct(v: string, hint?: string): Token {
    const t = this.next();
    if (!this.isPunct(v, t)) this.err(`Se esperaba "${v}" pero se encontró ${describe(t)}`, t, hint);
    return t;
  }

  // ------------------------------------------------------------ cuerpo

  parseBody(nested: boolean): Body {
    const body: Body = { attributes: [], blocks: [] };
    for (;;) {
      let t = this.peekRaw();
      while (t.type === 'newline') {
        this.pos++;
        t = this.peekRaw();
      }
      if (t.type === 'eof') {
        if (nested) this.err('Falta "}" para cerrar el bloque', t, 'Cada "{" debe tener su "}" correspondiente.');
        return body;
      }
      if (this.isPunct('}', t)) {
        if (!nested) this.err('"}" inesperado', t, 'Hay una llave de cierre de más.');
        return body;
      }
      if (t.type !== 'ident') {
        this.err(
          `Argument or block definition required, found ${describe(t)}`,
          t,
          'Aquí debería empezar un argumento (nombre = valor) o un bloque (tipo "etiqueta" { ... }).',
        );
      }
      this.pos++;
      const after = this.peekRaw();
      if (this.isPunct('=', after)) {
        this.pos++;
        const expr = this.parseExpr();
        const end = this.peekRaw();
        if (!(end.type === 'newline' || end.type === 'eof' || this.isPunct('}', end))) {
          this.err(
            `Missing newline after argument "${t.value}"`,
            end,
            'Cada argumento debe ir en su propia línea.',
          );
        }
        body.attributes.push({ name: t.value, expr, line: t.line });
        continue;
      }
      const labels: string[] = [];
      for (;;) {
        const l = this.peekRaw();
        if (l.type === 'string') {
          labels.push(l.value);
          this.pos++;
        } else if (l.type === 'ident') {
          labels.push(l.value);
          this.pos++;
        } else break;
      }
      const open = this.peekRaw();
      if (!this.isPunct('{', open)) {
        this.err(
          `Se esperaba "=" o "{" después de "${t.value}"`,
          open,
          labels.length
            ? 'Un bloque se escribe así: tipo "etiqueta" { ... }'
            : 'Un argumento se escribe así: nombre = valor',
        );
      }
      this.pos++;
      const inner = this.parseBody(true);
      this.pos++; // '}'
      body.blocks.push({ type: t.value, labels, body: inner, line: t.line });
    }
  }

  // ------------------------------------------------------------ expresiones

  parseExpr(): Expr {
    const cond = this.parseBinary(1);
    if (this.isPunct('?')) {
      const q = this.next();
      const a = this.parseExpr();
      this.expectPunct(':', 'Un condicional se escribe: condición ? valor_si : valor_no');
      const b = this.parseExpr();
      return { kind: 'conditional', cond, then: a, else: b, line: q.line };
    }
    return cond;
  }

  parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct') break;
      const p = PREC[t.value];
      if (p === undefined || p < minPrec) break;
      this.next();
      const right = this.parseBinary(p + 1);
      left = { kind: 'binary', op: t.value, left, right, line: t.line };
    }
    return left;
  }

  parseUnary(): Expr {
    const t = this.peek();
    if (this.isPunct('!', t) || this.isPunct('-', t)) {
      this.next();
      return { kind: 'unary', op: t.value, operand: this.parseUnary(), line: t.line };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parsePostfix(e: Expr): Expr {
    for (;;) {
      const t = this.peek();
      if (this.isPunct('.', t)) {
        this.next();
        const n = this.next();
        if (n.type === 'ident') e = { kind: 'getattr', target: e, name: n.value, line: n.line };
        else if (n.type === 'number')
          e = { kind: 'index', target: e, key: { kind: 'literal', value: Number(n.value), line: n.line }, line: n.line };
        else if (this.isPunct('*', n)) e = { kind: 'splat', target: e, chain: this.parseSplatChain(true), line: n.line };
        else this.err(`Se esperaba un nombre de atributo después de "."`, n);
        continue;
      }
      if (this.isPunct('[', t)) {
        const a = this.toks[this.pos + 1];
        const b = this.toks[this.pos + 2];
        if (this.isPunct('*', a) && this.isPunct(']', b)) {
          this.pos += 3;
          e = { kind: 'splat', target: e, chain: this.parseSplatChain(false), line: t.line };
          continue;
        }
        this.next();
        this.skipNl++;
        const key = this.parseExpr();
        this.expectPunct(']');
        this.skipNl--;
        e = { kind: 'index', target: e, key, line: t.line };
        continue;
      }
      return e;
    }
  }

  parseSplatChain(attrOnly: boolean): Expr {
    let c: Expr = { kind: 'splatItem', line: this.peek().line };
    for (;;) {
      const t = this.peek();
      if (this.isPunct('.', t) && this.toks[this.pos + 1]?.type === 'ident') {
        this.next();
        const n = this.next();
        c = { kind: 'getattr', target: c, name: n.value, line: n.line };
        continue;
      }
      if (!attrOnly && this.isPunct('[', t) && !this.isPunct('*', this.toks[this.pos + 1])) {
        this.next();
        this.skipNl++;
        const key = this.parseExpr();
        this.expectPunct(']');
        this.skipNl--;
        c = { kind: 'index', target: c, key, line: t.line };
        continue;
      }
      return c;
    }
  }

  parsePrimary(): Expr {
    const t = this.next();
    switch (t.type) {
      case 'number':
        return { kind: 'literal', value: Number(t.value), line: t.line };
      case 'string':
        return parseTemplate(t.value, t.line, !!t.heredoc);
      case 'ident': {
        if (t.value === 'true') return { kind: 'literal', value: true, line: t.line };
        if (t.value === 'false') return { kind: 'literal', value: false, line: t.line };
        if (t.value === 'null') return { kind: 'literal', value: null, line: t.line };
        if (this.isPunct('(', this.peekRaw())) return this.parseCall(t);
        return { kind: 'variable', name: t.value, line: t.line };
      }
      case 'punct':
        if (t.value === '(') {
          this.skipNl++;
          const e = this.parseExpr();
          this.expectPunct(')');
          this.skipNl--;
          return e;
        }
        if (t.value === '[') return this.parseTuple(t);
        if (t.value === '{') return this.parseObject(t);
        break;
      default:
        break;
    }
    return this.err(
      `Invalid expression: se encontró ${describe(t)}`,
      t,
      t.type === 'newline' || t.type === 'eof' ? 'Falta el valor después del "=".' : undefined,
    );
  }

  parseCall(name: Token): Expr {
    this.next(); // (
    this.skipNl++;
    const args: Expr[] = [];
    let expand = false;
    while (!this.isPunct(')')) {
      args.push(this.parseExpr());
      if (this.isPunct('...')) {
        this.next();
        expand = true;
      }
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct(')')) this.err(`Se esperaba "," o ")" en la llamada a ${name.value}()`, this.peek());
    }
    this.next();
    this.skipNl--;
    return { kind: 'call', name: name.value, args, expand, line: name.line };
  }

  parseTuple(open: Token): Expr {
    this.skipNl++;
    if (this.peek().type === 'ident' && this.peek().value === 'for') {
      const f = this.parseFor(open, false);
      this.expectPunct(']');
      this.skipNl--;
      return f;
    }
    const items: Expr[] = [];
    while (!this.isPunct(']')) {
      items.push(this.parseExpr());
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct(']')) this.err('Se esperaba "," o "]" en la lista', this.peek(), 'Separa los elementos de una lista con comas.');
    }
    this.next();
    this.skipNl--;
    return { kind: 'tuple', items, line: open.line };
  }

  parseObject(open: Token): Expr {
    this.skipNl++;
    if (this.peek().type === 'ident' && this.peek().value === 'for') {
      const f = this.parseFor(open, true);
      this.expectPunct('}');
      this.skipNl--;
      return f;
    }
    const items: { key: Expr; value: Expr }[] = [];
    while (!this.isPunct('}')) {
      const t = this.peek();
      if (t.type === 'eof') this.err('Falta "}" para cerrar el objeto', t);
      let key: Expr;
      const after = this.toks[this.pos + 1];
      if (t.type === 'ident' && (this.isPunct('=', after) || this.isPunct(':', after))) {
        this.next();
        key = { kind: 'literal', value: t.value, line: t.line };
      } else {
        key = this.parseBinary(1);
      }
      const sep = this.next();
      if (!this.isPunct('=', sep) && !this.isPunct(':', sep)) {
        this.err(`Se esperaba "=" después de la clave del objeto`, sep);
      }
      const value = this.parseExpr();
      items.push({ key, value });
      if (this.isPunct(',')) this.next();
    }
    this.next();
    this.skipNl--;
    return { kind: 'object', items, line: open.line };
  }

  parseFor(open: Token, isObject: boolean): Expr {
    this.next(); // for
    const first = this.next();
    if (first.type !== 'ident') this.err('Se esperaba un nombre de variable después de "for"', first);
    let keyVar: string | undefined;
    let valVar = first.value;
    if (this.isPunct(',')) {
      this.next();
      const second = this.next();
      if (second.type !== 'ident') this.err('Se esperaba un nombre de variable', second);
      keyVar = first.value;
      valVar = second.value;
    }
    const inTok = this.next();
    if (inTok.type !== 'ident' || inTok.value !== 'in') this.err('Se esperaba "in" en la expresión for', inTok);
    const coll = this.parseExpr();
    this.expectPunct(':');
    let keyExpr: Expr | undefined;
    let valExpr: Expr;
    let grouping = false;
    if (isObject) {
      keyExpr = this.parseExpr();
      this.expectPunct('=>', 'En un for de objeto se usa: clave => valor');
      valExpr = this.parseExpr();
      if (this.isPunct('...')) {
        this.next();
        grouping = true;
      }
    } else {
      valExpr = this.parseExpr();
    }
    let cond: Expr | undefined;
    if (this.peek().type === 'ident' && this.peek().value === 'if') {
      this.next();
      cond = this.parseExpr();
    }
    return { kind: 'for', isObject, keyVar, valVar, coll, keyExpr, valExpr, cond, grouping, line: open.line };
  }
}

// ---------------------------------------------------------------- plantillas

function findInterpolationEnd(raw: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };

export function parseTemplate(raw: string, line: number, heredoc = false): Expr {
  const parts: (string | Expr)[] = [];
  let buf = '';
  let i = 0;
  let curLine = line;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\n') curLine++;
    if (!heredoc && c === '\\') {
      const nx = raw[i + 1];
      if (nx === 'u') {
        buf += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      buf += ESCAPES[nx] ?? nx;
      i += 2;
      continue;
    }
    if (c === '$' && raw[i + 1] === '$' && raw[i + 2] === '{') {
      buf += '${';
      i += 3;
      continue;
    }
    if (c === '%' && raw[i + 1] === '{') {
      throw new HclSyntaxError(
        'Las directivas de plantilla %{ } no están soportadas en el simulador',
        curLine,
        1,
      );
    }
    if (c === '$' && raw[i + 1] === '{') {
      const end = findInterpolationEnd(raw, i + 2);
      if (end < 0) throw new HclSyntaxError('Interpolación "${" sin cerrar', curLine);
      if (buf) parts.push(buf);
      buf = '';
      parts.push(parseExpressionSource(raw.slice(i + 2, end).trim(), curLine));
      i = end + 1;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf || parts.length === 0) parts.push(buf);
  if (parts.length === 1 && typeof parts[0] === 'string') return { kind: 'literal', value: parts[0], line };
  if (parts.length === 1) return parts[0] as Expr; // "${x}" conserva el tipo de x
  return { kind: 'template', parts, line };
}

export function parseExpressionSource(src: string, line: number): Expr {
  const p = new Parser(tokenize(src, line - 1));
  p.skipNl = 1;
  const e = p.parseExpr();
  const end = p.peek();
  if (end.type !== 'eof') p.err(`Contenido inesperado ${describe(end)} en la expresión`, end);
  return e;
}

export interface ParseResult {
  body: Body | null;
  error?: HclSyntaxError;
}

export function parseHcl(src: string): ParseResult {
  try {
    const p = new Parser(tokenize(src));
    return { body: p.parseBody(false) };
  } catch (e) {
    if (e instanceof HclSyntaxError) return { body: null, error: e };
    throw e;
  }
}
