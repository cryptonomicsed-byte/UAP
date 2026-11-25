import { useRef } from 'react';

/**
 * Magnetic hover: the element's content leans a few px toward the cursor, like Codync's
 * .mac-chat-button (chat-controls.css). CSS does the actual translate (gated by
 * prefers-reduced-motion there); this hook only measures the pointer and writes --dx/--dy.
 * Pure read of pointer position relative to the button's center — no state, no re-render.
 */
export function useMagnetic<T extends HTMLElement>(strength = 6) {
  const ref = useRef<T>(null);
  const onPointerMove = (e: React.PointerEvent<T>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * strength;
    const dy = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * strength;
    el.style.setProperty('--dx', dx.toFixed(2));
    el.style.setProperty('--dy', dy.toFixed(2));
  };
  const onPointerLeave = () => {
    const el = ref.current;
    if (el) { el.style.setProperty('--dx', '0'); el.style.setProperty('--dy', '0'); }
  };
  return { ref, onPointerMove, onPointerLeave };
}
