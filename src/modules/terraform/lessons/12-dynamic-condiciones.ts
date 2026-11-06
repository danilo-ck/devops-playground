import { codeOnly, instancesOf, ran, resourcesInConfig, type TerraformLesson } from './types';

const head = `provider "aws" {
  region = "eu-west-1"
}

variable "ports" {
  description = "Puertos abiertos a internet"
  type        = list(number)
  default     = [80, 443, 8080]
}

variable "instance_type" {
  type    = string
  default = "t3.micro"
}
`;

const repetitive = `resource "aws_security_group" "web" {
  name = "web"

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "web" {
  ami                    = "ami-0abc1234"
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.web.id]
}
`;

export const lesson12: TerraformLesson = {
  id: 'dynamic-condiciones',
  title: 'Bloques dynamic y condiciones',
  summary: 'Genera bloques anidados con dynamic y protege tu infraestructura con validation, precondition, postcondition y check.',
  difficulty: 'Avanzado',
  duration: '20 min',
  concepts: ['dynamic', 'validation', 'precondition', 'postcondition', 'self', 'check'],
  defaultView: 'infra',
  content: `## dynamic: bloques anidados a partir de una colección

Algunos recursos tienen **bloques anidados** repetibles (\`ingress\` en un security group, \`route\` en una tabla de rutas…). \`count\` y \`for_each\` repiten **recursos enteros**; para repetir **bloques dentro** de un recurso se usa \`dynamic\`:

\`\`\`hcl
dynamic "ingress" {               # tipo de bloque que se genera
  for_each = var.ports            # lista, set o mapa
  content {                       # el cuerpo de cada bloque
    from_port = ingress.value     # el iterador se llama como el bloque…
    to_port   = ingress.value
    protocol  = "tcp"
  }
}
\`\`\`

- \`ingress.key\` es el índice (o la clave del mapa) e \`ingress.value\` el elemento.
- Con \`iterator = puerto\` puedes renombrar el iterador (\`puerto.value\`).

> [!WARNING]
> No abuses de \`dynamic\`: si el bloque es fijo, escribirlo tal cual se lee mejor. Úsalo cuando la lista viene de una variable.

## Condiciones personalizadas

| Dónde | Bloque | Cuándo se evalúa | Si falla |
|---|---|---|---|
| \`variable\` | \`validation\` | Al leer la variable | ❌ Error |
| \`lifecycle\` de un recurso/data | \`precondition\` | **Antes** de crear/modificar | ❌ Error |
| \`lifecycle\` de un recurso/data | \`postcondition\` | **Después**, con \`self\` | ❌ Error |
| \`output\` | \`precondition\` | Antes de exponer el valor | ❌ Error |
| \`check "nombre"\` | \`assert\` | Al final de plan y apply | ⚠️ Solo **aviso** |

\`\`\`hcl
resource "aws_instance" "web" {
  # …
  lifecycle {
    precondition {
      condition     = startswith(var.instance_type, "t3.")
      error_message = "Solo se permiten instancias de la familia t3."
    }
    postcondition {
      condition     = self.public_ip != null      # self = el propio recurso
      error_message = "La instancia necesita una IP pública."
    }
  }
}

check "sin_ssh_abierto" {
  assert {
    condition     = !contains(var.ports, 22)
    error_message = "Hay SSH abierto a internet."
  }
}
\`\`\`

> [!TIP]
> Si la condición depende de algo que solo se conoce tras el apply (como una IP), Terraform la comprueba en el apply. Los \`check\` sirven para vigilar la salud de la infraestructura sin bloquear a nadie.`,
  files: {
    'main.tf': `${head}
# 1️⃣ Sustituye los tres bloques ingress por un único dynamic "ingress" que recorra var.ports
# 2️⃣ Añade a la instancia un lifecycle con precondition (solo tipos "t3.") y postcondition (self.public_ip != null)
# 3️⃣ Añade un check que avise si var.ports contiene el 22

${repetitive}`,
  },
  objectives: [
    {
      id: 'dynamic',
      label: 'Sustituye los `ingress` repetidos por un `dynamic "ingress"` que recorra `var.ports`, y despliega',
      check: (c) => /dynamic\s+"ingress"/.test(codeOnly(c)) && instancesOf(c, 'aws_security_group').some((s) => Array.isArray(s.attributes.ingress) && s.attributes.ingress.length >= 3),
    },
    {
      id: 'pre',
      label: 'Añade a la instancia una `precondition` que solo permita tipos `t3.`',
      check: (c) => resourcesInConfig(c, 'aws_instance').some((r) => r.preconditions.length > 0),
    },
    {
      id: 'blocked',
      label: 'Comprueba que bloquea: `terraform plan -var="instance_type=m5.large"` debe fallar',
      check: (c) => c.history.some((h) => h.command === 'plan' && !h.ok && !!h.args?.some((a) => a.includes('instance_type=m5'))),
    },
    {
      id: 'post',
      label: 'Añade una `postcondition` que use `self` (la instancia debe tener IP pública)',
      check: (c) => resourcesInConfig(c, 'aws_instance').some((r) => r.postconditions.length > 0) && /self\./.test(codeOnly(c)),
    },
    {
      id: 'check',
      label: 'Añade un bloque `check` que avise si `var.ports` contiene el 22 y aplica (prueba a añadir el 22: avisa, pero no bloquea)',
      check: (c) => c.config.checks.length > 0 && ran(c, 'apply') && instancesOf(c, 'aws_instance').length > 0,
    },
  ],
  hints: [
    '```hcl\ndynamic "ingress" {\n  for_each = var.ports\n  content {\n    from_port   = ingress.value\n    to_port     = ingress.value\n    protocol    = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n```',
    '```hcl\nlifecycle {\n  precondition {\n    condition     = startswith(var.instance_type, "t3.")\n    error_message = "Solo instancias t3."\n  }\n}\n```',
    'La instancia no tiene subred, así que AWS le da IP pública: la postcondition `self.public_ip != null` se cumple en el apply.',
    '```hcl\ncheck "sin_ssh_abierto" {\n  assert {\n    condition     = !contains(var.ports, 22)\n    error_message = "Hay SSH abierto a internet."\n  }\n}\n```',
  ],
  solution: {
    'main.tf': `${head}
resource "aws_security_group" "web" {
  name = "web"

  dynamic "ingress" {
    for_each = var.ports
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}

resource "aws_instance" "web" {
  ami                    = "ami-0abc1234"
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.web.id]

  lifecycle {
    precondition {
      condition     = startswith(var.instance_type, "t3.")
      error_message = "Solo se permiten instancias de la familia t3."
    }
    postcondition {
      condition     = self.public_ip != null
      error_message = "La instancia necesita una IP pública."
    }
  }
}

check "sin_ssh_abierto" {
  assert {
    condition     = !contains(var.ports, 22)
    error_message = "Hay SSH (22) abierto a internet."
  }
}
`,
  },
};
