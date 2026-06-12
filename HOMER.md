# hOMER — Real Estate Agency CRM & Operations OS

> The full product is closed-source. This document describes the production system from which the engines in this repo were extracted.

hOMER is a **multi-tenant SaaS CRM** built end-to-end for Israeli real estate agencies. It handles the full agency lifecycle: lead capture → AI classification → agent assignment → property matchmaking → deal tracking → WhatsApp communication → billing — all in one platform, with complete data isolation between tenants.

---

## What it does

| Domain | Capabilities |
|---|---|
| **Lead management** | Real-time Kanban pipeline, status tracking, AI-extracted requirements, WhatsApp conversation history, call recordings |
| **Property management** | Internal/cross-agency/public B2C visibility tiers, custom fields, map view, AI bulk import from text or photos |
| **Matchmaking** | Weighted 0–100 scoring engine that runs every time a property or lead is created — scores below 50 are silently dropped |
| **Agent distribution** | Concurrency-safe round-robin inside Firestore transactions, filtered by specialization and service area |
| **AI copilot** | Gemini function-calling agent (22 tools) embedded in the dashboard and accessible via WhatsApp — queries leads, creates deals, sends messages, manages calendar, enforces RBAC per tool |
| **WhatsApp automation** | Customer-facing bot with hybrid state machine + Gemini, auto-mute on agent intervention, human-handoff push notification, rolling session TTL |
| **Call recording pipeline** | CDR webhook → static-IP relay (Make.com) → Gemini transcription + lead extraction — handles the telephony provider's IP whitelist constraint |
| **Facebook lead scraper** | Daily Apify scan of configured Facebook groups → Gemini intent classification (SELLER/BUYER/UNKNOWN) → auto-created CRM entities, idempotent on `postId` |
| **Billing & subscriptions** | Stripe Checkout + Customer Portal + Webhooks → auto-provision agency on payment, enforce trial/expired states in Firestore rules |
| **Financial dashboard** | Draggable KPI widgets (react-grid-layout), P&L with probability-weighted pipeline value, expense breakdown, PDF export |
| **Google Calendar sync** | OAuth 2.0 server-side, token refresh, events linked to leads and properties |
| **Catalog mini-sites** | Public B2C property catalog per agency — anonymous read, expiry-gated, images hidden until published |
| **Contracts** | Template builder + anonymous public signing at `/sign/{agencyId}/{contractId}` |

---

## Architecture

```
React 18 SPA (TypeScript + Vite + Tailwind)
    │
    ├── Firebase Auth (JWT + Custom Claims: agencyId, role)
    ├── Firestore (real-time onSnapshot, 800+ lines of security rules)
    ├── Firebase Storage (recordings, images, PDFs)
    │
    └── Cloud Functions Gen 2 (Node.js 20, europe-west1)
            │
            ├── agencies.*     — CRUD for agency settings, users, invitations
            ├── leads.*        — matchmaking trigger, distribution, AI extraction
            ├── properties.*   — city sync, matchmaking, catalog management
            ├── ai.*           — copilot (22 tools), bulk importer, text-to-action
            ├── whatsapp.*     — Green API gateway, bot pipeline, history sync
            ├── deals.*        — pipeline stages, collaborative deals
            ├── contracts.*    — template rendering, signing
            ├── catalogs.*     — snapshot builder, expiry management
            │
            ├── webhookWhatsAppAI      — inbound customer messages
            ├── webhookHomerSalesBot   — Twilio IVR / sales bot
            ├── webhookMaskyoo        — CDR callback (masked telephony)
            ├── ingestMaskyooRecording — audio → Gemini → lead (IP-bypass endpoint)
            └── stripeWebhook          — billing lifecycle
```

### Multi-tenancy model

Every document lives under `/agencies/{agencyId}/`. The `agencyId` is injected into the Firebase JWT as a **server-side Custom Claim** on registration — the client can never forge it. Every Cloud Function begins with `validateUserAuth()` which extracts `{agencyId, uid, role}` from the token. Firestore Security Rules enforce the same boundary for direct client reads.

### External services

| Service | Role |
|---|---|
| **Gemini 2.5 Flash** | Copilot function-calling, intent classification, NER, call transcription, image analysis |
| **Green API** | Two-way WhatsApp messaging |
| **Apify** | Facebook group scraping, Yad2/Madlan property sync |
| **Maskyoo** | Masked-number telephony; recording API is IP-whitelisted |
| **Make.com** | Static-IP relay — downloads Maskyoo recordings on behalf of Cloud Functions |
| **Stripe** | SaaS billing: Checkout, Customer Portal, Webhooks |
| **Twilio** | Voice routing, IVR, Homer Sales Bot |
| **Google Calendar API** | OAuth 2.0 calendar sync |
| **Nominatim** | Free geocoding for property addresses |
| **Resend** | Transactional email |

All secrets live in **Firebase Secret Manager** — zero API keys in code or Git.

---

## Engineering highlights

**Race condition in resource allocation** — parallel incoming leads could double-assign the same agent. Fixed by running the full read → pick → write cycle inside a Firestore transaction. ([distribution engine](src/distribution/))

**Vendor IP whitelist vs. dynamic egress** — Maskyoo only serves recordings to whitelisted IPs; Cloud Functions can't be whitelisted. Solved with a Make.com relay (static IP), constant-time secret comparison, tenant trust derived from the CDR doc rather than the request body, storage path pinning against IDOR, and full idempotency for provider retries. ([call pipeline](src/call-pipeline/))

**80% cloud cost reduction** — daily city property sync was scanning all of Israel every night. Added a three-layer gate: Madlan removed from daily runs (kept for bootstrap only), activity-based filter skips cities with no active agents in 7 days, today-only temporal window cuts Apify Actor runtime by 90%.

**LLMs inside deterministic business logic** — heuristics classify first; Gemini is fallback for anomalies. Every model output is validated like untrusted input. Uncertainty surfaces as `requiresVerification` flags for human review rather than fabricated confidence.

**Permissions in the tool layer, not the prompt** — the copilot's executors receive `{uid, role}` and enforce RBAC themselves. A prompt-injected "show me everyone's commissions" returns an error object because the model was never the security boundary. ([ai-copilot](src/ai-copilot/))

**A bot that knows when to stop** — outbound message from an agent auto-mutes the bot. Customer asks for a human → polite handoff, bot off, push notification to the agent. Pre-LLM security pipeline: dual-scope rate limiting, Hebrew+English injection detection with cumulative auto-block, rolling session TTLs. ([whatsapp agent](src/whatsapp-agent/))

---

## Tech stack

**Frontend:** React 18 · TypeScript · Vite · Tailwind CSS · React Router v7 · react-grid-layout · @dnd-kit · React Leaflet · Recharts · html2canvas + jsPDF

**Backend:** Firebase Cloud Functions Gen 2 · Node.js 20 · TypeScript · Firestore · Firebase Auth · Firebase Storage · Firebase Secret Manager

**AI:** Gemini 2.5 Flash — function calling, structured output (JSON Schema), multimodal (text + image + audio)

**Infrastructure:** Firebase Hosting (CDN, Brotli) · Firebase CLI CI/CD · Firestore Security Rules (800+ lines) · 22 composite indexes

**Integrations:** Stripe · Green API · Twilio · Maskyoo · Make.com · Apify · Google Calendar API · Nominatim · Resend

---

*The engines extracted into this repo — matchmaking, distribution, AI copilot, WhatsApp agent, lead classifier, data extractor, call pipeline — are the algorithmic core of the system. Each module includes a README, runnable demo where possible, and notes on the engineering decisions.*
