import { useEffect, useState } from 'react';
import { BotAvatar } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { shortSha, boardClosed, type DeployStatusPayload } from '../lib/deploy-format';
import { useStore } from '../store';
import { TrafficLights } from './Sidebar';

export function SignIn() {
  const devLogin = useStore((s) => s.devLogin);
  const googleLogin = useStore((s) => s.googleLogin);
  const checkAuth = useStore((s) => s.checkAuth);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => (new URLSearchParams(location.search).get('login') === 'failed' ? 'Sign-in didn’t finish. Try again.' : null));
  const [deploy, setDeploy] = useState<DeployStatusPayload | null>(null);

  useEffect(() => {
    fetch('/api/deploy-status', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) setDeploy(j as DeployStatusPayload); })
      .catch(() => {});
  }, []);

  const dev = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) { setError('Enter an email address'); return; }
    setBusy(true); setError(null);
    try { await api.devLogin(email.trim(), name.trim() || undefined); await checkAuth(); } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  const closed = boardClosed(deploy?.board);

  return (
    <div className="signin">
      <div className="signin__chrome"><TrafficLights /></div>

      <aside className="signin__rail" aria-label="Workspace status">
        <div className="signin__mark" aria-hidden>
          <span className="signin__mark-glyph">U</span>
        </div>
        <div className="signin__rail-copy">
          <p className="signin__kicker">Operate surface</p>
          <h2 className="signin__rail-title">Agent Console</h2>
          <p className="signin__rail-body">Steer a fleet of Hermes agents. Tools stay gated. Receipts stay honest.</p>
        </div>
        <dl className="signin__stats">
          <div>
            <dt>Build</dt>
            <dd><code>{shortSha(deploy?.sha, 9)}</code></dd>
          </div>
          <div>
            <dt>Board</dt>
            <dd>{closed.total ? closed.label : '—'}</dd>
          </div>
          <div>
            <dt>Live</dt>
            <dd className="signin__live">{deploy?.sha ? 'synced' : 'checking…'}</dd>
          </div>
        </dl>
      </aside>

      <div className="signin__card">
        <div className="signin__hero">
          <BotAvatar shape="blob" color="black" size={72} />
        </div>
        <p className="signin__product">Universal Agent Platform</p>
        <h1 className="signin__title">Sign in to the console</h1>
        <p className="signin__sub">Connect agents, manage work, keep tools under your control.</p>
        {googleLogin && <a className="btn btn--primary signin__google" href="/api/auth/google/start">Sign in with Google</a>}
        {!googleLogin && !devLogin && <p className="signin__sub">Ask your operator for a sign-in link to this workspace.</p>}
        {devLogin && (
          <form className="signin__dev" onSubmit={dev}>
            <div className="signin__divider"><span>Dev sign-in</span></div>
            <input className="text-input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            <input className="text-input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <button type="submit" className="btn btn--secondary" disabled={busy}>{busy ? 'Signing in…' : 'Continue with email'}</button>
          </form>
        )}
        {error && <div className="card__error signin__error">{error}</div>}
        <p className="signin__foot">Powered by Hermes · providers configured by your operator</p>
      </div>
    </div>
  );
}
