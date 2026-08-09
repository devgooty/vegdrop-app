import { useEffect, useMemo, useRef, useState } from 'react';
import { onSessionChange } from '../services/apiClient';
import { restoreSession } from '../services/auth';

/**
 * The signed-in user for one of the three apps, kept honest about WHO it is.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * All three apps are one origin, so they share one refresh cookie. Signing in
 * at `#/shopkeeper` replaces the cookie the customer tab is holding; the next
 * silent refresh in that tab then succeeds — with the shopkeeper's session.
 * `restoreSession()` was called once on mount and never again, and
 * `onSessionChange` was exported but nothing subscribed, so the customer tab
 * carried on rendering a customer shop, a customer cart and a customer order
 * list against a completely different account. Observed live: the customer tab
 * reported `Demo Shopkeeper / shopkeeper` from `/auth/refresh` while still
 * showing the customer UI.
 *
 * So identity is now watched, not sampled:
 *
 *  - `allowedRoles` gates which identities this app will render at all. A role
 *    it does not serve is treated as signed out — the API authorises every
 *    request independently, so this is a UX gate, not a security boundary.
 *  - A change of user id is a DIFFERENT PERSON, never an update. `onIdentityLost`
 *    fires so the app can drop per-user state (cart, orders, wallet) instead of
 *    showing one account's data to another.
 *
 * @param {{allowedRoles?: string[]|null, onIdentityLost?: (next: object|null) => void}} [options]
 *   `allowedRoles` null means every role may use this app — which is true of the
 *   customer app, where `developer` and `market_owner` also render panels.
 *   `onIdentityLost` receives whoever replaced them, or null if the session is
 *   simply gone.
 */
export default function useSessionUser({ allowedRoles = null, onIdentityLost } = {}) {
  const [user, setUser] = useState(null);
  const [isRestoringSession, setIsRestoringSession] = useState(true);

  // Compared by value: a fresh array literal on every render would otherwise
  // re-run the subscription effect forever.
  const roleKey = allowedRoles ? allowedRoles.join(',') : '';

  // Read through refs so the subscription can stay mounted for the app's life
  // rather than resubscribing every time the user object changes.
  const userIdRef = useRef(null);
  const lostRef = useRef(onIdentityLost);

  /**
   * Track WHOEVER is signed in, however they got here.
   *
   * Signing in goes through the app's own login handler and lands on `setUser`
   * directly, never through `apply` — so tracking the id only inside `apply`
   * left this null for the entire first session. The swap check then read a
   * falsy "previous" id and concluded nothing had changed, which is precisely
   * the case it exists to catch. Syncing from state covers every path.
   */
  useEffect(() => {
    userIdRef.current = user?.id ?? null;
    lostRef.current = onIdentityLost;
  });

  const permits = useMemo(() => {
    const roles = roleKey ? roleKey.split(',') : null;
    return (candidate) => Boolean(candidate) && (!roles || roles.includes(candidate.role));
  }, [roleKey]);

  useEffect(() => {
    let cancelled = false;

    /**
     * One place that decides what a new session object means here, used by both
     * the initial restore and every later refresh.
     */
    const apply = (candidate) => {
      if (cancelled) return;

      const next = permits(candidate) ? candidate : null;
      const previousId = userIdRef.current;
      const nextId = next?.id ?? null;

      if (previousId && previousId !== nextId) {
        /**
         * Either signed out, or replaced by someone else entirely. Both mean
         * nothing held for the old account may stay on screen — but they want
         * different landings, so the incoming identity is handed over: null is
         * "show them the way back in", a user is "start clean as them".
         */
        if (lostRef.current) lostRef.current(next);
      }

      userIdRef.current = nextId;
      setUser(next);
    };

    restoreSession()
      .then(apply)
      .catch(() => apply(null))
      .finally(() => {
        if (!cancelled) setIsRestoringSession(false);
      });

    // Fires on every silent refresh, which is exactly when another app's
    // sign-in can arrive underneath this one.
    const unsubscribe = onSessionChange(apply);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [permits]);

  return { user, setUser, isRestoringSession };
}
