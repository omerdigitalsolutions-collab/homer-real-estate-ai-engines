/**
 * Facebook post classifier and field extractors.
 *
 * Pure TypeScript — no external dependencies. Used by the daily Facebook
 * group scanner to classify posts and pull contact details.
 *
 * Matching strategy: every keyword is tested as a substring so that root
 * words cover all conjugations (e.g. 'מכירה' matches 'למכירה', 'דירה למכירה').
 * Exception: listing-type keywords 'ללא תיווך' and 'לא למתווכים' are compound
 * phrases and must appear verbatim.
 *
 * BUYER is checked before SELLER so that "מחפש דירה להשכרה" is not
 * mis-classified as SELLER due to the substring 'להשכרה'.
 */

export type PostIntent = 'SELLER' | 'BUYER' | 'UNKNOWN';

// Unambiguous signals that someone is offering / selling / renting out a property.
const SELLER_KEYWORDS = [
    'מכירה',
    'למכור',
    'נמכר',
    'מוכר',
    'מוצע',
    'מציע',
    'להשכיר',
    'להשכרה',
    'שכירות',
    'שכר דירה',
    'מתפנה',
];

// Compound phrases where a seller describes LOOKING FOR a buyer/tenant.
// These override the BUYER check — must be evaluated first.
const STRONG_SELLER_KEYWORDS = [
    'מחפש קונה',
    'מחפשת קונה',
    'מחפשים קונה',
    'מחפש שוכר',
    'מחפשת שוכר',
    'מחפשים שוכר',
    'מחפש דייר',
    'מחפשת דייר',
    'מחפשים דייר',
    'מחפש משפחה',
    'מחפשים משפחה',
    'מחפשת משפחה',
];

// Unambiguous "I am offering a property" listing markers. Treated as a strong
// SELLER signal that beats an *incidental* search verb later in the post
// (e.g. "דירה למכירה, מתאים למחפשי השקט"). Position is compared against
// STRONG_BUYER_PHRASES so the intent stated first wins.
const LISTING_MARKERS = [
    'למכירה',
    'להשכרה',
    'להשכיר',
    'למכור',
    'נמכרת',
    'נמכר',
    'מושכרת',
    'מתפנה',
];

// Genuine buyer search phrases: a search verb bound to a property/transaction
// object. Phrase-based (not the bare verb) so incidental 'מחפש' inside a
// listing does not flip it to BUYER.
const STRONG_BUYER_PHRASES = [
    'מחפש דירה', 'מחפשת דירה', 'מחפשים דירה', 'מחפשות דירה',
    'מחפש דירת', 'מחפשת דירת', 'מחפשים דירת',
    'מחפש בית', 'מחפשת בית', 'מחפשים בית',
    'מחפש נכס', 'מחפשת נכס', 'מחפשים נכס',
    'מחפש להשכרה', 'מחפשת להשכרה', 'מחפשים להשכרה',
    'מחפש לקנות', 'מחפש לשכור', 'מחפש לרכוש',
    'דרושה דירה', 'דרוש דירה', 'דרושה דירת', 'דרושים דירה',
    'מעוניין לקנות', 'מעוניינת לקנות', 'מעוניינים לקנות',
    'מעוניין לרכוש', 'מעוניינת לרכוש', 'מעוניינים לרכוש',
    'מעוניין לשכור', 'מעוניינת לשכור', 'מעוניינים לשכור',
    'זוג צעיר מחפש', 'משפחה מחפשת', 'זוג מחפש',
];

// Softer / bare search verbs — used only as a last-resort BUYER signal when no
// listing marker is present at all.
// Note: מבקש/מבקשת/מבקשים removed — too ambiguous ("מחיר מבוקש" / "מבקשים X שקל").
const BUYER_KEYWORDS = [
    'מחפש',
    'מחפשת',
    'מחפשים',
    'מעוניין',
    'מעוניינת',
    'מעוניינים',
    'לרכוש',
    'לקנות',
    'להשתכן',
];

// Listing-type keywords: compound phrases only (user requirement).
// PRIVATE wins when both sets match (e.g. "ללא תיווך" contains "תיווך").
const PRIVATE_KEYWORDS = [
    'ללא תיווך',
    'לא למתווכים',
    'בעל הנכס',
    'בעל הדירה',
    'בעלי הדירה',
    'מוכר בעצמי',
    'מוכרים בעצמנו',
    'ישיר מבעלים',
    'ישיר מהבעלים',
    'מכירה ישירה',
    'מבעל הנכס',
    'אין תיווך',
    'בלי תיווך',
];

const BROKER_KEYWORDS = [
    'מתווך',
    'מתווכת',
    'מתווכים',
    'תיווך',
    'בלעדיות',
    'בבלעדיות',
    'סוכנות',
    'יועץ נדל',
    'יועצת נדל',
    'משרד תיווך',
    'עמלה',
    'ליווי מקצועי',
];

// Commercial property signals (substring match).
const COMMERCIAL_KEYWORDS = [
    'חנות',
    'משרד',
    'מחסן',
    'מסחרי',
    'מגרש',
    'קרקע',
    'שטח מסחרי',
];

/** Earliest index at which any of the keywords appears, or -1 if none. */
function firstIndexOfAny(haystack: string, keywords: string[]): number {
    let min = -1;
    for (const kw of keywords) {
        const i = haystack.indexOf(kw.toLowerCase());
        if (i !== -1 && (min === -1 || i < min)) min = i;
    }
    return min;
}

/**
 * Classify a Facebook post by intent: SELLER (listing a property),
 * BUYER (searching for a property), or UNKNOWN (unrelated/ambiguous).
 *
 * Strategy (most-specific signal first):
 *   1. Seller explicitly looking for a buyer/tenant (מחפש קונה/שוכר/דייר) → SELLER.
 *   2. When a genuine buyer phrase AND a listing marker both appear, the one
 *      stated first wins ("מחפש דירה למכירה" → BUYER; "דירה למכירה למחפשי שקט"
 *      → SELLER). This fixes listings being flipped to BUYER by an incidental
 *      'מחפש' substring.
 *   3. Only one of them present → that intent.
 *   4. Fallbacks: a bare search verb (no listing marker) → BUYER; otherwise a
 *      soft seller keyword → SELLER.
 */
export function classifyPostIntent(text: string): PostIntent {
    if (!text) return 'UNKNOWN';
    const lower = text.toLowerCase();

    // 1. Seller seeking a buyer/tenant — unambiguous SELLER.
    if (STRONG_SELLER_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))) return 'SELLER';

    // 2-3. Genuine buyer phrase vs. listing marker — earliest mention wins.
    const buyerIdx  = firstIndexOfAny(lower, STRONG_BUYER_PHRASES);
    const sellerIdx = firstIndexOfAny(lower, LISTING_MARKERS);
    if (buyerIdx !== -1 && sellerIdx !== -1) return buyerIdx <= sellerIdx ? 'BUYER' : 'SELLER';
    if (buyerIdx !== -1) return 'BUYER';
    if (sellerIdx !== -1) return 'SELLER';

    // 4. Softer fallbacks: bare search verb (no listing marker) → BUYER.
    if (BUYER_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))) return 'BUYER';
    if (SELLER_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))) return 'SELLER';
    return 'UNKNOWN';
}

/**
 * For SELLER posts only — determine if the listing is direct from owner
 * (PRIVATE) or posted by a real-estate broker (BROKER).
 * Private wins when both keyword sets match, since owners often write
 * "ללא תיווך" alongside the word "תיווך".
 */
export function classifyListingType(text: string): 'PRIVATE' | 'BROKER' {
    if (!text) return 'PRIVATE';
    const lower = text.toLowerCase();

    const hasPrivate = PRIVATE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
    if (hasPrivate) return 'PRIVATE';

    const hasBroker = BROKER_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
    if (hasBroker) return 'BROKER';

    return 'PRIVATE';
}

/** @deprecated Use classifyPostIntent + classifyListingType instead. */
export function classifyFBPost(text: string): 'PRIVATE' | 'BROKER' {
    return classifyListingType(text);
}

/**
 * Extract the first Israeli phone number from a text blob (mobile or landline).
 * Returns the number with dashes stripped, or null if none found.
 */
export function extractPhone(text: string): string | null {
    if (!text) return null;
    // Supports formats: 0501234567 / 050-123-4567 / 050 123 4567 / 050-1234567 / 050 1234567
    const re = /(05\d[\s\-]?\d{3}[\s\-]?\d{4}|0[23489][\s\-]?\d{7})/;
    const match = text.match(re);
    if (!match) return null;
    return match[0].replace(/[\s\-]/g, '');
}

/**
 * Pick the first Photo attachment URL from an Apify Facebook post item.
 * Skips MediaContainerMediaSet wrappers and product-card attachments.
 */
export function extractThumbnail(attachments: any[] | undefined | null): string | null {
    if (!Array.isArray(attachments)) return null;
    for (const a of attachments) {
        if (a?.__typename === 'Photo' && a?.image?.uri) {
            return a.image.uri as string;
        }
    }
    return null;
}

const DIGIT_WORDS: Record<string, number> = {
    'אחד': 1, 'אחת': 1, 'שניים': 2, 'שתיים': 2, 'שלושה': 3, 'שלוש': 3,
    'ארבעה': 4, 'ארבע': 4, 'חמישה': 5, 'חמש': 5, 'שישה': 6, 'שש': 6,
    'שבעה': 7, 'שבע': 7, 'שמונה': 8, 'תשעה': 9, 'תשע': 9,
};

/** Extract room count from buyer/seller post text ("3 חדרים", "שלושה חד'", etc.). */
export function extractRooms(text: string): number | null {
    if (!text) return null;
    const numericMatch = text.match(/(\d(?:\.\d)?)\s*(?:חדרים|חד'|חד׳)/);
    if (numericMatch) {
        const n = parseFloat(numericMatch[1]);
        if (n >= 1 && n <= 9) return n;
    }
    for (const [word, val] of Object.entries(DIGIT_WORDS)) {
        if (text.includes(word) && text.includes('חד')) return val;
    }
    return null;
}

/** Extract max budget from buyer post text ("עד מיליון", "1.5 מיליון", "800 אלף"). */
export function extractBudget(text: string): number | null {
    if (!text) return null;
    const millionMatch = text.match(/(\d+(?:[.,]\d+)?)?\s*מיליון/);
    if (millionMatch) {
        const n = millionMatch[1] ? parseFloat(millionMatch[1].replace(',', '.')) : 1;
        return Math.round(n * 1_000_000);
    }
    const thousandMatch = text.match(/(\d+(?:[.,]\d+)?)\s*אלף/);
    if (thousandMatch) {
        return Math.round(parseFloat(thousandMatch[1].replace(',', '.')) * 1_000);
    }
    const shekelMatch = text.match(/עד\s+([\d,]+)\s*(?:ש[״"]ח|₪)/);
    if (shekelMatch) {
        return parseInt(shekelMatch[1].replace(/,/g, ''), 10);
    }
    return null;
}

/** Infer transaction type from post text; defaults to 'forsale'. */
export function extractTransactionType(text: string): 'forsale' | 'rent' | 'commercial' {
    if (!text) return 'forsale';
    const lower = text.toLowerCase();
    if (COMMERCIAL_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))) return 'commercial';
    if (['לשכירה', 'להשכרה', 'שכירות', 'לשכור', 'השכרה'].some(kw => lower.includes(kw))) return 'rent';
    return 'forsale';
}

/** Extract area in square meters from text ("90 מ\"ר", "90 מטר רבוע"). */
export function extractSquareMeters(text: string): number | null {
    if (!text) return null;
    const m = text.match(/(\d{2,4})\s*(?:מ["״']?ר|מטר(?:\s*רבוע)?)/);
    return m ? parseInt(m[1], 10) : null;
}

const FLOOR_WORDS: Record<string, number> = {
    'קרקע': 0, 'ראשונה': 1, 'ראשון': 1, 'שניה': 2, 'שני': 2, 'שתיים': 2,
    'שלישית': 3, 'שלישי': 3, 'רביעית': 4, 'רביעי': 4,
    'חמישית': 5, 'חמישי': 5, 'שישית': 6, 'שישי': 6,
    'שביעית': 7, 'שביעי': 7, 'שמינית': 8, 'שמיני': 8,
    'תשיעית': 9, 'תשיעי': 9, 'עשירית': 10, 'עשירי': 10,
};

/** Extract floor number (and total floors if available) from post text. */
export function extractFloor(text: string): { floor: number | null; totalFloors: number | null } {
    if (!text) return { floor: null, totalFloors: null };
    // "קומה 4 מתוך 8" or "קומה 4/8"
    const full = text.match(/קומה\s+(\d+)\s*(?:מתוך|\/)\s*(\d+)/);
    if (full) return { floor: +full[1], totalFloors: +full[2] };
    // "קומה 4"
    const num = text.match(/קומה\s+(\d+)/);
    if (num) return { floor: +num[1], totalFloors: null };
    // "קומה רביעית" / "בקומה הרביעית"
    for (const [word, val] of Object.entries(FLOOR_WORDS)) {
        if (text.includes(`קומה ${word}`) || text.includes(`ה${word}`))
            return { floor: val, totalFloors: null };
    }
    return { floor: null, totalFloors: null };
}

/** Extract asking price from a SELLER post. */
export function extractPrice(text: string): number | null {
    if (!text) return null;
    // "2,500,000 ₪" / "2,500,000 ש\"ח"
    const shekel = text.match(/([\d,]+)\s*(?:₪|ש["״']ח)/);
    if (shekel) return parseInt(shekel[1].replace(/,/g, ''), 10);
    // "2.5 מיליון"
    const mil = text.match(/(\d+(?:[.,]\d+)?)\s*מיליון/);
    if (mil) return Math.round(parseFloat(mil[1].replace(',', '.')) * 1_000_000);
    // "800 אלף"
    const k = text.match(/(\d+(?:[.,]\d+)?)\s*אלף/);
    if (k) return Math.round(parseFloat(k[1].replace(',', '.')) * 1_000);
    // "מחיר: 2500000"
    const label = text.match(/(?:מחיר|עלות)[:\s]+([\d,]+)/);
    if (label) return parseInt(label[1].replace(/,/g, ''), 10);
    return null;
}

/** Infer property type from post text; defaults to 'apartment'. */
export function extractPropertyType(text: string): string {
    if (!text) return 'apartment';
    if (/פנטהאוז/.test(text)) return 'penthouse';
    if (/דירת גן/.test(text)) return 'garden_apartment';
    if (/דופלקס/.test(text)) return 'duplex';
    if (/קוטג'|בית פרטי|בית דו/.test(text)) return 'house';
    if (/וילה/.test(text)) return 'villa';
    if (/סטודיו/.test(text)) return 'studio';
    if (/יחידת דיור/.test(text)) return 'apartment';
    if (/מגרש|קרקע/.test(text)) return 'land';
    if (/משרד/.test(text)) return 'office';
    if (/חנות/.test(text)) return 'store';
    if (/מחסן/.test(text)) return 'storage';
    return 'apartment';
}

/** Detect elevator presence from post text. */
export function extractHasElevator(text: string): boolean | null {
    if (!text) return null;
    if (/ללא מעלית|אין מעלית|בלי מעלית/.test(text)) return false;
    if (/מעלית/.test(text)) return true;
    return null;
}

/** Extract parking presence and spot count from post text. */
export function extractParking(text: string): { hasParking: boolean | null; parkingSpots: number | null } {
    if (!text) return { hasParking: null, parkingSpots: null };
    if (/ללא חניה|אין חניה|בלי חניה/.test(text)) return { hasParking: false, parkingSpots: null };
    // "2 חניות" / "3 חניות"
    const countMatch = text.match(/(\d+)\s*חניו?ת/);
    if (countMatch) return { hasParking: true, parkingSpots: parseInt(countMatch[1], 10) };
    if (/חניה כפולה/.test(text)) return { hasParking: true, parkingSpots: 2 };
    if (/חניה/.test(text)) return { hasParking: true, parkingSpots: 1 };
    return { hasParking: null, parkingSpots: null };
}

/** Extract neighborhood name from "שכונת X" or "בשכונת X" patterns. */
export function extractNeighborhood(text: string): string | null {
    if (!text) return null;
    const m = text.match(/(?:בשכונת|שכונת)\s+([^\s,.\n]+(?:\s+[^\s,.\n]+)?)/);
    return m ? m[1].trim() : null;
}

/** Extract street name and number from patterns like "רחוב הרצל 15". */
export function extractStreet(text: string): { street: string; number: string } | null {
    if (!text) return null;
    const m = text.match(/(?:ברחוב|רחוב|ר')\s+([^\s,\n]+(?:\s+[^\s,\n]+)?)\s+(\d+)/);
    return m ? { street: m[1].trim(), number: m[2] } : null;
}

const ISRAEL_CITIES_FOR_EXTRACT = [
    'תל אביב-יפו', 'תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 'אשדוד',
    'נתניה', 'באר שבע', 'בני ברק', 'חולון', 'רמת גן', 'אשקלון', 'רחובות',
    'בת ים', 'הרצליה', 'כפר סבא', 'מודיעין', 'חדרה', 'לוד', 'מזכרת בתיה',
    'נס ציונה', 'קרית גת', 'אילת', 'נהריה', 'ראש העין', 'גבעתיים', 'רעננה',
    'הוד השרון', 'יבנה', 'רמלה', 'אור יהודה', 'קרית אונו', 'אלעד',
    'מבשרת ציון', 'ביתר עילית', 'בית שמש', 'מודיעין עילית', 'קרית שמונה',
    'עפולה', 'טבריה', 'נצרת', 'עכו', 'כרמיאל', 'מעלות', 'צפת', 'שדרות',
    'ירוחם', 'דימונה', 'ערד', 'קרית אתא', 'קרית ביאליק', 'קרית מוצקין', 'קרית ים',
    'מגדל העמק', 'אופקים', 'נתיבות', 'שוהם', 'ראש פינה', 'זכרון יעקב',
    'פרדס חנה', 'קיסריה', 'בנימינה', 'יוקנעם', 'מעלה אדומים', 'אריאל',
    'גבעת זאב', 'בית אל', 'אפרת', 'אלפי מנשה', 'גן יבנה', 'יהוד',
    'אבן יהודה', 'תל מונד', 'כפר יונה', 'פרדסיה', 'ראש העין', 'קלנסווה',
    'טייבה', 'כפר קאסם', 'ג\'לג\'וליה', 'בית יצחק', 'שפרעם', 'סח\'נין',
    'עראבה', 'טמרה', 'כפר כנא', 'מגאר', 'בועינה', 'נצרת עילית',
];

/** Extract the first matching Israeli city name from text. */
export function extractCity(text: string): string | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    // Longer names first to avoid "תל אביב" matching inside "תל אביב-יפו"
    const sorted = [...ISRAEL_CITIES_FOR_EXTRACT].sort((a, b) => b.length - a.length);
    return sorted.find(c => lower.includes(c.toLowerCase())) || null;
}

/** Detect if a page is likely a property listing (price found + at least one property field). */
export function isLikelyPropertyPage(text: string): boolean {
    if (!text) return false;
    const hasPrice = extractPrice(text) !== null;
    if (!hasPrice) return false;
    const hasRoom = extractRooms(text) !== null;
    const hasSqm = extractSquareMeters(text) !== null;
    const hasFloor = extractFloor(text).floor !== null;
    const hasCity = extractCity(text) !== null;
    return hasRoom || hasSqm || hasFloor || hasCity;
}
