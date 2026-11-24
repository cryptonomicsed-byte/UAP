/**
 * Operate rail — always-visible agent controls for the details sidecar.
 * Honest empty states when Orgo / xAI / Composio / Hermes are unconfigured.
 */
import { useEffect, useState } from 'react';
import { isProviderConfigured, providerRecovery, type OptionalProvider } from '../lib/providers';
import { computerStatusText } from '../lib/computer';
import { useSelectedBot, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { Icon } from './Icon';
import { EngineSettings } from './EngineSettings';
import { VoiceSettings } from './VoiceSettings';

type SurfaceStatus = {
  providers: Record<string, { status: string }>;
  computer?: { status?: string; localBox?: boolean; maxScreens?: number; orgoConfigured?: boolean };
  mcp?: {
    tools: { name: string; description?: string; available?: boolean; provider?: string | null }[];
    note?: string;
    activeCount?: number;
  };
  hermes?: { url?: string; reachable?: boolean };
};

const PROVIDER_META: { id: OptionalProvider; label: string; need: string }[] = [
  { id: 'orgo', label: 'Computer (Orgo)', need: 'ORGO_API_KEY + ORGO_COMPUTER_ID (or HQ_LOCAL=1)' },
  { id: 'xai', label: 'Voice (xAI)', need: 'XAI_API_KEY' },
  { id: 'composio', label: 'Connectors (Composio)', need: 'COMPOSIO_API_KEY' },
];

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`op-dot${ok ? ' is-ok' : ' is-off'}`} aria-hidden />;
}

export function OperateRail() {
  const bot = useSelectedBot();
  const providers = useStore((s) => s.providers);
  const computer = useStore((s) => s.computer);
  const set = useStore((s) => s.set);
  const setModal = useStore((s) => s.setModal);
  const [surface, setSurface] = useState<SurfaceStatus | null>(null);
  const [surfaceErr, setSurfaceErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/v6/operate-surface', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`surface ${r.status}`);
        return r.json();
      })
      .then((j) => { if (alive) { setSurface(j); setSurfaceErr(null); } })
      .catch((e) => { if (alive) setSurfaceErr(e instanceof Error ? e.message : 'surface unavailable'); });
    return () => { alive = false; };
  }, [bot?.id, providers]);

  if (!bot || bot.kind === 'room') return null;

  const compOk = computer?.status === 'running' || computer?.status === 'starting';
  const localBox = !!surface?.computer?.localBox;

  return (
    <div className="operate">
      <section className="operate__section">
        <div className="section-label section-label--row">
          <span>Providers</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().openAppSettings('computer')}>
            Settings
          </button>
        </div>
        <div className="panel-card operate__card">
          {PROVIDER_META.map((p) => {
            const ok = isProviderConfigured(providers, p.id) || (p.id === 'orgo' && localBox);
            return (
              <div key={p.id} className="operate__row" title={ok ? undefined : p.need}>
                <StatusDot ok={ok} />
                <span className="operate__row-text">
                  <span className="operate__row-title">{p.label}</span>
                  <span className="operate__row-sub">
                {ok
                  ? 'Paid provider configured'
                  : p.id === 'orgo' && localBox
                    ? 'Free local computer (HQ_LOCAL). Orgo not required.'
                    : p.id === 'xai'
                      ? 'Free device voice. xAI is an optional upgrade.'
                      : p.id === 'composio'
                        ? 'Free local connectors. Composio is an optional upgrade.'
                        : providerRecovery[p.id]}
              </span>
                </span>
              </div>
            );
          })}
          {surfaceErr && <div className="operate__note" role="status">Surface probe: {surfaceErr}</div>}
        </div>
      </section>

      <section className="operate__section">
        <div className="section-label section-label--row">
          <span>Computer</span>
          <button
            type="button"
            className="link-btn link-btn--small"
            onClick={() => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null })}
          >
            Open
          </button>
        </div>
        <div className="panel-card operate__card">
          <div className="operate__row">
            <StatusDot ok={compOk || localBox} />
            <span className="operate__row-text">
              <span className="operate__row-title">{computerStatusText(computer)}</span>
              <span className="operate__row-sub">
                {localBox
                  ? 'HQ_LOCAL box — shell runs on this host'
                  : isProviderConfigured(providers, 'orgo')
                    ? `Shared desktop · max ${computer?.maxScreens ?? 4} screens`
                    : 'Needs Orgo credentials or HQ_LOCAL=1'}
              </span>
            </span>
          </div>
        </div>
      </section>

      <section className="operate__section">
        <div className="section-label section-label--row">
          <span>Connectors</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => setModal('apps')}>
            Browse apps
          </button>
        </div>
        <div className="panel-card operate__card">
          {isProviderConfigured(providers, 'composio') ? (
            <button type="button" className="panel-row panel-row--link" onClick={() => setModal('apps')}>
              <span className="panel-row__title" style={{ flex: 1 }}>Open app connections</span>
              <Icon name="chev_right" size={12} opacity={0.56} />
            </button>
          ) : (
            <div className="panel-empty">{providerRecovery.composio}</div>
          )}
        </div>
      </section>

      <section className="operate__section">
        <div className="section-label">Plugins · MCP tools</div>
        <div className="panel-card operate__card">
          {surface?.mcp?.tools?.length ? (
            surface.mcp.tools.slice(0, 14).map((t) => (
              <div key={t.name} className="operate__row">
                <StatusDot ok={t.available !== false} />
                <span className="operate__row-text">
                  <span className="operate__row-title">{t.name}</span>
                  <span className="operate__row-sub">
                    {t.available === false && t.provider
                      ? `Needs ${t.provider} · ${(t.description || '').slice(0, 80)}`
                      : t.description}
                  </span>
                </span>
              </div>
            ))
          ) : (
            <div className="panel-empty">
              {surface?.mcp?.note ?? 'No MCP tools advertised yet. Hermes attaches tools when the engine is ready.'}
            </div>
          )}
        </div>
      </section>

      <section className="operate__section">
        <div className="section-label">LLM · Engine</div>
        <EngineSettings bot={bot} />
      </section>

      <section className="operate__section">
        <div className="section-label">Voice</div>
        <VoiceSettings bot={bot} />
      </section>
    </div>
  );
}
