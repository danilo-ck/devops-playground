import { codeOnly, ran, type TerraformLesson, type TfLessonContext } from './types';

const vpc = (name: string) => `provider "aws" {
  region = "eu-west-1"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = ${name} }
}
`;

const backend = `terraform {
  backend "s3" {
    bucket       = "tienda-tfstate"
    key          = "red/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}
`;

const s3Key = (c: TfLessonContext) => c.initialized.find((x) => x.startsWith('backend:s3:'))?.slice('backend:'.length);
const devState = (c: TfLessonContext) => (c.workspace === 'dev' ? c.state : c.stateStore?.[`${s3Key(c)}|dev`]);

export const lesson15: TerraformLesson = {
  id: 'backends',
  title: 'Backends, bloqueo y workspaces',
  summary: 'Lleva el estado a un backend remoto, migra el que tienes, trabaja en equipo con bloqueo y separa entornos con workspaces.',
  difficulty: 'Avanzado',
  duration: '25 min',
  concepts: ['backend', 'init -migrate-state', '-reconfigure', 'state locking', 'force-unlock', 'workspace', 'terraform.workspace'],
  defaultView: 'state',
  setup: { 'main.tf': vpc('"red-principal"') },
  content: `## El backend: dónde vive el estado

Por defecto el estado es un fichero en tu disco (**backend local**). En equipo eso no funciona: tus compañeros no lo ven, se pierde con el portátil y nadie impide que dos personas hagan apply a la vez. La solución es un **backend remoto**:

\`\`\`hcl
terraform {
  backend "s3" {
    bucket       = "tienda-tfstate"
    key          = "red/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true    # bloqueo nativo en S3 (antes: tabla DynamoDB)
  }
}
\`\`\`

Otros: \`azurerm\`, \`gcs\`, \`consul\`, \`pg\`, \`http\`, \`kubernetes\`… y **HCP Terraform** (bloque \`cloud\`).

- El bloque backend **no admite variables**: se lee en \`init\`, antes de evaluar nada. Para no escribir valores en el código: \`terraform init -backend-config=fichero\`.
- Al cambiar de backend hay que repetir \`terraform init\`. Si ya hay estado:
  - \`-migrate-state\` **copia** el estado al nuevo backend.
  - \`-reconfigure\` cambia de backend **sin copiar**: empiezas con el estado vacío (¡y Terraform querrá crearlo todo otra vez!).

## Bloqueo del estado (state locking)

Mientras alguien hace \`plan\`/\`apply\`, el backend **bloquea** el estado. Si otro lo intenta, recibe \`Error acquiring the state lock\` con quién lo tiene.

| Situación | Qué hacer |
|---|---|
| Un compañero está aplicando | Esperar: \`-lock-timeout=5m\` reintenta durante ese tiempo |
| El bloqueo se quedó huérfano (se colgó un apply) | \`terraform force-unlock <ID>\`, solo si estás seguro |
| \`-lock=false\` | Saltarse el bloqueo: **casi nunca** es buena idea |

## Workspaces de la CLI

Un mismo código puede tener **varios estados** independientes: los workspaces. Siempre existe \`default\`.

\`\`\`bash
terraform workspace new dev        # crea y cambia (estado vacío)
terraform workspace list           # * marca el actual
terraform workspace select default
terraform workspace delete dev     # solo si está vacío (o -force)
\`\`\`

En el código, \`terraform.workspace\` da el nombre del actual: \`Name = "red-\${terraform.workspace}"\`.

> [!WARNING]
> Los workspaces comparten código y backend: sirven para copias parecidas (pruebas, ramas). Para entornos muy distintos (prod con otra cuenta, otros permisos) suele ser mejor separar carpetas o usar workspaces de HCP Terraform.

## Simula el trabajo en equipo

\`team apply\` hace que una compañera lance un apply (bloquea el estado un minuto). \`team crash\` deja un bloqueo huérfano.`,
  files: {
    'main.tf': `# 1️⃣ Guarda el estado en S3: descomenta el backend y ejecuta terraform init -migrate-state
# terraform {
#   backend "s3" {
#     bucket       = "tienda-tfstate"
#     key          = "red/terraform.tfstate"
#     region       = "eu-west-1"
#     encrypt      = true
#     use_lockfile = true
#   }
# }

${vpc('"red-principal"')}`,
  },
  objectives: [
    {
      id: 'backend',
      label: 'Configura el backend `s3` y migra el estado existente con `terraform init -migrate-state`',
      check: (c) => !!s3Key(c) && (Object.keys(c.state.resources).length > 0 || Object.values(c.stateStore ?? {}).some((s) => Object.keys(s.resources).length > 0)),
    },
    {
      id: 'locked',
      label: 'Simula un apply colgado con `team crash` y comprueba que `terraform plan` encuentra el estado bloqueado',
      check: (c) => {
        const i = c.history.findIndex((h) => h.command === 'team crash' && h.ok);
        return i >= 0 && c.history.slice(i + 1).some((h) => h.command === 'plan' && !h.ok);
      },
    },
    {
      id: 'unlock',
      label: 'Libera el bloqueo huérfano con `terraform force-unlock <ID>`',
      check: (c) => ran(c, 'force-unlock') && !c.lock,
    },
    {
      id: 'workspace',
      label: 'Usa `terraform.workspace` en el nombre de la VPC, crea el workspace `dev` y despliega allí',
      check: (c) => /terraform\.workspace/.test(codeOnly(c)) && !!devState(c)?.resources['aws_vpc.main'],
    },
    {
      id: 'back',
      label: 'Vuelve a `default` con `terraform workspace select default` (cada workspace conserva su estado)',
      check: (c) => (c.workspace ?? 'default') === 'default' && ran(c, 'workspace select') && !!devState(c),
    },
  ],
  hints: [
    'Al descomentar el backend, `terraform plan` pedirá `init`. Un `init` normal te pedirá elegir: `-migrate-state` (copiar) o `-reconfigure` (empezar de cero). Quieres copiar.',
    '`team crash` y después `terraform plan`. Copia el `ID:` del error.',
    '`terraform force-unlock <ID>` y responde `yes`.',
    'Cambia el tag a `Name = "red-${terraform.workspace}"`, luego `terraform workspace new dev` y `terraform apply`.',
  ],
  solution: {
    'main.tf': `${backend}
${vpc('"red-${terraform.workspace}"')}`,
  },
};
