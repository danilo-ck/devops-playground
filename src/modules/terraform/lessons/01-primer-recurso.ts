import { instancesOf, ran, resourcesInConfig, type TerraformLesson } from './types';

export const lesson01: TerraformLesson = {
  id: 'primer-recurso',
  title: 'Tu primer recurso',
  summary: 'Qué es la Infraestructura como Código, la anatomía de un bloque y el flujo init → plan → apply.',
  difficulty: 'Básico',
  duration: '10 min',
  concepts: ['IaC', 'resource', 'provider', 'init', 'plan', 'apply'],
  defaultView: 'infra',
  content: `## ¿Qué problema resuelve Terraform?

Crear infraestructura a mano, haciendo clic en la consola de AWS, funciona… hasta que tienes que repetirlo en otro entorno, recordar qué cambiaste hace un mes o deshacerlo sin romper nada.

**Terraform** te permite describir tu infraestructura en ficheros de texto (\`.tf\`). Ese código se versiona con Git, se revisa en un *pull request* y se reutiliza. A esto se le llama **Infraestructura como Código (IaC)**.

> [!ANALOGY]
> Tu código \`.tf\` es el **plano** de una casa. Terraform es el **constructor**: compara el plano con lo que ya está construido y solo hace las obras necesarias.

## Declarativo, no imperativo

No le dices a Terraform *"crea un bucket"*, sino *"quiero que exista un bucket"*. Si ya existe, no hace nada. Si lo quitas del código, lo elimina. Tú describes el **destino**; Terraform calcula el **camino**.

## Anatomía de un recurso

\`\`\`hcl
resource "aws_s3_bucket" "fotos" {
  bucket = "fotos-de-mi-equipo-2026"
}
\`\`\`

- \`resource\` → tipo de bloque: algo que Terraform crea y gestiona.
- \`"aws_s3_bucket"\` → **tipo de recurso**. El prefijo (\`aws\`) indica el **proveedor**.
- \`"fotos"\` → **nombre local**. Solo existe en tu código; sirve para referirte a él como \`aws_s3_bucket.fotos\`.
- \`bucket = "..."\` → **argumentos** que configuran el recurso.

El lenguaje se llama **HCL** (HashiCorp Configuration Language).

## El flujo básico

| Comando | Qué hace |
|---|---|
| \`terraform init\` | Descarga los **proveedores**: plugins que saben hablar con AWS, Azure, GCP… |
| \`terraform plan\` | Compara tu código con la realidad y **muestra** qué cambiaría. No toca nada. |
| \`terraform apply\` | Calcula el plan, pide confirmación y **ejecuta** los cambios. |

> [!TIP]
> Mira la pestaña **Infraestructura** mientras trabajas: tras el \`plan\` verás el bucket como borrador (borde discontinuo) y tras el \`apply\` aparecerá creado.`,
  files: {
    'main.tf': `# ──────────────────────────────────────────────
#  Lección 1 · Tu primer recurso
# ──────────────────────────────────────────────

# El bloque provider configura con qué nube hablamos
# y en qué región se crearán los recursos.
provider "aws" {
  region = "eu-west-1"
}

# 👇 Declara aquí un bucket S3. Plantilla:
#
# resource "TIPO" "NOMBRE" {
#   argumento = "valor"
# }
`,
  },
  objectives: [
    { id: 'declare', label: 'Declara un recurso `aws_s3_bucket` en main.tf', check: (c) => resourcesInConfig(c, 'aws_s3_bucket').length > 0 },
    { id: 'init', label: 'Inicializa el proyecto con `terraform init`', check: (c) => ran(c, 'init') },
    { id: 'plan', label: 'Previsualiza los cambios con `terraform plan`', check: (c) => ran(c, 'plan', (h) => (h.summary?.add ?? 0) > 0) || instancesOf(c, 'aws_s3_bucket').length > 0 },
    { id: 'apply', label: 'Crea el bucket de verdad con `terraform apply`', check: (c) => instancesOf(c, 'aws_s3_bucket').length > 0 },
  ],
  hints: [
    'Un bucket se declara así:\n\n```hcl\nresource "aws_s3_bucket" "fotos" {\n  bucket = "fotos-de-mi-equipo-2026"\n}\n```',
    'Los nombres de bucket solo admiten **minúsculas, números y guiones**, y son únicos en todo AWS: evita nombres genéricos como `test` o `bucket`.',
    'Tras `terraform apply` Terraform te pide confirmación: escribe `yes` (o pulsa el botón **yes · confirmar**).',
  ],
  solution: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

resource "aws_s3_bucket" "fotos" {
  bucket = "fotos-de-mi-equipo-2026"

  tags = {
    Proyecto = "devops-lab"
  }
}
`,
  },
};
