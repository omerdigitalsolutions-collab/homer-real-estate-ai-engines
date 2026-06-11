import { GoogleGenerativeAI } from '@google/generative-ai';

export interface FBImageAnalysis {
    isProperty: boolean;
    extractedText: string;
    phone: string | null;
}

export async function analyzeFBPostImage(
    imageUrl: string,
    geminiApiKey: string,
): Promise<FBImageAnalysis> {
    const res = await fetch(imageUrl);
    const buf = await res.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    const mimeType = res.headers.get('content-type') || 'image/jpeg';

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are a real estate assistant for Israel.
Extract all Hebrew text from this Facebook post image.
Then determine if this is a real estate listing (property for sale or rent in Israel).

Return ONLY valid JSON (no markdown):
- "isProperty": boolean — true only if the image is a real estate listing
- "extractedText": string — all text extracted from the image
- "phone": string or null — first Israeli mobile number found (digits only, no dashes)`;

    const result = await model.generateContent([
        { text: prompt },
        { inlineData: { data: base64, mimeType } },
    ]);

    let raw = result.response.text().trim()
        .replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw);

    return {
        isProperty: Boolean(parsed.isProperty),
        extractedText: String(parsed.extractedText || ''),
        phone: parsed.phone ? String(parsed.phone) : null,
    };
}
