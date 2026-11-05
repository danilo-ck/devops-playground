import type { LearningModule } from '@/core/types';
import { terraformModule } from './terraform';
import { comingSoonModules } from './coming-soon';

/** Registro central de módulos. Añade aquí los nuevos módulos. */
export const modules: LearningModule[] = [terraformModule, ...comingSoonModules];

export const getModule = (id: string | undefined) => modules.find((m) => m.id === id);
