# Call Recording Pipeline — IP-Bypass Architecture

Turns every answered phone call into a transcribed, summarized, structured CRM lead — despite the telephony provider blocking direct API access.

## The constraint

The masked-number telephony provider (Maskyoo) whitelists its recording API **by source IP**. Cloud Functions run on a dynamic egress pool — they can't be whitelisted. Setting up a VPC connector + static NAT just for one fetch would add cost and infrastructure for a single vendor quirk.

## The solution: a static-IP relay

```
Provider CDR callback (call ended)
        ▼
CDR webhook (Cloud Function)
  · resolves routing: numbers/{ddi} doc → users/ query by virtual number
    → query-param fallback; auto-creates the routing doc on first resolution
  · normalises DDI/CLI into 4 phone formats (±leading 0, ±972 prefix)
  · writes calls/{callId} status='processing' (missed call → WhatsApp auto-reply)
  · answered call → POSTs {callId, agencyId, agentId, callerPhone} to Make.com
        ▼
Make.com scenario (static IP — whitelisted at the provider)
  · downloads the recording from the provider API
  · uploads it to Firebase Storage (or inlines base64 for short calls)
  · POSTs to ingestRecording with header x-ingest-secret
        ▼
ingestRecording (Cloud Function — this module)
  · validates the shared secret in constant time (crypto.timingSafeEqual)
  · stores at agencies/{agencyId}/recordings/{callId}.wav
  · Gemini single pass: transcription + summary + structured lead extraction
  · upserts the lead keyed on (agencyId, phone) and completes the call doc
```

## Security model of the ingest endpoint

- **Constant-time secret comparison** — `timingSafeEqual` prevents timing attacks on the shared secret; a length mismatch bails early (only equal lengths can ever succeed, so this stays constant-time where it matters).
- **Tenant trust from the call doc, not the request** — `agencyId` is read from `calls/{callId}` written earlier by the CDR webhook. A `callId` that was never routed is rejected as forged; a relay-forwarded `agencyId` that contradicts the doc is rejected as a mismatch (defence in depth).
- **Storage path pinning** — the `storagePath` transport must equal the canonical `agencies/{agencyId}/recordings/{callId}.wav`. Without this check the endpoint could be tricked into stamping a public download token onto an arbitrary object — e.g. another agency's recording (an IDOR).

## Resilience

- **Idempotency** — the provider retries the CDR callback up to 5×, which can spawn duplicate relay runs. A `completed` call doc short-circuits re-processing; `processing`/`failed` remain re-processable so a retry *finishes* an interrupted job instead of being dropped. Inside `upsertLead`, a repeated `callId` doesn't double-increment `callCount` or re-append the same call summary.
- **AI failure ≠ data loss** — if Gemini errors, the recording URL and the lead are still persisted; only the transcript/summary fields stay empty.
- **Two audio transports** — Storage path (preferred, no size limit) or inline base64 (short calls), converging into the same pipeline.

## Files

- [ingestRecording.ts](ingestRecording.ts) — the authenticated ingest endpoint (stage 3)
- [recordingPipeline.ts](recordingPipeline.ts) — Storage layout, token URLs, idempotent lead upsert
- [audioExtraction.ts](audioExtraction.ts) — Gemini stereo-call analysis with full output validation

The CDR webhook (stage 1) is summarized above; its routing/normalisation logic is provider-specific and omitted from this repo.

## Performance & data structures

**Dominant cost — one Gemini multimodal call.** All other operations (secret comparison, Firestore reads, Storage upload/download) are O(1) or O(n) in file size. The transcription+extraction single-pass design is a deliberate choice: two passes (transcribe first, extract second) would double the model round-trip time and double token cost for no accuracy gain.

**`secretsMatch` — O(L) constant-time by design.** `crypto.timingSafeEqual` requires equal-length buffers and compares them byte-by-byte without short-circuiting, making the comparison time independent of how many bytes match. The length pre-check (`a.length !== b.length → false`) is safe because only equal-length inputs can ever succeed — different lengths can never produce a timing oracle.

**Lead upsert — O(1) Firestore ops.** `upsertLead` issues a single compound query (`agencyId == x AND phone == y`, indexed) to check for an existing lead, then either one `update()` or one `add()`. No scans, no batch reads. The phone is normalised to a canonical local format (`0XXXXXXXXX`) before the query, so the index always sees the same key regardless of how the caller formatted the number.

**Idempotency guard — `lastCallId` field comparison, O(1).** The repeat-call check compares two string fields on the existing lead document. No secondary collection, no bloom filter. This is sufficient because the CDR retry window is short (5 retries over ~30 seconds) and the field is always written atomically alongside the `callCount` increment — no race between the check and the write.

**Storage token reuse — avoids re-signing.** `loadRecordingFromStorage` reads the existing `firebaseStorageDownloadTokens` metadata field before minting a new UUID. If a token already exists (e.g., the relay uploaded the file and set one), it is reused. This keeps download URL stable across retries, which matters for the `recording_url` field on the call document (the CallCenter UI links directly to it).

**Output validation — typed coercion, not try/catch per field.** `audioExtraction.ts` uses three helper functions (`toStr`, `toNum`, `toBool`) that each handle the full space of model output types (string, number, boolean, null, undefined, unexpected type) in O(1). A single type-check per field, no exceptions, no defensive `JSON.parse` inside the field parsers. All enum fields (`property_type`, `transaction_type`, `urgency`, `condition`) are validated against a closed `Set` with a safe default, preventing invalid values from entering Firestore.

**Memory ceiling — 1 GiB function allocation.** The audio buffer must fit in memory for the base64 inline transport. A 10-minute WAV at 16-bit 44.1 kHz stereo is ~100 MB; the 1 GiB allocation gives comfortable headroom while the storage-path transport (no buffer in memory) is used for larger files. The two transports converge on the same pipeline after the buffer/URL resolution step.
