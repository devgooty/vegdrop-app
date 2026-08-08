/**
 * Standing orders.
 *
 * The scheduling screen kept these in React state until now: nothing was sent
 * anywhere, and a reload cleared a list the UI had just called "Active". These
 * talk to the real record, which the server turns into orders on its own clock
 * (see services/scheduler.js).
 *
 * A schedule stores INTENT — which products, how many, when — and never a
 * price. Each run is priced from the market's sheet on the morning it ships,
 * which is the only correct answer for a basket ordered weeks ahead.
 */

import { api } from './apiClient';

/** Frequencies the server accepts, and what the UI calls them. */
export const FREQUENCIES = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

export async function fetchSchedules() {
  const result = await api.get('/schedules');
  return result.data;
}

/**
 * @param {object} schedule
 * @param {Array<{productId: string, quantity: number}>} schedule.items
 * @param {'daily'|'weekly'|'monthly'} schedule.frequency
 * @param {number[]} [schedule.daysOfWeek]  0=Sunday..6=Saturday, for `weekly`
 * @param {number[]} [schedule.daysOfMonth] 1..31, for `monthly`
 */
export async function createSchedule({
  items,
  address,
  paymentMethod,
  marketId,
  lat,
  lng,
  frequency,
  daysOfWeek,
  daysOfMonth,
  hour,
}) {
  const result = await api.post('/schedules', {
    items,
    address,
    paymentMethod,
    frequency,
    ...(marketId ? { marketId } : {}),
    ...(typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : {}),
    ...(daysOfWeek?.length ? { daysOfWeek } : {}),
    ...(daysOfMonth?.length ? { daysOfMonth } : {}),
    ...(hour === undefined ? {} : { hour }),
  });
  return result.data;
}

/** Pause stops it running; resuming recomputes the next date from now. */
export async function setScheduleStatus(scheduleId, status) {
  const result = await api.patch(`/schedules/${scheduleId}`, { status });
  return result.data;
}

export async function cancelSchedule(scheduleId) {
  await api.delete(`/schedules/${scheduleId}`);
}

/** The orders one schedule has actually produced. */
export async function fetchScheduleOrders(scheduleId) {
  const result = await api.get(`/schedules/${scheduleId}/orders`);
  return result.data;
}

/**
 * Turn a set of chosen dates into a recurrence the server understands.
 *
 * The calendar lets somebody tick specific days, but a standing order recurs —
 * a fixed list of dates would silently expire. Weekly takes the weekdays those
 * dates fall on; monthly takes the days of the month. Daily needs neither.
 */
export function recurrenceFromDates(frequency, isoDates = []) {
  if (frequency === 'daily') return {};

  const dates = isoDates.map((iso) => new Date(`${iso}T00:00:00`));

  if (frequency === 'weekly') {
    return { daysOfWeek: [...new Set(dates.map((d) => d.getDay()))].sort((a, b) => a - b) };
  }

  return { daysOfMonth: [...new Set(dates.map((d) => d.getDate()))].sort((a, b) => a - b) };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Every Monday and Thursday" — what the schedule actually does, in words. */
export function describeRecurrence(schedule) {
  if (!schedule) return '';
  if (schedule.frequency === 'daily') return 'Every day';

  if (schedule.frequency === 'weekly') {
    const names = (schedule.daysOfWeek || []).map((d) => WEEKDAYS[d]);
    if (names.length === 0) return 'Weekly';
    if (names.length === 7) return 'Every day';
    return `Every ${names.join(' and ')}`;
  }

  const days = schedule.daysOfMonth || [];
  if (days.length === 0) return 'Monthly';
  return `Monthly on the ${days.map(ordinal).join(', ')}`;
}

function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}
