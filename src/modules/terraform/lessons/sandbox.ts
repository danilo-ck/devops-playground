import type { TerraformLesson } from './types';

export const sandbox: TerraformLesson = {
  id: 'sandbox',
  title: 'Sandbox libre',
  summary: 'Un laboratorio sin objetivos: escribe la infraestructura que quieras y experimenta sin miedo.',
  difficulty: 'Básico',
  duration: '∞',
  concepts: [],
  freeform: true,
  defaultView: 'infra',
  content: `## Laboratorio libre

Aquí no hay objetivos: experimenta. Algunas ideas:

- Diseña una red con subredes públicas y privadas en 3 zonas usando \`for_each\` y \`cidrsubnet\`.
- Crea una base de datos \`aws_db_instance\` con una contraseña generada por \`random_password\`.
- Provoca errores a propósito para ver cómo responde Terraform: referencias a recursos que no existen, ciclos, subredes que se solapan…

## Recursos disponibles

Consulta la pestaña **Docs** para ver todos los tipos de recurso, sus argumentos (y cuáles fuerzan reemplazo) y las funciones disponibles.

> [!TIP]
> Tu trabajo se guarda automáticamente en el navegador. Usa *Reiniciar lección* (pestaña Misión) para empezar de cero.`,
  files: {
    'main.tf': `provider "aws" {
  region = var.region
}

# Escribe aquí tu infraestructura 🚀
`,
    'variables.tf': `variable "region" {
  type    = string
  default = "eu-west-1"
}
`,
    'outputs.tf': ``,
    'terraform.tfvars': ``,
  },
  objectives: [],
  hints: [],
};
