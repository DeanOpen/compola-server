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

interface State {
  auth: AuthState;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  setAuth: (auth: AuthState) => void;
}

export const useStore = create<State>((set) => ({
  auth: { status: 'loading' },
  toasts: [],
  confirm: null,
  setAuth: (auth) => set({ auth }),
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
