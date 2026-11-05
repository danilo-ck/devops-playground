import type { ComponentType } from 'react';

/**
 * Contrato que cumple cada módulo de aprendizaje (Terraform, Docker, Kubernetes…).
 *
 * Para añadir un módulo nuevo:
 *   1. Crea src/modules/<id>/index.ts exportando un LearningModule.
 *   2. Regístralo en src/modules/index.ts.
 * La plataforma (home, rutas, progreso, panel de lección) funciona sin más cambios.
 */
export type Difficulty = 'Básico' | 'Intermedio' | 'Avanzado';

export interface LessonMeta {
  id: string;
  title: string;
  summary: string;
  difficulty: Difficulty;
  /** Duración estimada, p.ej. "10 min". */
  duration: string;
  concepts: string[];
  /** Las lecciones "libres" (sandbox) no cuentan para el progreso. */
  freeform?: boolean;
}

export interface LessonViewProps {
  moduleId: string;
  lessonId: string;
}

export interface LearningModule {
  id: string;
  title: string;
  tagline: string;
  description: string;
  /** Color principal del módulo (CSS). */
  accent: string;
  /** Emoji o texto corto usado como icono. */
  icon: string;
  status: 'available' | 'coming-soon';
  /** Temas que cubrirá (se muestran en la tarjeta). */
  topics: string[];
  lessons: LessonMeta[];
  /** Componente que renderiza el espacio de trabajo interactivo de una lección. */
  LessonView?: ComponentType<LessonViewProps>;
}

/** Un objetivo verificable de una lección. `T` es el contexto propio del módulo. */
export interface Objective<T> {
  id: string;
  label: string;
  check: (ctx: T) => boolean;
}
