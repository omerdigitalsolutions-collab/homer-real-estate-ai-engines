/**
 * Phone blocklist. In production this is a Firestore collection
 * (`whatsapp_blocklist/{phone}`) so blocks survive restarts and apply
 * across all function instances; here an in-memory set keeps the
 * pipeline runnable standalone.
 */
const blocked = new Map<string, { reason: string; blockedAt: number }>();

export async function checkBlocklist(phone: string): Promise<boolean> {
  return blocked.has(phone);
}

export async function blockPhone(phone: string, reason: string): Promise<void> {
  blocked.set(phone, { reason, blockedAt: Date.now() });
  console.warn(`[Bot Security] ⛔ Blocked phone: ${phone} — reason: ${reason}`);
}
