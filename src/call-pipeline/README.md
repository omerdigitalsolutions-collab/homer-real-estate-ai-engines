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
