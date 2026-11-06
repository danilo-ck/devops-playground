import type { LearningModule } from '@/core/types';
import { registerHighlighter } from '@/core/highlighters';
import { highlightHcl } from './components/highlight';
import { terraformLessons } from './lessons';
import { TerraformLessonView } from './TerraformLessonView';
import { lazy } from 'react';
import { bestSimulacroScore } from './exam/history';

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
  topics: ['HCL', 'plan / apply', 'Módulos', 'Estado y backends', 'Drift e import', 'HCP Terraform', 'Certificación Associate'],
  lessons: terraformLessons.map(({ id, title, summary, difficulty, duration, concepts, freeform }) => ({ id, title, summary, difficulty, duration, concepts, freeform })),
  LessonView: TerraformLessonView,
  exam: {
    title: 'Prepara la certificación Terraform Associate (004)',
    summary: 'Simulacros cronometrados de 57 preguntas y práctica por objetivo con explicaciones detalladas.',
    // El banco de preguntas solo se descarga al abrir el examen.
    View: lazy(() => import('./exam/ExamView').then((m) => ({ default: m.ExamView }))),
    bestScore: () => bestSimulacroScore(),
  },
};
