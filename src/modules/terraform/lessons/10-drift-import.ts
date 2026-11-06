import { codeOnly, instancesOf, ran, type TerraformLesson, type TfLessonContext } from './types';

const base = `provider "aws" {
  region = "eu-west-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0abc1234"
  instance_type = "t3.micro"
  tags          = { Name = "web", Entorno = "produccion" }
}

resource "aws_s3_bucket" "assets" {
  bucket = "assets-tienda-2026"
}
`;

const LEGACY = 'logs-tienda-legacy';

const web = (c: TfLessonContext) => instancesOf(c, 'aws_instance').find((i) => i.addr === 'aws_instance.web');
const webTags = (c: TfLessonContext) => (web(c)?.attributes.tags ?? {}) as Record<string, unknown>;
const noPendingDrift = (c: TfLessonContext) => Object.keys(c.cloud.modified).length === 0 && c.cloud.deleted.length === 0;
const isRefreshOnly = (args?: string[]) => !!args?.some((a) => /^--?refresh-only$/.test(a));

export const lesson10: TerraformLesson = {
  id: 'drift-import',
  title: 'Drift e importación',
  summary: 'Detecta cambios hechos fuera de Terraform, decide si aceptarlos o deshacerlos, y trae recursos creados a mano bajo control con import.',
  difficulty: 'Avanzado',
  duration: '25 min',
  concepts: ['drift', 'refresh', '-refresh-only', 'import', 'generate-config-out', 'ignore_changes'],
  defaultView: 'infra',
  setup: { 'main.tf': base },
  drift: {
    modify: { 'aws_instance.web': ['instance_type=t3.large', 'tags.ParcheManual=incidente-42'] },
    create: [{ type: 'aws_s3_bucket', args: [`bucket=${LEGACY}`, 'tags.Equipo=datos'] }],
  },
  content: `## Cuando la nube y el código no coinciden

Terraform da por hecho que **solo él** cambia la infraestructura. En la vida real no es así: alguien entra en la consola web durante un incidente, un script retoca una etiqueta, otro equipo crea un bucket a mano… A esa diferencia entre lo que hay en la nube y lo que dice el estado se le llama **drift** (deriva).

> [!ANALOGY]
> El estado es el **inventario** del almacén. Si alguien mueve cajas sin apuntarlo, el inventario miente hasta que alguien vuelve a contar: eso es el **refresh**.

## El refresh

Antes de calcular un plan, Terraform **lee cada recurso real** y actualiza su copia del estado (verás \`Refreshing state...\` en la terminal). Si algo cambió fuera, lo avisa:

\`\`\`
Note: Objects have changed outside of Terraform
  # aws_instance.web has changed
  ~ instance_type = "t3.micro" -> "t3.large"
\`\`\`

Y después el plan propone **volver a lo que dice tu código**. Ante un drift tienes tres opciones:

| Quieres… | Haz esto |
|---|---|
| **Deshacer** el cambio manual | \`terraform apply\`: el código manda |
| **Aceptar** el cambio | Cambia el código para que coincida y luego \`apply\` |
| **Ignorarlo** siempre | \`lifecycle { ignore_changes = [tags] }\` |

## Solo mirar: -refresh-only

\`\`\`bash
terraform plan -refresh-only    # muestra el drift, no propone ningún cambio
terraform apply -refresh-only   # guarda en el estado lo que hay en la nube, sin tocar la nube
\`\`\`

El antiguo \`terraform refresh\` hace lo mismo que \`apply -refresh-only\`, pero **sin pedir confirmación**: está obsoleto. Y \`-refresh=false\` hace lo contrario: planifica sin consultar la nube (más rápido, pero a ciegas).

## Importar lo que se creó a mano

Un recurso creado fuera de Terraform no aparece en ningún plan: Terraform no sabe que existe. Para gestionarlo hay que **importarlo**:

\`\`\`hcl
import {
  to = aws_s3_bucket.logs      # dónde vivirá en tu código
  id = "logs-tienda-legacy"    # identificador en la nube
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs-tienda-legacy"
}
\`\`\`

El plan dirá \`Plan: 1 to import, 0 to add…\` y el apply lo añade al estado **sin recrearlo**. Si tu bloque \`resource\` no coincide con el objeto real, el plan mostrará además los cambios que haría.

> [!TIP]
> ¿No sabes qué atributos tiene? Escribe solo el bloque \`import\` y ejecuta \`terraform plan -generate-config-out=generated.tf\`: Terraform escribe el bloque \`resource\` por ti.

También existe el comando clásico \`terraform import aws_s3_bucket.logs logs-tienda-legacy\`, que importa directamente al estado (sin plan previo). El bloque \`import\` es preferible: se revisa en el plan y queda en el código.

## La consola web simulada

En este simulador puedes hacer de "compañero que toca la consola" con el comando \`cloud\`:

\`\`\`bash
cloud ls                                         # lo que existe de verdad
cloud modify aws_instance.web instance_type=t3.small
cloud modify aws_instance.web tags.Owner=ana
cloud delete aws_s3_bucket.assets
cloud create aws_s3_bucket bucket=mi-bucket-manual
\`\`\``,
  files: {
    'main.tf': `# ⚠️ Durante un incidente, alguien cambió cosas desde la consola de AWS
#    y además hay un bucket de logs que se creó a mano hace meses.
#    Empieza por: terraform plan -refresh-only   y   cloud ls

${base}`,
  },
  objectives: [
    {
      id: 'detect',
      label: 'Descubre el drift sin cambiar nada con `terraform plan -refresh-only`',
      check: (c) => ran(c, 'plan', (h) => isRefreshOnly(h.args)) || ran(c, 'apply', (h) => isRefreshOnly(h.args)),
    },
    {
      id: 'accept',
      label: 'El equipo decide quedarse con **t3.large**: refleja el cambio en el código y aplica',
      check: (c) => /instance_type\s*=\s*"t3\.large"/.test(codeOnly(c)) && web(c)?.attributes.instance_type === 't3.large' && noPendingDrift(c),
    },
    {
      id: 'revert',
      label: 'La etiqueta `ParcheManual` sobra: deshazla con `terraform apply` (el código manda)',
      check: (c) => !!web(c) && !('ParcheManual' in webTags(c)) && noPendingDrift(c) && ran(c, 'apply'),
    },
    {
      id: 'import',
      label: `Importa el bucket \`${LEGACY}\` creado a mano (bloque \`import\` + \`resource\`)`,
      check: (c) => instancesOf(c, 'aws_s3_bucket').some((i) => i.attributes.id === LEGACY),
    },
    {
      id: 'clean',
      label: 'Termina con un `terraform plan` que diga *No changes*',
      check: (c) => {
        const last = [...c.history].reverse().find((h) => h.command === 'plan');
        const s = last?.summary as { add: number; change: number; destroy: number; import?: number } | undefined;
        return (
          !!last?.ok && !isRefreshOnly(last.args) && !!s && s.add + s.change + s.destroy + (s.import ?? 0) === 0 &&
          instancesOf(c, 'aws_s3_bucket').some((i) => i.attributes.id === LEGACY) && noPendingDrift(c)
        );
      },
    },
  ],
  hints: [
    'Ejecuta `terraform init` y después `terraform plan -refresh-only`. Compara con `cloud ls`: verás qué cambió y qué existe sin que Terraform lo sepa.',
    'Para aceptar el nuevo tamaño, cambia `instance_type = "t3.large"` en `main.tf`. La etiqueta no está en tu código, así que el `apply` la quitará.',
    '```hcl\nimport {\n  to = aws_s3_bucket.logs\n  id = "logs-tienda-legacy"\n}\n```\n\nLuego `terraform plan -generate-config-out=generated.tf` te escribe el `resource`.',
    'Si declaras el `resource` sin el bloque `import`, el apply fallará con *BucketAlreadyOwnedByYou*: Terraform intentaría **crear** un bucket que ya existe.',
  ],
  solution: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0abc1234"
  instance_type = "t3.large" # aceptamos el cambio hecho en el incidente
  tags          = { Name = "web", Entorno = "produccion" }
}

resource "aws_s3_bucket" "assets" {
  bucket = "assets-tienda-2026"
}

import {
  to = aws_s3_bucket.logs
  id = "${LEGACY}"
}

resource "aws_s3_bucket" "logs" {
  bucket = "${LEGACY}"
  tags   = { Equipo = "datos" }
}
`,
  },
};
