// Global UI state: the signed-in user, toasts and the confirm dialog.
import { create } from 'zustand';
import type { Me } from './types';

export type AuthState = { status: 'loading' } | { status: 'signedOut' } | { status: 'signedIn'; me: Me };

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

interface ConfirmRequest {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

/** Colour theme: follow the OS, or force light / dark (user menu → Giao diện). Remembered per browser. */
export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'compola-admin-theme';

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

interface State {
  auth: AuthState;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  theme: Theme;
  setAuth: (auth: AuthState) => void;
  setTheme: (theme: Theme) => void;
}

export const useStore = create<State>((set) => ({
  auth: { status: 'loading' },
  toasts: [],
  confirm: null,
  theme: readTheme(),
  setAuth: (auth) => set({ auth }),
  setTheme: (theme) => {
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage blocked (private window): the choice lasts for this page only.
    }
    applyTheme(theme);
    set({ theme });
  },
}));

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'ok') {
  const id = ++toastId;
  useStore.setState((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
  setTimeout(() => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 6000 : 3000);
}

export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), 'error');
}

export function confirmDialog(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    useStore.setState({
      confirm: {
        ...opts,
        resolve: (ok) => {
          useStore.setState({ confirm: null });
          resolve(ok);
        },
      },
    });
  });
}

export function useMe(): Me | null {
  return useStore((s) => (s.auth.status === 'signedIn' ? s.auth.me : null));
}
