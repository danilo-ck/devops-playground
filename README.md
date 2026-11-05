# DevOps Lab

Plataforma web para aprender conceptos DevOps **de forma práctica y visual**: cada cosa que escribes se representa gráficamente al momento. El primer módulo es **Terraform**; la arquitectura está pensada para ir añadiendo Docker, Kubernetes, CI/CD, etc.

Todo se ejecuta en el navegador: no hacen falta cuentas en la nube ni backend.

## Arrancar

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests del motor y de las lecciones
npm run build      # build de producción en dist/
```

## Qué incluye el módulo de Terraform

- **Motor de Terraform simulado** (`src/modules/terraform/engine`): lexer y parser de HCL, validación contra esquemas de proveedor, grafo de dependencias, `plan` / `apply` / `destroy` con valores `(known after apply)`, update in‑place vs replace (incluido el efecto dominó), `count`, `for_each`, `locals`, `data`, `lifecycle`, **módulos** (locales y de un registro simulado `devopslab/…` con versiones semánticas, ámbito propio por módulo, instalación con `terraform init` / `init -upgrade`), variables (`default`, `terraform.tfvars`, `-var`, `validation`), outputs, más de 40 funciones (`cidrsubnet`, `merge`, `format`…), errores de la "API" de la nube durante el apply (con apply parcial) y un estado tipo `terraform.tfstate`.
- **Terminal** con `init`, `validate`, `plan`, `apply` (pide `yes`), `destroy`, `output`, `state list|show|rm`, `show`, `graph` y `console`. Los errores imitan los de Terraform e incluyen una pista didáctica en español (💡).
- **Visualizaciones**:
  - *Infraestructura*: diagrama de la nube (región → VPC → subredes → instancias, IGW, rutas, security groups, servicios). Muestra el plan como borrador (crear / modificar / reemplazar / destruir) y anima el apply recurso a recurso.
  - *Grafo*: grafo de dependencias en vivo, con el estado de cada nodo.
  - *Plan*: diff visual de atributos, con lo que "fuerza reemplazo".
  - *Estado*: el `terraform.tfstate` en tarjetas o en JSON.
  - *Docs*: referencia de recursos y funciones disponibles.
- **9 lecciones** con teoría, objetivos que se validan solos, pistas y solución, más un **sandbox** libre. El progreso y el trabajo se guardan en `localStorage`.

## Arquitectura

```
src/
├── core/                  # Plataforma, independiente de cualquier módulo
│   ├── types.ts           # Contratos: LearningModule, LessonMeta, Objective
│   ├── progress.ts        # Progreso del usuario (zustand + localStorage)
│   └── highlighters.ts    # Registro de resaltadores de sintaxis por lenguaje
├── components/            # UI compartida: AppShell, LessonPanel, Markdown
├── pages/                 # Home, página de módulo, página de lección
└── modules/
    ├── index.ts           # Registro de módulos
    ├── coming-soon.ts     # Módulos planificados (Docker, K8s, CI/CD…)
    └── terraform/
        ├── index.ts               # Definición del módulo
        ├── engine/                # Motor (TypeScript puro, sin React, con tests)
        ├── components/            # Editor, terminal y visualizaciones
        ├── lessons/               # Una lección por fichero
        ├── useWorkspace.ts        # Estado del espacio de trabajo
        └── TerraformLessonView.tsx
```

### Añadir un módulo nuevo (p. ej. Docker)

1. Crea `src/modules/docker/` con su motor de simulación, sus componentes visuales y sus lecciones.
2. Exporta un `LearningModule` (ver `src/core/types.ts`) con `status: 'available'` y un `LessonView`.
3. Sustitúyelo en `src/modules/index.ts` (y quítalo de `coming-soon.ts`).

La home, la navegación, las rutas (`/m/:moduleId/:lessonId`), el progreso y el panel de lección (`LessonPanel`: teoría en Markdown, objetivos, pistas) funcionan sin más cambios.

### Añadir una lección de Terraform

Crea un fichero en `src/modules/terraform/lessons/` exportando un `TerraformLesson` (teoría, ficheros iniciales, `setup` opcional con infraestructura ya desplegada, objetivos, pistas y solución) y añádelo a `lessons/index.ts`. El test `lessons.test.ts` comprueba automáticamente que la solución se aplica y cumple los objetivos.

### Añadir un módulo al registro simulado

Añade una entrada en `engine/registry.ts` con su `source` (`devopslab/<nombre>/<proveedor>`) y los ficheros de cada versión. Aparece automáticamente en **Docs → Módulos** y se puede usar con `source` + `version`.

### Añadir un tipo de recurso

Añade un esquema en `engine/providers.ts` (argumentos, cuáles fuerzan reemplazo, atributos calculados, validaciones). El editor, el plan, la documentación y el grafo lo reconocen automáticamente; para darle un aspecto propio en el diagrama, añade su icono en `components/icons.tsx`.
