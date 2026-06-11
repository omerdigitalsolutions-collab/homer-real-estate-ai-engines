/**
 * Runnable demo of the AI copilot (requires GEMINI_API_KEY in the env):
 *
 *   GEMINI_API_KEY=... npx ts-node examples/copilot-demo.ts
 *
 * Asks the copilot to run a multi-step flow against the seeded mock CRM:
 * find a lead → match properties → create a catalog. Watch the tool-call
 * trace to see the function-calling loop in action.
 */
import { runCopilot } from '../src/ai-copilot/copilot';
import { createSeededStore } from '../src/ai-copilot/mockStore';

async function main() {
    const store = createSeededStore();
    const ctx = { store, uid: 'u_admin', role: 'admin' as const };

    const question = 'תמצא נכסים מתאימים לליד אבי כהן ותכין לו קטלוג';
    console.log(`👤 ${question}\n`);

    const turn = await runCopilot(question, ctx);

    for (const call of turn.toolCalls) {
        console.log(`🔧 ${call.name}(${JSON.stringify(call.args)})`);
        console.log(`   → ${JSON.stringify(call.result).slice(0, 200)}\n`);
    }
    console.log(`🤖 ${turn.response}`);
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
