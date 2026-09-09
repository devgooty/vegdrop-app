'use strict';

const config = require('../config/env');

/**
 * When "today" starts, for a market.
 *
 * WHY THIS IS NOT `new Date().setHours(0,0,0,0)`
 *
 * That expression uses the SERVER's timezone, which on every host this app is
 * likely to run on is UTC. A vegetable market in Hyderabad opens before dawn
 * and prices its first crates around 5am IST — which is 23:30 UTC the previous
 * day. Keyed on a UTC midnight, the busiest hour of the market's morning would
 * be filed under yesterday, and the owner would open the app to find the prices
 * they had just set already counted as stale.
 *
 * WHY AN OFFSET RATHER THAN A TIMEZONE NAME
 *
 * India observes no daylight saving, so a fixed offset is exact here rather
 * than merely convenient, and it avoids a timezone database as a dependency of
 * "is this price from today". If this ever serves a market in a DST-observing
 * region the offset becomes wrong twice a year, and at that point the honest
 * fix is a real IANA zone per market — not a second constant. The single
 * config value is deliberately easy to find for that reason.
 */
function startOfMarketDay(now = new Date()) {
  const offsetMs = config.marketDay.timezoneOffsetMinutes * 60 * 1000;

  // Shift into market-local time, truncate the clock, shift back. Done in
  // milliseconds rather than with setHours so the server's own zone never
  // enters the arithmetic.
  const local = new Date(now.getTime() + offsetMs);
  const localMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate()
  );

  return new Date(localMidnight - offsetMs);
}

/** Was this timestamp inside the current market day? Null counts as no. */
function isToday(at, now = new Date()) {
  if (!at) return false;
  return new Date(at).getTime() >= startOfMarketDay(now).getTime();
}

module.exports = { startOfMarketDay, isToday };
