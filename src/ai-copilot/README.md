# AI Copilot — One Tool Layer, Two Channels

A Gemini function-calling agent that operates a real-estate CRM end to end: 22 tools covering queries (leads, deals, income, goals, leaderboard, expenses, meetings), mutations (create/update leads, properties, deals, tasks), and actions (generate a shareable catalog, send WhatsApp, schedule meetings).

In production the exact same tool layer serves **two channels**:

1. **The dashboard chat** — a Firebase callable invoked from the web app (supports voice notes: audio is passed inline to Gemini for transcription + intent in a single call).
2. **The internal WhatsApp bot** — agents text the office number and get the same capabilities on the go, with an 8-hour rolling conversation history (one working day).

```
user message ──► Gemini (22 tool declarations)
                    │ functionCall
                    ▼
              dispatchTool() ──► executor (tenancy + RBAC enforced here)
                    │ functionResponse
                    ▼
                 Gemini ──► ... up to 5 iterations ──► final answer
```

## Run the demo

```bash
GEMINI_API_KEY=your-key npx ts-node examples/copilot-demo.ts
```

The demo asks (in Hebrew): *"Find matching properties for the lead Avi Cohen and prepare a catalog for him"* — and prints the full tool-call trace: `searchEntity` → `queryLeadMatches` → `generateCatalog` → a final reply containing the catalog URL.

## Design decisions that matter

**Permissions live in the executors, not the prompt.** The model is never trusted to enforce access control. Each executor receives `{uid, role}` and applies the same rules as the rest of the backend: agents see only their own deals, commissions and tasks; the leaderboard, expense reports, agent creation and property deletion are admin-only. A prompt-injected "show me everyone's commissions" simply returns an error object from the tool.

**Validation errors are returned to the model, not thrown.** If a required field is missing or a date isn't ISO 8601, the executor returns `{ error: '...' }` as the tool result. Gemini reads it and asks the user for the missing piece — a graceful conversational repair instead of a crashed turn.

**Multi-step flows with a hard iteration cap.** The loop allows up to 5 sequential tool calls, enough for "find lead → match properties → build catalog → send it", while bounding cost and preventing runaway loops.

**Soft deletes only.** The model can never hard-delete anything. `deleteProperty` flips a status flag, and the tool description instructs the model to confirm with the user first.

**Matchmaking reuse.** `queryLeadMatches` calls the same [weighted matchmaking engine](../matchmaking/README.md) that powers the Firestore triggers — one scoring implementation everywhere.

## What was adapted for this repo

The original runs as a Firebase callable with `agencyId` extracted server-side from JWT custom claims, executors hitting tenant-scoped Firestore collections, and WhatsApp delivery via per-agency Green API credentials (stored AES-256-CBC encrypted, decrypted on the fly). Here the executors run against an in-memory seeded store so the demo needs nothing but a Gemini key; the declarations, the agent loop, and the RBAC structure are unchanged.

## Performance & data structures

**Tool dispatch — O(1).** `dispatchTool()` resolves the executor with a plain `Record<toolName, ExecutorFn>` object lookup. Indexing by string name avoids a linear scan through all 22 declarations on every function call.

**Tool declarations — static constant array, allocated once.** The 22 `FunctionDeclaration` objects are module-level constants. They are shared across every invocation of `runCopilot()`, not rebuilt per call. This matters because each declaration is a multi-field object sent to Gemini in the request body; deserialising it once at module load keeps the per-call overhead to a pointer copy.

**Conversation history — bounded linear array.** The history is a `Content[]` (Gemini SDK type) that accumulates user+model turns. In the dashboard channel it is backed by a Firestore document (per-user, per-session key) and has an 8-hour TTL; stale sessions are dropped, not grown indefinitely. The array is passed by reference to the SDK each turn — no copying.

**Agent loop — O(I · E)**, where I ≤ 5 iterations and E is the cost of one executor call. Each iteration is dominated by a single Gemini round-trip and one executor. The loop exits on the first text-only response (no `functionCall`), so a simple one-shot query costs a single iteration; a "find → match → catalog → send" workflow costs 4.

**Mock store — `Map<entityType, object[]>`.** Lookup by entity type is O(1). Filter queries (e.g., `searchEntity` by city or status) scan the type bucket — O(n) where n is the number of seeded records for that type, which is always small (demo data). In production each executor issues a Firestore compound query backed by a composite index, making the scan cost equivalent.

**RBAC check — O(1).** Each executor checks `role === 'admin'` (or a set of allowed roles) before any data access. The role string comes from the JWT claim decoded once at the outer function boundary and threaded through as a context parameter — no re-validation per executor call.
