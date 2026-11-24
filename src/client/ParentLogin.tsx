import { ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { SessionInfo } from '../shared/types';
import { send } from './api';
import { Brand, Cover, ErrorNotice } from './components';
export function ParentLogin({
  setupRequired,
  onLogin,
}: {
  setupRequired: boolean;
  onLogin: (s: SessionInfo) => void;
}) {
  const [password, setPassword] = useState(''),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <div className="login-art">
        <Brand />
        <Cover src="/art/sunshine.svg?v=2" />
        <h1>
          Their music.
          <br />
          Her choice.
        </h1>
        <p>Her favourites, ready to play. You choose what’s available.</p>
      </div>
      <div className="login-form-wrap">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void send<SessionInfo>(
              `/api/auth/${setupRequired ? 'setup' : 'login'}`,
              { password, ...(setupRequired ? { setupCode: code } : {}) },
            )
              .then(onLogin)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <span className="large-symbol">
            <ShieldCheck />
          </span>
          <p className="eyebrow">PARENT SPACE</p>
          <h1>{setupRequired ? 'Make yourself at home.' : 'Welcome back.'}</h1>
          <p>
            {setupRequired
              ? 'Create your parent password to manage their music.'
              : 'Manage their library, player and settings.'}
          </p>
          {setupRequired && (
            <label>
              One-time setup code
              <input
                aria-label="Setup code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoComplete="off"
              />
              <small>
                Find this in the server startup log, or use PARENT_SETUP_CODE.
              </small>
            </label>
          )}
          <label>
            Parent password
            <input
              aria-label="Parent password"
              type="password"
              minLength={12}
              maxLength={200}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={setupRequired ? 'new-password' : 'current-password'}
              required
            />
          </label>
          {setupRequired && <small>Choose at least 12 characters.</small>}
          <ErrorNotice message={error} />
          <button
            className="button primary full-width"
            disabled={busy}
            type="submit"
          >
            {busy
              ? 'Opening…'
              : setupRequired
                ? 'Create parent account'
                : 'Log in'}
            <ArrowRight size={18} />
          </button>
          <a className="login-back" href="/simulator">
            <ArrowLeft size={16} /> Back to the virtual Lenovo
          </a>
        </form>
      </div>
    </div>
  );
}
