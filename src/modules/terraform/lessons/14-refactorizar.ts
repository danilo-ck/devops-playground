import { formatHclSource } from '../engine';
import { ran, type TerraformLesson, type TfLessonContext } from './types';

const tidy = `provider "aws" {
  region = "eu-west-1"
}

resource "aws_instance" "web" {
  ami           = "ami-0abc1234"
  instance_type = "t3.micro"
  tags          = { Name = "tienda" }
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs-tienda-2026"
}
`;

const messy = `provider "aws" {
region="eu-west-1"
}

resource   "aws_instance" "web"{
    ami = "ami-0abc1234"
  instance_type =    "t3.micro"
  tags = { Name = "tienda" }
}

resource "aws_s3_bucket"   "logs" {
      bucket = "logs-tienda-2026"
}
`;

const applies = (c: TfLessonContext) => c.history.filter((h) => h.command === 'apply' && h.ok);

export const lesson14: TerraformLesson = {
  id: 'refactorizar',
  title: 'Refactorizar y mantener: fmt, moved, -replace y TF_LOG',
  summary: 'Formatea el código, renombra recursos sin destruirlos, fuerza reemplazos, guarda planes y depura con logs detallados.',
  difficulty: 'Avanzado',
  duration: '25 min',
  concepts: ['terraform fmt', 'moved', 'state mv', '-replace', 'taint', 'plan -out', 'TF_LOG'],
  defaultView: 'plan',
  setup: { 'main.tf': tidy },
  content: `## terraform fmt

Formatea los ficheros con el estilo canónico: sangría de 2 espacios y los \`=\` alineados en bloques de líneas seguidas.

| Comando | Qué hace |
|---|---|
| \`terraform fmt\` | Reescribe los ficheros de la carpeta actual y lista los que cambia |
| \`terraform fmt -check\` | No toca nada: falla si algo no está formateado (para CI) |
| \`terraform fmt -diff\` | Muestra las diferencias |
| \`terraform fmt -recursive\` | Incluye subcarpetas (los módulos) |

## Renombrar sin destruir: moved

Si cambias el nombre de un recurso en el código (\`aws_instance.web\` → \`aws_instance.app\`), Terraform cree que has borrado uno y creado otro: **lo destruiría y lo crearía**. Para decirle que es el mismo:

\`\`\`hcl
moved {
  from = aws_instance.web
  to   = aws_instance.app
}
\`\`\`

El plan muestra \`aws_instance.web has moved to aws_instance.app\` y **0 cambios**. También sirve para meter recursos en un módulo (\`to = module.red.aws_vpc.this\`) o pasar a \`count\`/\`for_each\`.

La alternativa imperativa es \`terraform state mv origen destino\`: cambia el estado al momento, pero no queda registrada en el código ni la revisa nadie en un plan.

## Forzar un reemplazo: -replace

Si un recurso se ha estropeado por dentro pero su configuración no ha cambiado, Terraform no lo tocaría. Para recrearlo:

\`\`\`bash
terraform apply -replace="aws_instance.app"
\`\`\`

Antes se usaba \`terraform taint\` (marca el recurso en el estado); está **obsoleto** porque el cambio no se ve hasta el siguiente plan y lo podría aplicar otra persona sin saberlo.

## Planes guardados: -out

\`\`\`bash
terraform plan -out=tfplan     # guarda exactamente lo que se va a hacer
terraform apply tfplan         # lo aplica sin volver a preguntar
\`\`\`

Es lo que se hace en CI: alguien revisa el plan y se aplica **ese** plan. Si el estado cambia entre medias, el plan queda caducado (*Saved plan is stale*).

## Depurar: TF_LOG

\`\`\`bash
export TF_LOG=DEBUG               # TRACE, DEBUG, INFO, WARN, ERROR (o JSON)
export TF_LOG_PATH=terraform.log  # opcional: a un fichero en vez de a la terminal
TF_LOG=TRACE terraform plan       # solo para un comando
unset TF_LOG
\`\`\`

> [!TIP]
> En los logs verás cómo Terraform arranca los proveedores y recorre el **grafo de dependencias** (\`ReferenceTransformer\`, \`vertex …\`).`,
  files: { 'main.tf': messy },
  objectives: [
    {
      id: 'fmt',
      label: 'Comprueba el formato con `terraform fmt -check` y arréglalo con `terraform fmt`',
      check: (c) => ran(c, 'fmt', (h) => !!h.args?.includes('-check')) || (c.history.some((h) => h.command === 'fmt' && h.args?.includes('-check')) && Object.entries(c.files).filter(([f]) => f.endsWith('.tf')).every(([, s]) => formatHclSource(s) === s)),
    },
    {
      id: 'moved',
      label: 'Renombra `aws_instance.web` a `aws_instance.app` **sin destruirla**, con un bloque `moved`, y aplica',
      check: (c) =>
        !!c.state.resources['aws_instance.app'] && !c.state.resources['aws_instance.web'] && c.config.moved.length > 0 && !applies(c).some((h) => h.actions?.includes('delete') && !h.args?.some((a) => a.includes('replace'))),
    },
    {
      id: 'saved',
      label: 'Guarda un plan con `terraform plan -out=tfplan` y aplícalo con `terraform apply tfplan`',
      check: (c) => applies(c).some((h) => h.args?.includes('tfplan')),
    },
    {
      id: 'replace',
      label: 'La instancia se ha corrompido: recréala con `terraform apply -replace=aws_instance.app`',
      check: (c) => applies(c).some((h) => !!h.args?.some((a) => a.startsWith('-replace')) && !!h.actions?.includes('replace')),
    },
    {
      id: 'log',
      label: 'Ejecuta un `terraform plan` con `TF_LOG=DEBUG` y busca en los logs el recorrido del grafo',
      check: (c) => ran(c, 'plan', (h) => !!h.log),
    },
  ],
  hints: [
    '`terraform fmt -check` falla y lista `main.tf`. Después `terraform fmt` lo arregla (verás el cambio en el editor).',
    'Cambia `resource "aws_instance" "web"` por `"app"` y añade:\n\n```hcl\nmoved {\n  from = aws_instance.web\n  to   = aws_instance.app\n}\n```\n\nEl plan debe decir `0 to destroy`.',
    '`terraform plan -out=tfplan` y luego `terraform apply tfplan` (no pide `yes`).',
    '`terraform apply -replace=aws_instance.app` y confirma con `yes`.',
    '`export TF_LOG=DEBUG` y `terraform plan`. Después `unset TF_LOG`.',
  ],
  solution: {
    'main.tf': `${tidy.replace('"aws_instance" "web"', '"aws_instance" "app"')}
moved {
  from = aws_instance.web
  to   = aws_instance.app
}
`,
  },
};
