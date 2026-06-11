/**
 * ─── Bot Security Pipeline ────────────────────────────────────────────────────
 *
 * Entry point for every inbound WhatsApp DM before it reaches the AI bot.
 * Order of operations (identical to production):
 *
 *   1. Blocklist check
 *   2. Rate limit (10 msgs/min per phone, 500/hour per agency)
 *   3. Sanitize input
 *   4. Opt-out keyword detection (after sanitize, before injection check)
 *   5. Injection detection — accumulating score, auto-block at ≥ 3.
 *      Injection attempts are NEVER forwarded to Gemini.
 *   6. Rolling 24-hour security session TTL
 *   7. Delegate to the AI bot
 *   8. Audit log every interaction (inbound / outbound / blocked)
 *
 * Blocklist + rate-limit run in parallel and are FAIL-SAFE: if either check
 * itself errors, the message is treated as allowed. A monitoring outage
 * should degrade the security layer, not silence the product.
 *
 * In production the session store, audit log and lead updates are Firestore;
 * here they're injected so the pipeline runs standalone.
 */

import { checkBlocklist, blockPhone } from './security/blocklist';
import { checkRateLimit } from './security/rateLimiter';
import { sanitizeInput } from './security/sanitizeInput';
import { detectInjection } from './security/detectInjection';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMITED_MSG = 'יותר מדי הודעות. נסה שוב בעוד דקה.';

const OPT_OUT_KEYWORDS = ['הסר', 'הסירו', 'הסר אותי', 'הפסיקו', 'stop', 'unsubscribe'];
const OPT_OUT_CONFIRM_MSG = 'הוסרת בהצלחה מרשימת ההודעות האוטומטיות שלנו. תמיד נשמח לשמוע ממך! 😊';

function isOptOutMessage(text: string): boolean {
  const n = text.toLowerCase().trim();
  return OPT_OUT_KEYWORDS.some(kw => n === kw.toLowerCase() || n.startsWith(kw.toLowerCase() + ' '));
}

// ─── Injected dependencies ────────────────────────────────────────────────────

export interface Session {
  status: 'active' | 'expired';
  lastMessageAt: number;
}

export interface PipelineDeps {
  /** Send a WhatsApp message back to the customer. */
  send: (message: string) => Promise<void>;
  /** Append to the immutable audit log. */
  audit: (direction: 'inbound' | 'outbound' | 'blocked', text: string, extra?: Record<string, any>) => void;
  /** Get/create the rolling security session for (agencyId, phone). */
  getOrCreateSession: () => Promise<Session>;
  deleteSession: () => Promise<void>;
  /** Mark the lead as opted out of automated follow-ups. */
  markOptedOut: () => Promise<void>;
  /** Read/accumulate the injection-suspicion score for this phone. */
  bumpSuspicionScore: (delta: number) => Promise<number>;
  /** Hand the clean message to the AI bot (state machine + Gemini). */
  handleBotReply: (sanitizedText: string) => Promise<void>;
}

export interface PipelineParams {
  phone: string;
  text: string;
  agencyId: string;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function processInboundMessage(params: PipelineParams, deps: PipelineDeps): Promise<void> {
  const { phone, text, agencyId } = params;

  // 1. & 2. Blocklist + Rate limit (parallel, fail-safe)
  const [isBlocked, passedRateLimit] = await Promise.all([
    checkBlocklist(phone).catch(() => false),          // fail-safe: assume not blocked
    checkRateLimit(phone, agencyId).catch(() => true), // fail-safe: assume passed
  ]);

  if (isBlocked) {
    deps.audit('blocked', text, { reason: 'blocklist' });
    return;
  }

  if (!passedRateLimit) {
    await deps.send(RATE_LIMITED_MSG);
    deps.audit('blocked', text, { reason: 'rate_limit' });
    return;
  }

  // 3. Sanitize
  const sanitized = sanitizeInput(text);

  // 4. Opt-out detection — after sanitize, before injection check
  if (isOptOutMessage(sanitized)) {
    await deps.markOptedOut();
    await deps.send(OPT_OUT_CONFIRM_MSG);
    deps.audit('outbound', OPT_OUT_CONFIRM_MSG, { optOut: true });
    return;
  }

  // 5. Injection detection
  const { isInjection, score } = detectInjection(sanitized);
  if (isInjection) {
    const newScore = await deps.bumpSuspicionScore(score);

    if (newScore >= 3) {
      await blockPhone(phone, `injection_attempts_score_${newScore}`);
      deps.audit('blocked', text, { reason: 'auto_block_injection', score: newScore });
      return;
    }
    // Never forward injection attempts to Gemini — reply generically and stop.
    await deps.send('לא הצלחתי להבין את הבקשה. אשמח לעזור אם תנסח מחדש.');
    deps.audit('blocked', sanitized, { injectionScore: newScore, flagged: true, reason: 'injection_blocked_pre_ai' });
    return;
  }
  deps.audit('inbound', sanitized);

  // 6. Security session TTL (rolling 24h — expires 24h after the LAST message, not after creation)
  const session = await deps.getOrCreateSession();
  const isExpired = session.status === 'expired' || Date.now() - session.lastMessageAt > SESSION_TTL_MS;
  if (isExpired) {
    await deps.send('השיחה פגה. לחידוש פנה למשרד.');
    await deps.deleteSession();
    return;
  }

  // 7. Delegate to the AI bot (state machine + Gemini function calling)
  await deps.handleBotReply(sanitized);
}
