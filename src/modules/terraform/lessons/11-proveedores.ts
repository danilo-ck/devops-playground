import { satisfies } from '../engine';
import { instancesOf, ran, type TerraformLesson } from './types';

const base = (constraint: string) => `terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "${constraint}"
    }
  }
}

provider "aws" {
  region = "eu-west-1"
}

resource "aws_s3_bucket" "datos" {
  bucket = "datos-tienda-eu-2026"
}
`;

export const lesson11: TerraformLesson = {
  id: 'proveedores',
  title: 'Proveedores: versiones, lock file y varias regiones',
  summary: 'Fija versiones de Terraform y de los proveedores, entiende .terraform.lock.hcl, actualiza con init -upgrade y despliega en dos regiones con alias.',
  difficulty: 'Intermedio',
  duration: '20 min',
  concepts: ['required_version', 'required_providers', '.terraform.lock.hcl', 'init -upgrade', 'alias', 'provider ='],
  defaultView: 'infra',
  setup: { 'main.tf': base('~> 4.0') },
  locks: { aws: '4.67.0' },
  content: `## ¿Qué es un proveedor?

Terraform no sabe hablar con AWS, Azure o GitHub: delega en **proveedores** (*providers*), plugins que se descargan del registro en \`terraform init\`. Cada proveedor tiene sus propias versiones, independientes de la de Terraform.

> [!ANALOGY]
> Terraform es el **director de orquesta** y cada proveedor un **músico**. El director dice qué tocar; cada músico sabe tocar su instrumento (su API).

## Fijar versiones

\`\`\`hcl
terraform {
  required_version = ">= 1.5.0"        # versión de Terraform (el binario)

  required_providers {
    aws = {
      source  = "hashicorp/aws"         # <namespace>/<tipo> en el registro
      version = "~> 5.0"                # versión del proveedor
    }
  }
}
\`\`\`

| Restricción | Significa |
|---|---|
| \`"5.72.1"\` | exactamente esa |
| \`">= 5.30"\` | esa o más nueva (¡incluida la 6.0!) |
| \`"~> 5.0"\` | \`>= 5.0\` y \`< 6.0\`: cambios menores sí, la siguiente mayor no |
| \`">= 5.30, < 6.0"\` | rango explícito |

## El lock file: .terraform.lock.hcl

La restricción dice qué versiones **valen**; el lock file apunta **cuál se eligió**, con sus hashes. Así todo el equipo y la CI usan exactamente la misma.

- Se crea en el primer \`terraform init\` y **se sube al repositorio**.
- Los siguientes \`init\` **reutilizan** la versión del lock aunque haya otra más nueva.
- Para cambiar de versión: \`terraform init -upgrade\` elige la más nueva que cumpla la restricción y actualiza el lock.
- Si cambias la restricción y la versión fijada ya no la cumple, \`init\` falla hasta que uses \`-upgrade\`.

> [!TIP]
> Mira el lock con \`cat .terraform.lock.hcl\`, las versiones instaladas con \`terraform version\` y quién necesita cada proveedor con \`terraform providers\`.

## Varias configuraciones del mismo proveedor: alias

Un bloque \`provider\` sin alias es la configuración **por defecto**. Para usar otra región (u otra cuenta), declara uno nuevo con \`alias\` y elígelo en cada recurso con el meta-argumento \`provider\`:

\`\`\`hcl
provider "aws" {
  alias  = "virginia"
  region = "us-east-1"
}

resource "aws_s3_bucket" "replica" {
  provider = aws.virginia     # sin comillas
  bucket   = "datos-tienda-us-2026"
}
\`\`\`

A un módulo se le pasan con \`providers = { aws = aws.virginia }\` en el bloque \`module\`.

## Multi-cloud

Un mismo proyecto puede usar **varios proveedores a la vez** (AWS + Cloudflare + Datadog…): por eso Terraform es agnóstico de nube. Cada uno con su bloque en \`required_providers\`.`,
  files: {
    'main.tf': `# Este proyecto lleva tiempo con el proveedor de AWS 4.x (mira .terraform.lock.hcl).
# 1️⃣ Pásalo a la versión 5: cambia la restricción a "~> 5.0" y ejecuta terraform init -upgrade
# 2️⃣ Añade un segundo provider "aws" con alias = "virginia" en us-east-1
# 3️⃣ Crea un bucket de réplica en esa región con provider = aws.virginia

${base('~> 4.0')}`,
  },
  objectives: [
    {
      id: 'inspect',
      label: 'Mira qué versión está fijada con `terraform version` o `terraform providers` (o `cat .terraform.lock.hcl`)',
      check: (c) => ran(c, 'version') || ran(c, 'providers'),
    },
    {
      id: 'upgrade',
      label: 'Cambia la restricción a `~> 5.0` y actualiza el lock file con `terraform init -upgrade`',
      check: (c) => {
        const v = c.config.requiredProviders.aws?.version;
        const lock = c.initialized.find((x) => x.startsWith('lock:aws='))?.split('=')[1];
        return !!v && satisfies('5.72.1', v) && !satisfies('4.67.0', v) && !!lock && lock.startsWith('5.');
      },
    },
    {
      id: 'alias',
      label: 'Declara un segundo `provider "aws"` con `alias = "virginia"` en `us-east-1`',
      check: (c) =>
        c.config.providers.some((p) => p.name === 'aws' && p.alias === 'virginia' && p.body.attributes.some((a) => a.name === 'region' && a.expr.kind === 'literal' && a.expr.value === 'us-east-1')),
    },
    {
      id: 'replica',
      label: 'Despliega un bucket de réplica en us-east-1 con `provider = aws.virginia` (verás dos regiones en Infraestructura)',
      check: (c) => instancesOf(c, 'aws_s3_bucket').some((b) => b.attributes.region === 'us-east-1') && instancesOf(c, 'aws_s3_bucket').some((b) => b.attributes.region === 'eu-west-1'),
    },
  ],
  hints: [
    'Prueba primero `terraform init` sin más tras cambiar la restricción: verás por qué hace falta `-upgrade`.',
    '```hcl\nprovider "aws" {\n  alias  = "virginia"\n  region = "us-east-1"\n}\n```',
    '```hcl\nresource "aws_s3_bucket" "replica" {\n  provider = aws.virginia\n  bucket   = "datos-tienda-us-2026"\n}\n```',
  ],
  solution: {
    'main.tf': `${base('~> 5.0')}
provider "aws" {
  alias  = "virginia"
  region = "us-east-1"
}

resource "aws_s3_bucket" "replica" {
  provider = aws.virginia
  bucket   = "datos-tienda-us-2026"
}
`,
  },
};
