import { useEffect, useState } from 'react';
import { startEvents } from './lib/events';
import { useStore } from './store';
import { ChatView } from './components/ChatView';
import { ComputerViewer } from './components/ComputerViewer';
import { DetailsPanel } from './components/DetailsPanel';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { ConnectAppsModal } from './components/modals/ConnectAppsModal';
import { CreateBotModal } from './components/modals/CreateBotModal';
import { CreateGroupModal } from './components/modals/CreateGroupModal';
import { SearchModal } from './components/modals/SearchModal';
import { ConfigLayer } from './components/config/ConfigLayer';
import { TasksView } from './components/config/TasksView';
import { DeployBadge } from './components/DeployBadge';
import { WorkspaceRail, WorkspaceStage, type WorkspaceSurface } from './components/WorkspaceRail';
import { useConfigUI } from './configStore';

function Shell() {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const hasBot = useStore((s) => !!s.selectedBotId);
  const view = useConfigUI((s) => s.view);
  const set = useStore((s) => s.set);
  const [navOpen, setNavOpen] = useState(false);
  const [surface, setSurface] = useState<WorkspaceSurface>('chat');

  useEffect(() => {
    const st = useStore.getState();
    st.loadBots().catch(console.error);
    st.loadComputer().catch(console.error);
    const stop = startEvents();
    // OAuth popups post back here; refresh connection-dependent views and the open transcript.
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type !== 'uap-connected') return;
      const s = useStore.getState();
      s.set({ connectionsVersion: s.connectionsVersion + 1 });
      if (s.selectedBotId) s.loadRows(s.selectedBotId).catch(() => {});
    };
    window.addEventListener('message', onMsg);
    return () => { stop(); window.removeEventListener('message', onMsg); };
  }, []);

  // Global shortcuts: ⌘K search, ⌘B sidebar, ⇧⌘, details, ⌘N new bot.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (key === 'b') {
        e.preventDefault();
        if (window.matchMedia('(max-width: 900px)').matches) setNavOpen((v) => !v);
        else st.set({ sidebarCollapsed: !st.sidebarCollapsed });
      }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.set({ detailsOpen: !st.detailsOpen }); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // Close mobile drawers when switching bots / views
  useEffect(() => {
    setNavOpen(false);
  }, [view]);

  const showDetails = detailsOpen && hasBot && view === 'chat';
  const closeOverlays = () => {
    setNavOpen(false);
    if (window.matchMedia('(max-width: 900px)').matches && detailsOpen) set({ detailsOpen: false });
  };

  return (
    <div
      className={[
        'app',
        collapsed ? 'is-sidebar-collapsed' : '',
        showDetails ? 'has-details' : '',
        navOpen ? 'is-nav-open' : '',
        showDetails ? 'is-details-sheet' : '',
        'has-rail',
      ].filter(Boolean).join(' ')}
    >
      <button type="button" className="shell__scrim" aria-label="Close panel" onClick={closeOverlays} />
      <WorkspaceRail surface={surface} onChange={setSurface} />
      {(surface === 'chat' || surface === 'roster') && <Sidebar onNavigate={() => setNavOpen(false)} />}
      {surface === 'chat' && view === 'tasks' ? <TasksView /> : surface === 'chat' ? (
        <ChatView
          navOpen={navOpen}
          onToggleNav={() => setNavOpen((v) => !v)}
        />
      ) : surface !== 'roster' ? <WorkspaceStage surface={surface} /> : <WorkspaceStage surface="roster" />}
      {showDetails && <DetailsPanel />}
      {modal === 'create' && <CreateBotModal />}
      {modal === 'group' && <CreateGroupModal />}
      {modal === 'search' && <SearchModal />}
      {modal === 'apps' && <ConnectAppsModal />}
      {viewerOpen && <ComputerViewer />}
      <ConfigLayer />
    </div>
  );
}

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  useEffect(() => { useStore.getState().checkAuth(); }, []);
  if (!authChecked) {
    return (
      <>
        <div className="boot" />
        <DeployBadge />
      </>
    );
  }
  return (
    <>
      {user ? <Shell /> : <SignIn />}
      <DeployBadge />
    </>
  );
}
