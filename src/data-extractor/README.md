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
