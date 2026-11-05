/**
 * Registro de módulos simulado (equivalente a registry.terraform.io).
 *
 * Los módulos usan el espacio de nombres ficticio "devopslab" para no
 * confundirlos con módulos reales del registro público.
 */

export interface RegistryModule {
  source: string;
  description: string;
  versions: Record<string, Record<string, string>>;
}

// ------------------------------------------------------------ versiones semánticas

export const parseVersion = (v: string): number[] => {
  const p = v.replace(/^v/, '').split('.').map((x) => Number(x));
  while (p.length < 3) p.push(0);
  return p;
};

export const compareVersions = (a: string, b: string): number => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const CONSTRAINT_RE = /^(=|!=|>=|<=|>|<|~>)?\s*v?(\d+(?:\.\d+){0,2})$/;

export function isValidConstraint(constraint: string): boolean {
  return constraint
    .split(',')
    .map((c) => c.trim())
    .every((c) => CONSTRAINT_RE.test(c));
}

/** ¿Cumple `version` la restricción (p.ej. "~> 1.2, != 1.2.3")? */
export function satisfies(version: string, constraint: string): boolean {
  return constraint
    .split(',')
    .map((c) => c.trim())
    .every((c) => {
      const m = CONSTRAINT_RE.exec(c);
      if (!m) return false;
      const op = m[1] ?? '=';
      const target = m[2];
      const cmp = compareVersions(version, target);
      switch (op) {
        case '=':
          return cmp === 0;
        case '!=':
          return cmp !== 0;
        case '>':
          return cmp > 0;
        case '>=':
          return cmp >= 0;
        case '<':
          return cmp < 0;
        case '<=':
          return cmp <= 0;
        case '~>': {
          // ~> 1.2 → >= 1.2.0, < 2.0.0   ·   ~> 1.2.3 → >= 1.2.3, < 1.3.0
          const parts = target.split('.').length;
          const t = parseVersion(target);
          const upper = parts >= 3 ? [t[0], t[1] + 1, 0] : parts === 2 ? [t[0] + 1, 0, 0] : [t[0] + 1, 0, 0];
          return cmp >= 0 && compareVersions(version, upper.join('.')) < 0;
        }
      }
      return false;
    });
}

/** La versión más alta que cumple la restricción (o la última si no hay restricción). */
export function resolveVersion(versions: string[], constraint?: string): string | undefined {
  return [...versions].sort(compareVersions).reverse().find((v) => !constraint || satisfies(v, constraint));
}

// ------------------------------------------------------------ módulos

const vpcVariables = (cidrName: 'cidr' | 'cidr_block') => `variable "name" {
  description = "Nombre de la red (se usa en las etiquetas Name)"
  type        = string
}

variable "${cidrName}" {
  description = "Rango de IPs de la VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "azs" {
  description = "Zonas de disponibilidad de las subredes"
  type        = list(string)
  default     = []
}

variable "public_subnets" {
  description = "CIDR de las subredes públicas"
  type        = list(string)
  default     = []
}

variable "private_subnets" {
  description = "CIDR de las subredes privadas"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Etiquetas comunes para todos los recursos"
  type        = map(string)
  default     = {}
}
`;

const vpcMain = (cidrName: 'cidr' | 'cidr_block') => `resource "aws_vpc" "this" {
  cidr_block           = var.${cidrName}
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  count  = length(var.public_subnets) > 0 ? 1 : 0
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "\${var.name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = length(var.public_subnets)
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnets[count.index]
  availability_zone       = length(var.azs) > 0 ? element(var.azs, count.index) : null
  map_public_ip_on_launch = true
  tags                    = merge(var.tags, { Name = "\${var.name}-public-\${count.index + 1}" })
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnets)
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnets[count.index]
  availability_zone = length(var.azs) > 0 ? element(var.azs, count.index) : null
  tags              = merge(var.tags, { Name = "\${var.name}-private-\${count.index + 1}" })
}

resource "aws_route_table" "public" {
  count  = length(var.public_subnets) > 0 ? 1 : 0
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this[0].id
  }

  tags = merge(var.tags, { Name = "\${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  count          = length(var.public_subnets)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}
`;

const vpcOutputs = `output "vpc_id" {
  description = "ID de la VPC"
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "Rango de IPs de la VPC"
  value       = aws_vpc.this.cidr_block
}

output "public_subnets" {
  description = "IDs de las subredes públicas"
  value       = aws_subnet.public[*].id
}

output "private_subnets" {
  description = "IDs de las subredes privadas"
  value       = aws_subnet.private[*].id
}
`;

const bucketModule = (withForceDestroy: boolean) => ({
  'variables.tf': `variable "bucket_name" {
  description = "Nombre global y único del bucket"
  type        = string
}

variable "tags" {
  description = "Etiquetas del bucket"
  type        = map(string)
  default     = {}
}
${
  withForceDestroy
    ? `
variable "force_destroy" {
  description = "Permite borrar el bucket aunque tenga objetos"
  type        = bool
  default     = false
}
`
    : ''
}`,
  'main.tf': `resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
  tags   = var.tags${withForceDestroy ? '\n\n  force_destroy = var.force_destroy' : ''}
}
`,
  'outputs.tf': `output "bucket_name" {
  description = "Nombre del bucket"
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "ARN del bucket"
  value       = aws_s3_bucket.this.arn
}
`,
});

export const REGISTRY: Record<string, RegistryModule> = {
  'devopslab/vpc/aws': {
    source: 'devopslab/vpc/aws',
    description: 'Red completa: VPC, subredes públicas y privadas, Internet Gateway y rutas. La 2.0.0 renombra la entrada "cidr" a "cidr_block" (cambio incompatible).',
    versions: {
      '1.0.0': { 'variables.tf': vpcVariables('cidr'), 'main.tf': vpcMain('cidr'), 'outputs.tf': vpcOutputs.replace(/\noutput "private_subnets"[\s\S]*$/, '\n') },
      '1.2.0': { 'variables.tf': vpcVariables('cidr'), 'main.tf': vpcMain('cidr'), 'outputs.tf': vpcOutputs },
      '2.0.0': { 'variables.tf': vpcVariables('cidr_block'), 'main.tf': vpcMain('cidr_block'), 'outputs.tf': vpcOutputs },
    },
  },
  'devopslab/s3-bucket/aws': {
    source: 'devopslab/s3-bucket/aws',
    description: 'Bucket S3 con etiquetas. La 1.1.0 añade la entrada opcional "force_destroy".',
    versions: {
      '1.0.0': bucketModule(false),
      '1.1.0': bucketModule(true),
    },
  },
};

export const isRegistrySource = (s: string) => /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*\/[a-z0-9]+$/i.test(s);
export const isLocalSource = (s: string) => s.startsWith('./') || s.startsWith('../');

/** Une y normaliza rutas relativas: joinPath("modules/app", "../network") = "modules/network". */
export function joinPath(dir: string, rel: string): string | null {
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
