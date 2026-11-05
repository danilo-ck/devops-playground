import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ProgressState {
  /** Claves "modulo/leccion" completadas. */
  completed: Record<string, number>;
  markComplete: (moduleId: string, lessonId: string) => void;
  isComplete: (moduleId: string, lessonId: string) => boolean;
  resetModule: (moduleId: string) => void;
}

export const useProgress = create<ProgressState>()(
  persist(
    (set, get) => ({
      completed: {},
      markComplete: (m, l) => {
        const key = `${m}/${l}`;
        if (get().completed[key]) return;
        set((s) => ({ completed: { ...s.completed, [key]: Date.now() } }));
      },
      isComplete: (m, l) => !!get().completed[`${m}/${l}`],
      resetModule: (m) =>
        set((s) => ({
          completed: Object.fromEntries(Object.entries(s.completed).filter(([k]) => !k.startsWith(`${m}/`))),
        })),
    }),
    { name: 'devopslab:progress' },
  ),
);

/** Almacenamiento local tolerante a fallos (modo privado, cuota llena…). */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignorar */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignorar */
    }
  },
};
