import { GoogleGenerativeAI } from '@google/generative-ai';

export interface FBTextAnalysis {
    transactionType: 'forsale' | 'rent' | 'commercial';
    price: number | null;
    rooms: number | null;
    squareMeters: number | null;
    floor: number | null;
    totalFloors: number | null;
}

const PROMPT = `You are a real estate data extractor for Israeli property listings.
Given the following Hebrew Facebook post text, extract the fields below.

Return ONLY valid JSON (no markdown, no explanation):
- "transactionType": "forsale" | "rent" | "commercial"
  forsale = מכירה, commercial = מסחרי/חנות/משרד/קרקע, rent = כל השאר (שכירות/שכר דירה/להשכרה)
- "price": number or null — the price/rent amount as a plain integer (e.g. 7500, 2500000). null if not found.
- "rooms": number or null — total room count (include bedrooms + living room). e.g. "שני חדרי שינה וסלון" = 3. null if not found.
- "squareMeters": number or null — property size in sqm. null if not found.
- "floor": number or null — floor number. null if not found.
- "totalFloors": number or null — total floors in building. null if not found.

Post text:
`;

export async function analyzePostTextWithGemini(
    text: string,
    geminiApiKey: string,
): Promise<FBTextAnalysis | null> {
    try {
        const genAI = new GoogleGenerativeAI(geminiApiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        const result = await model.generateContent(PROMPT + text);
        let raw = result.response.text().trim()
            .replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();

        const parsed = JSON.parse(raw);

        const txType = ['forsale', 'rent', 'commercial'].includes(parsed.transactionType)
            ? parsed.transactionType as FBTextAnalysis['transactionType']
            : null;

        return {
            transactionType: txType || 'forsale',
            price: typeof parsed.price === 'number' ? parsed.price : null,
            rooms: typeof parsed.rooms === 'number' ? parsed.rooms : null,
            squareMeters: typeof parsed.squareMeters === 'number' ? parsed.squareMeters : null,
            floor: typeof parsed.floor === 'number' ? parsed.floor : null,
            totalFloors: typeof parsed.totalFloors === 'number' ? parsed.totalFloors : null,
        };
    } catch (err) {
        console.warn('[fbTextAnalyzer] Gemini text analysis failed:', err);
        return null;
    }
}

/** Returns true when extracted fields look suspicious and warrant Gemini re-analysis. */
export function needsTextAnalysis(
    intent: string,
    txType: string,
    price: number | null,
    rooms: number | null,
): boolean {
    if (intent !== 'SELLER') return false;
    // Price looks like a rent amount rather than a sale price
    const priceAnomalous = txType === 'forsale' && (price === null || price < 200_000);
    // Rooms=1 is a known false-positive from DIGIT_WORDS (e.g. "אחד" matching)
    const roomsAnomalous = rooms !== null && rooms <= 1;
    return priceAnomalous || roomsAnomalous;
}
