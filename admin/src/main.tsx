import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, readTheme } from './store';
import './styles.css';
import logo from '../../src/assets/compola-logo.svg';

// Before the first render, so a forced theme does not flash the OS one.
applyTheme(readTheme());

// The tab icon: the app's logo (the host serves no favicon of its own).
const icon = Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/svg+xml', href: logo });
document.head.appendChild(icon);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
