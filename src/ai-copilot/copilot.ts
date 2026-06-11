/**
 * ─── AI Copilot — Gemini function-calling loop ────────────────────────────────
 *
 * Standalone version of the production dashboard copilot (a Firebase callable
 * in the original system; auth/tenancy extraction stripped, the agent loop
 * preserved as-is). The same loop also powers the internal WhatsApp agent bot.
 *
 * Flow: user message → Gemini (with 22 tool declarations) → tool call →
 * executor → tool result fed back → repeat (max 5 iterations) → final text.
 */

import { GoogleGenerativeAI, Content } from '@google/generative-ai';
import { chatBotTools } from './tools';
import { dispatchTool, ToolContext } from './executors';

const MAX_TOOL_ITERATIONS = 5;

const SYSTEM_PROMPT =
    'אתה hOMER, עוזר AI חכם ורב-עוצמה למנהל/סוכן סוכנות הנדל"ן. ' +
    'יש לך גישה לכל פעולות ה-CRM: שאילתות, יצירה, עדכון, מחיקה (soft), יצירת קטלוגים, שליחת WhatsApp וקביעת פגישות. ' +
    'אתה יכול לבצע רצפי פעולות מורכבים — למשל: מחפש ליד → מוצא נכסים מתאימים → יוצר קטלוג → שולח בווצאפ. ' +
    'כשהמשתמש מבקש flow שלם, השתמש בכלים ברצף (עד 5 איטרציות) ודווח על כל שלב. ' +
    'לפני פעולות בלתי הפיכות (מחיקת נכס, שליחת הודעה), ודא שהמשתמש אישר. ' +
    'אם חסרים פרטים הכרחיים, שאל מפורשות. ' +
    'תמיד ענה בעברית תקנית וטבעית (אלא אם נשאלת בשפה אחרת). ' +
    'כשקטלוג נוצר, הצג תמיד את הקישור catalogUrl בתשובה.';

export interface CopilotTurn {
    response: string;
    toolCalls: Array<{ name: string; args: any; result: any }>;
}

export async function runCopilot(
    userMessage: string,
    ctx: ToolContext,
    history: Array<{ role: 'user' | 'ai'; text: string }> = [],
    apiKey = process.env.GEMINI_API_KEY,
): Promise<CopilotTurn> {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set — see .env.example');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', tools: chatBotTools });

    const geminiHistory: Content[] = history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }],
    }));

    const chat = model.startChat({
        systemInstruction: { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
        history: geminiHistory,
    });

    const toolCalls: CopilotTurn['toolCalls'] = [];

    let response  = await chat.sendMessage(userMessage);
    let candidate = response.response;

    let iterations = MAX_TOOL_ITERATIONS;
    while (candidate.functionCalls()?.length && iterations-- > 0) {
        const { name, args } = candidate.functionCalls()![0];

        let toolResult: any;
        try {
            toolResult = await dispatchTool(name, args, ctx);
        } catch (toolError: any) {
            // Never crash the turn on a tool failure — report it back to the model
            toolResult = { error: 'Internal execution error.' };
        }
        toolCalls.push({ name, args, result: toolResult });

        response  = await chat.sendMessage([{ functionResponse: { name, response: toolResult } }]);
        candidate = response.response;
    }

    return { response: candidate.text(), toolCalls };
}
