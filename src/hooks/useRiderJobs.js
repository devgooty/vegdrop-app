import { useCallback, useEffect, useState } from 'react';
import { fetchRiderOrders } from '../services/rider';

/**
 * What this rider has been offered and what they are carrying.
 *
 * Extracted so the pickup list and the map tab read the same thing rather than
 * each inventing their own idea of "the current job". Only one of those screens
 * is mounted at a time — they are tabs — so a hook instance per consumer still
 * means one poll running.
 *
 * The 5s cadence matches every other screen in the product, and pauses while the
 * tab is hidden for the reason given wherever else that appears: a background
 * tab hammering the API is work nobody is looking at.
 */
export default function useRiderJobs({ enabled = true, intervalMs = 5000 } = {}) {
  const [offers, setOffers] = useState([]);
  const [assigned, setAssigned] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchRiderOrders();
      setOffers(data.offers);
      setAssigned(data.assigned);
    } catch {
      /* Transient; the next tick retries. */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    refresh();
    const poll = () => {
      if (!document.hidden) refresh();
    };
    const interval = setInterval(poll, intervalMs);
    document.addEventListener('visibilitychange', poll);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [enabled, intervalMs, refresh]);

  /**
   * The job the rider is actually on.
   *
   * One that has left the market outranks one still being collected: if a rider
   * is somehow holding two, the bags already on the bike are the more urgent
   * thing to finish.
   */
  const activeJob =
    assigned.find((order) => order.status === 'dispatched') || assigned[0] || null;

  return { offers, assigned, activeJob, loaded, refresh };
}
