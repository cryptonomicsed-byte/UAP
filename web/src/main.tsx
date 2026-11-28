import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PublicCall } from './components/PublicCall';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/cards.css';
import './styles/details.css';
import './styles/config.css';
import './styles/operate.css';
import './styles/modals.css';
import './styles/viewer.css';
import './styles/voice.css';
import './styles/mobile.css';
import './styles/workspace.css';
import './styles/depth.css';
import './styles/glass.css';
import './styles/public-call.css';
import './styles/studio.css';

// A QR code opens /call/<token> with no login at all -- gate this before any auth check or
// app shell render, like the other HelixMain repos' /call/<slug> orb pages.
const callMatch = window.location.pathname.match(/^\/call\/([\w-]+)$/);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {callMatch ? <PublicCall token={callMatch[1]} /> : <App />}
  </StrictMode>,
);
