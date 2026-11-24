import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Brand } from './components';
import './style.css';
const Admin = lazy(() =>
  import('./Admin').then((module) => ({ default: module.Admin })),
);
const Child = lazy(() =>
  import('./Child').then((module) => ({ default: module.Child })),
);
const Simulator = lazy(() =>
  import('./Simulator').then((module) => ({ default: module.Simulator })),
);
class Boundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="center-page">
        <Brand />
        <h1>Let’s try that again.</h1>
        <p>The player needs a fresh start.</p>
        <button onClick={() => location.reload()}>Reload player</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const route = location.pathname;
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Boundary>
      <Suspense
        fallback={
          <div className="center-page">
            <Brand />
            <p>Opening Music Hub…</p>
          </div>
        }
      >
        {route.startsWith('/admin') ? (
          <Admin />
        ) : route.startsWith('/simulator') || route === '/' ? (
          <Simulator />
        ) : (
          <Child />
        )}
      </Suspense>
    </Boundary>
  </React.StrictMode>,
);
