import { codeOnly, instancesOf, ran, type TerraformLesson } from './types';

export const lesson06: TerraformLesson = {
  id: 'locals-funciones',
  title: 'Locals, funciones y expresiones',
  summary: 'Elimina repeticiones con locals, transforma datos con funciones y toma decisiones con condicionales.',
  difficulty: 'Intermedio',
  duration: '15 min',
  concepts: ['locals', 'merge', 'cidrsubnet', 'condicional', 'terraform console'],
  defaultView: 'graph',
  content: `## locals: valores con nombre

Un **local** es como una variable interna: un valor calculado una vez y reutilizado en todo el código. A diferencia de las \`variable\`, no se pueden pasar desde fuera.

\`\`\`hcl
locals {
  name_prefix = "\${var.project}-\${var.environment}"
  common_tags = {
    Proyecto = var.project
    Entorno  = var.environment
    Gestion  = "terraform"
  }
}
\`\`\`

Se usan con \`local.\` (en singular): \`local.common_tags\`.

## Funciones

Terraform trae muchas funciones integradas. Algunas muy útiles:

| Función | Ejemplo | Resultado |
|---|---|---|
| \`merge\` | \`merge({a=1}, {b=2})\` | \`{a=1, b=2}\` |
| \`format\` | \`format("web-%02d", 3)\` | \`"web-03"\` |
| \`upper\` | \`upper("dev")\` | \`"DEV"\` |
| \`cidrsubnet\` | \`cidrsubnet("10.0.0.0/16", 8, 2)\` | \`"10.0.2.0/24"\` |
| \`length\` | \`length(["a","b"])\` | \`2\` |
| \`lookup\` | \`lookup(var.sizes, "prod", "t3.micro")\` | valor del mapa |

Tienes la lista completa en la pestaña **Docs → Funciones**.

## Condicionales

\`\`\`hcl
instance_type = var.environment == "prod" ? "t3.large" : "t3.micro"
\`\`\`

## terraform console

Ejecuta \`terraform console\` en la terminal y prueba expresiones al vuelo: \`local.common_tags\`, \`upper(var.project)\`, \`cidrsubnet("10.0.0.0/16", 8, 5)\`… Escribe \`exit\` para salir.

> [!TIP]
> Mira el **Grafo**: los locals aparecen como nodos intermedios entre las variables y los recursos.`,
  files: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

variable "project" {
  default = "tienda"
}

variable "environment" {
  default = "dev"
}

# 😩 Mucha repetición: las mismas etiquetas en cada recurso...

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = {
    Proyecto = "tienda"
    Entorno  = "dev"
    Gestion  = "terraform"
    Name     = "tienda-dev-vpc"
  }
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
  tags = {
    Proyecto = "tienda"
    Entorno  = "dev"
    Gestion  = "terraform"
    Name     = "tienda-dev-app"
  }
}

resource "aws_instance" "app" {
  ami           = "ami-0a1b2c3d4e5f60001"
  instance_type = "t3.micro"
  subnet_id     = aws_subnet.app.id
  tags = {
    Proyecto = "tienda"
    Entorno  = "dev"
    Gestion  = "terraform"
    Name     = "tienda-dev-app"
  }
}
`,
  },
  objectives: [
    { id: 'locals', label: 'Define un bloque `locals` con `common_tags`', check: (c) => !!c.config.locals.common_tags },
    {
      id: 'merge',
      label: 'Usa `merge(local.common_tags, { Name = ... })` en los recursos',
      check: (c) => /merge\s*\(/.test(codeOnly(c)) && Object.values(c.config.resources).some((r) => c.graph?.deps[r.addr]?.includes('local.common_tags')),
    },
    { id: 'console', label: 'Prueba una expresión en `terraform console`', check: (c) => ran(c, 'console-eval') },
    {
      id: 'cond',
      label: 'Haz que `instance_type` dependa del entorno con un condicional `? :` y aplica',
      check: (c) => /instance_type\s*=.*\?.*:/.test(codeOnly(c)) && instancesOf(c, 'aws_instance').length > 0 && ran(c, 'apply'),
    },
  ],
  hints: [
    '```hcl\nlocals {\n  name_prefix = "${var.project}-${var.environment}"\n  common_tags = {\n    Proyecto = var.project\n    Entorno  = var.environment\n    Gestion  = "terraform"\n  }\n}\n```',
    'En cada recurso: `tags = merge(local.common_tags, { Name = "${local.name_prefix}-vpc" })`',
    'En la terminal: `terraform console`, luego prueba `cidrsubnet("10.0.0.0/16", 8, 2)` y `exit`.',
    '`instance_type = var.environment == "prod" ? "t3.large" : "t3.micro"`. Después prueba `terraform plan -var="environment=prod"`.',
  ],
  solution: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

variable "project" {
  default = "tienda"
}

variable "environment" {
  default = "dev"
}

locals {
  name_prefix = "\${var.project}-\${var.environment}"
  common_tags = {
    Proyecto = var.project
    Entorno  = var.environment
    Gestion  = "terraform"
  }
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = merge(local.common_tags, { Name = "\${local.name_prefix}-vpc" })
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.main.id
  cidr_block = cidrsubnet(aws_vpc.main.cidr_block, 8, 1)
  tags       = merge(local.common_tags, { Name = "\${local.name_prefix}-app" })
}

resource "aws_instance" "app" {
  ami           = "ami-0a1b2c3d4e5f60001"
  instance_type = var.environment == "prod" ? "t3.large" : "t3.micro"
  subnet_id     = aws_subnet.app.id
  tags          = merge(local.common_tags, { Name = "\${local.name_prefix}-app" })
}
`,
  },
};
