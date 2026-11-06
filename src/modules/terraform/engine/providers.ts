import { cidrContains, cidrHost, cidrOverlaps, parseCidr } from './functions';
import type { Value, ValueMap } from './values';

/**
 * Catálogo de proveedores y tipos de recurso simulados.
 * Añadir un recurso nuevo = añadir una entrada a RESOURCE_SCHEMAS.
 */

export type ArgType = 'string' | 'number' | 'bool' | 'list' | 'map' | 'block';

export interface ArgSpec {
  type: ArgType;
  required?: boolean;
  /** Cambiar este argumento obliga a destruir y recrear el recurso. */
  forceNew?: boolean;
  default?: Value;
  sensitive?: boolean;
  description: string;
  /** Opcional, pero si no se indica lo calcula el proveedor al crear el recurso. */
  computed?: boolean;
  /** Write-only (Terraform >= 1.11): se envía al proveedor pero nunca se guarda en el plan ni en el estado. */
  writeOnly?: boolean;
  /** Para argumentos de tipo bloque: su esquema interno. */
  block?: Record<string, ArgSpec>;
}

export type Category = 'network' | 'compute' | 'storage' | 'database' | 'security' | 'utility' | 'data';

export interface InstanceView {
  addr: string;
  type: string;
  attributes: ValueMap;
}

export interface GenCtx {
  region: string;
  findById(id: string): InstanceView | undefined;
  all(): InstanceView[];
  /** Dirección de la instancia que se está creando. */
  addr: string;
}

export interface ResourceSchema {
  type: string;
  provider: string;
  mode: 'managed' | 'data';
  title: string;
  description: string;
  category: Category;
  args: Record<string, ArgSpec>;
  computed: string[];
  generate?: (args: ValueMap, ctx: GenCtx) => ValueMap;
  /** Validación en tiempo de plan con valores conocidos. */
  validate?: (args: ValueMap, ctx: { region: string }) => string | null;
  /** Validación en el momento del apply (la "API" de la nube responde). */
  applyCheck?: (args: ValueMap, ctx: GenCtx) => string | null;
}

export interface ProviderInfo {
  name: string;
  source: string;
  version: string;
  description: string;
}

/** Versión de Terraform que simula la app. */
export const TF_VERSION = '1.12.2';

/** Versiones publicadas de cada proveedor en el registro simulado (de más antigua a más nueva). */
export const PROVIDER_VERSIONS: Record<string, string[]> = {
  aws: ['4.67.0', '5.31.0', '5.72.1', '6.0.0'],
  random: ['3.5.1', '3.6.3', '3.7.2'],
  local: ['2.4.1', '2.5.2'],
};

export const PROVIDERS: Record<string, ProviderInfo> = {
  aws: { name: 'aws', source: 'hashicorp/aws', version: '5.72.1', description: 'Amazon Web Services' },
  random: { name: 'random', source: 'hashicorp/random', version: '3.6.3', description: 'Valores aleatorios' },
  local: { name: 'local', source: 'hashicorp/local', version: '2.5.2', description: 'Ficheros locales' },
};

export const providerOf = (type: string) => type.split('_')[0];

// ------------------------------------------------------------ utilidades

const HEX = '0123456789abcdef';
export const hex = (n: number) => Array.from({ length: n }, () => HEX[Math.floor(Math.random() * 16)]).join('');
const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const hashStr = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
};
const ACCOUNT = '123456789012';
const tags = (): ArgSpec => ({ type: 'map', description: 'Etiquetas clave/valor para organizar recursos' });
const arn = (ctx: GenCtx, service: string, res: string) => `arn:aws:${service}:${ctx.region}:${ACCOUNT}:${res}`;

const PET_ADJ = ['happy', 'brave', 'calm', 'eager', 'fancy', 'gentle', 'jolly', 'lucky', 'proud', 'witty'];
const PET_NOUN = ['lynx', 'otter', 'panda', 'koala', 'falcon', 'tiger', 'gecko', 'heron', 'bison', 'moose'];
const TAKEN_BUCKETS = ['test', 'bucket', 'my-bucket', 'mybucket', 'data', 'backup', 'logs', 'images', 'terraform'];

const port: ArgSpec = { type: 'number', required: true, description: 'Puerto' };
const sgRule: Record<string, ArgSpec> = {
  from_port: port,
  to_port: port,
  protocol: { type: 'string', required: true, description: 'Protocolo: tcp, udp, icmp o "-1" (todos)' },
  cidr_blocks: { type: 'list', description: 'Rangos de IP permitidos' },
  description: { type: 'string', description: 'Descripción de la regla' },
};

// ------------------------------------------------------------ esquemas

const schemas: ResourceSchema[] = [
  {
    type: 'aws_vpc',
    provider: 'aws',
    mode: 'managed',
    title: 'VPC',
    category: 'network',
    description: 'Red privada virtual: el "terreno" aislado donde vivirán tus recursos.',
    args: {
      cidr_block: { type: 'string', required: true, forceNew: true, description: 'Rango de IPs de la red, p.ej. 10.0.0.0/16' },
      enable_dns_hostnames: { type: 'bool', default: false, description: 'Asigna nombres DNS a las instancias' },
      enable_dns_support: { type: 'bool', default: true, description: 'Habilita el DNS de AWS' },
      instance_tenancy: { type: 'string', default: 'default', forceNew: true, description: 'default o dedicated' },
      tags: tags(),
    },
    computed: ['id', 'arn', 'owner_id', 'main_route_table_id'],
    validate: (a) => {
      if (typeof a.cidr_block !== 'string') return null;
      try {
        const { bits } = parseCidr(a.cidr_block);
        if (bits < 16 || bits > 28) return `InvalidVpc.Range: el bloque CIDR de una VPC debe estar entre /16 y /28 (recibido /${bits})`;
      } catch (e) {
        return `invalid CIDR address: ${a.cidr_block}`;
      }
      return null;
    },
    generate: (_a, ctx) => {
      const id = `vpc-0${hex(16)}`;
      return { id, arn: arn(ctx, 'ec2', `vpc/${id}`), owner_id: ACCOUNT, main_route_table_id: `rtb-0${hex(16)}` };
    },
  },
  {
    type: 'aws_subnet',
    provider: 'aws',
    mode: 'managed',
    title: 'Subred',
    category: 'network',
    description: 'Un trozo del rango de IPs de la VPC, ubicado en una zona de disponibilidad.',
    args: {
      vpc_id: { type: 'string', required: true, forceNew: true, description: 'ID de la VPC a la que pertenece' },
      cidr_block: { type: 'string', required: true, forceNew: true, description: 'Rango de IPs de la subred (dentro del de la VPC)' },
      availability_zone: { type: 'string', forceNew: true, computed: true, description: 'Zona de disponibilidad, p.ej. us-east-1a' },
      map_public_ip_on_launch: { type: 'bool', default: false, description: 'Asigna IP pública a las instancias lanzadas aquí' },
      tags: tags(),
    },
    computed: ['id', 'arn', 'owner_id'],
    validate: (a, ctx) => {
      if (typeof a.cidr_block === 'string') {
        try {
          parseCidr(a.cidr_block);
        } catch {
          return `invalid CIDR address: ${a.cidr_block}`;
        }
      }
      if (typeof a.availability_zone === 'string' && !a.availability_zone.startsWith(ctx.region)) {
        return `InvalidParameterValue: la zona "${a.availability_zone}" no pertenece a la región ${ctx.region}`;
      }
      return null;
    },
    applyCheck: (a, ctx) => {
      const vpc = ctx.findById(String(a.vpc_id));
      if (!vpc) return `InvalidVpcID.NotFound: The vpc ID '${a.vpc_id}' does not exist`;
      const cidr = String(a.cidr_block);
      if (!cidrContains(String(vpc.attributes.cidr_block), cidr)) {
        return `InvalidSubnet.Range: The CIDR '${cidr}' is invalid (no está dentro de la VPC ${vpc.attributes.cidr_block}).`;
      }
      const clash = ctx
        .all()
        .find(
          (r) =>
            r.type === 'aws_subnet' &&
            r.addr !== ctx.addr &&
            r.attributes.vpc_id === a.vpc_id &&
            cidrOverlaps(String(r.attributes.cidr_block), cidr),
        );
      if (clash) return `InvalidSubnet.Conflict: The CIDR '${cidr}' conflicts with another subnet (${clash.addr}).`;
      return null;
    },
    generate: (a, ctx) => {
      const id = `subnet-0${hex(16)}`;
      return {
        id,
        arn: arn(ctx, 'ec2', `subnet/${id}`),
        owner_id: ACCOUNT,
        availability_zone: (a.availability_zone as string) ?? `${ctx.region}${pick(['a', 'b', 'c'])}`,
      };
    },
  },
  {
    type: 'aws_internet_gateway',
    provider: 'aws',
    mode: 'managed',
    title: 'Internet Gateway',
    category: 'network',
    description: 'La "puerta" que conecta tu VPC con Internet.',
    args: {
      vpc_id: { type: 'string', description: 'VPC a la que se conecta' },
      tags: tags(),
    },
    computed: ['id', 'arn', 'owner_id'],
    generate: (_a, ctx) => {
      const id = `igw-0${hex(16)}`;
      return { id, arn: arn(ctx, 'ec2', `internet-gateway/${id}`), owner_id: ACCOUNT };
    },
  },
  {
    type: 'aws_route_table',
    provider: 'aws',
    mode: 'managed',
    title: 'Tabla de rutas',
    category: 'network',
    description: 'Reglas que deciden hacia dónde va el tráfico de las subredes.',
    args: {
      vpc_id: { type: 'string', required: true, forceNew: true, description: 'VPC de la tabla' },
      route: {
        type: 'block',
        description: 'Una ruta',
        block: {
          cidr_block: { type: 'string', description: 'Destino, p.ej. 0.0.0.0/0' },
          gateway_id: { type: 'string', description: 'Internet Gateway de salida' },
        },
      },
      tags: tags(),
    },
    computed: ['id', 'arn', 'owner_id'],
    generate: (_a, ctx) => {
      const id = `rtb-0${hex(16)}`;
      return { id, arn: arn(ctx, 'ec2', `route-table/${id}`), owner_id: ACCOUNT };
    },
  },
  {
    type: 'aws_route_table_association',
    provider: 'aws',
    mode: 'managed',
    title: 'Asociación de rutas',
    category: 'network',
    description: 'Asocia una subred a una tabla de rutas.',
    args: {
      subnet_id: { type: 'string', required: true, forceNew: true, description: 'Subred' },
      route_table_id: { type: 'string', required: true, description: 'Tabla de rutas' },
    },
    computed: ['id'],
    generate: () => ({ id: `rtbassoc-0${hex(16)}` }),
  },
  {
    type: 'aws_security_group',
    provider: 'aws',
    mode: 'managed',
    title: 'Security Group',
    category: 'security',
    description: 'Cortafuegos virtual: decide qué tráfico entra y sale de tus instancias.',
    args: {
      name: { type: 'string', forceNew: true, computed: true, description: 'Nombre del grupo' },
      description: { type: 'string', forceNew: true, default: 'Managed by Terraform', description: 'Descripción' },
      vpc_id: { type: 'string', forceNew: true, description: 'VPC del grupo' },
      ingress: { type: 'block', description: 'Regla de entrada', block: sgRule },
      egress: { type: 'block', description: 'Regla de salida', block: sgRule },
      tags: tags(),
    },
    computed: ['id', 'arn', 'owner_id'],
    generate: (a, ctx) => {
      const id = `sg-0${hex(16)}`;
      return {
        id,
        arn: arn(ctx, 'ec2', `security-group/${id}`),
        owner_id: ACCOUNT,
        name: (a.name as string) ?? `terraform-${hex(12)}`,
      };
    },
  },
  {
    type: 'aws_instance',
    provider: 'aws',
    mode: 'managed',
    title: 'Instancia EC2',
    category: 'compute',
    description: 'Una máquina virtual (servidor) en la nube.',
    args: {
      ami: { type: 'string', required: true, forceNew: true, description: 'Imagen del sistema operativo (AMI)' },
      instance_type: { type: 'string', required: true, description: 'Tamaño de la máquina: t3.micro, t3.small…' },
      subnet_id: { type: 'string', forceNew: true, description: 'Subred donde se lanza' },
      vpc_security_group_ids: { type: 'list', description: 'Security groups asociados' },
      associate_public_ip_address: { type: 'bool', forceNew: true, description: 'Asignar IP pública' },
      key_name: { type: 'string', forceNew: true, description: 'Par de claves SSH' },
      user_data: { type: 'string', forceNew: true, description: 'Script que se ejecuta al arrancar' },
      tags: tags(),
    },
    computed: ['id', 'arn', 'private_ip', 'public_ip', 'instance_state', 'availability_zone'],
    validate: (a) => {
      const t = a.instance_type;
      if (typeof t === 'string' && !/^[a-z][a-z0-9]*\.(nano|micro|small|medium|large|\d*xlarge)$/.test(t)) {
        return `InvalidParameterValue: "${t}" no es un tipo de instancia válido (prueba t3.micro)`;
      }
      if (typeof a.ami === 'string' && !a.ami.startsWith('ami-')) {
        return `InvalidAMIID.Malformed: "${a.ami}" no es un ID de AMI válido (deben empezar por "ami-")`;
      }
      return null;
    },
    generate: (a, ctx) => {
      const id = `i-0${hex(16)}`;
      const subnet = a.subnet_id ? ctx.findById(String(a.subnet_id)) : undefined;
      let privateIp = `172.31.${rnd(0, 255)}.${rnd(4, 250)}`;
      if (subnet) {
        const used = ctx.all().filter((r) => r.type === 'aws_instance' && r.attributes.subnet_id === a.subnet_id).length;
        try {
          privateIp = cidrHost(String(subnet.attributes.cidr_block), 10 + used + rnd(0, 3) * 10);
        } catch {
          /* subred demasiado pequeña: dejamos la IP por defecto */
        }
      }
      const isPublic =
        a.associate_public_ip_address === true ||
        (a.associate_public_ip_address == null && (!subnet || subnet.attributes.map_public_ip_on_launch === true));
      return {
        id,
        arn: arn(ctx, 'ec2', `instance/${id}`),
        private_ip: privateIp,
        public_ip: isPublic ? `${pick([3, 18, 34, 54])}.${rnd(1, 254)}.${rnd(1, 254)}.${rnd(1, 254)}` : null,
        instance_state: 'running',
        availability_zone: (subnet?.attributes.availability_zone as string) ?? `${ctx.region}a`,
      };
    },
  },
  {
    type: 'aws_s3_bucket',
    provider: 'aws',
    mode: 'managed',
    title: 'Bucket S3',
    category: 'storage',
    description: 'Almacenamiento de objetos (ficheros) ilimitado.',
    args: {
      bucket: { type: 'string', forceNew: true, computed: true, description: 'Nombre global y único del bucket' },
      force_destroy: { type: 'bool', default: false, description: 'Permite borrar el bucket aunque tenga objetos' },
      tags: tags(),
    },
    computed: ['id', 'arn', 'bucket_domain_name', 'region'],
    validate: (a) => {
      const b = a.bucket;
      if (typeof b !== 'string') return null;
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b)) {
        return `invalid bucket name "${b}": solo minúsculas, números, puntos y guiones; entre 3 y 63 caracteres`;
      }
      return null;
    },
    applyCheck: (a) =>
      TAKEN_BUCKETS.includes(String(a.bucket))
        ? `BucketAlreadyExists: el nombre "${a.bucket}" ya lo usa otra cuenta de AWS. Los nombres de bucket son globales.`
        : null,
    generate: (a, ctx) => {
      const name = (a.bucket as string) ?? `terraform-${Date.now()}${hex(6)}`;
      return { id: name, bucket: name, arn: `arn:aws:s3:::${name}`, bucket_domain_name: `${name}.s3.amazonaws.com`, region: ctx.region };
    },
  },
  {
    type: 'aws_db_instance',
    provider: 'aws',
    mode: 'managed',
    title: 'Base de datos RDS',
    category: 'database',
    description: 'Base de datos relacional gestionada (MySQL, PostgreSQL…).',
    args: {
      identifier: { type: 'string', forceNew: true, computed: true, description: 'Nombre de la instancia' },
      engine: { type: 'string', required: true, forceNew: true, description: 'mysql, postgres o mariadb' },
      engine_version: { type: 'string', description: 'Versión del motor' },
      instance_class: { type: 'string', required: true, description: 'Tamaño: db.t3.micro…' },
      allocated_storage: { type: 'number', required: true, description: 'Almacenamiento en GB' },
      db_name: { type: 'string', forceNew: true, description: 'Nombre de la base de datos inicial' },
      username: { type: 'string', forceNew: true, description: 'Usuario administrador' },
      password: { type: 'string', sensitive: true, description: 'Contraseña del administrador (se guarda en el estado)' },
      password_wo: { type: 'string', sensitive: true, writeOnly: true, description: 'Contraseña write-only: admite valores ephemeral y nunca se guarda en el estado' },
      password_wo_version: { type: 'number', description: 'Cámbialo para que Terraform vuelva a enviar password_wo' },
      publicly_accessible: { type: 'bool', default: false, description: 'Accesible desde Internet' },
      skip_final_snapshot: { type: 'bool', default: false, description: 'No crear snapshot al destruir' },
      vpc_security_group_ids: { type: 'list', description: 'Security groups' },
      tags: tags(),
    },
    computed: ['id', 'arn', 'endpoint', 'address', 'port'],
    validate: (a) =>
      typeof a.engine === 'string' && !['mysql', 'postgres', 'mariadb'].includes(a.engine)
        ? `InvalidParameterValue: motor "${a.engine}" no soportado (usa mysql, postgres o mariadb)`
        : null,
    generate: (a, ctx) => {
      const ident = (a.identifier as string) ?? `terraform-${hex(10)}`;
      const p = a.engine === 'postgres' ? 5432 : 3306;
      const address = `${ident}.c${hex(10)}.${ctx.region}.rds.amazonaws.com`;
      return { id: `db-${hex(20).toUpperCase()}`, identifier: ident, arn: arn(ctx, 'rds', `db:${ident}`), address, endpoint: `${address}:${p}`, port: p };
    },
  },
  {
    type: 'random_pet',
    provider: 'random',
    mode: 'managed',
    title: 'Nombre aleatorio',
    category: 'utility',
    description: 'Genera un nombre aleatorio y memorable, p.ej. "happy-otter".',
    args: {
      length: { type: 'number', default: 2, forceNew: true, description: 'Número de palabras' },
      separator: { type: 'string', default: '-', forceNew: true, description: 'Separador' },
      prefix: { type: 'string', forceNew: true, description: 'Prefijo' },
      keepers: { type: 'map', forceNew: true, description: 'Si cambian, se genera otro nombre' },
    },
    computed: ['id'],
    generate: (a) => {
      const n = Number(a.length ?? 2);
      const words = [...Array.from({ length: Math.max(0, n - 1) }, () => pick(PET_ADJ)), pick(PET_NOUN)];
      if (a.prefix) words.unshift(String(a.prefix));
      return { id: words.join(String(a.separator ?? '-')) };
    },
  },
  {
    type: 'random_id',
    provider: 'random',
    mode: 'managed',
    title: 'ID aleatorio',
    category: 'utility',
    description: 'Genera bytes aleatorios en distintos formatos (hex, base64…).',
    args: {
      byte_length: { type: 'number', required: true, forceNew: true, description: 'Número de bytes' },
      prefix: { type: 'string', forceNew: true, description: 'Prefijo' },
      keepers: { type: 'map', forceNew: true, description: 'Si cambian, se genera otro ID' },
    },
    computed: ['id', 'hex', 'dec', 'b64_url'],
    generate: (a) => {
      const h = hex(Number(a.byte_length) * 2);
      const b64 = btoa(h.match(/../g)!.map((x) => String.fromCharCode(parseInt(x, 16))).join(''))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      return { id: b64, hex: `${a.prefix ?? ''}${h}`, dec: String(parseInt(h.slice(0, 12), 16)), b64_url: b64 };
    },
  },
  {
    type: 'random_password',
    provider: 'random',
    mode: 'managed',
    title: 'Contraseña aleatoria',
    category: 'utility',
    description: 'Genera una contraseña segura (se guarda como valor sensible).',
    args: {
      length: { type: 'number', required: true, forceNew: true, description: 'Longitud' },
      special: { type: 'bool', default: true, forceNew: true, description: 'Incluir caracteres especiales' },
    },
    computed: ['id', 'result'],
    generate: (a) => {
      const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' + (a.special === false ? '' : '!#%&*-_=+');
      return { id: 'none', result: Array.from({ length: Number(a.length) }, () => pick([...chars])).join('') };
    },
  },
  {
    type: 'local_file',
    provider: 'local',
    mode: 'managed',
    title: 'Fichero local',
    category: 'utility',
    description: 'Crea un fichero en el disco de la máquina que ejecuta Terraform.',
    args: {
      filename: { type: 'string', required: true, forceNew: true, description: 'Ruta del fichero' },
      content: { type: 'string', forceNew: true, description: 'Contenido' },
      file_permission: { type: 'string', default: '0777', forceNew: true, description: 'Permisos' },
    },
    computed: ['id'],
    generate: (a) => ({ id: hashStr(String(a.content ?? '')) + hex(32) }),
  },
  // ---------------------------------------------------------- data sources
  {
    type: 'aws_ami',
    provider: 'aws',
    mode: 'data',
    title: 'AMI (consulta)',
    category: 'data',
    description: 'Busca una imagen de sistema operativo existente.',
    args: {
      most_recent: { type: 'bool', default: false, description: 'Usar la más reciente' },
      owners: { type: 'list', description: 'Propietarios de la imagen' },
      filter: {
        type: 'block',
        description: 'Filtro de búsqueda',
        block: {
          name: { type: 'string', required: true, description: 'Campo' },
          values: { type: 'list', required: true, description: 'Valores' },
        },
      },
    },
    computed: ['id', 'name', 'architecture', 'image_id'],
    generate: (a) => {
      const key = JSON.stringify(a.filter ?? '') + JSON.stringify(a.owners ?? '');
      const id = `ami-0${hashStr(key)}${hashStr(key + 'x')}`.slice(0, 21);
      const f = Array.isArray(a.filter) ? (a.filter[0] as ValueMap | undefined) : undefined;
      const name = Array.isArray(f?.values) ? String(f!.values[0]).replace(/\*/g, '20261101') : 'amzn2-ami-hvm-x86_64-gp2';
      return { id, image_id: id, name, architecture: 'x86_64' };
    },
  },
  {
    type: 'aws_availability_zones',
    provider: 'aws',
    mode: 'data',
    title: 'Zonas de disponibilidad (consulta)',
    category: 'data',
    description: 'Lista las zonas de disponibilidad de la región.',
    args: { state: { type: 'string', description: 'Filtrar por estado: available' } },
    computed: ['id', 'names', 'zone_ids'],
    generate: (_a, ctx) => ({
      id: ctx.region,
      names: ['a', 'b', 'c'].map((z) => `${ctx.region}${z}`),
      zone_ids: [1, 2, 3].map((z) => `use1-az${z}`),
    }),
  },
  {
    type: 'aws_caller_identity',
    provider: 'aws',
    mode: 'data',
    title: 'Identidad (consulta)',
    category: 'data',
    description: 'Devuelve la cuenta y el usuario con los que se ejecuta Terraform.',
    args: {},
    computed: ['id', 'account_id', 'arn', 'user_id'],
    generate: () => ({ id: ACCOUNT, account_id: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/terraform`, user_id: 'AIDA' + hex(16).toUpperCase() }),
  },
  {
    type: 'aws_region',
    provider: 'aws',
    mode: 'data',
    title: 'Región (consulta)',
    category: 'data',
    description: 'Devuelve la región configurada en el proveedor.',
    args: {},
    computed: ['id', 'name', 'description'],
    generate: (_a, ctx) => ({ id: ctx.region, name: ctx.region, description: 'Región de AWS' }),
  },
];

export const RESOURCE_SCHEMAS: Record<string, ResourceSchema> = {};
export const DATA_SCHEMAS: Record<string, ResourceSchema> = {};
for (const s of schemas) (s.mode === 'managed' ? RESOURCE_SCHEMAS : DATA_SCHEMAS)[s.type] = s;

export function getSchema(mode: 'managed' | 'data', type: string): ResourceSchema | undefined {
  return mode === 'managed' ? RESOURCE_SCHEMAS[type] : DATA_SCHEMAS[type];
}

/** Sugerencia "¿quisiste decir…?" usando distancia de edición. */
export function suggest(name: string, options: string[]): string | undefined {
  const dist = (a: string, b: string) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  };
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = dist(name, o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}
