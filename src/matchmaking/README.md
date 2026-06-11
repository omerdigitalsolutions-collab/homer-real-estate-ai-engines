# Weighted Matchmaking Engine

Scores a property against a lead's requirements and returns a 0–100 match score, or rejects the pair outright. Pure TypeScript — no database, no external services. In production this runs inside Firestore `onCreate` triggers in both directions: new property → scan leads, new lead → scan properties.

## Run the demo

```bash
npx ts-node examples/matchmaking-demo.ts
```

## How scoring works

### 1. Strict gates (instant rejection)

- **Deal category** — `sale` / `rent` / `commercial` must match. Commercial is derived from the building kind (office, shop, clinic…) and keeps its own rent/sale axis, so a commercial-rent listing never leaks into a residential-rent search.
- **City** — the property city must match one of the lead's desired cities. Matching is normalization-based (strips hyphens, quotes, whitespace; Hebrew-aware) with bidirectional substring containment, so `תל-אביב` ≈ `תל אביב`.

### 2. Budget — linear degradation with a 7% margin

A property slightly over budget is often still negotiable, so instead of a hard cutoff:

```
price ≤ budget                → score 1.0
budget < price ≤ 1.07·budget  → score = 1 − (price − budget) / (0.07·budget)
price > 1.07·budget           → reject
```

### 3. Rooms — ±0.5 tolerance

Exact range → `1.0`. Within half a room of the range (a 3.5-room flat for a "4 rooms" lead) → `0.5`. Beyond tolerance → reject. Unknown room count → `0.5` + a `rooms` verification flag.

### 4. Location sub-scoring

When the lead names neighborhoods/streets:

```
S_location = 0.6 · S_neighborhood + 0.4 · S_street   (when streets are specified)
```

Match → `1.0`, mismatch → `0.5`, data missing on the property → `0.6` + verification flag. A neighborhood-only search (no city) hard-requires the neighborhood match, so "רמת אביב" in the wrong city can't slip through.

### 5. Amenities

Four must-have flags: elevator, parking, balcony, safe room (ממ"ד). Explicitly missing (`false`) → reject. Present → `1.0`. Unknown → `0.5` + verification flag.

### Final score

Each criterion group has a configurable weight (default 5):

```
Score = min(100, round( Σ(Sᵢ·wᵢ) / Σwᵢ · 100 ))
```

- `≥ 80` → **high** match
- `50–79` → **medium** match
- `< 50` → discarded — never shown to agents, to keep the matches list high-signal

## The `requiresVerification` design

The engine never silently passes unknown data. Anything it couldn't confirm (missing neighborhood, unknown room count, unlisted amenity) is collected into `requiresVerification: string[]` and surfaced in the UI as "verify with the seller" chips. This is what makes an LLM-fed pipeline safe: AI-extracted properties with partial data still match, but with an explicit human-in-the-loop marker instead of a fabricated certainty.
