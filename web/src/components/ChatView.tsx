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
import { useMagnetic } from '../lib/useMagnetic';
import { BotTasks } from './config/TasksView';
import { LibraryTab } from './config/LibraryTab';
import { AgentActivity } from './studio/AgentActivity';
import { AgentAutomations } from './studio/AgentAutomations';
import { AgentPortrait } from './studio/AgentPortrait';

const FACETS = [['chat', 'Chat'], ['work', 'Work'], ['files', 'Files'], ['automations', 'Automations'], ['activity', 'Activity']] as const;
type Facet = typeof FACETS[number][0];

export function ChatView(props: {
  navOpen?: boolean;
  studio?: boolean;
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
  const [facet, setFacet] = useState<{ id: string; view: Facet }>();
  const rows = useMemo(() => sortedRows(transcript), [transcript]);
  const inCall = useVoice((s) => isCallActive(s) && !!bot && s.botId === bot.id);
  const voiceOk = isProviderConfigured(providers, 'xai');
  const computerMag = useMagnetic<HTMLButtonElement>();
  const voiceMag = useMagnetic<HTMLButtonElement>();
  const agentMag = useMagnetic<HTMLButtonElement>();
  const navButton = <button type="button" className="icon-btn icon-btn--bordered shell__nav-toggle"
    aria-label={props.navOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={!!props.navOpen}
    onClick={props.onToggleNav}><Icon name="sidebar" opacity={0.8} /></button>;

  if (!bot) {
    return (
      <main className="chat chat--empty">
        {props.studio && navButton}
        <div className="empty-chat">
          <div className="empty-chat__sub">No agent selected.</div>
          <button type="button" className="btn btn--sm" onClick={() => useStore.getState().setModal('create')}>New agent</button>
        </div>
      </main>
    );
  }

  const view = props.studio && facet?.id === bot.id && (bot.kind !== 'room' || facet.view !== 'automations') ? facet.view : 'chat';
  const state = live?.awaiting ? 'waiting' : live?.isRunning ? 'working' : 'idle';
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
      <header className="chat__header glass-grain">
        {navButton}
        <span className="chat__pill-anchor">
          <button type="button" className="chat__pill" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
            {props.studio && bot.kind !== 'room' ? <AgentPortrait id={bot.id} size={38} state={state} /> :
              <BotAvatarFor bot={bot} size={24} state={live?.isRunning ? 'working' : 'idle'} />}
            <span className="chat__pill-meta">
              <span className="chat__pill-name">{displayName(bot)}</span>
              {props.studio && <span className="studio-agent-status" data-state={state}>
                {state === 'waiting' ? 'Needs your input' : state === 'working' ? 'Working' : bot.kind === 'room' ? 'Group conversation' : 'Agent workspace'}
              </span>}
            </span>
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
            ref={computerMag.ref}
            onPointerMove={computerMag.onPointerMove}
            onPointerLeave={computerMag.onPointerLeave}
            type="button"
            className="chat__quick magnetic"
            onClick={() => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null })}
            title="Open agent computer"
          >
            <span>Computer</span>
          </button>
          <button
            ref={voiceMag.ref}
            onPointerMove={voiceMag.onPointerMove}
            onPointerLeave={voiceMag.onPointerLeave}
            type="button"
            className={`chat__quick magnetic${inCall ? ' is-on' : ''}`}
            onClick={() => void toggleVoice()}
            title={inCall ? 'End voice call' : 'Start voice call'}
            disabled={voiceBusy}
          >
            <span>{inCall ? 'End call' : 'Voice'}</span>
          </button>
          <button
            ref={agentMag.ref}
            onPointerMove={agentMag.onPointerMove}
            onPointerLeave={agentMag.onPointerLeave}
            type="button"
            className={`chat__quick magnetic${detailsOpen ? ' is-on' : ''}`}
            onClick={() => set({ detailsOpen: !detailsOpen })}
            title={detailsOpen ? 'Hide agent panel' : 'Show agent panel'}
          >
            <span>Agent</span>
          </button>
        </div>
      </header>
      {props.studio && <nav className="studio-facets" aria-label="Agent workspace">
        {FACETS.filter(([id]) => bot.kind !== 'room' || id !== 'automations').map(([id, label]) => (
          <button key={id} type="button" aria-pressed={view === id} onClick={() => setFacet({ id: bot.id, view: id })}>{label}</button>
        ))}
      </nav>}
      {view === 'chat' ? <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} studio={props.studio} /> :
        <div className="studio-stage-scroll" key={`${bot.id}:${view}`}>
          {view === 'work' && <section className="studio-facet" aria-label="Agent work">
            <header className="studio-facet__head"><p>Workspace / Work</p><h1>Work</h1><span>Tasks assigned to {displayName(bot)}.</span></header>
            <BotTasks bot={bot} onOpenConversation={() => setFacet({ id: bot.id, view: 'chat' })} />
          </section>}
          {view === 'files' && <section className="studio-facet" aria-label="Agent files">
            <header className="studio-facet__head"><p>Workspace / Files</p><h1>Files</h1><span>Files saved by {displayName(bot)}.</span></header>
            <LibraryTab key={bot.id} bot={bot} studio />
          </section>}
          {view === 'automations' && <AgentAutomations bot={bot} />}
          {view === 'activity' && (transcript?.loaded ? <AgentActivity bot={bot} rows={rows} /> : <p className="studio-facet" role="status">Waiting for conversation history…</p>)}
        </div>}
      <VoiceCallBar />
      {view === 'chat' && <Composer key={bot.id} bot={bot} running={!!live?.isRunning} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
