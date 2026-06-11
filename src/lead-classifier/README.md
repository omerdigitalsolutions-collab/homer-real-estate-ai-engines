# Facebook Lead Classifier — Heuristics First, LLM as Fallback

Turns raw Hebrew Facebook-group posts into structured CRM entities. Part of a daily pipeline: Apify scrapes configured groups → each post is classified `SELLER` / `BUYER` / `UNKNOWN` → entities are extracted → a property + linked lead (sellers) or a lead with structured requirements (buyers) is created, idempotent on the Facebook `postId`.

## Run the demo (no API key needed)

```bash
npx ts-node examples/classifier-demo.ts
```

## Why heuristics first?

Thousands of posts are scanned daily. Running every one through an LLM is slow, costly, and unnecessary — most fields are extractable with deterministic Hebrew-aware rules (`fbClassifier.ts`, zero dependencies):

- **Intent classification** with ordered precedence: explicit "seller seeking buyer" phrases (מחפש קונה/שוכר/דייר) win first; then, when a genuine buyer phrase and a listing marker both appear, *the one stated first wins* — so "מחפש דירה למכירה" is a BUYER but "דירה למכירה, מתאים למחפשי שקט" stays a SELLER despite the incidental search verb.
- **Field extractors** for phone (all Israeli formats), price ("2.5 מיליון" / "800 אלף" / "2,500,000 ₪"), rooms (numeric and word forms — "שלושה חד'"), floor ("קומה 4 מתוך 8", ordinal words), square meters, neighborhood, street + number, city (longest-name-first against a city list), elevator/parking detection with negation handling ("ללא חניה").
- **Listing type** — private owner vs. broker, with "ללא תיווך" correctly beating its own substring "תיווך".

## When the LLM steps in

Two escalation paths (`fbTextAnalyzer.ts`, `fbImageAnalyzer.ts`):

1. **Suspicious heuristics** — `needsTextAnalysis()` flags anomalies the rules can't be trusted on: a "sale" with a price under ₪200K (probably rent), or rooms = 1 (a known false positive of the Hebrew word-digit matcher). Only those posts are re-analyzed by Gemini with a strict JSON contract, and every returned field is type-checked before use.
2. **Image-only posts** — listings published as a picture with no text go to Gemini Vision: extract the Hebrew text, decide if it's a real-estate listing at all, and pull the phone number.

This is the "deterministic business logic with an LLM inside" pattern: rules give speed and predictability, the model handles only the residual ambiguity, and its output is validated like any untrusted input.

## Idempotency

The Facebook `postId` is the Firestore document ID. Re-running the scanner (or Apify returning the same post twice) updates the existing record instead of duplicating leads.
