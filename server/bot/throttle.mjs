/**
 * Send pacing.
 *
 * This is a ban-avoidance measure, not a performance one.
 *
 * Unofficial WhatsApp clients get flagged by behaviour, and the loudest signals
 * are bursts of near-identical messages to people who never messaged first —
 * which is precisely the shape of OTP traffic. Pacing sends with jitter, capping
 * daily volume, and refusing to exceed a per-recipient rate makes the traffic look
 * less mechanical. None of it makes the account safe; it makes it less obvious.
 *
 * The queue is strictly serial: one message in flight at a time, in order.
 */

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createThrottle({
  minIntervalMs = 3000,
  jitterMs = 2000,
  dailyCap = 200,
  perRecipientCooldownMs = 60000,
} = {}) {
  /** @type {Array<{ run: () => Promise<any>, resolve: Function, reject: Function, key: string }>} */
  const queue = [];
  let draining = false;

  let lastSentAt = 0;
  let sentToday = 0;
  let dayStamp = new Date().toDateString();

  /** @type {Map<string, number>} */
  const lastPerRecipient = new Map();

  function rollDayIfNeeded() {
    const today = new Date().toDateString();
    if (today !== dayStamp) {
      dayStamp = today;
      sentToday = 0;
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;

    try {
      while (queue.length > 0) {
        const job = queue.shift();

        rollDayIfNeeded();

        if (sentToday >= dailyCap) {
          job.reject(
            new Error(
              `Daily send cap of ${dailyCap} reached. Raise WHATSAPP_BOT_DAILY_CAP only if this number is warmed up — a sudden volume jump is a common trigger for a ban.`
            )
          );
          continue;
        }

        const now = Date.now();
        const recipientLast = lastPerRecipient.get(job.key) ?? 0;
        if (now - recipientLast < perRecipientCooldownMs) {
          job.reject(
            new Error('Refusing to message this recipient again so soon; slow down or the number gets flagged.')
          );
          continue;
        }

        // Space sends out, with jitter so the interval is not a fixed tick.
        const wait = lastSentAt + minIntervalMs + Math.floor(Math.random() * jitterMs) - now;
        if (wait > 0) await sleep(wait);

        try {
          const result = await job.run();
          lastSentAt = Date.now();
          sentToday += 1;
          lastPerRecipient.set(job.key, lastSentAt);
          job.resolve(result);
        } catch (err) {
          // A failed send still consumed an attempt against the socket.
          lastSentAt = Date.now();
          job.reject(err);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    /**
     * Queue a send. Resolves with whatever `run` returns.
     * @param {string} key  recipient identifier, for per-recipient pacing
     * @param {() => Promise<any>} run
     */
    submit(key, run) {
      return new Promise((resolve, reject) => {
        queue.push({ key, run, resolve, reject });
        drain();
      });
    },

    stats() {
      rollDayIfNeeded();
      return { queued: queue.length, sentToday, dailyCap };
    },
  };
}
