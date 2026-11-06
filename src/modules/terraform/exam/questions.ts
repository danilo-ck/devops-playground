/**
 * Banco de preguntas originales para practicar la certificación
 * HashiCorp Certified: Terraform Associate (004).
 *
 * Las preguntas NO son preguntas reales del examen: están redactadas para
 * cubrir cada objetivo oficial con el comportamiento actual de Terraform 1.x.
 */

export type ObjectiveId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type QuestionKind = 'single' | 'multi' | 'truefalse';

export interface ExamQuestion {
  id: string;
  objective: ObjectiveId;
  subtopic: string;
  kind: QuestionKind;
  /** Enunciado en Markdown (admite bloques de código). */
  prompt: string;
  /** Opciones (Markdown en línea). */
  options: string[];
  /** Índices (base 0) de las opciones correctas. */
  correct: number[];
  /** Explicación en Markdown: por qué es correcta y cuál es la trampa habitual. */
  explanation: string;
}

export interface ObjectiveInfo {
  id: ObjectiveId;
  title: string;
  short: string;
}

export const OBJECTIVES: ObjectiveInfo[] = [
  { id: 1, title: 'Infraestructura como código (IaC) con Terraform', short: 'IaC' },
  { id: 2, title: 'Fundamentos de Terraform', short: 'Fundamentos' },
  { id: 3, title: 'Flujo de trabajo principal', short: 'Flujo principal' },
  { id: 4, title: 'Configuración de Terraform', short: 'Configuración' },
  { id: 5, title: 'Módulos de Terraform', short: 'Módulos' },
  { id: 6, title: 'Estado de Terraform', short: 'Estado' },
  { id: 7, title: 'Mantener la infraestructura con Terraform', short: 'Mantenimiento' },
  { id: 8, title: 'HCP Terraform', short: 'HCP Terraform' },
];

const TF = ['Verdadero', 'Falso'];
const hcl = (src: string) => '```hcl\n' + src.trim() + '\n```';
const sh = (src: string) => '```bash\n' + src.trim() + '\n```';

export const QUESTIONS: ExamQuestion[] = [
  // ------------------------------------------------------------------ 1 · IaC
  {
    id: 'iac-01',
    objective: 1,
    subtopic: 'Qué es IaC',
    kind: 'single',
    prompt: '¿Cuál es la definición más precisa de **infraestructura como código** (IaC)?',
    options: [
      'Gestionar y aprovisionar infraestructura mediante ficheros de definición legibles por máquinas, en lugar de configuración manual o herramientas interactivas',
      'Programar aplicaciones que se ejecutan dentro de servidores virtuales',
      'Documentar en una wiki los pasos manuales para crear servidores',
      'Usar la consola web del proveedor cloud con plantillas guardadas como favoritos',
    ],
    correct: [0],
    explanation:
      'IaC consiste en **describir la infraestructura en ficheros** (versionables, revisables y reproducibles) y dejar que una herramienta la aprovisione. Documentar pasos manuales o hacer clic en una consola, aunque sea con plantillas, sigue siendo un proceso manual.',
  },
  {
    id: 'iac-02',
    objective: 1,
    subtopic: 'Ventajas de IaC',
    kind: 'multi',
    prompt: '¿Cuáles de las siguientes son ventajas de gestionar la infraestructura como código? **Elige dos.**',
    options: [
      'Los cambios pueden revisarse en pull requests y quedan en el historial del control de versiones',
      'Permite crear entornos repetibles y consistentes (dev, staging, prod) a partir del mismo código',
      'Elimina por completo la necesidad de probar los cambios',
      'Hace innecesarias las credenciales de acceso al proveedor',
    ],
    correct: [0, 1],
    explanation:
      'IaC aporta **trazabilidad** (VCS, revisiones) y **reproducibilidad**. No elimina las pruebas (de hecho facilita automatizarlas) ni las credenciales: Terraform sigue necesitando autenticarse contra cada API.',
  },
  {
    id: 'iac-03',
    objective: 1,
    subtopic: 'Enfoque declarativo',
    kind: 'single',
    prompt: 'Terraform utiliza un enfoque **declarativo**. ¿Qué significa esto en la práctica?',
    options: [
      'Describes el estado final deseado y Terraform calcula qué acciones son necesarias para alcanzarlo',
      'Escribes paso a paso los comandos que deben ejecutarse y en qué orden',
      'Cada recurso debe declararse en un fichero distinto',
      'Terraform solo puede crear recursos, nunca modificarlos',
    ],
    correct: [0],
    explanation:
      'En un lenguaje declarativo indicas **qué** quieres, no **cómo** conseguirlo. Terraform compara la configuración con el estado y genera un plan con las acciones (crear, actualizar, reemplazar, destruir). Escribir los pasos uno a uno sería un enfoque imperativo.',
  },
  {
    id: 'iac-04',
    objective: 1,
    subtopic: 'Agnóstico de proveedor',
    kind: 'truefalse',
    prompt:
      'Como Terraform es agnóstico de proveedor, una configuración escrita para recursos de AWS puede aplicarse **sin cambios** para crear la misma infraestructura en Azure.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** Lo que es común es el **flujo de trabajo** y el lenguaje (HCL, plan/apply, estado). Los recursos son específicos de cada proveedor (`aws_instance` frente a `azurerm_linux_virtual_machine`), así que la configuración debe reescribirse para otra nube.',
  },
  {
    id: 'iac-05',
    objective: 1,
    subtopic: 'Multi-cloud',
    kind: 'single',
    prompt: '¿Cuál es una ventaja de usar Terraform en un despliegue **multi-cloud**?',
    options: [
      'Un único flujo de trabajo y lenguaje para gestionar varios proveedores, pudiendo expresar dependencias entre recursos de nubes distintas en la misma configuración',
      'Terraform replica automáticamente cada recurso en todas las nubes configuradas',
      'Terraform elimina la latencia de red entre proveedores',
      'Las facturas de todas las nubes se unifican en HCP Terraform',
    ],
    correct: [0],
    explanation:
      'Terraform permite gestionar varias nubes con **la misma herramienta y el mismo flujo**, e incluso referenciar en un proveedor atributos de otro (p. ej. una IP de AWS en un registro DNS de Cloudflare). No replica nada automáticamente ni unifica la facturación.',
  },
  {
    id: 'iac-06',
    objective: 1,
    subtopic: 'Agnóstico de servicio',
    kind: 'single',
    prompt:
      'Un equipo quiere gestionar con la misma herramienta sus repositorios de GitHub, sus monitores de Datadog y sus VPC de AWS. ¿Qué característica de Terraform lo hace posible?',
    options: [
      'Su arquitectura de proveedores (plugins), que permite gestionar cualquier servicio con API',
      'El uso obligatorio de HCP Terraform',
      'Los workspaces de la CLI',
      'El comando `terraform fmt`',
    ],
    correct: [0],
    explanation:
      'Terraform es **agnóstico de servicio**: cualquier plataforma con API puede tener un **proveedor** (miles en el Registry). No se limita a la infraestructura de nube: SaaS, DNS, Kubernetes, bases de datos, etc.',
  },
  {
    id: 'iac-07',
    objective: 1,
    subtopic: 'Idempotencia',
    kind: 'single',
    prompt:
      'Aplicas una configuración con `terraform apply` y todo se crea correctamente. Sin cambiar nada (ni el código ni la infraestructura real), vuelves a ejecutar `terraform apply`. ¿Qué ocurre?',
    options: [
      'Terraform informa de que no hay cambios: la infraestructura ya coincide con la configuración',
      'Terraform crea una segunda copia de todos los recursos',
      'Terraform destruye y vuelve a crear todos los recursos',
      'Terraform devuelve un error porque los recursos ya existen',
    ],
    correct: [0],
    explanation:
      'Es la **idempotencia** del enfoque declarativo: si el estado deseado ya se cumple, el plan sale vacío (`No changes`). Un script imperativo, en cambio, intentaría crear otra vez los recursos.',
  },
  {
    id: 'iac-08',
    objective: 1,
    subtopic: 'Infraestructura inmutable',
    kind: 'single',
    prompt:
      'Cambias un argumento de un recurso que el proveedor **no puede actualizar en el sitio** (por ejemplo, la zona de disponibilidad de una instancia). ¿Cómo lo gestiona Terraform?',
    options: [
      'Planifica un reemplazo: destruye el recurso y crea uno nuevo (o al revés con `create_before_destroy`)',
      'Ignora el cambio hasta que se ejecute `terraform refresh`',
      'Modifica el recurso en el sitio igualmente',
      'Falla siempre y obliga a borrar el recurso a mano',
    ],
    correct: [0],
    explanation:
      'El plan muestra el recurso con `-/+` y la anotación **forces replacement**. Es el modelo de **infraestructura inmutable**: en lugar de parchear, se sustituye. Con `lifecycle { create_before_destroy = true }` se crea el nuevo antes de destruir el antiguo.',
  },
  {
    id: 'iac-09',
    objective: 1,
    subtopic: 'Nube híbrida',
    kind: 'truefalse',
    prompt:
      'Con Terraform se pueden gestionar en un mismo flujo recursos on-premises (por ejemplo, VMware vSphere) y recursos de una nube pública.',
    options: TF,
    correct: [0],
    explanation:
      '**Verdadero.** Existen proveedores para plataformas locales (vSphere, Nutanix, OpenStack…) y para nubes públicas. Esto hace de Terraform una buena opción para escenarios **híbridos**.',
  },

  // ---------------------------------------------------------- 2 · Fundamentos
  {
    id: 'fund-01',
    objective: 2,
    subtopic: 'required_providers',
    kind: 'single',
    prompt: '¿En qué bloque se declaran la **fuente** y la **restricción de versión** de los proveedores que usa una configuración?',
    options: [
      '`required_providers`, dentro del bloque `terraform`',
      'El bloque `provider "aws" { ... }`',
      'El fichero `.terraform.lock.hcl`, editándolo a mano',
      'El bloque `backend`',
    ],
    correct: [0],
    explanation:
      'La forma correcta es `terraform { required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } } }`. El bloque `provider` sirve para **configurar** el proveedor (región, credenciales…); el argumento `version` dentro de `provider` está obsoleto. El lock file lo genera Terraform, no se edita a mano.',
  },
  {
    id: 'fund-02',
    objective: 2,
    subtopic: 'Restricciones de versión',
    kind: 'single',
    prompt:
      'Dada esta restricción, ¿qué versiones del proveedor son aceptables?\n\n' +
      hcl(`
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.31.0"
    }
  }
}`),
    options: ['`>= 5.31.0` y `< 5.32.0`', '`>= 5.31.0` y `< 6.0.0`', 'Solo la `5.31.0` exacta', 'Cualquier versión `>= 5.31.0`'],
    correct: [0],
    explanation:
      'El operador pesimista `~>` solo permite que aumente **el componente más a la derecha** indicado. Con `~> 5.31.0` se aceptan parches (`5.31.x`). La trampa: `~> 5.31` (sin el `.0`) sí permitiría `5.32`, `5.99`… pero nunca `6.0`.',
  },
  {
    id: 'fund-03',
    objective: 2,
    subtopic: 'Restricciones de versión',
    kind: 'single',
    prompt: '¿Qué rango de versiones permite la restricción `version = "~> 5.31"`?',
    options: ['`>= 5.31` y `< 6.0`', '`>= 5.31.0` y `< 5.32.0`', '`>= 5.0` y `< 6.0`', 'Solo `5.31`'],
    correct: [0],
    explanation:
      'Con dos componentes, `~> 5.31` deja variar el **minor** (y el patch) pero no el major: `>= 5.31, < 6.0`. Compáralo con `~> 5.31.0`, que solo deja variar el patch.',
  },
  {
    id: 'fund-04',
    objective: 2,
    subtopic: 'Lock file',
    kind: 'single',
    prompt: '¿Qué guarda el fichero `.terraform.lock.hcl`?',
    options: [
      'Las versiones exactas de los **proveedores** seleccionadas por `terraform init` y sus checksums',
      'Las versiones de los módulos descargados',
      'El estado de la infraestructura',
      'El identificador del bloqueo del estado mientras se ejecuta un `apply`',
    ],
    correct: [0],
    explanation:
      'El **dependency lock file** registra la versión concreta de cada proveedor y los hashes para verificarla, de modo que todo el equipo y la CI usen exactamente lo mismo. Trampas frecuentes: **no** registra módulos y **no** tiene nada que ver con el bloqueo (*locking*) del estado.',
  },
  {
    id: 'fund-05',
    objective: 2,
    subtopic: 'Lock file',
    kind: 'multi',
    prompt: '¿Qué afirmaciones sobre `.terraform.lock.hcl` son correctas? **Elige dos.**',
    options: [
      'Debe incluirse en el control de versiones junto al código',
      '`terraform init -upgrade` permite actualizar los proveedores a la versión más nueva que cumpla las restricciones y actualiza el fichero',
      'Debe añadirse a `.gitignore` porque contiene secretos',
      'Se borra y regenera automáticamente en cada `terraform plan`',
    ],
    correct: [0, 1],
    explanation:
      'HashiCorp recomienda **versionar** el lock file para que las ejecuciones sean reproducibles. Por defecto `init` respeta las versiones bloqueadas; para cambiarlas se usa `terraform init -upgrade`. No contiene secretos y `plan` no lo modifica.',
  },
  {
    id: 'fund-06',
    objective: 2,
    subtopic: 'Alias de proveedor',
    kind: 'single',
    prompt:
      'Con esta configuración, ¿cómo indicas que el bucket debe crearse en `eu-west-1`?\n\n' +
      hcl(`
provider "aws" {
  region = "us-east-1"
}

provider "aws" {
  alias  = "eu"
  region = "eu-west-1"
}

resource "aws_s3_bucket" "logs" {
  bucket = "acme-logs-eu"
  # ???
}`),
    options: ['`provider = aws.eu`', '`alias = "eu"`', '`provider = "eu"`', '`region = aws.eu`'],
    correct: [0],
    explanation:
      'El meta-argumento `provider` recibe una referencia `<NOMBRE>.<ALIAS>` **sin comillas**: `provider = aws.eu`. Sin él, el recurso usaría la configuración por defecto (la que no tiene alias).',
  },
  {
    id: 'fund-07',
    objective: 2,
    subtopic: 'Alias de proveedor',
    kind: 'single',
    prompt:
      'Hay dos bloques `provider "aws"`: uno sin alias y otro con `alias = "west"`. Un recurso `aws_instance` no especifica el meta-argumento `provider`. ¿Qué configuración utiliza?',
    options: [
      'La configuración por defecto (la que no tiene alias)',
      'La configuración con alias, por ser la última declarada',
      'Terraform falla porque hay ambigüedad',
      'Crea el recurso en ambas regiones',
    ],
    correct: [0],
    explanation:
      'Los recursos usan la **configuración por defecto** del proveedor cuyo nombre coincide con el prefijo del tipo (`aws_` → `aws`). Las configuraciones con alias solo se usan cuando se seleccionan explícitamente.',
  },
  {
    id: 'fund-08',
    objective: 2,
    subtopic: 'Proveedores como plugins',
    kind: 'truefalse',
    prompt:
      'Los proveedores se distribuyen por separado del binario de Terraform y tienen su propio ciclo de versiones.',
    options: TF,
    correct: [0],
    explanation:
      '**Verdadero.** Terraform Core y los proveedores son binarios independientes. `terraform init` descarga los proveedores (normalmente desde el Terraform Registry) y la versión de Terraform se restringe aparte con `required_version`.',
  },
  {
    id: 'fund-09',
    objective: 2,
    subtopic: 'Instalar proveedores',
    kind: 'single',
    prompt: '¿Dónde instala `terraform init` los proveedores para el directorio de trabajo actual?',
    options: [
      'En el subdirectorio oculto `.terraform/` del directorio de trabajo',
      'En el fichero `terraform.tfstate`',
      'Siempre en una carpeta global del sistema, compartida por todos los proyectos',
      'Dentro del fichero `.terraform.lock.hcl`',
    ],
    correct: [0],
    explanation:
      'Por defecto los plugins se guardan en `.terraform/providers` (y los módulos en `.terraform/modules`). Se puede configurar una caché global con `TF_PLUGIN_CACHE_DIR`, pero no es el comportamiento por defecto. El directorio `.terraform` no se suele versionar.',
  },
  {
    id: 'fund-10',
    objective: 2,
    subtopic: 'Uso del estado',
    kind: 'single',
    prompt: '¿Cuál es el propósito **principal** del estado de Terraform?',
    options: [
      'Asociar cada recurso de la configuración con su objeto real (por ejemplo, su ID en la nube)',
      'Guardar una copia de seguridad del código HCL',
      'Almacenar los binarios de los proveedores',
      'Registrar el historial de comandos ejecutados por cada usuario',
    ],
    correct: [0],
    explanation:
      'El estado es el **mapa** entre `aws_instance.web` y, p. ej., `i-0abc123`. Sin él Terraform no sabría qué objeto real corresponde a cada bloque. No guarda el código ni los binarios.',
  },
  {
    id: 'fund-11',
    objective: 2,
    subtopic: 'Uso del estado',
    kind: 'multi',
    prompt: 'Además de mapear recursos con objetos reales, ¿para qué más usa Terraform el estado? **Elige dos.**',
    options: [
      'Guardar metadatos como las dependencias, para poder destruir en el orden correcto aunque el código ya no exista',
      'Cachear atributos de los recursos, lo que mejora el rendimiento en infraestructuras grandes',
      'Sustituir al lock file de proveedores',
      'Guardar las credenciales del proveedor para no tener que configurarlas',
    ],
    correct: [0, 1],
    explanation:
      'La documentación cita: mapeo con el mundo real, **metadatos** (dependencias), **rendimiento** (caché de atributos) y **sincronización** en equipo. No sustituye al lock file y no es un almacén de credenciales (aunque puede contener datos sensibles de los recursos).',
  },
  {
    id: 'fund-12',
    objective: 2,
    subtopic: 'required_version',
    kind: 'single',
    prompt: '¿Qué controla el argumento `required_version` del bloque `terraform`?',
    options: [
      'Qué versiones de la **CLI de Terraform** pueden usarse con la configuración',
      'Qué versión del proveedor AWS se descarga',
      'La versión del formato del fichero de estado',
      'La versión mínima de los módulos hijos',
    ],
    correct: [0],
    explanation:
      '`required_version = ">= 1.6.0"` hace que Terraform falle si la CLI no cumple la restricción. Las versiones de proveedores se fijan en `required_providers` y las de módulos con el argumento `version` del bloque `module`.',
  },
  {
    id: 'fund-13',
    objective: 2,
    subtopic: 'Fuente de proveedores',
    kind: 'single',
    prompt:
      'Usas recursos `aws_*` pero no declaras el proveedor en `required_providers`. ¿Qué fuente asume Terraform al ejecutar `init`?',
    options: [
      '`hashicorp/aws` del Terraform Registry público (`registry.terraform.io/hashicorp/aws`)',
      'Ninguna: `init` falla siempre si falta `required_providers`',
      'La última versión que haya en la caché local del sistema',
      'Un proveedor de la comunidad elegido al azar',
    ],
    correct: [0],
    explanation:
      'Por compatibilidad, si un proveedor no está declarado Terraform asume el espacio de nombres **`hashicorp`** en el registro público. Funciona para proveedores oficiales, pero es buena práctica declararlos siempre con `source` y `version` (para proveedores de partners o comunidad es imprescindible).',
  },
  {
    id: 'fund-14',
    objective: 2,
    subtopic: 'Alias de proveedor en módulos',
    kind: 'single',
    prompt: '¿Cómo pasas la configuración de proveedor con alias `aws.eu` a un módulo hijo para que la use como su proveedor `aws` por defecto?',
    options: [
      '`providers = { aws = aws.eu }` dentro del bloque `module`',
      '`provider = aws.eu` dentro del bloque `module`',
      'Declarando una variable `region` en el módulo',
      'No es posible: los módulos solo usan el proveedor por defecto',
    ],
    correct: [0],
    explanation:
      'Los bloques `module` usan el meta-argumento **`providers`** (en plural y con un mapa). El meta-argumento `provider` (singular) es para recursos y data sources.',
  },

  // ----------------------------------------------------------- 3 · Flujo
  {
    id: 'flow-01',
    objective: 3,
    subtopic: 'Write / Plan / Apply',
    kind: 'single',
    prompt: '¿Cuál es el orden del flujo de trabajo principal de Terraform?',
    options: ['Write → Plan → Apply', 'Plan → Write → Apply', 'Apply → Plan → Write', 'Init → Apply → Plan'],
    correct: [0],
    explanation:
      'Escribes la configuración (**Write**), revisas los cambios propuestos (**Plan**) y los ejecutas (**Apply**). `init` es un paso de preparación del directorio, no forma parte de las tres fases del flujo principal.',
  },
  {
    id: 'flow-02',
    objective: 3,
    subtopic: 'terraform init',
    kind: 'single',
    prompt: 'Clonas un repositorio con código de Terraform. ¿Qué comando debes ejecutar **primero**?',
    options: ['`terraform init`', '`terraform plan`', '`terraform apply`', '`terraform validate`'],
    correct: [0],
    explanation:
      '`init` prepara el directorio: instala proveedores y módulos y configura el backend. Sin él, `plan`, `apply` e incluso `validate` fallan porque faltan los proveedores.',
  },
  {
    id: 'flow-03',
    objective: 3,
    subtopic: 'terraform init',
    kind: 'multi',
    prompt: '¿Qué acciones realiza `terraform init`? **Elige tres.**',
    options: [
      'Descarga e instala los proveedores',
      'Descarga los módulos referenciados',
      'Inicializa el backend donde se guarda el estado',
      'Crea los recursos definidos en la configuración',
      'Formatea los ficheros `.tf`',
    ],
    correct: [0, 1, 2],
    explanation:
      '`init` **nunca** crea infraestructura ni formatea código: se ocupa de proveedores, módulos y backend (y del lock file). Es seguro ejecutarlo varias veces.',
  },
  {
    id: 'flow-04',
    objective: 3,
    subtopic: 'terraform validate',
    kind: 'single',
    prompt: '¿Qué comprueba `terraform validate`?',
    options: [
      'Que la configuración es sintácticamente válida e internamente coherente, sin consultar APIs remotas ni el estado',
      'Que los recursos existen realmente en el proveedor',
      'Que el código está correctamente formateado',
      'Que el plan no destruye ningún recurso',
    ],
    correct: [0],
    explanation:
      '`validate` revisa sintaxis, tipos, referencias y argumentos obligatorios usando los esquemas de los proveedores (por eso requiere `init`), pero **no** contacta con la nube. El formato lo revisa `terraform fmt -check`.',
  },
  {
    id: 'flow-05',
    objective: 3,
    subtopic: 'terraform validate',
    kind: 'truefalse',
    prompt: '`terraform validate` detecta que el ID de AMI indicado en un `aws_instance` no existe en tu cuenta de AWS.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** `validate` no llama a las APIs del proveedor. Un ID inexistente solo se detecta durante `plan` (si un data source lo consulta) o, más habitualmente, al hacer `apply`.',
  },
  {
    id: 'flow-06',
    objective: 3,
    subtopic: 'terraform fmt',
    kind: 'single',
    prompt: 'En tu pipeline de CI quieres que el job **falle** si algún fichero no tiene el formato canónico, sin modificar ningún fichero. ¿Qué usas?',
    options: ['`terraform fmt -check`', '`terraform fmt`', '`terraform validate -fmt`', '`terraform plan -check`'],
    correct: [0],
    explanation:
      '`fmt -check` no reescribe nada y devuelve un código de salida distinto de 0 si hay ficheros sin formatear. `terraform fmt` sin flags reescribe los ficheros. Se suele combinar con `-recursive` para incluir subdirectorios.',
  },
  {
    id: 'flow-07',
    objective: 3,
    subtopic: 'terraform fmt',
    kind: 'single',
    prompt: 'Ejecutas `terraform fmt` en la raíz de un proyecto que tiene módulos en `./modules/*`. ¿Qué ficheros se formatean?',
    options: [
      'Solo los del directorio actual; para incluir subdirectorios hay que añadir `-recursive`',
      'Todos los ficheros `.tf` del proyecto, incluidos los subdirectorios',
      'Solo los ficheros modificados según git',
      'Ninguno: `fmt` solo muestra las diferencias',
    ],
    correct: [0],
    explanation:
      'Por defecto `terraform fmt` actúa sobre el directorio indicado (o el actual). Con `-recursive` procesa también los subdirectorios. Para solo ver diferencias se usa `-diff` o `-check`.',
  },
  {
    id: 'flow-08',
    objective: 3,
    subtopic: 'Planes guardados',
    kind: 'single',
    prompt:
      '¿Qué ocurre al ejecutar estos comandos?\n\n' +
      sh(`
terraform plan -out=tfplan
terraform apply tfplan`),
    options: [
      'Se aplican exactamente los cambios del plan guardado, sin pedir confirmación interactiva',
      'Se genera un plan nuevo y se pide confirmación antes de aplicar',
      'Se aplica el plan pero solo si se añade `-auto-approve`',
      'Falla porque `apply` no acepta ficheros de plan',
    ],
    correct: [0],
    explanation:
      'Al pasar un plan guardado, `apply` **no vuelve a planificar ni pregunta**: la aprobación es haber revisado ese plan. Si el estado ha cambiado desde que se generó, el plan queda obsoleto (*stale*) y `apply` falla.',
  },
  {
    id: 'flow-09',
    objective: 3,
    subtopic: 'Leer un plan',
    kind: 'single',
    prompt: 'En la salida de `terraform plan`, ¿qué símbolo indica que un recurso se **destruirá y se volverá a crear**?',
    options: ['`-/+`', '`~`', '`+`', '`<=`'],
    correct: [0],
    explanation:
      '`+` crear, `-` destruir, `~` actualizar en el sitio, `-/+` reemplazar (destruir y crear; `+/-` si es `create_before_destroy`) y `<=` lectura de un data source.',
  },
  {
    id: 'flow-10',
    objective: 3,
    subtopic: 'terraform destroy',
    kind: 'single',
    prompt: '¿Qué comando muestra **sin ejecutarlo** lo que haría `terraform destroy`?',
    options: ['`terraform plan -destroy`', '`terraform destroy -dry-run`', '`terraform show -destroy`', '`terraform apply -refresh-only`'],
    correct: [0],
    explanation:
      '`terraform plan -destroy` genera un plan de destrucción para revisarlo. `terraform destroy` es equivalente a `terraform apply -destroy`. No existe la opción `-dry-run`.',
  },
  {
    id: 'flow-11',
    objective: 3,
    subtopic: 'terraform apply',
    kind: 'single',
    prompt: 'Ejecutas `terraform apply` **sin** fichero de plan. ¿Qué sucede?',
    options: [
      'Terraform crea un plan, lo muestra y pide confirmación (`yes`) antes de aplicar',
      'Terraform aplica inmediatamente sin mostrar nada',
      'Terraform falla porque antes es obligatorio ejecutar `terraform plan`',
      'Terraform aplica el último plan que se generó en el directorio',
    ],
    correct: [0],
    explanation:
      '`apply` sin argumentos ejecuta su propio plan y solicita aprobación interactiva. Para omitir la pregunta se usa `-auto-approve` (con precaución). No es obligatorio ejecutar `plan` antes.',
  },
  {
    id: 'flow-12',
    objective: 3,
    subtopic: 'terraform plan',
    kind: 'truefalse',
    prompt: '`terraform plan` modifica la infraestructura real si detecta diferencias con la configuración.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** `plan` es de solo lectura respecto a la infraestructura: consulta el estado real (refresh) y propone cambios, pero no aplica nada ni persiste el estado actualizado.',
  },
  {
    id: 'flow-13',
    objective: 3,
    subtopic: 'terraform apply',
    kind: 'single',
    prompt: '¿Qué opción de `terraform apply` evita la pregunta de confirmación interactiva?',
    options: ['`-auto-approve`', '`-force`', '`-yes`', '`-no-confirm`'],
    correct: [0],
    explanation:
      '`-auto-approve` se usa sobre todo en automatizaciones. En pipelines es más seguro generar un plan con `-out`, revisarlo y aplicar ese fichero.',
  },

  // ------------------------------------------------------ 4 · Configuración
  {
    id: 'cfg-01',
    objective: 4,
    subtopic: 'resource y data',
    kind: 'single',
    prompt: '¿En qué se diferencia un bloque `data` de un bloque `resource`?',
    options: [
      '`data` lee información de objetos existentes sin gestionarlos; `resource` crea, actualiza y destruye objetos',
      '`data` solo puede usarse dentro de módulos',
      '`data` crea recursos que no aparecen en el estado',
      'No hay diferencia: son sinónimos',
    ],
    correct: [0],
    explanation:
      'Un **data source** consulta (por ejemplo, la AMI más reciente o una VPC creada por otro equipo) y Terraform nunca lo modifica ni lo destruye. Un **resource** es infraestructura que Terraform gestiona en todo su ciclo de vida.',
  },
  {
    id: 'cfg-02',
    objective: 4,
    subtopic: 'Referencias',
    kind: 'single',
    prompt:
      '¿Cómo referencias el atributo `id` de este data source?\n\n' +
      hcl(`
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
}`),
    options: ['`data.aws_ami.ubuntu.id`', '`aws_ami.ubuntu.id`', '`data.ubuntu.id`', '`${aws_ami.ubuntu}.id`'],
    correct: [0],
    explanation:
      'Los data sources se referencian con el prefijo **`data.`**: `data.<TIPO>.<NOMBRE>.<ATRIBUTO>`. Sin el prefijo, `aws_ami.ubuntu` se interpretaría como un recurso gestionado.',
  },
  {
    id: 'cfg-03',
    objective: 4,
    subtopic: 'Precedencia de variables',
    kind: 'single',
    prompt:
      'La variable `env` tiene `default = "dev"`. Además, `terraform.tfvars` contiene `env = "staging"`, y existe la variable de entorno `TF_VAR_env=qa`. Ejecutas `terraform apply -var="env=prod"`. ¿Qué valor toma `env`?',
    options: ['`prod`', '`staging`', '`qa`', '`dev`'],
    correct: [0],
    explanation:
      'Orden de menor a mayor prioridad: `default` → `TF_VAR_*` → `terraform.tfvars` → `terraform.tfvars.json` → `*.auto.tfvars` (orden alfabético) → `-var` / `-var-file` en línea de comandos. Las opciones de la CLI ganan siempre.',
  },
  {
    id: 'cfg-04',
    objective: 4,
    subtopic: 'Precedencia de variables',
    kind: 'single',
    prompt:
      'Defines `export TF_VAR_region=us-east-1` y el fichero `terraform.tfvars` contiene `region = "eu-west-1"`. No pasas opciones `-var`. ¿Qué valor toma `var.region`?',
    options: ['`eu-west-1`', '`us-east-1`', 'Terraform pregunta interactivamente', 'Error por valor duplicado'],
    correct: [0],
    explanation:
      'Trampa clásica: las variables de entorno `TF_VAR_` tienen **menos** prioridad que cualquier fichero `.tfvars` cargado. Por eso gana `terraform.tfvars`.',
  },
  {
    id: 'cfg-05',
    objective: 4,
    subtopic: 'Precedencia de variables',
    kind: 'single',
    prompt:
      '`terraform.tfvars` contiene `replicas = 1` y `prod.auto.tfvars` contiene `replicas = 3`. Ejecutas `terraform plan` sin opciones. ¿Qué valor se usa?',
    options: ['`3`', '`1`', 'El que tenga la fecha de modificación más reciente', 'Error: no se pueden definir dos veces'],
    correct: [0],
    explanation:
      'Los ficheros `*.auto.tfvars` se cargan automáticamente **después** de `terraform.tfvars`, así que tienen prioridad sobre él. Entre varios `*.auto.tfvars`, se procesan en orden alfabético y gana el último.',
  },
  {
    id: 'cfg-06',
    objective: 4,
    subtopic: 'Ficheros de variables',
    kind: 'single',
    prompt: 'Tienes un fichero `produccion.tfvars` en el directorio raíz. ¿Cuándo carga Terraform sus valores?',
    options: [
      'Solo si se indica con `-var-file=produccion.tfvars`',
      'Siempre, porque termina en `.tfvars`',
      'Solo al ejecutar `terraform init`',
      'Solo si el workspace actual se llama `produccion`',
    ],
    correct: [0],
    explanation:
      'Solo se cargan automáticamente `terraform.tfvars`, `terraform.tfvars.json` y los ficheros `*.auto.tfvars(.json)`. Cualquier otro nombre requiere `-var-file`. Para que se cargase solo, podría llamarse `produccion.auto.tfvars`.',
  },
  {
    id: 'cfg-07',
    objective: 4,
    subtopic: 'Tipos complejos',
    kind: 'single',
    prompt:
      'Con esta variable, si un elemento de `buckets` no define `public`, ¿qué valor tiene `public` para ese elemento?\n\n' +
      hcl(`
variable "buckets" {
  type = map(object({
    versioning = bool
    public     = optional(bool, false)
  }))
}`),
    options: ['`false`', '`null`', 'Error de validación: falta un atributo', '`true`'],
    correct: [0],
    explanation:
      '`optional(tipo, valor_por_defecto)` permite omitir el atributo y aplicar el valor por defecto indicado (`false`). Si se hubiera escrito `optional(bool)` sin valor por defecto, sería `null`.',
  },
  {
    id: 'cfg-08',
    objective: 4,
    subtopic: 'Tipos complejos',
    kind: 'single',
    prompt: '¿Qué tipo de colección de Terraform es **no ordenada** y **no admite valores duplicados**?',
    options: ['`set`', '`list`', '`tuple`', '`map`'],
    correct: [0],
    explanation:
      'Un `set` contiene valores únicos sin orden. `list` y `tuple` son ordenadas e indexadas; `map` usa claves únicas pero sus valores pueden repetirse. Por eso `for_each` acepta un `set(string)` o un `map`, pero no una `list` directamente (se usa `toset()`).',
  },
  {
    id: 'cfg-09',
    objective: 4,
    subtopic: 'Expresiones for',
    kind: 'single',
    prompt:
      'Si `var.names = ["web", "api"]`, ¿cuál es el resultado de esta expresión?\n\n' +
      hcl(`[for n in var.names : upper(n)]`),
    options: ['`["WEB", "API"]`', '`{ web = "WEB", api = "API" }`', '`"WEBAPI"`', '`["web", "api"]`'],
    correct: [0],
    explanation:
      'Una expresión `for` entre **corchetes** produce una lista (o tupla). Entre llaves y con `=>` produciría un mapa: `{for n in var.names : n => upper(n)}`.',
  },
  {
    id: 'cfg-10',
    objective: 4,
    subtopic: 'Funciones',
    kind: 'single',
    prompt: '¿Qué devuelve `merge({ a = 1, b = 2 }, { b = 3, c = 4 })`?',
    options: ['`{ a = 1, b = 3, c = 4 }`', '`{ a = 1, b = 2, c = 4 }`', '`[1, 2, 3, 4]`', 'Error: la clave `b` está duplicada'],
    correct: [0],
    explanation:
      '`merge` combina mapas u objetos; si una clave se repite, **gana el argumento posterior**. Es muy usado para combinar etiquetas comunes con etiquetas específicas.',
  },
  {
    id: 'cfg-11',
    objective: 4,
    subtopic: 'Funciones',
    kind: 'truefalse',
    prompt: 'En una configuración de Terraform puedes definir tus propias funciones escritas en HCL y llamarlas desde cualquier expresión.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** HCL no permite definir funciones de usuario. Solo existen las funciones **integradas** y, desde Terraform 1.8, las **funciones de proveedor** (`provider::<nombre>::<función>`). Para reutilizar lógica se usan `locals` o módulos.',
  },
  {
    id: 'cfg-12',
    objective: 4,
    subtopic: 'Funciones',
    kind: 'single',
    prompt: '¿Qué comando abre una consola interactiva para probar expresiones y funciones con los valores de tu configuración?',
    options: ['`terraform console`', '`terraform show`', '`terraform repl`', '`terraform eval`'],
    correct: [0],
    explanation:
      '`terraform console` evalúa expresiones (p. ej. `cidrsubnet("10.0.0.0/16", 8, 1)`) en el contexto de la configuración y el estado actuales. `terraform show` muestra el estado o un plan.',
  },
  {
    id: 'cfg-13',
    objective: 4,
    subtopic: 'Dependencias implícitas',
    kind: 'single',
    prompt:
      '¿Cómo sabe Terraform que debe crear la VPC antes que la subred?\n\n' +
      hcl(`
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}`),
    options: [
      'Por la referencia `aws_vpc.main.id`, que crea una dependencia implícita',
      'Porque la VPC aparece antes en el fichero',
      'Porque los recursos se crean por orden alfabético de tipo',
      'No lo sabe: hay que añadir `depends_on`',
    ],
    correct: [0],
    explanation:
      'Terraform construye un **grafo de dependencias** a partir de las referencias entre bloques. El orden en el fichero es irrelevante. `depends_on` solo es necesario cuando la dependencia no se expresa con una referencia.',
  },
  {
    id: 'cfg-14',
    objective: 4,
    subtopic: 'depends_on',
    kind: 'single',
    prompt: '¿Cuándo está justificado usar `depends_on`?',
    options: [
      'Cuando un recurso depende del comportamiento de otro pero no referencia ninguno de sus atributos (dependencia oculta)',
      'Siempre que un recurso referencie a otro, para que el orden sea explícito',
      'Para que dos recursos se creen en paralelo',
      'Para forzar que un recurso se recree en cada apply',
    ],
    correct: [0],
    explanation:
      'Ejemplo típico: una instancia cuya aplicación necesita una política IAM ya asociada, aunque el código de la instancia no referencie la política. `depends_on` es el **último recurso**: si existe una referencia, la dependencia ya es implícita.',
  },
  {
    id: 'cfg-15',
    objective: 4,
    subtopic: 'depends_on',
    kind: 'multi',
    prompt: '¿Qué afirmaciones sobre `depends_on` son correctas? **Elige dos.**',
    options: [
      'Recibe una lista de referencias a recursos o módulos, sin comillas',
      'Puede hacer los planes más conservadores, porque Terraform trata más valores como desconocidos hasta el apply',
      'Acepta cadenas con el nombre del recurso, por ejemplo `"aws_vpc.main"`',
      'Es obligatorio cuando un recurso referencia atributos de otro',
    ],
    correct: [0, 1],
    explanation:
      'La sintaxis es `depends_on = [aws_iam_role_policy.app]`. Abusar de `depends_on` hace que Terraform tenga que posponer lecturas y valores (más `(known after apply)`), por eso se recomienda solo cuando no hay otra forma.',
  },
  {
    id: 'cfg-16',
    objective: 4,
    subtopic: 'Bloques dynamic',
    kind: 'single',
    prompt:
      '¿Qué expresión debe ir en lugar de `???` para usar el puerto de cada regla?\n\n' +
      hcl(`
resource "aws_security_group" "web" {
  name = "web"

  dynamic "ingress" {
    for_each = var.rules
    content {
      from_port   = ???
      to_port     = ingress.value.port
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}`),
    options: ['`ingress.value.port`', '`each.value.port`', '`var.rules.port`', '`dynamic.value.port`'],
    correct: [0],
    explanation:
      'Dentro de `content`, el iterador se llama por defecto como la etiqueta del bloque dinámico (`ingress`) y expone `.key` y `.value`. `each` es el objeto de `for_each` a nivel de **recurso**, no de bloque dinámico. Se puede renombrar con `iterator = rule`.',
  },
  {
    id: 'cfg-17',
    objective: 4,
    subtopic: 'Validación de variables',
    kind: 'single',
    prompt:
      'Ejecutas `terraform plan -var="env=test"` con esta variable. ¿Qué ocurre?\n\n' +
      hcl(`
variable "env" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "env debe ser dev o prod."
  }
}`),
    options: [
      'El plan falla mostrando el `error_message`, antes de proponer ningún cambio',
      'El plan muestra un aviso pero continúa',
      'Terraform sustituye el valor por el primero válido (`dev`)',
      'La validación solo se evalúa durante `apply`',
    ],
    correct: [0],
    explanation:
      'Los bloques `validation` se evalúan al procesar el valor de la variable y producen un **error** que detiene la operación. A diferencia de los bloques `check`, no son simples avisos.',
  },
  {
    id: 'cfg-18',
    objective: 4,
    subtopic: 'precondition / postcondition',
    kind: 'single',
    prompt:
      '¿Qué hace este `postcondition`?\n\n' +
      hcl(`
data "aws_ami" "app" {
  most_recent = true
  owners      = ["self"]

  lifecycle {
    postcondition {
      condition     = self.architecture == "x86_64"
      error_message = "La AMI debe ser x86_64."
    }
  }
}`),
    options: [
      'Tras leer el data source, comprueba el resultado (vía `self`) y genera un error si la AMI no es x86_64',
      'Filtra las AMIs para devolver solo las x86_64',
      'Comprueba la condición antes de consultar la API',
      'Muestra un aviso que no detiene la ejecución',
    ],
    correct: [0],
    explanation:
      'Un `postcondition` se evalúa **después** de leer/crear el objeto y puede usar `self`. Un `precondition` se evalúa **antes** y no puede usar `self`. Ninguno filtra resultados: si la condición falla, la operación termina con error.',
  },
  {
    id: 'cfg-19',
    objective: 4,
    subtopic: 'Bloques check',
    kind: 'single',
    prompt: '¿Qué ocurre si falla un `assert` dentro de un bloque `check`?',
    options: [
      'Terraform muestra un **aviso** (warning) pero el plan o el apply continúan',
      'Terraform aborta el apply y revierte los cambios',
      'El recurso asociado se marca para reemplazo',
      'Terraform reintenta la comprobación hasta que se cumpla',
    ],
    correct: [0],
    explanation:
      'Los bloques `check` (Terraform 1.5+) sirven para validar la infraestructura de forma continua sin bloquear: sus fallos son **avisos**. Para bloquear se usan `validation`, `precondition` o `postcondition`. HCP Terraform puede evaluarlos periódicamente (validación continua).',
  },
  {
    id: 'cfg-20',
    objective: 4,
    subtopic: 'Datos sensibles',
    kind: 'truefalse',
    prompt: 'Marcar una variable con `sensitive = true` impide que su valor se guarde en el fichero de estado.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** `sensitive` solo **oculta** el valor en la salida de la CLI (`(sensitive value)`). El valor se guarda en texto plano en el estado y en los planes guardados si se usa en un recurso. Por eso el estado debe protegerse (backend cifrado, acceso restringido) o usarse valores efímeros.',
  },
  {
    id: 'cfg-21',
    objective: 4,
    subtopic: 'Datos sensibles',
    kind: 'single',
    prompt:
      '¿Qué ocurre al ejecutar `terraform plan` con este código?\n\n' +
      hcl(`
variable "db_password" {
  type      = string
  sensitive = true
}

output "password" {
  value = var.db_password
}`),
    options: [
      'Error: un output que usa un valor sensible debe declararse con `sensitive = true`',
      'El output muestra la contraseña en texto plano',
      'El output se omite silenciosamente',
      'Terraform cifra el output automáticamente',
    ],
    correct: [0],
    explanation:
      'Terraform propaga la marca de sensibilidad y **exige** que el output se marque `sensitive = true` (o que se use `nonsensitive()` de forma consciente). Así se evita filtrar secretos por accidente.',
  },
  {
    id: 'cfg-22',
    objective: 4,
    subtopic: 'Valores efímeros',
    kind: 'multi',
    prompt: '¿Qué mecanismos evitan que un secreto quede guardado en el estado **y** en el plan? **Elige dos.**',
    options: [
      'Una variable declarada con `ephemeral = true`, usada solo en contextos que admiten valores efímeros',
      'Un argumento de solo escritura (*write-only*), como `password_wo`, de un recurso que lo soporte',
      'Una variable con `sensitive = true`',
      'Envolver el valor con la función `nonsensitive()`',
    ],
    correct: [0, 1],
    explanation:
      'Los valores **efímeros** (variables/outputs con `ephemeral = true` y recursos `ephemeral`) y los **argumentos write-only** nunca se persisten en plan ni en estado. `sensitive` solo oculta la salida, y `nonsensitive()` hace justo lo contrario: quitar la marca.',
  },
  {
    id: 'cfg-23',
    objective: 4,
    subtopic: 'Argumentos write-only',
    kind: 'single',
    prompt:
      'Un recurso de base de datos usa el argumento de solo escritura `password_wo` junto a `password_wo_version`. ¿Para qué sirve `password_wo_version`?',
    options: [
      'Como Terraform no guarda el valor write-only, no puede detectar cambios en él; incrementar la versión indica que debe enviarse de nuevo',
      'Indica la versión del algoritmo de cifrado de la contraseña',
      'Fija la versión mínima del proveedor que soporta write-only',
      'Guarda en el estado un hash reversible de la contraseña',
    ],
    correct: [0],
    explanation:
      'Los argumentos write-only se envían al proveedor pero **nunca** se almacenan, así que Terraform no puede compararlos entre ejecuciones. El argumento de versión (que sí se guarda) actúa como disparador para rotar el secreto.',
  },
  {
    id: 'cfg-24',
    objective: 4,
    subtopic: 'Vault',
    kind: 'single',
    prompt:
      'Lees una contraseña de HashiCorp Vault con un **data source** del proveedor `vault` y la usas en un recurso. ¿Qué debes tener en cuenta?',
    options: [
      'El valor leído por un data source se guarda en el estado; para evitarlo puede usarse un recurso efímero (`ephemeral`) y argumentos write-only',
      'Los valores de Vault nunca se escriben en el estado porque están cifrados',
      'Vault rota la contraseña automáticamente en cada `terraform plan`',
      'No se puede usar Vault con Terraform sin HCP Terraform',
    ],
    correct: [0],
    explanation:
      'Integrar Vault evita guardar secretos en el **código**, pero un data source tradicional sí persiste el resultado en el **estado**. Con Terraform 1.10+ los recursos efímeros (por ejemplo `ephemeral "vault_kv_secret_v2"`) permiten usar el secreto sin persistirlo.',
  },
  {
    id: 'cfg-25',
    objective: 4,
    subtopic: 'count y for_each',
    kind: 'single',
    prompt:
      'Creas usuarios con `count = length(var.users)` a partir de `["ana", "luis", "eva"]`. Eliminas `"luis"` de la lista. ¿Qué propone el plan?',
    options: [
      'Modificar o recrear `[1]` (que pasa a ser "eva") y destruir `[2]`, porque los recursos se identifican por índice',
      'Destruir solo el usuario "luis"',
      'No hay cambios',
      'Recrear los tres usuarios',
    ],
    correct: [0],
    explanation:
      'Con `count` las instancias se identifican por **posición**; al quitar un elemento intermedio todo se desplaza. Con `for_each = toset(var.users)` cada instancia se identifica por **clave** (`["luis"]`) y solo se destruiría esa.',
  },
  {
    id: 'cfg-26',
    objective: 4,
    subtopic: 'Expresiones splat',
    kind: 'single',
    prompt: 'El recurso `aws_instance.web` usa `count = 3`. ¿Qué expresión devuelve una lista con los IDs de las tres instancias?',
    options: ['`aws_instance.web[*].id`', '`aws_instance.web.id`', '`aws_instance.web.*`', '`aws_instance[*].web.id`'],
    correct: [0],
    explanation:
      'La **expresión splat** `[*]` equivale a `[for i in aws_instance.web : i.id]`. Sin índice, `aws_instance.web.id` da error porque `aws_instance.web` es una lista de instancias.',
  },
  {
    id: 'cfg-27',
    objective: 4,
    subtopic: 'Variables locales y outputs',
    kind: 'single',
    prompt: 'Declaras `locals { prefix = "acme-${var.env}" }`. ¿Cómo lo referencias?',
    options: ['`local.prefix`', '`locals.prefix`', '`var.prefix`', '`local["prefix"]` solamente'],
    correct: [0],
    explanation:
      'El bloque se llama `locals` (plural) pero se referencia con **`local.`** (singular). Las variables de entrada se referencian con `var.` y los outputs de un módulo con `module.<nombre>.<output>`.',
  },

  // ------------------------------------------------------------- 5 · Módulos
  {
    id: 'mod-01',
    objective: 5,
    subtopic: 'Versionado de módulos',
    kind: 'single',
    prompt: '¿Con qué tipo de fuente de módulo se puede usar el argumento `version` del bloque `module`?',
    options: [
      'Con módulos de un registro (Terraform Registry público o registro privado)',
      'Con rutas locales como `./modules/vpc`',
      'Con repositorios Git genéricos',
      'Con cualquier fuente',
    ],
    correct: [0],
    explanation:
      '`version` solo funciona con **registros**. Para Git se fija la versión en la propia URL con `?ref=v1.2.0`; los módulos locales no se versionan por separado (van con el mismo código).',
  },
  {
    id: 'mod-02',
    objective: 5,
    subtopic: 'Fuentes de módulos',
    kind: 'single',
    prompt: '¿Cómo fijas un módulo alojado en un repositorio Git a la etiqueta `v1.2.0`?',
    options: [
      '`source = "git::https://example.com/vpc.git?ref=v1.2.0"`',
      '`source = "git::https://example.com/vpc.git"` y `version = "1.2.0"`',
      '`source = "https://example.com/vpc.git#v1.2.0"`',
      '`source = "git::https://example.com/vpc.git"` y `tag = "v1.2.0"`',
    ],
    correct: [0],
    explanation:
      'Para fuentes Git se usa el parámetro **`ref`** en la URL (rama, etiqueta o SHA). El argumento `version` solo es válido para módulos de registro.',
  },
  {
    id: 'mod-03',
    objective: 5,
    subtopic: 'Ámbito de variables',
    kind: 'single',
    prompt:
      'El módulo raíz declara `variable "env"`. Dentro de un módulo hijo, un recurso usa `var.env`, pero el módulo hijo no declara esa variable. ¿Qué ocurre?',
    options: [
      'Error: los módulos hijos no heredan las variables del padre; hay que declarar la variable en el hijo y pasarla en el bloque `module`',
      'Funciona, porque las variables del módulo raíz son globales',
      'Funciona solo si la variable tiene valor por defecto',
      'Terraform pregunta el valor de forma interactiva',
    ],
    correct: [0],
    explanation:
      'Cada módulo tiene su **propio ámbito**. El hijo debe declarar `variable "env"` y el padre pasar `env = var.env` en el bloque `module`. Es la forma de mantener los módulos encapsulados y reutilizables.',
  },
  {
    id: 'mod-04',
    objective: 5,
    subtopic: 'Outputs de módulos',
    kind: 'single',
    prompt: 'El módulo `network` declara `output "vpc_id"`. ¿Cómo usas ese valor en el módulo raíz?',
    options: ['`module.network.vpc_id`', '`network.vpc_id`', '`output.network.vpc_id`', '`module.network.outputs.vpc_id`'],
    correct: [0],
    explanation:
      'Los outputs de un módulo hijo se exponen como `module.<NOMBRE_DEL_BLOQUE>.<OUTPUT>`. Es la **única** forma de leer datos de un módulo: sus recursos internos no son accesibles directamente.',
  },
  {
    id: 'mod-05',
    objective: 5,
    subtopic: 'Ámbito de módulos',
    kind: 'truefalse',
    prompt:
      'Un módulo hijo puede leer directamente atributos de un recurso definido en **otro** módulo hijo, sin que el módulo padre se los pase.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** La información fluye solo por la interfaz del módulo: el módulo A expone un `output`, el padre lo lee con `module.a.x` y lo pasa como argumento al módulo B.',
  },
  {
    id: 'mod-06',
    objective: 5,
    subtopic: 'Uso de módulos',
    kind: 'single',
    prompt: 'Añades un nuevo bloque `module` que apunta al Terraform Registry. Al ejecutar `terraform plan` aparece el error *Module not installed*. ¿Qué te falta?',
    options: ['Ejecutar `terraform init` (o `terraform get`)', 'Ejecutar `terraform fmt`', 'Ejecutar `terraform apply -refresh-only`', 'Añadir `depends_on` al módulo'],
    correct: [0],
    explanation:
      'Los módulos se descargan en `.terraform/modules` durante `init` (o con `terraform get`). Cada vez que se añade un módulo o cambia su `source`/`version` hay que volver a inicializar.',
  },
  {
    id: 'mod-07',
    objective: 5,
    subtopic: 'Fuentes de módulos',
    kind: 'single',
    prompt: '¿Cuál es el formato de `source` de un módulo del Terraform Registry **público**?',
    options: ['`<NAMESPACE>/<NOMBRE>/<PROVEEDOR>`, p. ej. `terraform-aws-modules/vpc/aws`', '`registry://vpc/aws`', '`<PROVEEDOR>/<NOMBRE>`, p. ej. `aws/vpc`', '`https://registry.terraform.io/vpc`'],
    correct: [0],
    explanation:
      'Los módulos del registro público usan tres partes: espacio de nombres, nombre y proveedor. En un registro privado se antepone el host: `app.terraform.io/<ORG>/<NOMBRE>/<PROVEEDOR>`.',
  },
  {
    id: 'mod-08',
    objective: 5,
    subtopic: 'Versionado de módulos',
    kind: 'multi',
    prompt: '¿Qué prácticas son recomendables al consumir módulos de un registro? **Elige dos.**',
    options: [
      'Restringir la versión con `version` (por ejemplo `~> 5.1`) para evitar cambios incompatibles inesperados',
      'Revisar el changelog y probar el plan antes de subir de versión mayor',
      'No indicar nunca `version` para recibir siempre las últimas novedades',
      'Editar directamente el código en `.terraform/modules` para adaptarlo',
    ],
    correct: [0, 1],
    explanation:
      'Fijar versiones da **reproducibilidad**. Sin `version`, `init` descargaría la última y podría romper la configuración. Lo que hay en `.terraform/modules` es una copia descargada que se sobrescribe: los cambios se perderían.',
  },
  {
    id: 'mod-09',
    objective: 5,
    subtopic: 'Fuentes de módulos',
    kind: 'single',
    prompt: '¿Qué afirmación es correcta sobre un módulo con `source = "./modules/vpc"`?',
    options: [
      'Es una ruta local: no admite `version` y Terraform usa el código directamente desde esa carpeta',
      'Terraform lo descarga del Registry público',
      'Debe publicarse en el registro privado antes de usarlo',
      'Necesita el prefijo `file::`',
    ],
    correct: [0],
    explanation:
      'Las rutas locales deben empezar por `./` o `../`. No se copian ni se versionan aparte: los cambios en esa carpeta se ven en el siguiente plan.',
  },
  {
    id: 'mod-10',
    objective: 5,
    subtopic: 'Módulo raíz',
    kind: 'single',
    prompt: '¿Qué es el **módulo raíz** (*root module*)?',
    options: [
      'El conjunto de ficheros `.tf` del directorio de trabajo donde ejecutas Terraform',
      'El módulo publicado con más descargas en el Registry',
      'El primer bloque `module` que aparece en `main.tf`',
      'Un módulo especial que solo puede contener proveedores',
    ],
    correct: [0],
    explanation:
      'Toda configuración tiene al menos un módulo: el **raíz**, formado por los ficheros del directorio de trabajo. Los módulos que este llama son **hijos**.',
  },
  {
    id: 'mod-11',
    objective: 5,
    subtopic: 'Proveedores en módulos',
    kind: 'truefalse',
    prompt: 'Por defecto, los módulos hijos heredan las configuraciones de proveedor **sin alias** del módulo padre.',
    options: TF,
    correct: [0],
    explanation:
      '**Verdadero.** Por eso los módulos reutilizables no deberían incluir bloques `provider` propios: declaran sus requisitos en `required_providers` y reciben la configuración del padre (implícitamente o con `providers = {...}`).',
  },
  {
    id: 'mod-12',
    objective: 5,
    subtopic: 'Meta-argumentos de módulos',
    kind: 'single',
    prompt: '¿Cuál de estos **no** es un meta-argumento válido en un bloque `module`?',
    options: ['`lifecycle`', '`for_each`', '`depends_on`', '`providers`'],
    correct: [0],
    explanation:
      'Los bloques `module` admiten `source`, `version`, `count`, `for_each`, `providers` y `depends_on`. `lifecycle` es exclusivo de recursos y data sources.',
  },

  // ------------------------------------------------------------- 6 · Estado
  {
    id: 'state-01',
    objective: 6,
    subtopic: 'Backend local',
    kind: 'single',
    prompt: 'Si no configuras ningún backend, ¿dónde guarda Terraform el estado?',
    options: [
      'En el fichero `terraform.tfstate` del directorio de trabajo (backend `local`)',
      'En HCP Terraform automáticamente',
      'En memoria; se pierde al terminar el comando',
      'En `.terraform/state.json`',
    ],
    correct: [0],
    explanation:
      'El backend por defecto es **`local`**: `terraform.tfstate` en el directorio raíz, con una copia anterior en `terraform.tfstate.backup`. Para trabajo en equipo se recomienda un backend remoto.',
  },
  {
    id: 'state-02',
    objective: 6,
    subtopic: 'Bloqueo del estado',
    kind: 'single',
    prompt: '¿Para qué sirve el **bloqueo del estado** (*state locking*)?',
    options: [
      'Evita que dos operaciones escriban el estado a la vez y lo corrompan',
      'Cifra el estado en reposo',
      'Impide que se lean los outputs del estado',
      'Bloquea los recursos en la nube para que nadie los modifique manualmente',
    ],
    correct: [0],
    explanation:
      'Si el backend lo soporta, Terraform bloquea el estado automáticamente en las operaciones que pueden escribirlo (`plan`, `apply`, `destroy`…). No cifra nada ni afecta a los recursos reales.',
  },
  {
    id: 'state-03',
    objective: 6,
    subtopic: 'Bloqueo del estado',
    kind: 'single',
    prompt: 'Un `apply` se interrumpió y el estado ha quedado bloqueado. Tras comprobar que nadie más está ejecutando Terraform, ¿qué comando liberas el bloqueo?',
    options: ['`terraform force-unlock <LOCK_ID>`', '`terraform state unlock`', '`terraform apply -lock=false`', '`terraform init -reconfigure`'],
    correct: [0],
    explanation:
      '`force-unlock` elimina el bloqueo indicado por su ID (que aparece en el mensaje de error). `-lock=false` no libera nada: solo ejecuta sin bloquear, lo cual es peligroso.',
  },
  {
    id: 'state-04',
    objective: 6,
    subtopic: 'Backends remotos',
    kind: 'multi',
    prompt: '¿Qué ventajas aporta un backend remoto (S3, azurerm, gcs, HCP Terraform…) frente al local? **Elige dos.**',
    options: [
      'Permite que todo el equipo comparta el mismo estado',
      'Muchos ofrecen bloqueo y cifrado en reposo, y evitan que el estado viva en portátiles',
      'Hace que el estado deje de contener datos sensibles',
      'Elimina la necesidad de ejecutar `terraform init`',
    ],
    correct: [0, 1],
    explanation:
      'Un backend remoto centraliza el estado, permite bloqueo y suele soportar cifrado y control de acceso. Pero el estado **sigue** conteniendo los mismos datos (incluidos secretos) y `init` sigue siendo necesario para configurar el backend.',
  },
  {
    id: 'state-05',
    objective: 6,
    subtopic: 'Backends remotos',
    kind: 'single',
    prompt: 'En versiones actuales de Terraform, ¿cómo se activa el bloqueo del estado en el backend `s3` sin depender de DynamoDB?',
    options: [
      'Con `use_lockfile = true`, que usa un fichero de bloqueo en el propio bucket',
      'Con `lock = "s3"`',
      'No es posible: el backend `s3` no admite bloqueo',
      'Activando el versionado del bucket',
    ],
    correct: [0],
    explanation:
      'El backend `s3` admite **bloqueo nativo** con `use_lockfile = true` (crea un objeto `.tflock` en el bucket). El bloqueo con `dynamodb_table` está obsoleto. El versionado del bucket es recomendable para recuperar estados anteriores, pero no bloquea.',
  },
  {
    id: 'state-06',
    objective: 6,
    subtopic: 'Configuración del backend',
    kind: 'single',
    prompt: 'Quieres que el nombre del bucket del backend sea distinto por entorno. ¿Cómo lo haces?',
    options: [
      'Con **configuración parcial**: omites el argumento en el bloque `backend` y lo pasas con `terraform init -backend-config=...`',
      'Con `bucket = var.state_bucket` dentro del bloque `backend`',
      'Con `bucket = local.bucket`',
      'Con un bloque `dynamic "backend"`',
    ],
    correct: [0],
    explanation:
      'El bloque `backend` se procesa durante `init`, **antes** de evaluar variables y locals, así que no admite referencias. La configuración parcial (`-backend-config=archivo.hcl` o `clave=valor`) es la solución.',
  },
  {
    id: 'state-07',
    objective: 6,
    subtopic: 'Migrar el estado',
    kind: 'single',
    prompt: 'Cambias el backend de `local` a `s3`. ¿Qué comando copia el estado existente al nuevo backend?',
    options: ['`terraform init -migrate-state`', '`terraform state push`', '`terraform apply -backend=s3`', '`terraform refresh`'],
    correct: [0],
    explanation:
      'Al cambiar el bloque `backend`, `terraform init` detecta el cambio y con `-migrate-state` ofrece copiar el estado. `-reconfigure` haría lo contrario: ignorar el estado anterior.',
  },
  {
    id: 'state-08',
    objective: 6,
    subtopic: 'Drift',
    kind: 'single',
    prompt: 'Alguien cambió a mano las etiquetas de una instancia desde la consola. ¿Cómo ves esas diferencias **sin proponer cambios** sobre la infraestructura?',
    options: ['`terraform plan -refresh-only`', '`terraform plan -refresh=false`', '`terraform validate`', '`terraform state list`'],
    correct: [0],
    explanation:
      'Eso es **drift**. `plan -refresh-only` muestra qué ha cambiado fuera de Terraform y qué se actualizaría en el estado. `-refresh=false` hace justo lo contrario: no consulta la infraestructura real.',
  },
  {
    id: 'state-09',
    objective: 6,
    subtopic: 'Drift',
    kind: 'single',
    prompt: '¿Qué hace `terraform apply -refresh-only`?',
    options: [
      'Actualiza el estado para que refleje la infraestructura real, sin modificar ningún recurso',
      'Revierte la infraestructura real a lo que dice la configuración',
      'Borra del estado los recursos que tienen drift',
      'Vuelve a descargar los proveedores',
    ],
    correct: [0],
    explanation:
      'Acepta el drift en el **estado**. Si en cambio quieres revertir la infraestructura a lo que dice el código, basta con un `terraform apply` normal.',
  },
  {
    id: 'state-10',
    objective: 6,
    subtopic: 'Drift',
    kind: 'truefalse',
    prompt: '`terraform refresh` es el método recomendado actualmente para sincronizar el estado con la infraestructura real.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** `terraform refresh` está **obsoleto**: equivale a `terraform apply -refresh-only -auto-approve`, es decir, actualiza el estado sin dejarte revisar los cambios. Se recomienda `apply -refresh-only` (que pide confirmación).',
  },
  {
    id: 'state-11',
    objective: 6,
    subtopic: 'Workspaces CLI',
    kind: 'single',
    prompt:
      'Estás en el workspace `staging` (creado con `terraform workspace new staging`). ¿Qué nombre tendrá el bucket?\n\n' +
      hcl(`
resource "aws_s3_bucket" "app" {
  bucket = "acme-app-\${terraform.workspace}"
}`),
    options: ['`acme-app-staging`', '`acme-app-default`', '`acme-app-${terraform.workspace}`', 'Error: `terraform.workspace` no existe'],
    correct: [0],
    explanation:
      'La expresión `terraform.workspace` devuelve el nombre del workspace actual. Es la forma habitual de diferenciar nombres entre workspaces que comparten configuración.',
  },
  {
    id: 'state-12',
    objective: 6,
    subtopic: 'Workspaces CLI',
    kind: 'single',
    prompt: 'Con el backend local, ¿dónde se guarda el estado de un workspace llamado `dev`?',
    options: ['`terraform.tfstate.d/dev/terraform.tfstate`', '`terraform.tfstate`', '`.terraform/workspaces/dev.tfstate`', '`dev.tfstate`'],
    correct: [0],
    explanation:
      'El workspace `default` usa `terraform.tfstate`; los demás se guardan en `terraform.tfstate.d/<nombre>/`. En backends remotos cada backend usa su propia convención (p. ej. prefijos `env:/` en S3).',
  },
  {
    id: 'state-13',
    objective: 6,
    subtopic: 'Workspaces CLI',
    kind: 'truefalse',
    prompt: 'El workspace `default` puede eliminarse con `terraform workspace delete default`.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** El workspace `default` siempre existe y no puede eliminarse. Tampoco puedes borrar el workspace en el que estás actualmente.',
  },
  {
    id: 'state-14',
    objective: 6,
    subtopic: 'Workspaces CLI',
    kind: 'single',
    prompt: '¿Por qué los workspaces de la CLI **no** son ideales para separar producción de desarrollo en una organización grande?',
    options: [
      'Todos comparten el mismo backend y credenciales, por lo que no ofrecen aislamiento fuerte de acceso',
      'Porque no pueden tener valores de variables distintos',
      'Porque cada workspace requiere un proveedor distinto',
      'Porque solo se permite un workspace por directorio',
    ],
    correct: [0],
    explanation:
      'Los workspaces CLI son estados distintos **en el mismo backend**: quien puede acceder a uno, puede acceder al resto. Para aislar entornos se recomiendan configuraciones/backends separados o workspaces de HCP Terraform con permisos por equipo.',
  },
  {
    id: 'state-15',
    objective: 6,
    subtopic: 'Compartir estado',
    kind: 'single',
    prompt: 'Otro equipo gestiona la red y expone `vpc_id` como output en su estado remoto. ¿Cómo lo lees desde tu configuración?',
    options: [
      'Con el data source `terraform_remote_state`, leyendo `outputs.vpc_id`',
      'Copiando su fichero de estado a tu directorio',
      'Con `terraform state pull` en cada plan',
      'Con un bloque `import`',
    ],
    correct: [0],
    explanation:
      '`data "terraform_remote_state" "net" { backend = "s3" config = {...} }` y luego `data.terraform_remote_state.net.outputs.vpc_id`. Solo expone los **outputs** del módulo raíz. En HCP Terraform también existe el data source `tfe_outputs`.',
  },

  // ------------------------------------------------------- 7 · Mantenimiento
  {
    id: 'maint-01',
    objective: 7,
    subtopic: 'Bloque import',
    kind: 'single',
    prompt:
      '¿Qué ocurre al ejecutar `terraform plan` con este bloque (y el bloque `resource` correspondiente definido)?\n\n' +
      hcl(`
import {
  to = aws_s3_bucket.logs
  id = "acme-logs-2024"
}`),
    options: [
      'El plan muestra que el bucket existente se importará; la importación se hace efectiva al aplicar',
      'El bucket se importa inmediatamente al estado, sin plan',
      'Terraform crea un bucket nuevo llamado `acme-logs-2024`',
      'Error: los bloques `import` solo funcionan en HCP Terraform',
    ],
    correct: [0],
    explanation:
      'Los bloques `import` (Terraform 1.5+) son **declarativos** y forman parte del plan: puedes revisar qué se importará y aplicarlo con `apply`. Se pueden usar en local, en CI o en HCP Terraform.',
  },
  {
    id: 'maint-02',
    objective: 7,
    subtopic: 'Generar configuración',
    kind: 'single',
    prompt: 'Tienes un bloque `import` pero aún no has escrito el bloque `resource`. ¿Qué comando genera automáticamente la configuración HCL?',
    options: [
      '`terraform plan -generate-config-out=generated.tf`',
      '`terraform import -generate`',
      '`terraform show -config`',
      '`terraform state pull > generated.tf`',
    ],
    correct: [0],
    explanation:
      '`-generate-config-out` escribe en un fichero **nuevo** el HCL de los recursos importados que no tienen bloque `resource`. Conviene revisarlo y limpiarlo antes de aplicar. El fichero no debe existir previamente.',
  },
  {
    id: 'maint-03',
    objective: 7,
    subtopic: 'terraform import',
    kind: 'multi',
    prompt: '¿Qué afirmaciones son correctas sobre el comando `terraform import <DIRECCIÓN> <ID>`? **Elige dos.**',
    options: [
      'El bloque `resource` de destino debe existir ya en la configuración',
      'Modifica el estado directamente, sin un plan previo que revisar',
      'Genera automáticamente el código HCL del recurso',
      'Puede importar varios recursos a la vez mediante `for_each`',
    ],
    correct: [0, 1],
    explanation:
      'El comando clásico importa **un** objeto, escribe el estado inmediatamente y no genera código. El bloque `import` es más moderno: va en el plan, admite `for_each` y puede generar configuración.',
  },
  {
    id: 'maint-04',
    objective: 7,
    subtopic: 'Inspeccionar el estado',
    kind: 'single',
    prompt: '¿Qué comando muestra la lista de direcciones de todos los recursos del estado?',
    options: ['`terraform state list`', '`terraform show -list`', '`terraform output`', '`terraform graph`'],
    correct: [0],
    explanation:
      '`state list` lista direcciones como `aws_instance.web` o `module.net.aws_vpc.main` (admite filtros). `terraform output` solo muestra outputs y `terraform graph` genera el grafo de dependencias en formato DOT.',
  },
  {
    id: 'maint-05',
    objective: 7,
    subtopic: 'Inspeccionar el estado',
    kind: 'single',
    prompt: 'Quieres ver todos los atributos guardados en el estado para `aws_instance.web`. ¿Qué comando usas?',
    options: ['`terraform state show aws_instance.web`', '`terraform state list aws_instance.web --all`', '`terraform console aws_instance.web`', '`terraform plan -target=aws_instance.web`'],
    correct: [0],
    explanation: '`terraform state show <DIRECCIÓN>` imprime los atributos de un único recurso tal y como están en el estado.',
  },
  {
    id: 'maint-06',
    objective: 7,
    subtopic: 'Bloques moved',
    kind: 'single',
    prompt:
      'Renombras `aws_instance.web` a `aws_instance.frontend` y añades este bloque. ¿Qué propone el plan?\n\n' +
      hcl(`
moved {
  from = aws_instance.web
  to   = aws_instance.frontend
}`),
    options: [
      'Mover el objeto en el estado a la nueva dirección, sin destruir ni crear la instancia',
      'Destruir `web` y crear `frontend`',
      'Crear una segunda instancia',
      'Nada: los bloques `moved` solo funcionan con módulos',
    ],
    correct: [0],
    explanation:
      'Los bloques `moved` (1.1+) son la alternativa **declarativa y revisable** a `terraform state mv`: se ven en el plan y sirven a todos los que usen la configuración (ideal en módulos compartidos). Sin el bloque, el plan destruiría y recrearía.',
  },
  {
    id: 'maint-07',
    objective: 7,
    subtopic: 'terraform state rm',
    kind: 'single',
    prompt: '¿Qué hace `terraform state rm aws_s3_bucket.legacy`?',
    options: [
      'Deja de gestionar el bucket (lo quita del estado) **sin** borrarlo en la nube',
      'Borra el bucket en la nube y en el estado',
      'Marca el bucket para que se recree en el próximo apply',
      'Mueve el bucket a otro workspace',
    ],
    correct: [0],
    explanation:
      'El objeto real sigue existiendo, pero Terraform se "olvida" de él. Si el bloque `resource` sigue en el código, el siguiente plan intentará **crearlo** de nuevo. La alternativa declarativa es el bloque `removed` con `lifecycle { destroy = false }`.',
  },
  {
    id: 'maint-08',
    objective: 7,
    subtopic: 'Reemplazar recursos',
    kind: 'single',
    prompt: 'Una instancia está degradada y quieres que Terraform la destruya y la vuelva a crear aunque su configuración no haya cambiado. ¿Qué haces?',
    options: [
      '`terraform apply -replace="aws_instance.web"`',
      '`terraform taint aws_instance.web` (método recomendado actualmente)',
      '`terraform state rm aws_instance.web` y luego `terraform apply`',
      '`terraform apply -refresh-only`',
    ],
    correct: [0],
    explanation:
      '`-replace` muestra el reemplazo en el plan y es el método recomendado. `terraform taint` está **obsoleto**. Usar `state rm` crearía una instancia nueva dejando la antigua huérfana (sin destruir).',
  },
  {
    id: 'maint-09',
    objective: 7,
    subtopic: 'Logging',
    kind: 'single',
    prompt: '¿Qué valor de `TF_LOG` produce la salida **más detallada**?',
    options: ['`TRACE`', '`DEBUG`', '`INFO`', '`ERROR`'],
    correct: [0],
    explanation:
      'Niveles de más a menos detalle: `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`. También existe `JSON` (nivel TRACE en formato JSON). Para desactivarlo basta con no definir `TF_LOG` (o usar `OFF`).',
  },
  {
    id: 'maint-10',
    objective: 7,
    subtopic: 'Logging',
    kind: 'single',
    prompt: 'Defines `TF_LOG_PATH=./terraform.log` pero **no** defines `TF_LOG`. ¿Qué ocurre?',
    options: [
      'No se escribe ningún log: `TF_LOG_PATH` solo tiene efecto si el logging está activado con `TF_LOG`',
      'Se escribe el log a nivel TRACE en `terraform.log`',
      'Se escribe el log a nivel INFO en `terraform.log`',
      'Terraform devuelve un error de configuración',
    ],
    correct: [0],
    explanation:
      '`TF_LOG_PATH` solo indica **dónde** escribir; el logging se activa con `TF_LOG` (o `TF_LOG_CORE`/`TF_LOG_PROVIDER`).',
  },
  {
    id: 'maint-11',
    objective: 7,
    subtopic: 'Logging',
    kind: 'single',
    prompt: 'Sospechas de un problema en el proveedor y quieres logs detallados **solo de los proveedores**, no de Terraform Core. ¿Qué variable usas?',
    options: ['`TF_LOG_PROVIDER=DEBUG`', '`TF_LOG=PROVIDER`', '`TF_PROVIDER_DEBUG=1`', '`TF_LOG_CORE=DEBUG`'],
    correct: [0],
    explanation:
      '`TF_LOG_CORE` y `TF_LOG_PROVIDER` permiten activar el logging por separado para el núcleo y para los proveedores, con los mismos niveles que `TF_LOG`.',
  },
  {
    id: 'maint-12',
    objective: 7,
    subtopic: 'Bloques removed',
    kind: 'single',
    prompt:
      '¿Qué consigue este bloque al aplicarlo (tras eliminar el bloque `resource "aws_instance" "old"`)?\n\n' +
      hcl(`
removed {
  from = aws_instance.old

  lifecycle {
    destroy = false
  }
}`),
    options: [
      'Quita la instancia del estado sin destruirla, como un `state rm` declarativo y visible en el plan',
      'Destruye la instancia y la elimina del estado',
      'Impide que nadie borre la instancia desde la consola',
      'Mueve la instancia a otro módulo',
    ],
    correct: [0],
    explanation:
      'El bloque `removed` (1.7+) con `destroy = false` hace que Terraform "olvide" el recurso. Con `destroy = true` (o sin el bloque) el plan lo destruiría.',
  },
  {
    id: 'maint-13',
    objective: 7,
    subtopic: 'terraform state mv',
    kind: 'truefalse',
    prompt: 'Al mover un recurso a un módulo con `terraform state mv aws_vpc.main module.network.aws_vpc.main`, Terraform recrea la VPC.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** `state mv` solo cambia la **dirección** en el estado; el objeto real no se toca. Si se actualiza el código a la vez, el siguiente plan no mostrará cambios. Hoy se prefiere un bloque `moved` porque queda revisado en el plan.',
  },

  // ------------------------------------------------------- 8 · HCP Terraform
  {
    id: 'hcp-01',
    objective: 8,
    subtopic: 'Workspaces y projects',
    kind: 'single',
    prompt: '¿Cuál es la jerarquía de organización de recursos en HCP Terraform?',
    options: ['Organización → Project → Workspace', 'Workspace → Project → Organización', 'Equipo → Workspace → Project', 'Organización → Workspace → Module'],
    correct: [0],
    explanation:
      'Una **organización** agrupa **projects**, y cada project agrupa **workspaces**. Los projects permiten asignar permisos y variable sets a grupos de workspaces.',
  },
  {
    id: 'hcp-02',
    objective: 8,
    subtopic: 'Workspaces y projects',
    kind: 'single',
    prompt: '¿Qué contiene un workspace de HCP Terraform que **no** tiene un workspace de la CLI?',
    options: [
      'Además del estado: variables, historial de ejecuciones, configuración de VCS y permisos de equipo',
      'Solo el fichero de estado',
      'Los binarios de los proveedores',
      'Nada: son exactamente lo mismo',
    ],
    correct: [0],
    explanation:
      'Un workspace CLI es solo un estado alternativo en el mismo backend. Un workspace de HCP Terraform es una unidad completa: estado (con versiones), variables, ejecuciones, políticas, permisos y conexión VCS.',
  },
  {
    id: 'hcp-03',
    objective: 8,
    subtopic: 'Variable sets',
    kind: 'single',
    prompt: 'Quieres usar las mismas credenciales de nube en 40 workspaces sin definirlas en cada uno. ¿Qué funcionalidad de HCP Terraform utilizas?',
    options: ['Variable sets aplicados a la organización, a projects o a workspaces concretos', 'Un fichero `terraform.tfvars` en cada repositorio', 'Run tasks', 'El registro privado'],
    correct: [0],
    explanation:
      'Los **variable sets** agrupan variables (de Terraform o de entorno, sensibles o no) y se aplican de forma global, por project o por workspace. Evitan duplicar y facilitan rotar credenciales.',
  },
  {
    id: 'hcp-04',
    objective: 8,
    subtopic: 'Flujos de trabajo',
    kind: 'multi',
    prompt: '¿Qué flujos de ejecución ofrece HCP Terraform para lanzar runs en un workspace? **Elige tres.**',
    options: ['Flujo dirigido por VCS', 'Flujo dirigido por la CLI', 'Flujo dirigido por la API', 'Flujo por subida FTP', 'Flujo por correo electrónico'],
    correct: [0, 1, 2],
    explanation:
      '**VCS** (cada commit/PR dispara runs), **CLI** (`terraform plan/apply` en local, ejecución remota) y **API** (integración con otras herramientas, subiendo versiones de configuración).',
  },
  {
    id: 'hcp-05',
    objective: 8,
    subtopic: 'Flujo VCS',
    kind: 'single',
    prompt: 'En un workspace con flujo VCS, un desarrollador abre una pull request contra la rama configurada. ¿Qué hace HCP Terraform?',
    options: [
      'Lanza un plan especulativo y publica el resultado en la pull request',
      'Aplica los cambios automáticamente',
      'Nada hasta que se haga merge',
      'Bloquea la rama hasta que alguien ejecute `terraform apply` en local',
    ],
    correct: [0],
    explanation:
      'Las PR generan **planes especulativos** (solo lectura) para revisar el impacto. Al hacer merge a la rama, se lanza un run normal que puede aplicarse (manualmente o con auto-apply).',
  },
  {
    id: 'hcp-06',
    objective: 8,
    subtopic: 'terraform login',
    kind: 'single',
    prompt: '¿Qué hace `terraform login`?',
    options: [
      'Obtiene un token de API de HCP Terraform (u otro host) y lo guarda en `credentials.tfrc.json`',
      'Inicia sesión en el proveedor de nube configurado',
      'Crea una cuenta nueva en HCP Terraform',
      'Guarda el token dentro del bloque `cloud`',
    ],
    correct: [0],
    explanation:
      'Abre el navegador para generar un token y lo almacena localmente para que la CLI se autentique. No tiene nada que ver con las credenciales de AWS/Azure/GCP. Nunca debe escribirse el token en el código.',
  },
  {
    id: 'hcp-07',
    objective: 8,
    subtopic: 'Bloque cloud',
    kind: 'single',
    prompt:
      'Con esta configuración y el workspace en modo de ejecución remota, ejecutas `terraform plan` en tu portátil. ¿Qué ocurre?\n\n' +
      hcl(`
terraform {
  cloud {
    organization = "acme"
    workspaces {
      name = "app-prod"
    }
  }
}`),
    options: [
      'El plan se ejecuta en HCP Terraform y la salida se muestra en tu terminal',
      'El plan se ejecuta en local y el estado se guarda en `terraform.tfstate`',
      'Error: el bloque `cloud` solo se usa con el flujo VCS',
      'El plan se ejecuta en local y se sube después a HCP Terraform',
    ],
    correct: [0],
    explanation:
      'Es el **flujo CLI**: el código se sube y el run se ejecuta remotamente, usando las variables y el estado del workspace; la salida se transmite a tu terminal. Si el workspace estuviera en modo local, solo el estado se guardaría en HCP Terraform.',
  },
  {
    id: 'hcp-08',
    objective: 8,
    subtopic: 'Bloque cloud',
    kind: 'single',
    prompt: 'Tienes estado en local y añades un bloque `cloud`. ¿Cómo migras el estado a HCP Terraform?',
    options: [
      'Ejecutando `terraform init`, que detecta el cambio y ofrece migrar el estado al workspace',
      'Subiendo `terraform.tfstate` por correo al administrador',
      'Ejecutando `terraform apply -cloud`',
      'No es posible: hay que destruir y recrear la infraestructura',
    ],
    correct: [0],
    explanation:
      'Como con cualquier cambio de backend, `terraform init` inicializa la integración y pregunta si quieres migrar el estado existente.',
  },
  {
    id: 'hcp-09',
    objective: 8,
    subtopic: 'Gobernanza: políticas',
    kind: 'single',
    prompt: '¿En qué momento de un run de HCP Terraform se evalúan las políticas de **Sentinel** u **OPA**?',
    options: ['Después del plan y antes del apply', 'Antes del plan', 'Después del apply', 'Solo al crear el workspace'],
    correct: [0],
    explanation:
      'Las políticas como código evalúan el plan (y otros datos) para decidir si el run puede continuar a la fase de apply. Así se bloquean, p. ej., instancias demasiado grandes o buckets públicos **antes** de crearlos.',
  },
  {
    id: 'hcp-10',
    objective: 8,
    subtopic: 'Gobernanza: políticas',
    kind: 'single',
    prompt: 'Una política de Sentinel falla. ¿Qué nivel de aplicación permite que un usuario autorizado la **anule** y continúe el run?',
    options: ['`soft-mandatory`', '`hard-mandatory`', '`advisory`', 'Ninguno: los fallos nunca se pueden anular'],
    correct: [0],
    explanation:
      '`advisory` solo avisa (el run sigue), `soft-mandatory` detiene el run pero permite un *override* por usuarios con permiso, y `hard-mandatory` no puede anularse. En OPA los niveles son `advisory` y `mandatory`.',
  },
  {
    id: 'hcp-11',
    objective: 8,
    subtopic: 'Run tasks',
    kind: 'single',
    prompt: '¿Para qué sirven las **run tasks** en HCP Terraform?',
    options: [
      'Para integrar servicios externos (escaneo de seguridad, costes, cumplimiento…) en fases concretas del run, como pre-plan, post-plan o pre-apply',
      'Para programar `terraform destroy` en horarios concretos',
      'Para ejecutar scripts dentro de las máquinas virtuales creadas',
      'Para sustituir a los proveedores',
    ],
    correct: [0],
    explanation:
      'Una run task envía datos del run a un servicio externo que devuelve un resultado; según su nivel (`advisory` o `mandatory`) puede bloquear el run. No son provisioners ni planificadores.',
  },
  {
    id: 'hcp-12',
    objective: 8,
    subtopic: 'Registro privado',
    kind: 'single',
    prompt: '¿Cuál es la dirección `source` de un módulo publicado en el **registro privado** de la organización `acme` en HCP Terraform?',
    options: ['`app.terraform.io/acme/vpc/aws`', '`acme/vpc/aws`', '`private://acme/vpc`', '`registry.terraform.io/private/acme/vpc`'],
    correct: [0],
    explanation:
      'Los módulos privados añaden el **hostname** delante: `<HOST>/<ORG>/<NOMBRE>/<PROVEEDOR>`. Sin host (`acme/vpc/aws`), Terraform lo buscaría en el registro público. El registro privado también puede alojar proveedores.',
  },
  {
    id: 'hcp-13',
    objective: 8,
    subtopic: 'Equipos y permisos',
    kind: 'single',
    prompt: 'Quieres que el equipo de desarrollo pueda lanzar planes en el workspace de producción pero **no** aplicar cambios. ¿Qué haces?',
    options: [
      'Asignar al equipo el permiso `Plan` sobre ese workspace (o un permiso personalizado equivalente)',
      'Darles acceso de `Admin` y pedirles que no apliquen',
      'Quitarles el acceso al repositorio VCS',
      'Configurar una política Sentinel `advisory`',
    ],
    correct: [0],
    explanation:
      'Los permisos se asignan a **equipos** a nivel de organización, project o workspace. Los niveles fijos de workspace son `Read`, `Plan`, `Write` y `Admin`; `Plan` permite crear runs pero no aplicarlos.',
  },
  {
    id: 'hcp-14',
    objective: 8,
    subtopic: 'Planes especulativos',
    kind: 'truefalse',
    prompt: 'Un plan especulativo de HCP Terraform puede aplicarse si un administrador lo confirma.',
    options: TF,
    correct: [1],
    explanation:
      '**Falso.** Los planes especulativos (de PR o `terraform plan` en el flujo CLI) son **solo informativos** y nunca se pueden aplicar. Para aplicar hay que lanzar un run normal.',
  },
  {
    id: 'hcp-15',
    objective: 8,
    subtopic: 'Variables sensibles',
    kind: 'truefalse',
    prompt: 'Una variable marcada como **sensible** en un workspace de HCP Terraform pasa a ser de solo escritura: no puede volver a leerse desde la interfaz ni desde la API.',
    options: TF,
    correct: [0],
    explanation:
      '**Verdadero.** Los valores sensibles se guardan cifrados y solo se pueden sobrescribir, no leer. Terraform los recibe durante el run.',
  },
  {
    id: 'hcp-16',
    objective: 8,
    subtopic: 'Health assessments',
    kind: 'single',
    prompt: '¿Qué funcionalidad de HCP Terraform comprueba periódicamente si la infraestructura de un workspace ha sufrido **drift** o si fallan sus bloques `check`?',
    options: ['Health assessments (detección de drift y validación continua)', 'Run tasks pre-plan', 'Políticas Sentinel advisory', 'El registro privado'],
    correct: [0],
    explanation:
      'Los **health assessments** ejecutan periódicamente un plan *refresh-only* para detectar drift y evalúan las comprobaciones (`check`, condiciones) sin aplicar cambios, notificando los problemas.',
  },
  {
    id: 'hcp-17',
    objective: 8,
    subtopic: 'Bloque cloud',
    kind: 'single',
    prompt: 'En el bloque `cloud`, ¿qué permite usar `workspaces { tags = ["app:web"] }` en lugar de `name`?',
    options: [
      'Trabajar con varios workspaces que tengan esas etiquetas, eligiéndolos con `terraform workspace select`',
      'Aplicar etiquetas a todos los recursos de la nube',
      'Filtrar qué variables se cargan',
      'Crear automáticamente un project con ese nombre',
    ],
    correct: [0],
    explanation:
      'Con `name` la configuración se asocia a **un** workspace. Con `tags` puede usarse con **varios** workspaces etiquetados, y la CLI permite cambiar entre ellos. No etiqueta recursos de la nube.',
  },
];

// ---------------------------------------------------------------- helpers

/** Distribución de preguntas del simulacro completo (suma 57). */
export const EXAM_WEIGHTS: Record<ObjectiveId, number> = { 1: 4, 2: 6, 3: 8, 4: 13, 5: 6, 6: 7, 7: 6, 8: 7 };
export const FULL_EXAM_SIZE = 57;
export const FULL_EXAM_MINUTES = 60;
export const PASS_MARK = 70;

export type Rng = () => number;

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Reparte `total` entre objetivos de forma proporcional a `weights`
 * (método del resto mayor), respetando las preguntas disponibles y
 * redistribuyendo lo que no quepa.
 */
export function allocate(total: number, weights: Partial<Record<ObjectiveId, number>>, available: Partial<Record<ObjectiveId, number>>): Record<number, number> {
  const ids = (Object.keys(weights).map(Number) as ObjectiveId[]).filter((id) => (weights[id] ?? 0) > 0 && (available[id] ?? 0) > 0);
  const out: Record<number, number> = {};
  for (const id of ids) out[id] = 0;
  const cap = ids.reduce((s, id) => s + (available[id] ?? 0), 0);
  let remaining = Math.min(total, cap);
  let open = ids.slice();
  while (remaining > 0 && open.length > 0) {
    const wsum = open.reduce((s, id) => s + weights[id]!, 0);
    const quotas = open.map((id) => ({ id, q: (remaining * weights[id]!) / wsum }));
    let given = 0;
    for (const { id, q } of quotas) {
      const n = Math.min(Math.floor(q), (available[id] ?? 0) - out[id]);
      out[id] += n;
      given += n;
    }
    const byRemainder = quotas.slice().sort((a, b) => b.q - Math.floor(b.q) - (a.q - Math.floor(a.q)));
    for (const { id } of byRemainder) {
      if (given >= remaining) break;
      if (out[id] < (available[id] ?? 0)) {
        out[id]++;
        given++;
      }
    }
    remaining -= given;
    open = open.filter((id) => out[id] < (available[id] ?? 0));
    if (given === 0) break;
  }
  return out;
}

function countByObjective(bank: readonly ExamQuestion[]): Partial<Record<ObjectiveId, number>> {
  const c: Partial<Record<ObjectiveId, number>> = {};
  for (const q of bank) c[q.objective] = (c[q.objective] ?? 0) + 1;
  return c;
}

/** Simulacro: `total` preguntas aleatorias repartidas proporcionalmente por objetivo. */
export function buildExam(bank: readonly ExamQuestion[], total = FULL_EXAM_SIZE, rng: Rng = Math.random, weights: Partial<Record<ObjectiveId, number>> = EXAM_WEIGHTS): ExamQuestion[] {
  const alloc = allocate(total, weights, countByObjective(bank));
  const picked: ExamQuestion[] = [];
  for (const [id, n] of Object.entries(alloc)) {
    const pool = bank.filter((q) => q.objective === Number(id));
    picked.push(...shuffle(pool, rng).slice(0, n));
  }
  return shuffle(picked, rng);
}

/** Práctica: `count` preguntas de los objetivos elegidos, proporcional al tamaño de cada objetivo en el banco. */
export function buildPractice(bank: readonly ExamQuestion[], objectives: readonly ObjectiveId[], count: number, rng: Rng = Math.random): ExamQuestion[] {
  const pool = bank.filter((q) => objectives.includes(q.objective));
  const avail = countByObjective(pool);
  return buildExam(pool, count, rng, avail);
}

/** ¿La respuesta (índices originales) es exactamente la correcta? */
export function isCorrect(q: ExamQuestion, answer: readonly number[] | undefined): boolean {
  if (!answer || answer.length !== q.correct.length) return false;
  return q.correct.every((c) => answer.includes(c));
}
