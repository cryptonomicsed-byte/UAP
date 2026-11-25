import { useMemo, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { isProviderConfigured } from '../lib/providers';
import { displayName, sortedRows, useSelectedBot, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';

export function ChatView(props: {
  navOpen?: boolean;
  onToggleNav?: () => void;
} = {}) {
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const detailsOpen = useStore((s) => s.detailsOpen);
  const providers = useStore((s) => s.providers);
  const set = useStore((s) => s.set);
  const setModal = useStore((s) => s.setModal);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const rows = useMemo(() => sortedRows(transcript), [transcript]);
  const inCall = useVoice((s) => isCallActive(s) && !!bot && s.botId === bot.id);
  const voiceOk = isProviderConfigured(providers, 'xai');

  if (!bot) {
    return (
      <main className="chat chat--empty">
        <div className="empty-chat">
          <div className="empty-chat__sub">No agent selected.</div>
          <button type="button" className="btn btn--sm" onClick={() => useStore.getState().setModal('create')}>New agent</button>
        </div>
      </main>
    );
  }

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 2000); };

  const toggleVoice = async () => {
    if (voiceBusy) return;
    setVoiceBusy(true);
    try {
      if (inCall) endCall();
      else if (!voiceOk && typeof window !== 'undefined' && !('speechSynthesis' in window)) flash('Voice needs a browser with speech synthesis');
      else await startCall(bot.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Voice failed');
    } finally {
      setVoiceBusy(false);
    }
  };

  return (
    <main className="chat" style={botVars(bot.avatarColor)}>
      <header className="chat__header">
        <button
          type="button"
          className="icon-btn icon-btn--bordered shell__nav-toggle"
          aria-label={props.navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={!!props.navOpen}
          onClick={() => props.onToggleNav?.()}
        >
          <Icon name="sidebar" opacity={0.8} />
        </button>
        <span className="chat__pill-anchor">
          <button type="button" className="chat__pill" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
            <BotAvatarFor bot={bot} size={24} state={live?.isRunning ? 'working' : 'idle'} />
            <span className="chat__pill-name">{displayName(bot)}</span>
          </button>
          {menu && (
            <Menu
              align="center"
              onClose={() => setMenu(false)}
              items={[
                { label: detailsOpen ? 'Hide details' : 'Show details', hint: '⇧⌘,', onSelect: () => set({ detailsOpen: !detailsOpen }) },
                { label: 'Open computer', onSelect: () => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null }) },
                { label: 'Connect apps', onSelect: () => setModal('apps') },
                { label: 'New conversation', onSelect: () => api.fresh(bot.id).then(() => flash('Started a new conversation')).catch((e) => flash(e.message)) },
                { label: 'Bot settings', onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
              ]}
            />
          )}
        </span>
        <div className="chat__header-right">
          <button
            type="button"
            className="chat__quick"
            onClick={() => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null })}
            title="Open agent computer"
          >
            Computer
          </button>
          <button
            type="button"
            className={`chat__quick${inCall ? ' is-on' : ''}`}
            onClick={() => void toggleVoice()}
            title={voiceOk ? (inCall ? 'End voice call' : 'Start voice call') : 'Voice needs XAI_API_KEY'}
            disabled={voiceBusy}
          >
            {inCall ? 'End call' : 'Voice'}
          </button>
          <button
            type="button"
            className={`chat__quick${detailsOpen ? ' is-on' : ''}`}
            onClick={() => set({ detailsOpen: !detailsOpen })}
            title={detailsOpen ? 'Hide agent panel' : 'Show agent panel'}
          >
            Agent
          </button>
        </div>
      </header>
      <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} />
      <VoiceCallBar />
      <Composer bot={bot} running={!!live?.isRunning} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
