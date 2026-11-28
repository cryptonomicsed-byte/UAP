import * as React from 'react';

// Original UAP artwork. These outlines, fabric panels, stitching, and dyes were
// drawn for the shell; no upstream artwork, shaders, or textures are used.
const PODS = [
  { // Samara: an off-center wing folds over a rounded seed.
    outline: 'M20 58C18 39 30 26 47 24C61 22 70 12 73 7C84 15 88 27 82 37C94 45 100 57 98 73C96 93 80 102 57 102C33 102 15 91 15 73C15 67 17 62 20 58Z',
    panel: 'M55 21C63 18 70 12 73 7C84 15 88 27 82 37C87 40 92 46 95 52C81 47 70 38 55 21Z',
    seam: 'M56 22C69 38 81 47 94 51',
    hem: 'M24 80C32 94 53 99 73 93',
    highlights: '#E4EAD5', wool: '#ACBD95', shade: '#657953', edge: '#4A5F46',
    panelLight: '#A2B683', panelDark: '#627C57', thread: '#F2EBDC', tag: '#EBC183',
    faceX: 54, faceY: 65, tagX: 83, tagY: 83, tagAngle: 24,
  },
  { // Flax: angular linen folds meet in a tall, narrow husk.
    outline: 'M57 8C65 9 69 16 74 24L88 48C93 57 95 66 93 76C90 92 77 102 55 102C34 102 21 91 19 77C17 66 20 55 26 46L45 18C49 12 53 8 57 8Z',
    panel: 'M57 8C65 9 69 16 74 24L88 48C93 57 95 66 93 76C90 92 77 102 55 102C68 91 74 79 74 62C73 42 63 26 57 8Z',
    seam: 'M61 20C66 34 75 48 76 64C76 79 71 89 63 97',
    hem: 'M25 78C29 90 42 97 54 96',
    highlights: '#FAF4E1', wool: '#E3CAAC', shade: '#B18163', edge: '#88624E',
    panelLight: '#E9C5A1', panelDark: '#A16F55', thread: '#FFF2DC', tag: '#CBD7A5',
    faceX: 48, faceY: 64, tagX: 83, tagY: 67, tagAngle: -12,
  },
  { // Mallow: a squat, three-chamber pod with a pieced lower gusset.
    outline: 'M10 71C9 57 17 46 29 44C31 31 41 23 53 24C65 22 75 28 80 39C96 39 104 52 103 69C103 86 95 96 80 96C72 102 60 103 53 98C43 103 31 101 25 96C16 94 11 85 10 71Z',
    panel: 'M11 75C24 81 36 82 49 79C69 77 84 67 103 69C103 86 95 96 80 96C72 102 60 103 53 98C43 103 31 101 25 96C16 94 12 85 11 75Z',
    seam: 'M15 78C27 83 38 84 51 81C70 78 87 69 99 72',
    hem: 'M34 44C36 36 45 30 54 30',
    highlights: '#F0E4F2', wool: '#BAAACB', shade: '#837294', edge: '#655574',
    panelLight: '#B09CBD', panelDark: '#78658B', thread: '#F7E9EE', tag: '#E6A98F',
    faceX: 55, faceY: 65, tagX: 28, tagY: 56, tagAngle: -28,
  },
] as const;

type PortraitState = 'idle' | 'working' | 'waiting' | 'offline';

const MOUTHS: Record<PortraitState, string> = {
  idle: 'M-3 5.5C-1.5 8 1.5 8 3 5.5',
  working: 'M-2 6h4',
  waiting: 'M-3 6q3-2 6-1',
  offline: 'M-2 6q2 1 4 0',
};

function podFor(id: string) {
  // FNV-1a over UTF-16 code units. Identity stays put across renders and sizes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return PODS[(hash >>> 0) % PODS.length];
}

/** Decorative companion art; state comes from the shell and never conveys status on its own. */
export function AgentPortrait({ id, size = 112, state = 'idle' }: { id: string; size?: number; state?: PortraitState }) {
  const pod = podFor(id);
  const working = state === 'working';
  const waiting = state === 'waiting';
  const offline = state === 'offline';
  const gaze = working ? 1.5 : 0;
  // Fragment references use render identity, not agent identity: the same pod can
  // appear in the dock and stage at once without resolving to another SVG's defs.
  const uid = `uap-textile-${React.useId()}`;
  const bodyId = `${uid}-body`;
  const panelId = `${uid}-panel`;
  const weaveId = `${uid}-weave`;
  const cutId = `${uid}-cut`;

  return (
    <svg className="studio-portrait" width={size} height={size} viewBox="0 0 112 112" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id={bodyId} gradientUnits="userSpaceOnUse" cx="41" cy="38" r="68" fx="36" fy="32">
          <stop stopColor={pod.highlights} />
          <stop offset=".56" stopColor={pod.wool} />
          <stop offset="1" stopColor={pod.shade} />
        </radialGradient>
        <linearGradient id={panelId} gradientUnits="userSpaceOnUse" x1="35" y1="27" x2="89" y2="96">
          <stop stopColor={pod.panelLight} />
          <stop offset="1" stopColor={pod.panelDark} />
        </linearGradient>
        <pattern id={weaveId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-14)">
          <path d="M0 1.5h2m1 3h2" fill="none" stroke={pod.thread} strokeWidth=".85" strokeLinecap="round" opacity=".39" />
          <path d="M1 3h1m2 2.5h1" fill="none" stroke={pod.edge} strokeWidth=".75" strokeLinecap="round" opacity=".27" />
        </pattern>
        <clipPath id={cutId}><path d={pod.outline} /></clipPath>
      </defs>
      <g opacity={offline ? 0.59 : undefined}>
        <ellipse cx="56" cy="102" rx="33" ry="4" fill="#221E22" opacity=".15" />
        <path d={pod.outline} fill={`url(#${bodyId})`} />
        <g clipPath={`url(#${cutId})`}>
          <path d={pod.panel} fill={`url(#${panelId})`} />
          <rect width="112" height="112" fill={`url(#${weaveId})`} />
          <path d={pod.seam} fill="none" stroke={pod.edge} strokeWidth="3.4" strokeLinecap="round" opacity=".43" />
          <path d={pod.seam} fill="none" stroke={pod.thread} strokeWidth="1.35" strokeLinecap="round" strokeDasharray="1.7 2.7" />
          <path d={pod.hem} fill="none" stroke={pod.thread} strokeWidth="1.45" strokeLinecap="round" strokeDasharray="2.1 2.5" opacity=".72" />
        </g>
        <path d={pod.outline} fill="none" stroke={pod.edge} strokeWidth="1.45" strokeLinejoin="round" />
        <g transform={`translate(${pod.tagX} ${pod.tagY}) rotate(${pod.tagAngle})`}>
          <rect x="-6" y="-4.5" width="12" height="9" rx="2.6" fill={pod.tag} stroke={pod.edge} strokeWidth=".9" />
          <path d="M-3 -1.5l2 3m0-3-2 3m4-3 2 3m0-3-2 3" fill="none" stroke={pod.edge} strokeWidth=".8" strokeLinecap="round" />
        </g>
        <g className="studio-portrait__face" transform={`translate(${pod.faceX} ${pod.faceY})`} fill="#30272D" strokeLinecap="round">
          {offline ? (
            <path d="M-15-2q4 4 8 0m14 0q4 4 8 0" fill="none" stroke="#30272D" strokeWidth="2.5" />
          ) : (
            <>
              <ellipse cx={-11 + gaze} cy="-2" rx="3.35" ry={working ? 3.05 : 4.3} />
              <ellipse cx={11 + gaze} cy={waiting ? -3 : -2} rx="3.35" ry={working ? 3.05 : 4.3} />
              {working && <path d="m-13-8 6 1.2m17 0 6-1.2" fill="none" stroke="#30272D" strokeWidth="1.75" />}
              {waiting && <path d="M7-10q3.5-3 7.5-.8" fill="none" stroke="#30272D" strokeWidth="1.75" />}
            </>
          )}
          <path d={MOUTHS[state]} fill="none" stroke="#30272D" strokeWidth="1.85" />
        </g>
      </g>
    </svg>
  );
}
