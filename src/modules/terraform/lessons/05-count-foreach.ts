import { instancesOf, type TerraformLesson } from './types';

export const lesson05: TerraformLesson = {
  id: 'count-foreach',
  title: 'Escalar con count y for_each',
  summary: 'Crea muchos recursos iguales (o casi) sin copiar y pegar, y entiende cuándo usar cada mecanismo.',
  difficulty: 'Intermedio',
  duration: '15 min',
  concepts: ['count', 'count.index', 'for_each', 'each.key', 'splat [*]'],
  defaultView: 'infra',
  content: `## count: N copias de un recurso

\`\`\`hcl
resource "aws_instance" "web" {
  count         = 3
  ami           = "ami-0a1b2c3d4e5f60001"
  instance_type = "t3.micro"

  tags = {
    Name = "web-\${count.index + 1}"   # count.index va de 0 a 2
  }
}
\`\`\`

Cada copia tiene su propia **dirección**: \`aws_instance.web[0]\`, \`aws_instance.web[1]\`…

## for_each: una copia por cada elemento

\`for_each\` recibe un **mapa** o un **set** de strings. Cada instancia se identifica por su **clave**, no por un número:

\`\`\`hcl
resource "aws_s3_bucket" "datos" {
  for_each = toset(["logs", "backups"])
  bucket   = "miapp-\${each.key}-2026"
}
\`\`\`

Direcciones: \`aws_s3_bucket.datos["logs"]\`, \`aws_s3_bucket.datos["backups"]\`. Con un mapa tienes además \`each.value\`.

> [!WARNING]
> \`for_each\` no acepta listas: usa \`toset([...])\` o un mapa. Si lo olvidas, Terraform te lo dirá.

## ¿Cuál uso?

| | \`count\` | \`for_each\` |
|---|---|---|
| Identificador | número (\`[0]\`) | clave (\`["logs"]\`) |
| Ideal para | N copias idénticas | elementos con identidad propia |
| Quitar uno del medio | ⚠️ reindexa y recrea los siguientes | solo borra ese |

## Splat: todos los valores a la vez

\`aws_instance.web[*].id\` devuelve la **lista** de los id de todas las copias. Muy útil en outputs.

> [!TIP]
> Prueba a bajar \`count\` de 3 a 2 y haz \`plan\`: verás qué instancia se destruye. Luego súbelo otra vez.`,
  files: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = { Name = "red-apps" }
}

resource "aws_subnet" "apps" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "eu-west-1a"
  tags = { Name = "apps" }
}

# ✏️ Convierte este servidor en 3 usando count
resource "aws_instance" "web" {
  ami           = "ami-0a1b2c3d4e5f60001"
  instance_type = "t3.micro"
  subnet_id     = aws_subnet.apps.id

  tags = {
    Name = "web"
  }
}

# 👇 Crea varios buckets con for_each
`,
    'outputs.tf': `# 👇 Crea un output con los IDs de todos los servidores
`,
  },
  objectives: [
    { id: 'count', label: 'Crea 3 servidores con `count = 3`', check: (c) => instancesOf(c, 'aws_instance').filter((i) => typeof i.indexKey === 'number').length >= 3 },
    {
      id: 'index',
      label: 'Dales nombres distintos con `count.index` (web-1, web-2, web-3)',
      check: (c) => {
        const names = instancesOf(c, 'aws_instance')
          .filter((i) => typeof i.indexKey === 'number')
          .map((i) => JSON.stringify((i.attributes.tags as Record<string, unknown> | null)?.Name ?? null));
        return names.length >= 3 && new Set(names).size === names.length;
      },
    },
    { id: 'foreach', label: 'Crea al menos 2 buckets con `for_each`', check: (c) => instancesOf(c, 'aws_s3_bucket').filter((i) => typeof i.indexKey === 'string').length >= 2 },
    {
      id: 'splat',
      label: 'Muestra todos los IDs de los servidores en un output con `[*]`',
      check: (c) => Object.values(c.state.outputs).some((o) => Array.isArray(o.value) && o.value.length >= 3 && o.value.every((v) => typeof v === 'string' && v.startsWith('i-'))),
    },
  ],
  hints: [
    'Añade `count = 3` dentro del recurso y cambia el nombre a `Name = "web-${count.index + 1}"`.',
    'Buckets con for_each:\n\n```hcl\nresource "aws_s3_bucket" "datos" {\n  for_each = toset(["logs", "backups"])\n  bucket   = "miapp-${each.key}-2026"\n}\n```',
    'En outputs.tf: `output "web_ids" { value = aws_instance.web[*].id }`',
  ],
  solution: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = { Name = "red-apps" }
}

resource "aws_subnet" "apps" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "eu-west-1a"
  tags = { Name = "apps" }
}

resource "aws_instance" "web" {
  count         = 3
  ami           = "ami-0a1b2c3d4e5f60001"
  instance_type = "t3.micro"
  subnet_id     = aws_subnet.apps.id

  tags = {
    Name = "web-\${count.index + 1}"
  }
}

resource "aws_s3_bucket" "datos" {
  for_each = toset(["logs", "backups"])
  bucket   = "miapp-\${each.key}-2026"
}
`,
    'outputs.tf': `output "web_ids" {
  value = aws_instance.web[*].id
}

output "buckets" {
  value = [for b in aws_s3_bucket.datos : b.bucket]
}
`,
  },
};
