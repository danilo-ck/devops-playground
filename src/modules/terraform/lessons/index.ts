import type { TerraformLesson } from './types';
import { lesson01 } from './01-primer-recurso';
import { lesson02 } from './02-variables-outputs';
import { lesson03 } from './03-dependencias';
import { lesson04 } from './04-ciclo-de-vida';
import { lesson05 } from './05-count-foreach';
import { lesson06 } from './06-locals-funciones';
import { lesson07 } from './07-modulos';
import { lesson08 } from './08-arquitectura-web';
import { lesson09 } from './09-estado';
import { sandbox } from './sandbox';

/** Orden de la ruta de aprendizaje. Añadir una lección = crear el fichero y listarlo aquí. */
export const terraformLessons: TerraformLesson[] = [lesson01, lesson02, lesson03, lesson04, lesson05, lesson06, lesson07, lesson08, lesson09, sandbox];
