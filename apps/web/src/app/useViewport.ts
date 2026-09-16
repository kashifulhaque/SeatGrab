/**
 * Which of the three layouts of section 13.10 the viewport is in.
 *
 * The match screen changes structure between widths, not only style: on a phone the
 * table becomes four tabs, and on a tablet the action column becomes a drawer. Both need
 * a state a stylesheet cannot hold, so the breakpoint is read here once and handed to
 * the component. The two widths are the ones `app.css` already breaks at.
 *
 * Under jsdom `matchMedia` is absent, and the answer is `desktop`: the render tests
 * assert which control exists, and the desktop layout draws every one of them.
 */
import { useEffect, useState } from 'react';

export type Viewport = 'desktop' | 'tablet' | 'phone';

const PHONE = '(max-width: 760px)';
const TABLET = '(max-width: 1100px)';

function read(): Viewport {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'desktop';
  if (window.matchMedia(PHONE).matches) return 'phone';
  if (window.matchMedia(TABLET).matches) return 'tablet';
  return 'desktop';
}

export function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const queries = [window.matchMedia(PHONE), window.matchMedia(TABLET)];
    const update = () => setViewport(read());
    for (const query of queries) query.addEventListener('change', update);
    update();
    return () => {
      for (const query of queries) query.removeEventListener('change', update);
    };
  }, []);
  return viewport;
}
