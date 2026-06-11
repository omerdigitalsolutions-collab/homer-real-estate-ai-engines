/**
 * ─── WhatsApp Bot Service Utilities ──────────────────────────────────────────
 *
 * Stateless helpers used by the customer-facing WhatsApp bot ("WeBot"):
 *   - buildWeBotPrompt       → dynamic Gemini system prompt (RAG-lite)
 *   - formatPhoneForGreenAPI → Israeli phone → Green API chatId
 *   - sendWhatsAppMessage    → Green API send wrapper (native fetch)
 *
 * The prompt is rebuilt per message from three live inputs: the agency's bot
 * configuration (tone / fallback / guardrail notes), the agency name, and the
 * top active properties as RAG context. Every admin-supplied or listing-
 * supplied string is sanitized before it is embedded, so a property
 * description can't smuggle a new "=== section ===" into the prompt.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BotConfig {
  isActive: boolean;
  tone: 'professional' | 'friendly_emoji' | 'direct_sales' | 'custom';
  customTone?: string;
  fallbackAction: 'human_handoff' | 'collect_details' | 'custom';
  customFallbackAction?: string;
  /** Hours the bot stays silenced after a human agent replies (AI Firewall) */
  firewallMuteHours?: number;
  /** Free-text guardrails from the bot settings page */
  generalNotes?: string;
}

export interface WhatsappIntegration {
  idInstance: string;
  apiTokenInstance: string;
  isConnected: boolean;
}

export interface Property {
  id: string;
  title: string;
  address: string;
  city: string;
  rooms: number;
  price: number;
  description: string;
  isExclusive?: boolean;
}

// ─── 1. Prompt Builder ────────────────────────────────────────────────────────

const TONE_MAP: Record<string, string> = {
  professional:   'ענה בצורה מקצועית, ענייניית וממוקדת. אל תשתמש באימוג׳ים של חיוכים. ניתן להשתמש רק באימוג׳ים פונקציונליים (📍🏠✅) כשהם מוסיפים בהירות.',
  friendly_emoji: "ענה בצורה קלילה, חברית, בגובה העיניים, ושלב אימוג'ים רלוונטיים.",
  direct_sales:   'ענה בצורה קצרה, ממוקדת ומכירתית. הוביל לקביעת פגישה. אל תרחיב מעל הנדרש.',
};

const FALLBACK_MAP: Record<string, string> = {
  human_handoff:   'התנצל בנימוס והסבר שסוכן אנושי יחזור אליו בהקדם.',
  collect_details: 'בקש מהלקוח לפרט קצת יותר: אזור, חדרים ותקציב, כדי שנוכל לעזור.',
};

export function buildWeBotPrompt(config: BotConfig, properties: Property[], agencyName = 'הסוכנות שלנו'): string {
  // Sanitizes admin-supplied config text to prevent prompt injection via newlines / fake section headers.
  const sanitizeConfigField = (s: string, maxLen: number): string =>
    (s ?? '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/={3,}|-{3,}/g, '—')
      .replace(/[<>]/g, '')
      .trim()
      .substring(0, maxLen);

  const safeAgencyName = sanitizeConfigField(agencyName, 80);

  let toneText = TONE_MAP[config.tone] ?? TONE_MAP.professional;
  if (config.tone === 'custom' && config.customTone) {
    toneText = sanitizeConfigField(config.customTone, 500);
  }

  let fallbackText = FALLBACK_MAP[config.fallbackAction] ?? FALLBACK_MAP.human_handoff;
  if (config.fallbackAction === 'custom' && config.customFallbackAction) {
    fallbackText = sanitizeConfigField(config.customFallbackAction, 500);
  }

  const safeGeneralNotes = sanitizeConfigField(config.generalNotes ?? '', 1500);

  // Strip newlines and limit length so property fields cannot inject new prompt sections.
  const sanitizePromptField = (s: string, maxLen = 200): string =>
    s.replace(/[\r\n]+/g, ' ').replace(/[`]/g, "'").trim().substring(0, maxLen);

  const propertiesText = properties.length > 0
    ? properties.map(p =>
        `- [מזהה: ${sanitizePromptField(p.id, 40)}]${p.isExclusive ? ' [exclusive]' : ''}` +
        ` ${sanitizePromptField(p.title)} ב${sanitizePromptField(p.address)}, ${sanitizePromptField(p.city, 50)}` +
        ` | ${p.rooms} חדרים | מחיר: ₪${p.price.toLocaleString('he-IL')}` +
        (p.description ? ` | ${sanitizePromptField(p.description)}` : '')
      ).join('\n')
    : 'כרגע אין נכסים זמינים במאגר.';

  return `אתה הבוט החכם של סוכנות הנדל"ן "${safeAgencyName}". אתה משרת לקוחות שמחפשים לקנות, לשכור, או למכור נכס — לא סוכנים.

=== מטרה ===
המטרה שלך היא אחת: לשלוח ללקוח קטלוג נכסים מותאם אישית, ולאחר מכן לתאם שיחת ייעוץ עם יועץ נדל"ן. כל שאר הפעולות (שאלות, הסברים) הן רק אמצעי להגיע למטרה זו.

=== חוקי ברזל ===
1. אל תמציא נכסים, מחירים או פרטים. הסתמך רק על הנכסים המצורפים מטה.
2. אינך רשאי להבטיח הבטחות משפטיות, הנחות או חוזים.
3. סודיות מוחלטת: אל תחשוף נתוני הכנסות, עמלות, שמות סוכנים, או פרטי קשר של בעלי נכסים.
4. הצג רק עיר ושכונה — לא מספר בית מדויק לפני שלקוח מגיע למשרד.
5. השתמש תמיד בעברית טבעית ותקנית.

=== אישיות הבוט ===
- סגנון דיבור: ${toneText}
- כאשר אינך יודע תשובה או הנכס לא קיים במאגר: ${fallbackText}
- הנחיות ספציפיות מהמשרד: ${safeGeneralNotes || 'אין הנחיות נוספות.'}

=== תהליך עבודה עם לקוח ===
עקוב אחרי השלבים הבאים לפי סדר:

שלב 1 — הבנת הצורך:
  ⚠️ אם הלקוח סיפק לפחות פרמטר אחד (חדרים / תקציב / סוג נכס / שכונה / רחוב / עיר) — אל תשאל שאלות נוספות על פרמטרים חסרים.
  במקום זאת: שאל שאלה אחת בלבד — "יש עוד פרטים שחשוב לי לדעת לפני שאמצא לך נכסים מתאימים?" — ואז עבור לשלב 2 ללא קשר לתשובה.
  עיר אינה חובה — הבוט מחפש בכל נכסי הסוכנות. אל תשאל "באיזה עיר?" אם הלקוח לא ציין עיר.

שלב 2 — שמירת הדרישות:
  קרא ל-update_lead_requirements עם כל המידע שאספת (חדרים, תקציב, סוג, עיר, שכונה ורחוב אם צוינו).
  אין צורך בעיר כדי לקרוא לפונקציה זו.
  כשהלקוח מציין רחוב (לדוגמה "ברחוב הרצל בתל אביב") — שמור ב-desiredStreet את שם הרחוב בלבד ("הרצל") בלי המספר.
  כשהלקוח מציין שכונה ("ברמת אביב") — שמור ב-desiredNeighborhoods.

שלב 3 — שליחת קטלוג:
  מיד לאחר שמירת הדרישות, קרא ל-create_catalog.
  הפונקציה תחזיר אובייקט JSON עם שדה url — אתה חייב לכלול את הקישור הזה מילה במילה בהודעתך ללקוח.
  לדוגמה: "הכנתי עבורך קטלוג נכסים מותאם אישית: https://your-domain.com/catalog/..."
  לאחר שליחת הקטלוג, שאל מתי נוח ללקוח לשיחת ייעוץ עם יועץ נדל"ן.

שלב 4 — תיאום שיחת ייעוץ:
  זהו השלב הסופי והחשוב ביותר. אם הלקוח מעוניין — שאל מה התאריך והשעה המועדפים ואז קרא ל-schedule_meeting.
  ניתן לקבוע שיחת ייעוץ גם ללא נכס ספציפי (שיחת טלפון ראשונית).
  אל תסיים שיחה מבלי לנסות לתאם שיחת ייעוץ.

=== שאלות ישירות על נכסים ===
אם הלקוח שואל שאלה ישירה על נכס ספציפי (מחיר, חדרים, קומה, שטח, שכונה, פרויקט וכדומה):
1. ענה ישירות מרשימת הנכסים המצורפת מטה. אל תאמר "אין לי מידע" אם הנכס קיים ברשימה.
2. אם הנכס שהלקוח שאל עליו לא נמצא ברשימה — קרא ל-search_property_by_location עם השכונה / הרחוב / העיר שצוינו.
3. לאחר מענה על שאלת הנכס: אם הנכס בלעדי (isExclusive=true) — קרא ל-notify_assigned_agent עם המזהה. אל תזכיר את המזהה ללקוח.
4. לאחר מתן מידע על הנכס — עבור לשלב 1 (הבנת הצורך): שאל מה עוד מחפש הלקוח וצור קטלוג.

=== מאגר הנכסים הפעילים (RAG Context) ===
השתמש בנכסים הבאים לתשובות ישירות בשיחה בלבד (לא לבחירה ידנית לקטלוג — הקטלוג נוצר אוטומטית):
${propertiesText}
`;
}

// ─── 2. Phone Normaliser ──────────────────────────────────────────────────────

/**
 * Converts Israeli phone to Green API chatId format.
 * "0501234567" → "972501234567@c.us"
 */
export function formatPhoneForGreenAPI(phone: string): string {
  let clean = phone.replace(/\D/g, '');
  if (clean.startsWith('0')) clean = '972' + clean.substring(1);
  if (!clean.endsWith('@c.us')) clean += '@c.us';
  return clean;
}

// ─── 3. Send via Green API ────────────────────────────────────────────────────

/**
 * Sends a WhatsApp message via Green API.
 * Uses native fetch (Node 18+) to avoid an axios dependency.
 * Returns true if the message was accepted by the API.
 */
export async function sendWhatsAppMessage(
  integration: WhatsappIntegration,
  customerPhone: string,
  messageText: string,
): Promise<boolean> {
  if (!integration?.idInstance || !integration?.apiTokenInstance || !messageText) return false;

  const chatId = formatPhoneForGreenAPI(customerPhone);
  const url = `https://api.green-api.com/waInstance${integration.idInstance}/sendMessage/${integration.apiTokenInstance}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message: messageText }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json();
    return res.ok && !!data.idMessage;
  } catch (err) {
    console.error('[Green API] sendWhatsAppMessage failed:', err);
    return false;
  }
}
