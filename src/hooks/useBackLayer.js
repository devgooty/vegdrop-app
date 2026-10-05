import { useEffect, useRef } from 'react';
import { openLayer, closeLayer } from '../lib/backStack';

/**
 * While `open`, the back button closes this by calling `close` — see
 * lib/backStack.js. Closing it any other way, or unmounting, gives its history
 * entry back.
 *
 * Put the hook where the open/closed state lives, not inside the thing it
 * shows: App unmounts its whole tree while the sign-in screen is up, and a
 * basket that should still be open behind it must keep its entry.
 */
export function useBackLayer(open, close) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!open) return undefined;
    const id = openLayer(() => closeRef.current());
    return () => closeLayer(id);
  }, [open]);
}
