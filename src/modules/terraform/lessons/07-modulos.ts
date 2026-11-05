import { satisfies } from '../engine';
import { instancesOf, ran, type TerraformLesson, type TfLessonContext } from './types';

const networkFiles = {
  'modules/network/variables.tf': `variable "name" {
  description = "Nombre de la red"
  type        = string
}

variable "cidr" {
  description = "Rango de IPs de la VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "azs" {
  description = "Zonas de disponibilidad (una subred por zona)"
  type        = list(string)
  default     = ["eu-west-1a", "eu-west-1b"]
}
`,
  'modules/network/main.tf': `resource "aws_vpc" "this" {
  cidr_block = var.cidr
  tags       = { Name = var.name }
}

resource "aws_subnet" "this" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.cidr, 8, count.index + 1)
  availability_zone = var.azs[count.index]
  tags              = { Name = "\${var.name}-\${var.azs[count.index]}" }
}
`,
};

const networkCall = (c: TfLessonContext) => Object.values(c.config.moduleCalls).find((m) => /^\.\/modules\/network\/?$/.test(m.source));
const bucketCall = (c: TfLessonContext) => Object.values(c.config.moduleCalls).find((m) => m.source === 'devopslab/s3-bucket/aws');

export const lesson07: TerraformLesson = {
  id: 'modulos',
  title: 'Módulos: reutiliza infraestructura',
  summary: 'Empaqueta recursos en módulos, pásales entradas, lee sus outputs y usa módulos del registro fijando su versión.',
  difficulty: 'Intermedio',
  duration: '20 min',
  concepts: ['module', 'source', 'version', 'ámbito', 'registro', 'init'],
  defaultView: 'graph',
  content: `## ¿Qué es un módulo?

Un **módulo** es una carpeta con ficheros \`.tf\`. De hecho, tu proyecto ya es uno: el **módulo raíz** (*root module*). Desde él puedes llamar a otros, los **módulos hijos**, para reutilizar infraestructura sin copiar y pegar.

> [!ANALOGY]
> Un módulo es como una **función**: las \`variable\` son sus **parámetros**, los \`output\` son sus **valores de retorno** y los recursos son su cuerpo, que desde fuera no se ve.

Estructura típica de un módulo:

\`\`\`
modules/network/
├── variables.tf   # entradas
├── main.tf        # recursos
└── outputs.tf     # salidas
\`\`\`

## Llamar a un módulo

\`\`\`hcl
module "network" {
  source = "./modules/network"   # de dónde sale el código

  name = "principal"             # entradas = variables del módulo
  cidr = "10.0.0.0/16"
}
\`\`\`

Y sus outputs se leen como \`module.<NOMBRE>.<OUTPUT>\`:

\`\`\`hcl
output "vpc_id" {
  value = module.network.vpc_id
}
\`\`\`

## El ámbito: cada módulo es una caja cerrada

- El módulo **no ve** las variables, locals ni recursos de quien lo llama: solo lo que le pasas como argumento.
- Quien lo llama **no ve** sus recursos: solo sus **outputs**. Escribir \`aws_vpc.this.id\` desde el raíz da error; hay que exponerlo con un output.
- Si una variable del módulo no tiene \`default\`, el argumento es **obligatorio**.

En el estado, los recursos de un módulo llevan su ruta delante: \`module.network.aws_vpc.this\`.

## De dónde salen los módulos (\`source\`)

| Origen | Ejemplo |
|---|---|
| Ruta local | \`./modules/network\` |
| Registro de Terraform | \`hashicorp/consul/aws\` (\`<namespace>/<nombre>/<proveedor>\`) |
| GitHub | \`github.com/org/repo\` |
| Git genérico | \`git::https://example.com/red.git?ref=v1.2.0\` |
| HTTP / S3 / GCS | \`s3::https://…/red.zip\` |

En este simulador puedes usar **rutas locales** y un **registro simulado** con módulos \`devopslab/…\` (mira *Docs → Módulos*).

## Versiones

Solo los módulos del **registro** admiten \`version\`. Fíjala siempre: si no, \`init\` descargará la última, que puede traer cambios incompatibles.

| Restricción | Acepta |
|---|---|
| \`"1.2.0"\` | exactamente 1.2.0 |
| \`"~> 1.2"\` | \`>= 1.2.0\` y \`< 2.0.0\` |
| \`"~> 1.2.0"\` | \`>= 1.2.0\` y \`< 1.3.0\` |
| \`">= 1.0, < 2.0"\` | rango explícito |

## terraform init instala los módulos

Al añadir un módulo, o cambiar su \`source\` o \`version\`, hay que volver a ejecutar \`terraform init\`: descarga los del registro en \`.terraform/modules\` y enlaza los locales. \`terraform init -upgrade\` busca la versión más nueva que cumpla la restricción.

> [!TIP]
> En la pestaña **Grafo** cada módulo aparece como una caja 📦. Pulsa *Expandir módulos* para ver por dentro sus variables, recursos y outputs.`,
  files: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

# 1️⃣ Llama al módulo local de red que hay en ./modules/network.
#    Pásale sus entradas obligatorias (mira modules/network/variables.tf).

# 2️⃣ Crea un bucket de logs con el módulo del registro "devopslab/s3-bucket/aws",
#    fijando la versión con version = "~> 1.0".
`,
    'outputs.tf': `# 3️⃣ Declara un output "vpc_id" con el id de la VPC que crea el módulo de red
`,
    ...networkFiles,
    'modules/network/outputs.tf': `output "subnet_ids" {
  description = "IDs de las subredes"
  value       = aws_subnet.this[*].id
}

# 👇 Expón también el id de la VPC para que el módulo raíz pueda usarlo
`,
  },
  objectives: [
    {
      id: 'local',
      label: 'Llama al módulo local `./modules/network` pasándole su entrada obligatoria `name`',
      check: (c) => !!networkCall(c)?.args.some((a) => a.name === 'name'),
    },
    {
      id: 'output',
      label: 'Expón `vpc_id` en `modules/network/outputs.tf` y úsalo en un output raíz con `module.<nombre>.vpc_id`',
      check: (c) => {
        const call = networkCall(c);
        if (!call || !c.config.children[call.name]?.outputs.vpc_id) return false;
        return Object.keys(c.config.outputs).some((o) => c.graph?.deps[`output.${o}`]?.includes(`${call.id}.output.vpc_id`));
      },
    },
    {
      id: 'registry',
      label: 'Usa el módulo del registro `devopslab/s3-bucket/aws` fijando la versión con `~> 1.0`',
      check: (c) => {
        const v = bucketCall(c)?.version;
        return !!v && satisfies('1.1.0', v) && !satisfies('2.0.0', v);
      },
    },
    {
      id: 'deploy',
      label: 'Despliega (init + apply) y mira las direcciones `module.…` con `terraform state list`',
      check: (c) =>
        instancesOf(c, 'aws_vpc').some((i) => !!i.module) && instancesOf(c, 'aws_s3_bucket').some((i) => !!i.module) && ran(c, 'state list'),
    },
  ],
  hints: [
    '```hcl\nmodule "network" {\n  source = "./modules/network"\n  name   = "principal"\n}\n```',
    'En `modules/network/outputs.tf`:\n\n```hcl\noutput "vpc_id" {\n  value = aws_vpc.this.id\n}\n```\n\nY en el `outputs.tf` raíz: `output "vpc_id" { value = module.network.vpc_id }`.',
    '```hcl\nmodule "logs" {\n  source      = "devopslab/s3-bucket/aws"\n  version     = "~> 1.0"\n  bucket_name = "logs-mi-equipo-2026"\n}\n```\n\nConsulta sus entradas en **Docs → Módulos**.',
    'Cada vez que añades un módulo hay que repetir `terraform init`. Si no, el plan falla con *Module not installed*.',
  ],
  solution: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

module "network" {
  source = "./modules/network"

  name = "principal"
  cidr = "10.0.0.0/16"
}

module "logs" {
  source  = "devopslab/s3-bucket/aws"
  version = "~> 1.0"

  bucket_name = "logs-mi-equipo-2026"
  tags        = { Red = "principal" }
}
`,
    'outputs.tf': `output "vpc_id" {
  value = module.network.vpc_id
}

output "subnet_ids" {
  value = module.network.subnet_ids
}

output "logs_bucket" {
  value = module.logs.bucket_name
}
`,
    ...networkFiles,
    'modules/network/outputs.tf': `output "subnet_ids" {
  description = "IDs de las subredes"
  value       = aws_subnet.this[*].id
}

output "vpc_id" {
  description = "ID de la VPC"
  value       = aws_vpc.this.id
}
`,
  },
};
