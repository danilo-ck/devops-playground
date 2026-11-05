import { instancesOf, resourcesInConfig, type TerraformLesson } from './types';

export const lesson03: TerraformLesson = {
  id: 'dependencias',
  title: 'Dependencias: construye una red',
  summary: 'Crea una VPC con subredes y descubre cómo Terraform deduce el orden de creación con el grafo de dependencias.',
  difficulty: 'Básico',
  duration: '15 min',
  concepts: ['VPC', 'subnet', 'referencias', 'grafo', 'known after apply'],
  defaultView: 'graph',
  content: `## Redes en la nube en 1 minuto

- **VPC** (*Virtual Private Cloud*): tu red privada y aislada dentro de AWS. Tiene un rango de IPs, p.ej. \`10.0.0.0/16\`.
- **Subred** (*subnet*): un trozo de ese rango, ubicado en una **zona de disponibilidad** (AZ), que es un centro de datos independiente.

> [!ANALOGY]
> La VPC es una **urbanización** con su propio terreno; las subredes son las **parcelas**. Repartir parcelas en varias AZ es como construir en dos barrios distintos: si uno se queda sin luz, el otro sigue funcionando.

| CIDR | Nº de IPs | Uso típico |
|---|---|---|
| \`10.0.0.0/16\` | 65.536 | Una VPC |
| \`10.0.1.0/24\` | 256 | Una subred |

Cada subred debe estar **dentro** del rango de la VPC y **no solaparse** con otras.

## Referencias entre recursos

Una subred necesita saber a qué VPC pertenece, pero el \`id\` de la VPC no existe hasta que AWS la crea. Por eso se **referencia**:

\`\`\`hcl
resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id   # <TIPO>.<NOMBRE>.<ATRIBUTO>
  cidr_block = "10.0.1.0/24"
}
\`\`\`

En el plan verás \`vpc_id = (known after apply)\`: el valor se conocerá durante el apply.

## El grafo de dependencias

Al leer esa referencia, Terraform deduce que la subred **depende** de la VPC: primero crea la VPC y después la subred. Es una **dependencia implícita**. Con todas ellas construye un **grafo** y:

- crea en orden (y en paralelo lo que no depende entre sí),
- destruye en el orden inverso.

> [!TIP]
> Abre la pestaña **Grafo** mientras escribes: se actualiza en vivo. Y durante el \`apply\` verás cómo se iluminan los nodos en orden.

> [!NOTE]
> Si una dependencia no se puede deducir de una referencia, se puede declarar a mano con \`depends_on = [aws_vpc.main]\`. Úsalo solo cuando sea necesario.`,
  files: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

# La VPC es tu red privada en la nube
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  tags = {
    Name = "red-principal"
  }
}

# 👇 Crea aquí dos subredes dentro de la VPC, en zonas distintas
#    (eu-west-1a y eu-west-1b)
`,
  },
  objectives: [
    {
      id: 'subnet',
      label: 'Crea una `aws_subnet` que referencie la VPC con `aws_vpc.main.id`',
      check: (c) => resourcesInConfig(c, 'aws_subnet').some((r) => c.graph?.deps[r.addr]?.includes('aws_vpc.main')),
    },
    {
      id: 'second',
      label: 'Añade una segunda subred en otra zona de disponibilidad',
      check: (c) => {
        const subs = resourcesInConfig(c, 'aws_subnet');
        return subs.length >= 2 || subs.some((s) => s.count || s.forEach);
      },
    },
    {
      id: 'apply',
      label: 'Aplica los cambios: deben existir la VPC y dos subredes en AZ distintas',
      check: (c) => {
        const vpcIds = instancesOf(c, 'aws_vpc').map((v) => v.attributes.id);
        const subs = instancesOf(c, 'aws_subnet').filter((s) => vpcIds.includes(s.attributes.vpc_id));
        return subs.length >= 2 && new Set(subs.map((s) => s.attributes.availability_zone)).size >= 2;
      },
    },
  ],
  hints: [
    'Una subred:\n\n```hcl\nresource "aws_subnet" "a" {\n  vpc_id            = aws_vpc.main.id\n  cidr_block        = "10.0.1.0/24"\n  availability_zone = "eu-west-1a"\n}\n```',
    'La segunda necesita **otro nombre local** (p.ej. `"b"`), **otro rango** (`10.0.2.0/24`) y **otra AZ** (`eu-west-1b`).',
    'Si ves `InvalidSubnet.Conflict` es que dos subredes se solapan; si ves `InvalidSubnet.Range`, el CIDR no está dentro de `10.0.0.0/16`.',
  ],
  solution: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  tags = {
    Name = "red-principal"
  }
}

resource "aws_subnet" "a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "eu-west-1a"

  tags = {
    Name = "subred-a"
  }
}

resource "aws_subnet" "b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "eu-west-1b"

  tags = {
    Name = "subred-b"
  }
}
`,
  },
};
