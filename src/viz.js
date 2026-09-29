// Chart colours and the shared hover-tooltip state for src/charts.jsx.
// Validated for the dark surface with the dataviz palette validator: a one-hue
// blue ramp for magnitude, fixed categorical slots for series.
import { useCallback, useState } from 'react';

export const SEQ = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'];
export const SERIES = ['#3987e5', '#d95926', '#199e70'];

// bind(render) -> pointer/focus handlers for a mark; tip -> what TipLayer shows.
export function useTip() {
  const [tip, setTip] = useState(null);
  const bind = useCallback((render) => ({
    onPointerEnter: (e) => setTip({ x: e.clientX, y: e.clientY, render }),
    onPointerMove: (e) => setTip({ x: e.clientX, y: e.clientY, render }),
    onPointerLeave: () => setTip(null),
    onFocus: (e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ x: r.left + r.width / 2, y: r.top, render }); },
    onBlur: () => setTip(null),
  }), []);
  return [bind, tip];
}
