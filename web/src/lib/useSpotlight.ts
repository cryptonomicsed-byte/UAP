import { useRef } from 'react';

/** Cursor-follow spotlight: a soft radial highlight that tracks the pointer across a card,
 *  like Stripe/Linear-style surfaces. Pure CSS var read — --mx/--my as percentages, --spot-o
 *  for the fade in/out — no React state, no re-render per mouse move. */
export function useSpotlight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const onPointerMove = (e: React.PointerEvent<T>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    el.style.setProperty('--spot-o', '1');
  };
  const onPointerLeave = () => ref.current?.style.setProperty('--spot-o', '0');
  return { ref, onPointerMove, onPointerLeave };
}
