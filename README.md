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

- **Motor de Terraform simulado** (`src/modules/terraform/engine`): lexer y parser de HCL, validación contra esquemas de proveedor, grafo de dependencias, `plan` / `apply` / `destroy` con valores `(known after apply)`, update in‑place vs replace (incluido el efecto dominó), `count`, `for_each`, `locals`, `data`, `lifecycle`, **módulos** (locales y de un registro simulado `devopslab/…` con versiones semánticas, ámbito propio por módulo, instalación con `terraform init` / `init -upgrade`), **drift** (una "nube real" separada del estado: refresh, `-refresh-only`, `-refresh=false`) e **importación** (bloques `import`, `terraform import`, `-generate-config-out`), **proveedores** con versiones, `.terraform.lock.hcl`, `required_version` y `alias` multirregión, variables (precedencia completa: `default`, `TF_VAR_`, `terraform.tfvars`, `*.auto.tfvars`, `-var-file`, `-var`; `validation`, `sensitive`, `ephemeral`), argumentos write-only, bloques `dynamic`, `precondition` / `postcondition` / `check`, `moved`, `-replace` / `taint`, **backends** (local, s3, azurerm, gcs… con `-migrate-state` / `-reconfigure`), **bloqueo del estado**, **workspaces**, **HCP Terraform** (bloque `cloud`, ejecuciones remotas, estimación de costes y políticas advisory / soft / hard-mandatory), outputs, más de 40 funciones (`cidrsubnet`, `merge`, `format`…), errores de la "API" de la nube durante el apply (con apply parcial) y un estado tipo `terraform.tfstate`.
- **Terminal** con `init` (`-upgrade`, `-migrate-state`, `-reconfigure`), `validate`, `fmt` (`-check`, `-diff`, `-recursive`), `plan` (`-out`, `-refresh-only`, `-replace`, `-var-file`, `-generate-config-out`), `apply` (pide `yes`, o aplica un plan guardado), `destroy`, `output` (`-json`, `-raw`), `state list|show|mv|rm|pull`, `import`, `taint`/`untaint`, `workspace`, `providers`, `force-unlock`, `login`, `show`, `graph`, `console` y `refresh` (obsoleto). Admite variables de entorno (`export TF_LOG=DEBUG`, `TF_LOG_PATH`, `TF_VAR_…`). Para simular lo que pasa fuera de Terraform: `cloud ls|modify|delete|create` (consola web de AWS) y `team apply|crash` (una compañera bloquea el estado remoto). Los errores imitan los de Terraform e incluyen una pista didáctica en español (💡).
- **Visualizaciones**:
  - *Infraestructura*: diagrama de la nube (una sección por región → VPC → subredes → instancias, IGW, rutas, security groups, servicios). Muestra el plan como borrador (crear / modificar / reemplazar / destruir / importar), marca lo cambiado o creado a mano fuera de Terraform y anima el apply recurso a recurso.
  - *Grafo*: grafo de dependencias en vivo, con el estado de cada nodo.
  - *Plan*: diff visual de atributos, con lo que "fuerza reemplazo".
  - *Estado*: el `terraform.tfstate` en tarjetas o en JSON.
  - *Docs*: referencia de recursos y funciones disponibles.
- **16 lecciones** con teoría, objetivos que se validan solos, pistas y solución, más un **sandbox** libre. Cubren los objetivos del examen **Terraform Associate (004)**.
- **Modo examen** (`/m/terraform/examen`): banco de 120 preguntas propias por objetivo del examen, simulacro de 57 preguntas en 60 minutos, práctica por objetivo con corrección inmediata y repaso de fallos.
- El progreso, el trabajo de cada lección y los intentos de examen se guardan en `localStorage`.

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

Crea un fichero en `src/modules/terraform/lessons/` exportando un `TerraformLesson` (teoría, ficheros iniciales, `setup` opcional con infraestructura ya desplegada, `drift` opcional con cambios hechos a mano sobre ella, `locks` opcional con versiones de proveedor ya fijadas, `policies` opcionales de HCP Terraform, objetivos, pistas y solución) y añádelo a `lessons/index.ts`. El test `lessons.test.ts` comprueba automáticamente que la solución se aplica y cumple los objetivos; para misiones que dependen de comandos interactivos, añade un recorrido completo en `flows.test.ts`.

### Añadir un módulo al registro simulado

Añade una entrada en `engine/registry.ts` con su `source` (`devopslab/<nombre>/<proveedor>`) y los ficheros de cada versión. Aparece automáticamente en **Docs → Módulos** y se puede usar con `source` + `version`.

### Añadir un tipo de recurso

Añade un esquema en `engine/providers.ts` (argumentos, cuáles fuerzan reemplazo, atributos calculados, validaciones). El editor, el plan, la documentación y el grafo lo reconocen automáticamente; para darle un aspecto propio en el diagrama, añade su icono en `components/icons.tsx`.
