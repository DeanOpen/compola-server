// Hash routing: `#/users`, `#/device?code=ABCD-EFGH`. No router library.
import { useSyncExternalStore } from 'react';

export interface Route {
  path: string;
  query: URLSearchParams;
  /** The hash without `#`, e.g. "/device?code=ABCD-EFGH" (what `next` remembers). */
  full: string;
}

function current(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h.startsWith('/') ? h : '/' + h;
}

let cachedKey = '';
let cached: Route = parse('/');
function parse(full: string): Route {
  const i = full.indexOf('?');
  const path = (i >= 0 ? full.slice(0, i) : full).replace(/\/+$/, '') || '/';
  return { path, query: new URLSearchParams(i >= 0 ? full.slice(i + 1) : ''), full };
}

function snapshot(): Route {
  const key = current();
  if (key !== cachedKey) {
    cachedKey = key;
    cached = parse(key);
  }
  return cached;
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot);
}

export function getRoute(): Route {
  return snapshot();
}

export function navigate(to: string, replace = false) {
  const hash = '#' + (to.startsWith('/') ? to : '/' + to);
  if (replace) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
}

/** `#/login?next=/device%3Fcode%3D…` → "/device?code=…" (only same-app routes). */
export function nextFrom(route: Route): string {
  const n = route.query.get('next');
  return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') ? n : '/';
}
