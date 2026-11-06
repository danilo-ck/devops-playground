import { codeOnly, instancesOf, ran, type TerraformLesson } from './types';

const provider = `provider "aws" {
  region = "eu-west-1"
}
`;

const db = (password: string) => `resource "aws_db_instance" "main" {
  engine              = "postgres"
  instance_class      = var.instance_class
  allocated_storage   = 20
  username            = "app"
  skip_final_snapshot = true
${password}
}
`;

export const lesson13: TerraformLesson = {
  id: 'secretos',
  title: 'Variables y secretos',
  summary: 'Precedencia de variables (TF_VAR_, tfvars, -var-file), valores sensitive, ephemeral y argumentos write-only para que los secretos no acaben en el estado.',
  difficulty: 'Avanzado',
  duration: '25 min',
  concepts: ['TF_VAR_', '*.auto.tfvars', '-var-file', 'sensitive', 'ephemeral', 'write-only', 'Vault'],
  defaultView: 'state',
  content: `## ¿De dónde sale el valor de una variable?

Si una variable recibe valor por varios sitios, gana el de **más prioridad**:

| Prioridad | Origen |
|---|---|
| 1 (menos) | \`default\` en el bloque \`variable\` |
| 2 | Variable de entorno \`TF_VAR_nombre\` |
| 3 | \`terraform.tfvars\` (y \`terraform.tfvars.json\`) |
| 4 | \`*.auto.tfvars\` (en orden alfabético) |
| 5 (más) | \`-var\` y \`-var-file\`, en el orden en que los escribas |

Solo \`terraform.tfvars\` y \`*.auto.tfvars\` se cargan solos: cualquier otro fichero (\`prod.tfvars\`) necesita \`-var-file=prod.tfvars\`.

> [!TIP]
> En la terminal: \`export TF_VAR_db_password=...\` (y \`unset\` para quitarla). Es la forma típica de pasar secretos en CI sin escribirlos en ningún fichero.

## sensitive: ocultar, que no proteger

\`sensitive = true\` en una variable u output hace que Terraform muestre \`(sensitive value)\` en el plan y en la terminal. Y si un output usa un valor sensible sin marcarlo, Terraform da error para que no lo publiques sin querer.

> [!WARNING]
> **sensitive no cifra nada**: el valor sigue guardado en claro en \`terraform.tfstate\` (y \`terraform output -json\` lo muestra). Por eso el estado se trata como un secreto: backend remoto cifrado y con acceso restringido.

## ephemeral y write-only: que el secreto no llegue al estado

Desde Terraform 1.10–1.11:

- Una variable con \`ephemeral = true\` **nunca se guarda** ni en el plan ni en el estado. Solo puede usarse donde no hay que guardarla: configuración de proveedores, otros valores efímeros y **argumentos write-only**.
- Un **argumento write-only** (sufijo \`_wo\`, como \`password_wo\`) se envía a la API pero no se guarda. Como Terraform no puede compararlo, se acompaña de un \`password_wo_version\`: cámbialo para volver a enviar el secreto.
- También hay **recursos efímeros** (\`ephemeral "random_password" "db" {}\`, \`ephemeral "vault_kv_secret_v2" …\`) que existen solo durante la ejecución.

\`\`\`hcl
variable "db_password" {
  type      = string
  sensitive = true
  ephemeral = true
}

resource "aws_db_instance" "main" {
  # …
  password_wo         = var.db_password
  password_wo_version = 1
}
\`\`\`

## Vault y gestores de secretos

En equipos reales los secretos viven en **HashiCorp Vault**, AWS Secrets Manager, etc. Terraform los lee con su proveedor (\`data "vault_kv_secret_v2"\` o, mejor, el recurso efímero equivalente para que no acaben en el estado). Vault puede incluso generar **credenciales dinámicas** de corta duración para el propio proveedor.`,
  files: {
    'main.tf': `${provider}
# ⚠️ La contraseña de la base de datos acaba en el plan, en un output y en el estado.
variable "db_password" {
  type = string
}

variable "instance_class" {
  type    = string
  default = "db.t3.micro"
}

${db('  password            = var.db_password')}
output "db_password" {
  value = var.db_password
}
`,
    'prod.tfvars': `# Valores de producción: solo se usan con -var-file=prod.tfvars
instance_class = "db.t3.small"
`,
  },
  objectives: [
    {
      id: 'env',
      label: 'Da valor a la contraseña con una variable de entorno: `export TF_VAR_db_password=...`',
      check: (c) => !!c.env?.TF_VAR_db_password,
    },
    {
      id: 'sensitive',
      label: 'Marca `var.db_password` como `sensitive` y arregla el output (márcalo `sensitive` o, mejor, bórralo)',
      check: (c) => !!c.config.variables.db_password?.sensitive && Object.values(c.config.outputs).every((o) => o.sensitive || !/db_password/.test(JSON.stringify(o.value))),
    },
    {
      id: 'writeonly',
      label: 'Hazla `ephemeral` y usa `password_wo` + `password_wo_version` en lugar de `password`',
      check: (c) => !!c.config.variables.db_password?.ephemeral && /password_wo\s*=/.test(codeOnly(c)) && !/^\s*password\s*=/m.test(codeOnly(c)),
    },
    {
      id: 'varfile',
      label: 'Despliega producción con `terraform apply -var-file=prod.tfvars` y comprueba en el Estado que la contraseña no aparece',
      check: (c) =>
        ran(c, 'apply', (h) => !!h.args?.some((a) => a.includes('var-file'))) &&
        instancesOf(c, 'aws_db_instance').some((d) => d.attributes.instance_class === 'db.t3.small' && d.attributes.password === null && d.attributes.password_wo === null),
    },
  ],
  hints: [
    'En la terminal: `export TF_VAR_db_password=SuperSecreta123`. Después `env` para verla.',
    'Un output con un valor sensible necesita `sensitive = true`. Pero si nadie necesita leer la contraseña, lo más seguro es borrar el output.',
    '```hcl\nvariable "db_password" {\n  type      = string\n  sensitive = true\n  ephemeral = true\n}\n```\n\nY en el recurso: `password_wo = var.db_password` y `password_wo_version = 1`. Si dejas `password = var.db_password`, Terraform dará error: un valor efímero no puede ir a un argumento que se guarda.',
    'Un output no puede devolver un valor efímero desde el módulo raíz: bórralo.',
  ],
  solution: {
    'main.tf': `${provider}
variable "db_password" {
  type      = string
  sensitive = true
  ephemeral = true
}

variable "instance_class" {
  type    = string
  default = "db.t3.micro"
}

${db('  password_wo         = var.db_password\n  password_wo_version = 1')}`,
    'prod.tfvars': `instance_class = "db.t3.small"
`,
  },
};
