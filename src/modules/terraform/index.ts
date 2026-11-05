import type { LearningModule } from '@/core/types';
import { registerHighlighter } from '@/core/highlighters';
import { highlightHcl } from './components/highlight';
import { terraformLessons } from './lessons';
import { TerraformLessonView } from './TerraformLessonView';

registerHighlighter('hcl', highlightHcl);
registerHighlighter('terraform', highlightHcl);

export const terraformModule: LearningModule = {
  id: 'terraform',
  title: 'Terraform',
  tagline: 'Infraestructura como código',
  description:
    'Declara redes, servidores y buckets en HCL y observa en tiempo real cómo Terraform planifica, crea, modifica y destruye tu infraestructura en una nube simulada.',
  accent: '#7b42bc',
  icon: '🏗️',
  status: 'available',
  topics: ['HCL', 'plan / apply', 'Variables', 'Dependencias', 'count / for_each', 'Estado'],
  lessons: terraformLessons.map(({ id, title, summary, difficulty, duration, concepts, freeform }) => ({ id, title, summary, difficulty, duration, concepts, freeform })),
  LessonView: TerraformLessonView,
};
