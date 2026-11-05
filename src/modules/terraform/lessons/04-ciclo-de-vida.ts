import { ran, resourcesInConfig, type TerraformLesson } from './types';

const base = `provider "aws" {
  region = "eu-west-1"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  tags = {
    Name = "red-produccion"
  }
}

resource "aws_subnet" "app" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "eu-west-1a"

  tags = {
    Name = "app"
  }
}

resource "aws_instance" "web" {
  ami           = "ami-0a1b2c3d4e5f60001"
  instance_type = "t3.micro"
  subnet_id     = aws_subnet.app.id

  tags = {
    Name   = "web"
    Equipo = "plataforma"
  }
}
`;

export const lesson04: TerraformLesson = {
  id: 'ciclo-de-vida',
  title: 'Cambios: modificar o reemplazar',
  summary: 'Aprende a leer un plan: qué cambios se aplican en caliente, cuáles obligan a recrear el recurso y cómo protegerte.',
  difficulty: 'Intermedio',
  duration: '15 min',
  concepts: ['update in-place', 'replace', 'forces replacement', 'lifecycle', 'prevent_destroy'],
  defaultView: 'infra',
  setup: { 'main.tf': base },
  content: `## La infraestructura ya existe

En esta lección partes de una red con un servidor **ya desplegado** (míralo en la pestaña *Infraestructura*). Ahora toca cambiarla, que es el día a día real.

## Los símbolos del plan

| Símbolo | Significado | Ejemplo |
|---|---|---|
| \`+\` | crear | recurso nuevo en el código |
| \`~\` | modificar **en caliente** (*in-place*) | cambiar etiquetas o el tamaño de la máquina |
| \`-/+\` | **destruir y volver a crear** | cambiar la imagen (\`ami\`) de un servidor |
| \`-\` | destruir | recurso eliminado del código |

## ¿Por qué algunos cambios obligan a recrear?

Porque la API de la nube **no permite** modificar ciertas propiedades de un recurso existente. No puedes cambiar el sistema operativo de un servidor que está en marcha ni el rango de IPs de una red: hay que crear uno nuevo. En el plan lo verás marcado con \`# forces replacement\`.

> [!WARNING]
> Un \`-/+\` sobre un servidor o una base de datos significa **perder lo que había dentro**. Lee siempre el plan antes de escribir \`yes\`.

## Efecto dominó

Si se reemplaza la VPC, su \`id\` cambia… y todo lo que la referencia (subredes, servidores) también tendrá que recrearse. El grafo de dependencias lo propaga.

## lifecycle: controlar el ciclo de vida

\`\`\`hcl
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  lifecycle {
    prevent_destroy       = true  # error si el plan intenta destruirlo
    create_before_destroy = false # crea el nuevo antes de borrar el viejo
    ignore_changes        = [tags]
  }
}
\`\`\`

> [!TIP]
> \`prevent_destroy\` es un cinturón de seguridad para recursos críticos (bases de datos, redes de producción).`,
  files: { 'main.tf': base },
  objectives: [
    {
      id: 'update',
      label: 'Cambia una etiqueta (`tags`) de la instancia y aplica: verás un cambio in-place `~`',
      check: (c) => ran(c, 'apply', (h) => !!h.actions?.includes('update')),
    },
    {
      id: 'replace',
      label: 'Cambia el `ami` de la instancia (p.ej. `ami-0a1b2c3d4e5f60002`) y aplica: verás un reemplazo `-/+`',
      check: (c) => ran(c, 'apply', (h) => !!h.actions?.includes('replace')),
    },
    {
      id: 'protect',
      label: 'Protege la VPC con `lifecycle { prevent_destroy = true }`',
      check: (c) => resourcesInConfig(c, 'aws_vpc').some((r) => r.lifecycle.preventDestroy),
    },
    {
      id: 'refuse',
      label: 'Comprueba que `terraform destroy` se niega a borrarla',
      check: (c) => resourcesInConfig(c, 'aws_vpc').some((r) => r.lifecycle.preventDestroy) && c.history.some((h) => h.command === 'destroy' && !h.ok),
    },
  ],
  hints: [
    'Cambia por ejemplo `Equipo = "plataforma"` por `Equipo = "backend"`, ejecuta `terraform plan` y fíjate en el símbolo `~`.',
    'Para el reemplazo cambia la última cifra del `ami`. En el plan aparecerá `# forces replacement` junto a ese atributo.',
    'El bloque `lifecycle` va **dentro** del recurso `aws_vpc`:\n\n```hcl\nlifecycle {\n  prevent_destroy = true\n}\n```',
  ],
  solution: {
    'main.tf': base
      .replace('Equipo = "plataforma"', 'Equipo = "backend"')
      .replace('ami-0a1b2c3d4e5f60001', 'ami-0a1b2c3d4e5f60002')
      .replace('    Name = "red-produccion"\n  }\n', '    Name = "red-produccion"\n  }\n\n  lifecycle {\n    prevent_destroy = true\n  }\n'),
  },
};
