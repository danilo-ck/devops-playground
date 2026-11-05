import { containsUnknown, deepEqual, isMap, isSet, isUnknown, markSet, typeName, Unknown, type Value, type ValueMap } from './values';

export class FunctionError extends Error {}

type Fn = (args: Value[]) => Value;

// ------------------------------------------------------------ helpers de red

export function parseCidr(cidr: string): { ip: number; bits: number } {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!m) throw new FunctionError(`"${cidr}" no es un bloque CIDR válido (ejemplo: 10.0.0.0/16)`);
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) throw new FunctionError(`"${cidr}" no es un bloque CIDR válido`);
  const ip = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return { ip, bits };
}

export const ipToString = (ip: number) =>
  [(ip >>> 24) & 255, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');

const maskOf = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

export function cidrContains(outer: string, inner: string): boolean {
  const o = parseCidr(outer);
  const i = parseCidr(inner);
  if (i.bits < o.bits) return false;
  const m = maskOf(o.bits);
  return ((o.ip & m) >>> 0) === ((i.ip & m) >>> 0);
}

export function cidrOverlaps(a: string, b: string): boolean {
  return cidrContains(a, b) || cidrContains(b, a);
}

export function cidrHost(prefix: string, host: number): string {
  const { ip, bits } = parseCidr(prefix);
  const size = 2 ** (32 - bits);
  if (host >= size || host < -size) throw new FunctionError(`El host ${host} no cabe en ${prefix}`);
  const base = (ip & maskOf(bits)) >>> 0;
  return ipToString((base + (host < 0 ? size + host : host)) >>> 0);
}

// ------------------------------------------------------------ conversión

const str = (v: Value, fn: string): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new FunctionError(`${fn}(): se esperaba un string y se recibió ${typeName(v)}`);
};
const num = (v: Value, fn: string): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  throw new FunctionError(`${fn}(): se esperaba un número y se recibió ${typeName(v)}`);
};
const list = (v: Value, fn: string): Value[] => {
  if (Array.isArray(v)) return v;
  throw new FunctionError(`${fn}(): se esperaba una lista y se recibió ${typeName(v)}`);
};
const map = (v: Value, fn: string): ValueMap => {
  if (isMap(v)) return v;
  throw new FunctionError(`${fn}(): se esperaba un mapa y se recibió ${typeName(v)}`);
};

function format(fmt: string, args: Value[]): string {
  let i = 0;
  return fmt.replace(/%(-?)(0?)(\d*)(\.\d+)?([sdvfq%])/g, (_m, left, zero, width, prec, verb) => {
    if (verb === '%') return '%';
    const a = args[i++];
    if (a === undefined) throw new FunctionError('format(): faltan argumentos para el formato');
    let out: string;
    switch (verb) {
      case 'd':
        out = String(Math.trunc(num(a, 'format')));
        break;
      case 'f':
        out = num(a, 'format').toFixed(prec ? Number(prec.slice(1)) : 6);
        break;
      case 'q':
        out = JSON.stringify(str(a, 'format'));
        break;
      default:
        out = typeof a === 'string' ? a : JSON.stringify(a);
    }
    const w = Number(width || 0);
    if (out.length >= w) return out;
    if (left) return out.padEnd(w);
    return out.padStart(w, zero && verb !== 's' ? '0' : ' ');
  });
}

// ------------------------------------------------------------ catálogo

export const FUNCTIONS: Record<string, { fn: Fn; signature: string; description: string }> = {
  upper: { signature: 'upper(string)', description: 'Convierte a mayúsculas', fn: ([s]) => str(s, 'upper').toUpperCase() },
  lower: { signature: 'lower(string)', description: 'Convierte a minúsculas', fn: ([s]) => str(s, 'lower').toLowerCase() },
  title: {
    signature: 'title(string)',
    description: 'Primera letra de cada palabra en mayúscula',
    fn: ([s]) => str(s, 'title').replace(/\b\w/g, (c) => c.toUpperCase()),
  },
  trimspace: { signature: 'trimspace(string)', description: 'Elimina espacios al inicio y al final', fn: ([s]) => str(s, 'trimspace').trim() },
  replace: {
    signature: 'replace(string, buscar, reemplazo)',
    description: 'Reemplaza todas las apariciones de un texto',
    fn: ([s, a, b]) => str(s, 'replace').split(str(a, 'replace')).join(str(b, 'replace')),
  },
  substr: {
    signature: 'substr(string, inicio, longitud)',
    description: 'Extrae una subcadena',
    fn: ([s, o, l]) => {
      const x = str(s, 'substr');
      const len = num(l, 'substr');
      return len < 0 ? x.slice(num(o, 'substr')) : x.substr(num(o, 'substr'), len);
    },
  },
  format: { signature: 'format(fmt, args...)', description: 'Formatea un texto: format("web-%02d", 1)', fn: ([f, ...rest]) => format(str(f, 'format'), rest) },
  join: { signature: 'join(separador, lista)', description: 'Une una lista en un string', fn: ([sep, l]) => list(l, 'join').map((x) => str(x, 'join')).join(str(sep, 'join')) },
  split: { signature: 'split(separador, string)', description: 'Divide un string en una lista', fn: ([sep, s]) => str(s, 'split').split(str(sep, 'split')) },
  length: {
    signature: 'length(valor)',
    description: 'Número de elementos de una lista, mapa o string',
    fn: ([v]) => {
      if (typeof v === 'string') return [...v].length;
      if (Array.isArray(v)) return v.length;
      if (isMap(v)) return Object.keys(v).length;
      throw new FunctionError(`length(): no se puede calcular la longitud de ${typeName(v)}`);
    },
  },
  concat: { signature: 'concat(lista1, lista2, ...)', description: 'Concatena listas', fn: (args) => args.flatMap((a) => list(a, 'concat')) },
  merge: {
    signature: 'merge(mapa1, mapa2, ...)',
    description: 'Combina mapas (los últimos tienen prioridad)',
    fn: (args) => Object.assign({}, ...args.filter((a) => a !== null).map((a) => map(a, 'merge'))),
  },
  lookup: {
    signature: 'lookup(mapa, clave, por_defecto)',
    description: 'Busca una clave en un mapa',
    fn: ([m, k, d]) => {
      const mm = map(m, 'lookup');
      const key = str(k, 'lookup');
      if (key in mm) return mm[key];
      if (d === undefined) throw new FunctionError(`lookup(): la clave "${key}" no existe`);
      return d;
    },
  },
  element: {
    signature: 'element(lista, índice)',
    description: 'Elemento de la lista (con desbordamiento circular)',
    fn: ([l, i]) => {
      const ll = list(l, 'element');
      if (!ll.length) throw new FunctionError('element(): la lista está vacía');
      return ll[num(i, 'element') % ll.length];
    },
  },
  index: {
    signature: 'index(lista, valor)',
    description: 'Posición de un valor en la lista',
    fn: ([l, v]) => {
      const i = list(l, 'index').findIndex((x) => deepEqual(x, v));
      if (i < 0) throw new FunctionError('index(): el valor no está en la lista');
      return i;
    },
  },
  contains: { signature: 'contains(lista, valor)', description: '¿Contiene la lista el valor?', fn: ([l, v]) => list(l, 'contains').some((x) => deepEqual(x, v)) },
  keys: { signature: 'keys(mapa)', description: 'Claves de un mapa (ordenadas)', fn: ([m]) => Object.keys(map(m, 'keys')).sort() },
  values: {
    signature: 'values(mapa)',
    description: 'Valores de un mapa (ordenados por clave)',
    fn: ([m]) => {
      const mm = map(m, 'values');
      return Object.keys(mm).sort().map((k) => mm[k]);
    },
  },
  distinct: {
    signature: 'distinct(lista)',
    description: 'Elimina duplicados',
    fn: ([l]) => list(l, 'distinct').filter((x, i, a) => a.findIndex((y) => deepEqual(x, y)) === i),
  },
  flatten: { signature: 'flatten(lista)', description: 'Aplana listas anidadas', fn: ([l]) => (list(l, "flatten") as unknown[]).flat(Infinity as 1) as Value[] },
  range: {
    signature: 'range(n) / range(inicio, fin, paso)',
    description: 'Genera una lista de números',
    fn: (args) => {
      const [a, b, c] = args.map((x) => num(x, 'range'));
      const [start, end, step] = args.length === 1 ? [0, a, 1] : [a, b, c ?? 1];
      const out: number[] = [];
      if (step === 0) throw new FunctionError('range(): el paso no puede ser 0');
      for (let i = start; step > 0 ? i < end : i > end; i += step) {
        out.push(i);
        if (out.length > 1024) throw new FunctionError('range(): demasiados elementos');
      }
      return out;
    },
  },
  zipmap: {
    signature: 'zipmap(claves, valores)',
    description: 'Crea un mapa a partir de dos listas',
    fn: ([k, v]) => {
      const kk = list(k, 'zipmap');
      const vv = list(v, 'zipmap');
      const out: ValueMap = {};
      kk.forEach((key, i) => (out[str(key, 'zipmap')] = vv[i] ?? null));
      return out;
    },
  },
  min: { signature: 'min(n1, n2, ...)', description: 'El menor número', fn: (args) => Math.min(...args.map((a) => num(a, 'min'))) },
  max: { signature: 'max(n1, n2, ...)', description: 'El mayor número', fn: (args) => Math.max(...args.map((a) => num(a, 'max'))) },
  abs: { signature: 'abs(n)', description: 'Valor absoluto', fn: ([a]) => Math.abs(num(a, 'abs')) },
  ceil: { signature: 'ceil(n)', description: 'Redondea hacia arriba', fn: ([a]) => Math.ceil(num(a, 'ceil')) },
  floor: { signature: 'floor(n)', description: 'Redondea hacia abajo', fn: ([a]) => Math.floor(num(a, 'floor')) },
  coalesce: {
    signature: 'coalesce(v1, v2, ...)',
    description: 'Primer valor no nulo ni vacío',
    fn: (args) => {
      const v = args.find((a) => a !== null && a !== '');
      if (v === undefined) throw new FunctionError('coalesce(): todos los argumentos son nulos o vacíos');
      return v;
    },
  },
  tostring: { signature: 'tostring(v)', description: 'Convierte a string', fn: ([v]) => (v === null ? null : str(v, 'tostring')) },
  tonumber: { signature: 'tonumber(v)', description: 'Convierte a número', fn: ([v]) => (v === null ? null : num(v, 'tonumber')) },
  tolist: { signature: 'tolist(v)', description: 'Convierte a lista', fn: ([v]) => [...list(v, 'tolist')] },
  toset: {
    signature: 'toset(lista)',
    description: 'Convierte una lista en un set (sin duplicados). Necesario para for_each',
    fn: ([v]) => {
      const l = list(v, 'toset').map((x) => (typeof x === 'number' || typeof x === 'boolean' ? String(x) : x));
      return markSet(l.filter((x, i, a) => a.findIndex((y) => deepEqual(x, y)) === i).sort() as Value[]);
    },
  },
  tomap: { signature: 'tomap(v)', description: 'Convierte a mapa', fn: ([v]) => ({ ...map(v, 'tomap') }) },
  jsonencode: {
    signature: 'jsonencode(v)',
    description: 'Serializa a JSON',
    fn: ([v]) => JSON.stringify(v),
  },
  cidrsubnet: {
    signature: 'cidrsubnet(prefijo, bits_nuevos, número)',
    description: 'Calcula una subred: cidrsubnet("10.0.0.0/16", 8, 1) = "10.0.1.0/24"',
    fn: ([p, nb, nn]) => {
      const { ip, bits } = parseCidr(str(p, 'cidrsubnet'));
      const newbits = num(nb, 'cidrsubnet');
      const netnum = num(nn, 'cidrsubnet');
      const newPrefix = bits + newbits;
      if (newPrefix > 32) throw new FunctionError(`cidrsubnet(): /${bits} + ${newbits} bits supera /32`);
      if (netnum >= 2 ** newbits || netnum < 0)
        throw new FunctionError(`cidrsubnet(): el número de red ${netnum} no cabe en ${newbits} bits`);
      const base = (ip & maskOf(bits)) >>> 0;
      const sub = (base + netnum * 2 ** (32 - newPrefix)) >>> 0;
      return `${ipToString(sub)}/${newPrefix}`;
    },
  },
  cidrhost: {
    signature: 'cidrhost(prefijo, número_host)',
    description: 'Dirección IP de un host dentro de un CIDR',
    fn: ([p, h]) => cidrHost(str(p, 'cidrhost'), num(h, 'cidrhost')),
  },
  timestamp: { signature: 'timestamp()', description: 'Fecha actual (se conoce en el apply)', fn: () => new Unknown() },
  uuid: { signature: 'uuid()', description: 'UUID aleatorio (se conoce en el apply)', fn: () => new Unknown() },
};

export function callFunction(name: string, args: Value[]): Value {
  const f = FUNCTIONS[name];
  if (!f) {
    throw new FunctionError(`Call to unknown function "${name}"`);
  }
  if (args.some((a) => isUnknown(a))) return new Unknown();
  // length() de una lista con elementos desconocidos sí se conoce.
  if (name !== 'length' && args.some((a) => containsUnknown(a))) return new Unknown();
  return f.fn(args);
}

export const isSetValue = isSet;
