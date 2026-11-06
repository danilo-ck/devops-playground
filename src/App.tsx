import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { HomePage } from './pages/HomePage';
import { ModulePage } from './pages/ModulePage';
import { LessonPage } from './pages/LessonPage';
import { ExamPage } from './pages/ExamPage';
import { NotFound } from './pages/NotFound';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="m/:moduleId" element={<ModulePage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="m/:moduleId/examen" element={<AppShell compact />}>
        <Route index element={<ExamPage />} />
      </Route>
      <Route path="m/:moduleId/:lessonId" element={<AppShell compact />}>
        <Route index element={<LessonPage />} />
      </Route>
    </Routes>
  );
}
