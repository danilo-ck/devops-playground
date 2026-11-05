import type { ValueMap } from '../engine';
import { instancesOf, type TerraformLesson } from './types';

export const lesson08: TerraformLesson = {
  id: 'arquitectura-web',
  title: 'Proyecto: un servidor web público',
  summary: 'Junta todo lo aprendido: Internet Gateway, rutas, security groups, data sources y outputs para publicar una web.',
  difficulty: 'Avanzado',
  duration: '25 min',
  concepts: ['internet gateway', 'route table', 'security group', 'data source', 'outputs'],
  defaultView: 'infra',
  content: `## El objetivo

Un servidor web accesible desde Internet. Para ello no basta con crear la máquina: hay que **abrirle camino**.

\`\`\`
Internet ⇄ Internet Gateway ⇄ Tabla de rutas ⇄ Subred pública ⇄ Security Group ⇄ Servidor
\`\`\`

## Las piezas

- **Internet Gateway (IGW)**: la puerta entre tu VPC e Internet. Se conecta a la VPC.
- **Tabla de rutas**: le dice al tráfico a dónde ir. La ruta \`0.0.0.0/0 → IGW\` significa *"todo lo que no sea de la red local, sal por la puerta a Internet"*.
- **Asociación**: une la tabla de rutas con una subred. Una subred con esa ruta es una **subred pública**.
- **Security Group**: el cortafuegos de la instancia. Por defecto bloquea toda entrada; hay que abrir el puerto 80 (HTTP).
- **IP pública**: para que el servidor tenga dirección en Internet (\`map_public_ip_on_launch = true\` en la subred).

## Data sources: consultar en lugar de crear

Un bloque \`data\` **lee** información que ya existe (no la crea). Aquí buscamos el identificador de la imagen de Ubuntu más reciente:

\`\`\`hcl
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
}

# se usa con el prefijo data.
ami = data.aws_ami.ubuntu.id
\`\`\`

## Bloques anidados

Algunos argumentos son **bloques** que se pueden repetir, como las reglas de un security group:

\`\`\`hcl
ingress {
  from_port   = 80
  to_port     = 80
  protocol    = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
}
\`\`\`

> [!TIP]
> En la vista **Infraestructura** la subred mostrará 🌐 *pública* cuando la ruta hacia el IGW esté asociada, y el servidor enseñará su IP pública.`,
  files: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

# Busca la imagen más reciente de Ubuntu (no la creamos: la consultamos)
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "web-vpc" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "eu-west-1a"
  map_public_ip_on_launch = true
  tags                    = { Name = "publica" }
}

# TODO 1: aws_internet_gateway conectado a la VPC
# TODO 2: aws_route_table con una ruta 0.0.0.0/0 hacia el gateway
# TODO 3: aws_route_table_association entre la subred y la tabla
# TODO 4: aws_security_group que permita HTTP (puerto 80) desde 0.0.0.0/0
# TODO 5: aws_instance en la subred pública, usando data.aws_ami.ubuntu.id
`,
    'outputs.tf': `# TODO 6: output "url" con "http://<ip pública del servidor>"
`,
  },
  objectives: [
    {
      id: 'igw',
      label: 'Crea un Internet Gateway conectado a la VPC',
      check: (c) => {
        const vpcs = instancesOf(c, 'aws_vpc').map((v) => v.attributes.id);
        return instancesOf(c, 'aws_internet_gateway').some((g) => vpcs.includes(g.attributes.vpc_id));
      },
    },
    {
      id: 'routes',
      label: 'Haz pública la subred: tabla de rutas `0.0.0.0/0 → IGW` asociada a la subred',
      check: (c) => {
        const igws = instancesOf(c, 'aws_internet_gateway').map((g) => g.attributes.id);
        const rts = instancesOf(c, 'aws_route_table').filter((rt) =>
          (Array.isArray(rt.attributes.route) ? (rt.attributes.route as ValueMap[]) : []).some((r) => r.cidr_block === '0.0.0.0/0' && igws.includes(r.gateway_id)),
        );
        const rtIds = rts.map((r) => r.attributes.id);
        return instancesOf(c, 'aws_route_table_association').some((a) => rtIds.includes(a.attributes.route_table_id));
      },
    },
    {
      id: 'sg',
      label: 'Crea un Security Group que permita el puerto 80 (HTTP)',
      check: (c) =>
        instancesOf(c, 'aws_security_group').some((sg) =>
          (Array.isArray(sg.attributes.ingress) ? (sg.attributes.ingress as ValueMap[]) : []).some((r) => Number(r.from_port) <= 80 && Number(r.to_port) >= 80),
        ),
    },
    {
      id: 'web',
      label: 'Lanza el servidor con IP pública y crea un output `url` con su dirección',
      check: (c) => {
        const ips = instancesOf(c, 'aws_instance')
          .map((i) => i.attributes.public_ip)
          .filter((ip): ip is string => typeof ip === 'string');
        return ips.length > 0 && Object.values(c.state.outputs).some((o) => typeof o.value === 'string' && ips.some((ip) => (o.value as string).includes(ip)));
      },
    },
  ],
  hints: [
    '```hcl\nresource "aws_internet_gateway" "gw" {\n  vpc_id = aws_vpc.main.id\n}\n```',
    '```hcl\nresource "aws_route_table" "public" {\n  vpc_id = aws_vpc.main.id\n  route {\n    cidr_block = "0.0.0.0/0"\n    gateway_id = aws_internet_gateway.gw.id\n  }\n}\n\nresource "aws_route_table_association" "public" {\n  subnet_id      = aws_subnet.public.id\n  route_table_id = aws_route_table.public.id\n}\n```',
    'El servidor: `ami = data.aws_ami.ubuntu.id`, `subnet_id = aws_subnet.public.id` y `vpc_security_group_ids = [aws_security_group.web.id]`.',
    'El output: `output "url" { value = "http://${aws_instance.web.public_ip}" }`',
  ],
  solution: {
    'main.tf': `provider "aws" {
  region = "eu-west-1"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "web-vpc" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "eu-west-1a"
  map_public_ip_on_launch = true
  tags                    = { Name = "publica" }
}

resource "aws_internet_gateway" "gw" {
  vpc_id = aws_vpc.main.id
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.gw.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "web" {
  name        = "web-sg"
  description = "Permite HTTP"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "web" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]

  tags = {
    Name = "servidor-web"
  }
}
`,
    'outputs.tf': `output "url" {
  value = "http://\${aws_instance.web.public_ip}"
}
`,
  },
};
