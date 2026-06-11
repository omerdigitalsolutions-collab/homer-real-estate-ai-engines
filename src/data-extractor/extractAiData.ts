/**
 * ─── AI Bulk Import — multi-entity extraction framework ──────────────────────
 *
 * One function turns messy input (CSV text, scraped blobs, or a base64 image
 * of a listing sheet) into typed CRM records. The entity type selects a
 * system prompt with a strict JSON contract; the payload is attached either
 * as text or as inline image data (Gemini Vision) — same code path.
 *
 * In production this is a Firebase callable gated by a per-plan feature guard
 * (AI_IMPORT_TEXT); here it's a plain async function taking the API key.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

export type EntityType =
    | 'properties' | 'property'
    | 'leads' | 'lead'
    | 'expenses'
    | 'finance'
    | 'deals' | 'deal'
    | 'agents' | 'agent'
    | 'combined' | 'mixed';

const PROMPTS: Record<string, string> = {
    properties: `You are an expert data extraction assistant for a real estate CRM.
You will receive raw scraped data, a CSV, or image text. Intelligently map this data into a strictly formatted JSON array of objects.
Rules for property objects:
- "price" (number, overcome typos like '2.5M' to 2500000)
- "city" (string)
- "address" (string - street address)
- "rooms" (number)
- "sqm" (number - total size in square meters)
- "floor" (number)
- "totalFloors" (number - total floors in building, extracted from patterns like 'קומה 3 מתוך 8' → 8)
- "type" (string - 'למכירה' or 'להשכרה')
- "kind" (string - property kind like 'דירה', 'פנטהאוז', 'דירת גן')
- "description" (string - EXTRACT THE FULL DESCRIPTION. Include details about property condition, view, orientations, and special features. Do not summarize too much.)
- "contactPhone" (string - phone number of the listing contact, owner, or agent. Extract all digits and format cleanly, e.g. '050-1234567')
- "agentName" (string - name or email of the agent responsible for the property)
- "agentLicense" (string - broker/agent license number if visible, e.g. from 'רישוי מס׳ 12345' extract '12345')
- "listingType" (string - 'exclusive' if it's an office listing/בלעדיות, 'external' if it's a cooperation/שת״פ, 'private' if it's a private owner/פרטי. Default to 'exclusive' if unsure.)
- "isExclusive" (boolean - true unless listingType is explicitly 'private' or 'external')
- "exclusivityEndDate" (string - 'YYYY-MM-DD' format if an exclusivity end date is found)
- "hasElevator" (boolean - true if מעלית is mentioned)
- "hasParking" (boolean - true if חניה/חנייה is mentioned)
- "hasMamad" (boolean - true if ממ"ד or ממד is mentioned)
- "hasBalcony" (boolean - true if מרפסת is mentioned)
- "hasStorage" (boolean - true if מחסן is mentioned)
Return ONLY a valid parseable JSON array of objects. Do not use markdown wrapping (\`\`\`json) in the response. Ignore empty rows.`,

    leads: `You are an expert data extraction assistant for a real estate CRM.
You will receive raw scraped data, a CSV, or image text. Intelligently map this data into a strictly formatted JSON array of objects.
Rules for lead objects:
- "name" (string - full name)
- "phone" (string - clean numbers only if possible)
- "email" (string)
- "budget" (number, overcome typos like '2.5M' to 2500000)
- "city" (string - desired city)
- "notes" (string - extra details)
- "agentName" (string - name or email of the agent assigned to this lead)
Return ONLY a valid parseable JSON array of objects. Do not use markdown wrapping (\`\`\`json) in the response. Ignore empty rows.`,

    expenses: `You are a financial assistant for a real estate agency. Review this JSON array of raw expenses. Map each expense to one of the following exact categories: ['שיווק', 'תפעול משרד', 'שכר', 'רכבים', 'שונות'].
Return a raw JSON array of objects with the exact keys:
- "description" (string)
- "amount" (number)
- "category" (string - must be one of the exact 5 categories above)
- "date" (string - YYYY-MM-DD format)
- "isRecurring" (boolean - true only if it looks like a fixed monthly bill like rent, software subscriptions, insurance, etc. otherwise false)
Do not wrap in markdown blocks. Return ONLY a parseable JSON array of objects. Ignore completely empty rows.`,

    finance: `You are a financial assistant for a real estate agency. The input file may contain BOTH income rows AND expense rows mixed together.

CRITICAL RULES for determining rowType:
1. PRIMARY SIGNAL — The SIGN of the amount value is the most important indicator:
   - NEGATIVE number (e.g. -1000, -500.00) → rowType = "expense"
   - POSITIVE number (e.g. 1000, 500.00) → rowType = "income"
2. SECONDARY SIGNAL — Column name hints (use these when amount sign is unclear or zero):
   - Columns named "חובה", "debit", "Debit", "charge", "withdrawal", "הוצאה" → rowType = "expense"
   - Columns named "זכות", "credit", "Credit", "deposit", "הכנסה", "income" → rowType = "income"
3. TERTIARY SIGNAL — Description context (only if sign and column name are both unclear):
   - Rent, salary, subscription, marketing fee, insurance → likely "expense"
   - Commission received, deal closed, wire transfer in → likely "income"

Return a raw JSON array of objects with EXACTLY these keys:
- "rowType" (string - MUST be exactly "income" or "expense", determined by the rules above)
- "description" (string - take from the description/תיאור column)
- "amount" (number - ALWAYS POSITIVE, use Math.abs() on the original value)
- "category" (string - for expenses: one of ['שיווק', 'תפעול משרד', 'שכר', 'רכבים', 'שונות']; for income: one of ['עמלה', 'עסקה שנסגרה', 'הכנסה אחרת'])
- "date" (string - YYYY-MM-DD format, infer from any date column available)
- "isRecurring" (boolean - true only for fixed recurring charges like rent, insurance, subscriptions)

Do not wrap in markdown blocks. Return ONLY a parseable JSON array. Ignore completely empty rows.`,

    deals: `You are an expert data extraction assistant for a real estate CRM.
You will receive raw transaction data or image text. Intelligently map this data into a strictly formatted JSON array of objects.
Rules for deal objects:
- "propertyName" (string - address or name of the property)
- "leadName" (string - name of the buyer/client)
- "leadPhone" (string - phone of the buyer/client)
- "price" (number - total deal value)
- "projectedCommission" (number - expected commission amount)
- "stage" (string - 'משא ומתן', 'סגירה', 'נחתם', 'בוטל')
- "agentName" (string - name of the agent handling the deal)
- "notes" (string - extra details about the transaction)
Return ONLY a valid parseable JSON array of objects. Do not use markdown wrapping.`,

    agents: `You are an expert data extraction assistant for a real estate CRM.
You will receive team member lists or image text. Intelligently map this data into a strictly formatted JSON array of objects.
Rules for agent objects:
- "name" (string - full name)
- "email" (string - must be unique)
- "phone" (string)
- "role" (string - 'admin' or 'agent')
Return ONLY a valid parseable JSON array of objects. Do not use markdown wrapping.`,

    combined: `You are an expert data extraction assistant for a real estate CRM.
You will receive a mixed file that might contain both Lead (client/owner) information and Property information in the same row or alternating rows.
Intelligently map this data into a strictly formatted JSON array of objects.
For each logical record, extract:
- Property fields: "address", "city", "price", "rooms", "sqm", "floor", "type", "kind", "description", "agentName", "listingType", "isExclusive"
- Lead/Owner fields: "name", "phone", "email", "notes"
- Metadata: "entityType" (string - 'property', 'lead', or 'combined' if the record has both)
Return ONLY a valid parseable JSON array of objects. Do not use markdown wrapping (\`\`\`json) in the response.`,
};

// Aliases: 'property' → 'properties', 'deal' → 'deals', etc.
const ALIASES: Record<string, string> = {
    property: 'properties', lead: 'leads', deal: 'deals', agent: 'agents', mixed: 'combined',
};

export interface ExtractionResult {
    success: boolean;
    data: any;
}

export async function extractAiData(
    payload: string,
    entityType: EntityType,
    mode: 'single' | 'bulk' = 'single',
    apiKey = process.env.GEMINI_API_KEY,
): Promise<ExtractionResult> {
    if (!payload || !entityType) throw new Error('Missing payload or entityType.');
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set — see .env.example');

    const systemPrompt = PROMPTS[ALIASES[entityType] ?? entityType];
    if (!systemPrompt) {
        throw new Error(`Unsupported entityType '${entityType}'. Must be properties, leads, deals, agents, combined, mixed, finance, or expenses.`);
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Decide payload format — base64 image (Gemini Vision) or text, same code path
    let contents: any[];
    if (payload.startsWith('data:image')) {
        const base64Data = payload.replace(/^data:image\/\w+;base64,/, '');
        const mimeTypeMatch = payload.match(/^data:(image\/\w+);base64,/);
        const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/jpeg';
        contents = [{ text: systemPrompt }, { inlineData: { data: base64Data, mimeType } }];
    } else {
        contents = [{ text: systemPrompt }, { text: `Payload to extract:\n${payload}` }];
    }

    const result = await model.generateContent(contents);
    let responseText = result.response.text().trim();

    // Clean the JSON format if the AI returned it with markdown anyway
    if (responseText.startsWith('```json')) {
        responseText = responseText.replace(/^```json/, '').replace(/```$/, '').trim();
    } else if (responseText.startsWith('```')) {
        responseText = responseText.replace(/^```/, '').replace(/```$/, '').trim();
    }

    let parsedData: any;
    try {
        parsedData = JSON.parse(responseText);
    } catch {
        throw new Error(`AI did not return a valid JSON array. Response: ${responseText.substring(0, 100)}...`);
    }

    // 'single' mode: the property modal expects one object — take the first array element
    if (mode === 'single') {
        const resultObj = Array.isArray(parsedData) && parsedData.length > 0 ? parsedData[0] : parsedData;
        return { success: true, data: resultObj };
    }

    return { success: true, data: Array.isArray(parsedData) ? parsedData : [parsedData] };
}
