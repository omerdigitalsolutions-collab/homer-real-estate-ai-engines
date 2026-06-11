/**
 * Gemini single-pass call analysis: transcription + summary + structured lead
 * extraction from one stereo recording (left channel = customer, right = agent).
 * Every field returned by the model is validated/coerced before use.
 */

import { GoogleGenerativeAI, Part } from '@google/generative-ai';

export type PropertyType = 'apartment' | 'house' | 'plot' | 'commercial';
const VALID_PROPERTY_TYPES = new Set<PropertyType>(['apartment', 'house', 'plot', 'commercial']);

/** Structured output from analysing a recorded phone call */
export interface CallLeadPayload {
    transcription: string;
    summary: string;
    clientName: string | null;
    budget_max: number | null;
    rooms: number | null;
    preferred_location: string | null;
    property_type: PropertyType;
    transaction_type: 'sale' | 'rent' | null;
    floor_min: number | null;
    floor_max: number | null;
    min_size_sqm: number | null;
    must_have_elevator: boolean;
    must_have_parking: boolean;
    must_have_balcony: boolean;
    must_have_safe_room: boolean;
    urgency: 'immediate' | 'flexible' | null;
    condition: 'new' | 'renovated' | 'any' | null;
    extra_notes: string | null;
}

const CALL_ANALYSIS_PROMPT = `אתה מנתח שיחות בין סוכן נדל"ן ולקוח פוטנציאלי.
השיחה מוקלטת ב-Stereo: ערוץ שמאל = לקוח, ערוץ ימין = סוכן.

תפקידך:
1. תמלל את השיחה המלאה בעברית — ציין [סוכן] ו[לקוח] לפני כל תור דיבור.
2. ספק סיכום קצר (2-3 משפטים) של צרכי הלקוח.
3. חלץ נתונים מובנים.

חוקים:
- אם שדה לא הוזכר בשיחה — הגדר כ-null (או false לשדות בוליאניים).
- budget_max: מספר שלם בשקלים (לדוגמה "3 מיליון" → 3000000).
- property_type: "apartment" | "house" | "plot" | "commercial" — תרגם מעברית.
- transaction_type: "sale" (קנייה/מכירה) | "rent" (שכירות) | null.
- floor_min / floor_max: מספר קומה (לדוגמה "קומה 3 ומעלה" → floor_min: 3, floor_max: null).
- min_size_sqm: שטח מינימלי במ"ר (לדוגמה "לפחות 100 מטר" → 100).
- must_have_elevator: true אם הלקוח ביקש מעלית, אחרת false.
- must_have_parking: true אם הלקוח ביקש חנייה, אחרת false.
- must_have_balcony: true אם הלקוח ביקש מרפסת, אחרת false.
- must_have_safe_room: true אם הלקוח ביקש ממ"ד, אחרת false.
- urgency: "immediate" (דחוף/מיידי/עכשיו) | "flexible" (גמיש/לא דחוף) | null.
- condition: "new" (חדש מקבלן/בנייה חדשה) | "renovated" (משופץ) | "any" (לא משנה) | null.
- extra_notes: כל מידע רלוונטי שלא נכנס לשדות אחרים (למשל שכונה מועדפת, קומת קרקע בלבד, עם גינה וכד').

החזר JSON בלבד — ללא markdown, ללא הסברים:
{
  "transcription": "תמלול מלא עם [סוכן] / [לקוח]...",
  "summary": "סיכום קצר של צרכי הלקוח...",
  "clientName": string | null,
  "budget_max": number | null,
  "rooms": number | null,
  "preferred_location": string | null,
  "property_type": "apartment" | "house" | "plot" | "commercial",
  "transaction_type": "sale" | "rent" | null,
  "floor_min": number | null,
  "floor_max": number | null,
  "min_size_sqm": number | null,
  "must_have_elevator": boolean,
  "must_have_parking": boolean,
  "must_have_balcony": boolean,
  "must_have_safe_room": boolean,
  "urgency": "immediate" | "flexible" | null,
  "condition": "new" | "renovated" | "any" | null,
  "extra_notes": string | null
}`;

function stripFences(text: string): string {
    return text.trim()
        .replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
}

/**
 * Analyses a recorded phone call using Gemini.
 * Transcribes, summarises, and extracts structured lead data in one pass.
 */
export async function extractLeadDataFromAudio(
    audioBase64: string,
    mimeType: string,
    apiKey: string,
): Promise<CallLeadPayload> {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const parts: Part[] = [
        { text: CALL_ANALYSIS_PROMPT },
        { inlineData: { data: audioBase64, mimeType } },
    ];

    const result = await model.generateContent(parts);
    const rawText = stripFences(result.response.text());

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        throw new Error('[extractLeadDataFromAudio] Gemini returned invalid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('[extractLeadDataFromAudio] Gemini returned non-object');
    }

    const obj = parsed as Record<string, unknown>;

    // Coercion helpers — model output is untrusted input, never used raw
    const toStr = (v: unknown): string | null =>
        typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
    const toNum = (v: unknown): number | null => {
        if (typeof v === 'number' && isFinite(v)) return Math.round(v);
        if (typeof v === 'string') {
            const n = parseFloat(v.replace(/,/g, ''));
            if (isFinite(n)) return Math.round(n);
        }
        return null;
    };
    const toBool = (v: unknown): boolean => v === true || v === 'true' || v === 1;

    const propertyType: PropertyType = VALID_PROPERTY_TYPES.has(obj['property_type'] as PropertyType)
        ? (obj['property_type'] as PropertyType)
        : 'apartment';

    const txRaw = toStr(obj['transaction_type']);
    const transactionType: 'sale' | 'rent' | null =
        txRaw === 'sale' || txRaw === 'rent' ? txRaw : null;

    const urgencyRaw = toStr(obj['urgency']);
    const urgency: 'immediate' | 'flexible' | null =
        urgencyRaw === 'immediate' || urgencyRaw === 'flexible' ? urgencyRaw : null;

    const conditionRaw = toStr(obj['condition']);
    const condition: 'new' | 'renovated' | 'any' | null =
        conditionRaw === 'new' || conditionRaw === 'renovated' || conditionRaw === 'any'
            ? conditionRaw
            : null;

    return {
        transcription: toStr(obj['transcription']) ?? '',
        summary: toStr(obj['summary']) ?? '',
        clientName: toStr(obj['clientName']),
        budget_max: toNum(obj['budget_max']),
        rooms: toNum(obj['rooms']),
        preferred_location: toStr(obj['preferred_location']),
        property_type: propertyType,
        transaction_type: transactionType,
        floor_min: toNum(obj['floor_min']),
        floor_max: toNum(obj['floor_max']),
        min_size_sqm: toNum(obj['min_size_sqm']),
        must_have_elevator: toBool(obj['must_have_elevator']),
        must_have_parking: toBool(obj['must_have_parking']),
        must_have_balcony: toBool(obj['must_have_balcony']),
        must_have_safe_room: toBool(obj['must_have_safe_room']),
        urgency,
        condition,
        extra_notes: toStr(obj['extra_notes']),
    };
}
