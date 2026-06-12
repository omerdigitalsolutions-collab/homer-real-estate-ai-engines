# AI Bulk Import — Multi-Entity Extraction Framework

One function (`extractAiData`) converts messy real-world input into typed CRM records, powering the "import anything" feature: agents paste a CSV export from a legacy CRM, drop in scraped text, or photograph a handwritten listing sheet — and get structured rows back.

## Supported entity types

| Type | Extracted fields (highlights) |
|---|---|
| `properties` | price (handles "2.5M" typos), address, rooms, sqm, floor + totalFloors ("קומה 3 מתוך 8"), exclusivity + end date, broker license number, amenities (elevator/parking/ממ"ד/balcony/storage) |
| `leads` | name, phone, email, budget, desired city, assigned agent |
| `expenses` | amount, mapped to 5 fixed Hebrew categories, recurring-bill detection |
| `finance` | mixed income+expense files — `rowType` decided by a 3-tier signal cascade: amount sign → column-name hints (חובה/זכות, debit/credit) → description context |
| `deals` | property, buyer, price, commission, pipeline stage |
| `agents` | team-member lists |
| `combined` | rows holding both a property and its owner/lead, tagged per record |

## Design notes

- **Text and images share one code path** — a base64 `data:image/...` payload is sent as inline Gemini Vision data; anything else is sent as text. The system prompt is identical.
- **Strict JSON contract per entity type** — each prompt enumerates exact keys, formats (`YYYY-MM-DD`), and closed category lists, and forbids markdown wrapping. A markdown-cleanup pass still runs because models occasionally wrap anyway; a parse failure produces a clear error with the first 100 chars of the offending output.
- **`single` vs `bulk` mode** — the add-property modal wants one object; the bulk importer wants an array. Same extraction, different unwrapping.
- **The finance cascade** is the interesting prompt-engineering bit: bank exports disagree about how to express direction (sign, debit/credit columns, or nothing), so the prompt encodes an explicit priority order instead of letting the model guess.

In production this is a Firebase callable gated by a per-plan feature flag, with the Gemini key injected from Secret Manager. A companion function (`analyzeNoteToFields`, not included here) runs the same pattern over free-text lead notes and *suggests* custom-field values for human confirmation — never writing directly.

## Usage

```ts
import { extractAiData } from '../src/data-extractor/extractAiData';

const { data } = await extractAiData(csvText, 'properties', 'bulk');
```

## Performance & data structures

**Prompt lookup — O(1).** `PROMPTS` and `ALIASES` are plain `Record<string, string>` objects; resolving the correct prompt for an entity type is a single property access after one optional alias redirect.

**Dominant cost — one Gemini API call.** Every other operation in the function (input type detection, JSON fence stripping, parse, unwrap) is O(n) in the input length but negligibly fast compared to the model round-trip. The function makes exactly one API call regardless of `single` vs `bulk` mode — both modes send the full input in one request and differ only in the unwrapping step at the end.

**Single vs. bulk unwrapping.** The model always returns a JSON array (the prompt contracts specify this). `single` mode returns `data[0]`; `bulk` mode returns the full array. Both paths are O(1) — no second parse, no transformation loop. The distinction is purely in how the caller consumes the output.

**Image vs. text dispatch.** The `data:image/...` prefix check is a single `String.startsWith()` call, O(1). The two code paths diverge only at the Gemini `Part` construction (`inlineData` vs `text`); the model invocation and response handling are identical.

**JSON fence cleanup — O(n) single pass.** The cleanup regex strips ` ```json `, ` ``` `, and trailing fences in one chained replace. Intentional — models occasionally wrap output despite being told not to, and a one-shot cleanup is cheaper than wrapping every call in a retry loop.

**Error locality.** A parse failure throws immediately with the first 100 characters of the offending output, avoiding silent data corruption. The 100-char cap is deliberate: enough context to debug the issue, not enough to accidentally log sensitive user data from a malformed response.

**Stateless, no caches.** The function creates no closures over mutable state and holds no per-invocation caches. It is safe to call concurrently with different entity types from multiple Cloud Function instances without coordination.
