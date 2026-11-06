import { instancesOf, type TerraformLesson } from './types';

const app = (type: string, tags: string) => `provider "aws" {
  region = "eu-west-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0abc1234"
  instance_type = "${type}"
  tags          = ${tags}
}
`;

const cloud = `terraform {
  cloud {
    organization = "devopslab"

    workspaces {
      name = "tienda-prod"
    }
  }
}
`;

export const lesson16: TerraformLesson = {
  id: 'hcp-terraform',
  title: 'HCP Terraform: equipo, ejecuciones remotas y políticas',
  summary: 'Conecta tu proyecto a HCP Terraform, ejecuta plan y apply en remoto y cumple las políticas de la organización (Sentinel/OPA).',
  difficulty: 'Avanzado',
  duration: '25 min',
  concepts: ['HCP Terraform', 'terraform login', 'cloud', 'workspaces', 'projects', 'Sentinel', 'OPA', 'VCS', 'variable sets'],
  defaultView: 'plan',
  content: `## ¿Qué es HCP Terraform?

**HCP Terraform** (antes *Terraform Cloud*; su versión autoalojada es **Terraform Enterprise**) es la plataforma de HashiCorp para usar Terraform en equipo:

- **Estado remoto** cifrado, versionado y con bloqueo, sin montar nada.
- **Ejecuciones remotas**: \`plan\` y \`apply\` corren en agentes de HCP, no en tu portátil. Las credenciales de la nube viven allí.
- **Colaboración y gobierno**: permisos por equipos, aprobación de applies, políticas, estimación de costes, registro privado de módulos…

## Organización, projects y workspaces

| Concepto | Qué es |
|---|---|
| **Organización** | Tu empresa: equipos, facturación, políticas |
| **Project** | Agrupa workspaces (p.ej. por producto) y sus permisos |
| **Workspace** | Un estado + sus variables + su historial de ejecuciones. Suele ser "componente × entorno": \`red-prod\`, \`red-dev\` |

> [!WARNING]
> Un workspace de HCP Terraform **no es** lo mismo que un workspace de la CLI: aquí cada uno tiene sus variables, permisos y ejecuciones.

## Formas de lanzar ejecuciones

| Flujo | Cómo |
|---|---|
| **CLI** | Desde tu terminal con el bloque \`cloud\`: el código se sube y se ejecuta en remoto |
| **VCS** | El workspace se conecta a un repositorio: cada PR genera un *speculative plan* y cada merge un apply |
| **API** | Desde CI/CD u otras herramientas |

## Conectar el proyecto

\`\`\`bash
terraform login        # guarda un token de usuario (en CI: variable TF_TOKEN_app_terraform_io)
\`\`\`

\`\`\`hcl
terraform {
  cloud {
    organization = "devopslab"
    workspaces {
      name = "tienda-prod"       # o tags = ["tienda"] para varios
    }
  }
}
\`\`\`

y \`terraform init\`. Las **variables** se definen en el workspace o en **variable sets** compartidos; los secretos se marcan *sensitive*. Con **dynamic provider credentials** HCP obtiene credenciales temporales de AWS/Azure/GCP por OIDC, sin claves fijas.

## Políticas: Sentinel y OPA

Después del plan, HCP evalúa las **políticas** de la organización (escritas en Sentinel o en OPA/Rego) contra lo que se va a cambiar:

| Nivel | Si falla |
|---|---|
| \`advisory\` | Solo avisa |
| \`soft-mandatory\` | Bloquea, pero alguien con permiso puede hacer **override** |
| \`hard-mandatory\` | Bloquea siempre: hay que cambiar el código |

Además: **cost estimation**, **run tasks** (integraciones de terceros, p.ej. escáneres de seguridad), **health assessments** (detección automática de drift), **registro privado** y módulos *no-code*.

> [!TIP]
> Este simulador aplica tres políticas de ejemplo: solo instancias t3.micro/small/medium (*hard*), etiqueta \`Owner\` obligatoria (*soft*) y preferencia por regiones de la UE (*advisory*).`,
  files: {
    'main.tf': `# 1️⃣ terraform login
# 2️⃣ Añade el bloque terraform { cloud { ... } } con organization = "devopslab" y el workspace "tienda-prod"
# 3️⃣ terraform init y terraform plan: lee la estimación de costes y las políticas
# 4️⃣ Cumple las políticas y despliega con terraform apply

${app('t3.large', '{ Name = "web" }')}`,
  },
  objectives: [
    { id: 'login', label: 'Autentícate con `terraform login`', check: (c) => c.initialized.includes('hcp:login') },
    {
      id: 'cloud',
      label: 'Añade el bloque `cloud` (organización `devopslab`, workspace `tienda-prod`) y ejecuta `terraform init`',
      check: (c) => c.initialized.some((x) => x === 'backend:cloud:devopslab/tienda-prod'),
    },
    {
      id: 'policy',
      label: 'Lanza un `terraform plan` remoto y mira qué política *hard-mandatory* falla',
      check: (c) => c.history.some((h) => h.command === 'plan' && h.policy === 'hard'),
    },
    {
      id: 'deploy',
      label: 'Cumple las políticas (tipo de instancia permitido y etiqueta `Owner`) y despliega con `terraform apply`',
      check: (c) =>
        c.initialized.some((x) => x.startsWith('backend:cloud:')) &&
        instancesOf(c, 'aws_instance').some((i) => ['t3.micro', 't3.small', 't3.medium'].includes(String(i.attributes.instance_type)) && typeof (i.attributes.tags as Record<string, unknown> | null)?.Owner === 'string'),
    },
  ],
  hints: [
    '`terraform login` (en el simulador no hace falta pegar ningún token).',
    '```hcl\nterraform {\n  cloud {\n    organization = "devopslab"\n    workspaces {\n      name = "tienda-prod"\n    }\n  }\n}\n```',
    'La política `restrict-instance-types` es hard-mandatory: t3.large no está permitido.',
    'Si solo cambias el tipo, fallará `require-owner-tag` (soft-mandatory): podrías escribir `override`, pero lo correcto es añadir `Owner = "..."` a los tags.',
  ],
  solution: {
    'main.tf': `${cloud}
${app('t3.small', '{ Name = "web", Owner = "equipo-tienda" }')}`,
  },
};
