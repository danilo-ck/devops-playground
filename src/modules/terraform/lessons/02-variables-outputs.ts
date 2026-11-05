import { codeOnly, instancesOf, resourcesInConfig, type TerraformLesson } from './types';

export const lesson02: TerraformLesson = {
  id: 'variables-outputs',
  title: 'Variables y outputs',
  summary: 'Parametriza tu código con variables de entrada y expón datos útiles con outputs.',
  difficulty: 'Básico',
  duration: '12 min',
  concepts: ['variable', 'output', 'tfvars', 'interpolación'],
  defaultView: 'graph',
  content: `## Variables: los parámetros de tu infraestructura

Escribir valores fijos (*hardcodeados*) en el código impide reutilizarlo. Si quieres el mismo bucket en **dev** y en **prod**, no copies el fichero: usa **variables de entrada**.

\`\`\`hcl
variable "environment" {
  description = "Entorno: dev, staging o prod"
  type        = string
  default     = "dev"
}
\`\`\`

Y se usan con el prefijo \`var.\`:

\`\`\`hcl
resource "aws_s3_bucket" "fotos" {
  bucket = "fotos-equipo-\${var.environment}"
}
\`\`\`

> [!INFO]
> \`"\${...}"\` es **interpolación**: inserta el valor de una expresión dentro de un texto.

## ¿De dónde sale el valor?

De menor a mayor prioridad:

| Origen | Ejemplo |
|---|---|
| \`default\` en el bloque variable | \`default = "dev"\` |
| Fichero \`terraform.tfvars\` | \`environment = "prod"\` |
| Línea de comandos | \`terraform plan -var="environment=prod"\` |

Si una variable no tiene \`default\` y nadie le da valor, Terraform se queja: es **obligatoria**.

## Outputs: los valores de retorno

Un **output** expone un dato de tu infraestructura (una IP, un ARN, una URL) para que lo veas al terminar el \`apply\`, lo consultes con \`terraform output\` o lo use otro sistema.

\`\`\`hcl
output "bucket_arn" {
  value = aws_s3_bucket.fotos.arn
}
\`\`\`

> [!TIP]
> Abre la pestaña **Grafo**: verás cómo la variable "alimenta" al bucket y el bucket al output. Terraform usa ese grafo para saber en qué orden hacer las cosas.

> [!WARNING]
> Cambiar el nombre de un bucket (\`bucket\`) obliga a **destruirlo y crearlo de nuevo** (\`-/+\`). Fíjate en el plan si ya lo habías creado con otro nombre.`,
  files: {
    'main.tf': `provider "aws" {
  region = var.region
}

resource "aws_s3_bucket" "fotos" {
  # ✏️ Haz que el nombre dependa del entorno: "fotos-equipo-<entorno>"
  bucket = "fotos-equipo-dev"

  tags = {
    Entorno = "dev"
  }
}
`,
    'variables.tf': `variable "region" {
  description = "Región de AWS donde desplegar"
  type        = string
  default     = "eu-west-1"
}

# 👇 Declara aquí la variable "environment"
`,
    'outputs.tf': `# 👇 Declara aquí un output con el ARN del bucket
`,
    'terraform.tfvars': `# Aquí se asignan valores a las variables, uno por línea:
# nombre = "valor"
`,
  },
  objectives: [
    { id: 'var', label: 'Declara la variable `environment` en variables.tf', check: (c) => !!c.config.variables.environment },
    {
      id: 'use',
      label: 'Usa `var.environment` en el bucket (nombre y etiquetas)',
      check: (c) => resourcesInConfig(c, 'aws_s3_bucket').some((r) => c.graph?.deps[r.addr]?.includes('var.environment')),
    },
    {
      id: 'output',
      label: 'Crea un output que muestre el ARN del bucket',
      check: (c) => Object.keys(c.config.outputs).some((o) => c.graph?.deps[`output.${o}`]?.some((d) => d.startsWith('aws_s3_bucket.'))) && /\.arn\b/.test(codeOnly(c)),
    },
    {
      id: 'prod',
      label: 'Asigna `environment = "prod"` en terraform.tfvars y despliega con apply',
      check: (c) =>
        /^\s*environment\s*=\s*"prod"/m.test(c.files['terraform.tfvars'] ?? '') &&
        instancesOf(c, 'aws_s3_bucket').some((b) => String(b.attributes.bucket).includes('prod')) &&
        Object.values(c.state.outputs).some((o) => typeof o.value === 'string' && o.value.startsWith('arn:aws:s3')),
    },
  ],
  hints: [
    'La variable se declara así:\n\n```hcl\nvariable "environment" {\n  type    = string\n  default = "dev"\n}\n```',
    'Para usarla dentro de un texto: `bucket = "fotos-equipo-${var.environment}"`, y en las etiquetas: `Entorno = var.environment`.',
    'El output: `output "bucket_arn" { value = aws_s3_bucket.fotos.arn }`',
    'En `terraform.tfvars` escribe una línea `environment = "prod"`. Luego `terraform apply`: verás que el bucket se **reemplaza** porque cambia su nombre.',
  ],
  solution: {
    'main.tf': `provider "aws" {
  region = var.region
}

resource "aws_s3_bucket" "fotos" {
  bucket = "fotos-equipo-\${var.environment}"

  tags = {
    Entorno = var.environment
  }
}
`,
    'variables.tf': `variable "region" {
  description = "Región de AWS donde desplegar"
  type        = string
  default     = "eu-west-1"
}

variable "environment" {
  description = "Entorno: dev, staging o prod"
  type        = string
  default     = "dev"
}
`,
    'outputs.tf': `output "bucket_arn" {
  description = "ARN del bucket de fotos"
  value       = aws_s3_bucket.fotos.arn
}
`,
    'terraform.tfvars': `environment = "prod"
`,
  },
};
