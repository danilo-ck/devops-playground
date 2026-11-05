import type { LearningModule } from '@/core/types';

/**
 * Módulos planificados. Aparecen en la home como "Próximamente" y sirven de
 * hoja de ruta. Para activarlos basta con implementar su LessonView y lecciones.
 */
export const comingSoonModules: LearningModule[] = [
  {
    id: 'docker',
    title: 'Docker',
    tagline: 'Contenedores desde cero',
    description: 'Imágenes, capas, contenedores, volúmenes y redes, visualizando cómo se apilan las capas y cómo se comunican los contenedores.',
    accent: '#2496ed',
    icon: '🐳',
    status: 'coming-soon',
    topics: ['Dockerfile', 'Capas e imágenes', 'Volúmenes', 'Redes', 'Compose'],
    lessons: [],
  },
  {
    id: 'kubernetes',
    title: 'Kubernetes',
    tagline: 'Orquestación de contenedores',
    description: 'Pods, Deployments, Services e Ingress en un clúster simulado donde verás el scheduler, los réplicas y el autoescalado en acción.',
    accent: '#326ce5',
    icon: '☸️',
    status: 'coming-soon',
    topics: ['Pods', 'Deployments', 'Services', 'ConfigMaps', 'HPA'],
    lessons: [],
  },
  {
    id: 'cicd',
    title: 'CI/CD',
    tagline: 'Pipelines de integración y despliegue',
    description: 'Diseña pipelines con stages, jobs y artefactos, y observa cómo fluye cada commit hasta producción.',
    accent: '#f05032',
    icon: '🚀',
    status: 'coming-soon',
    topics: ['Pipelines', 'Stages y jobs', 'Artefactos', 'Entornos', 'Estrategias de despliegue'],
    lessons: [],
  },
  {
    id: 'ansible',
    title: 'Ansible',
    tagline: 'Gestión de configuración',
    description: 'Inventarios, playbooks y roles aplicados sobre una flota de servidores simulada, con idempotencia visible.',
    accent: '#ee0000',
    icon: '📜',
    status: 'coming-soon',
    topics: ['Inventario', 'Playbooks', 'Módulos', 'Roles', 'Idempotencia'],
    lessons: [],
  },
  {
    id: 'observability',
    title: 'Observabilidad',
    tagline: 'Métricas, logs y trazas',
    description: 'Instrumenta servicios, crea dashboards y alertas, y sigue una petición a través de un sistema distribuido.',
    accent: '#f46800',
    icon: '📈',
    status: 'coming-soon',
    topics: ['Métricas', 'Logs', 'Trazas', 'Alertas', 'SLOs'],
    lessons: [],
  },
];
