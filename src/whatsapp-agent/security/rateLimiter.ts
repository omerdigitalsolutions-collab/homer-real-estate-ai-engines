/**
 * Two-level fixed-window rate limiter:
 *
 *   - Per phone:  10 messages / minute — stops a single chatty number.
 *   - Per agency: 500 messages / hour  — stops phone-rotation attacks from
 *     flooding the Gemini quota of a whole tenant.
 *
 * In production both counters live in Firestore and each check runs inside a
 * transaction (read → compare → increment atomically), so concurrent webhook
 * invocations can't double-spend the window. This standalone version keeps
 * the same window logic over an in-memory map.
 */

const MAX_MSGS_PER_MINUTE_PER_PHONE = 10;
const WINDOW_MS = 60_000;

const MAX_MSGS_PER_HOUR_PER_AGENCY = 500;
const AGENCY_WINDOW_MS = 60 * 60_000;

interface Window { count: number; windowStart: number; }
const windows = new Map<string, Window>();

function checkWindow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.windowStart > windowMs) {
    windows.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (w.count >= max) return false;
  w.count++;
  return true;
}

export async function checkRateLimit(phone: string, agencyId?: string): Promise<boolean> {
  const phoneOk = checkWindow(`wa_${phone}`, MAX_MSGS_PER_MINUTE_PER_PHONE, WINDOW_MS);
  const agencyOk = agencyId
    ? checkWindow(`agency_${agencyId}`, MAX_MSGS_PER_HOUR_PER_AGENCY, AGENCY_WINDOW_MS)
    : true;
  return phoneOk && agencyOk;
}
