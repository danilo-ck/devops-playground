import { ran, type TerraformLesson } from './types';

const base = `provider "aws" {
  region = "eu-west-1"
}

resource "random_pet" "sufijo" {
  length = 2
}

resource "aws_s3_bucket" "datos" {
  bucket = "datos-\${random_pet.sufijo.id}"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "red-estado" }
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
  tags       = { Name = "subred-a" }
}
`;

export const lesson08: TerraformLesson = {
  id: 'estado',
  title: 'El estado y destroy',
  summary: 'Qué es terraform.tfstate, por qué es tan importante, cómo inspeccionarlo y cómo destruir la infraestructura.',
  difficulty: 'Intermedio',
  duration: '15 min',
  concepts: ['tfstate', 'state list/show/rm', 'backend remoto', 'locking', 'destroy'],
  defaultView: 'state',
  setup: { 'main.tf': base },
  content: `## La memoria de Terraform

Cuando Terraform crea un recurso, apunta en el fichero **terraform.tfstate** la relación entre tu código y el objeto real:

\`\`\`
aws_vpc.main  ⟶  vpc-0a1b2c3d4e5f67890
\`\`\`

Sin el estado, Terraform no sabría que esa VPC ya existe y la crearía otra vez. El estado guarda también los atributos de cada recurso y sus dependencias (para destruir en el orden correcto).

> [!ANALOGY]
> El código es la **lista de la compra**; la nube es la **despensa**; el estado es el **inventario** que te dice qué compraste ya y dónde lo guardaste.

## Reglas de oro

- **Nunca lo edites a mano.** Usa los comandos \`terraform state …\`.
- **Puede contener secretos** (contraseñas, claves): trátalo como información sensible.
- **En equipo, guárdalo en remoto** (p.ej. un bucket S3) con **bloqueo** (*locking*) para que dos personas no hagan \`apply\` a la vez.

\`\`\`hcl
terraform {
  backend "s3" {
    bucket       = "mi-empresa-tfstate"
    key          = "red/terraform.tfstate"
    region       = "eu-west-1"
    use_lockfile = true
  }
}
\`\`\`

## Comandos de estado

| Comando | Para qué |
|---|---|
| \`terraform state list\` | Ver qué recursos gestiona Terraform |
| \`terraform state show <dir>\` | Ver todos los atributos de uno |
| \`terraform state rm <dir>\` | **Olvidar** un recurso (sigue existiendo en la nube) |
| \`terraform destroy\` | Destruir todo lo gestionado |

> [!WARNING]
> Tras un \`state rm\`, Terraform ya no conoce el recurso: si sigue en tu código, el próximo plan querrá **crearlo de nuevo** (y en la nube real tendrías un duplicado).`,
  files: { 'main.tf': base },
  objectives: [
    { id: 'list', label: 'Lista los recursos con `terraform state list`', check: (c) => ran(c, 'state list') },
    { id: 'show', label: 'Inspecciona uno con `terraform state show aws_vpc.main`', check: (c) => ran(c, 'state show') },
    {
      id: 'rm',
      label: 'Olvida la subred con `terraform state rm aws_subnet.a` y comprueba con `plan` que Terraform quiere crearla otra vez',
      check: (c) => {
        const i = c.history.findIndex((h) => h.command === 'state rm' && h.ok);
        return i >= 0 && c.history.slice(i + 1).some((h) => (h.command === 'plan' || h.command === 'apply') && (h.summary?.add ?? 0) > 0);
      },
    },
    {
      id: 'destroy',
      label: 'Destruye toda la infraestructura con `terraform destroy`',
      check: (c) => ran(c, 'destroy', (h) => (h.summary?.destroy ?? 0) > 0) && Object.values(c.state.resources).filter((r) => r.mode === 'managed').length === 0,
    },
  ],
  hints: [
    'Las direcciones son `TIPO.NOMBRE`, por ejemplo `aws_vpc.main` o `random_pet.sufijo`.',
    'Abre la pestaña **Estado** y alterna entre *Recursos* y *JSON* para ver el fichero real.',
    '`terraform destroy` también pide confirmación: escribe `yes`. Fíjate en el orden: primero las subredes, luego la VPC.',
  ],
};
