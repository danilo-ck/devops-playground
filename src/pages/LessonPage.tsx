import { Navigate, useParams } from 'react-router-dom';
import { getModule } from '@/modules';

export function LessonPage() {
  const { moduleId, lessonId } = useParams();
  const mod = getModule(moduleId);
  if (!mod || mod.status !== 'available' || !mod.LessonView) return <Navigate to="/" replace />;
  if (!mod.lessons.some((l) => l.id === lessonId)) return <Navigate to={`/m/${mod.id}`} replace />;
  const View = mod.LessonView;
  return <View key={lessonId} moduleId={mod.id} lessonId={lessonId!} />;
}
