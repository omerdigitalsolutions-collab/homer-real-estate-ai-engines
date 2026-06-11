import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import { timingSafeEqual } from 'crypto';
import { extractLeadDataFromAudio, CallLeadPayload } from './audioExtraction';
import {
    recordingStoragePath,
    saveRecordingToStorage,
    loadRecordingFromStorage,
    upsertLead,
} from './recordingPipeline';

const geminiApiKey  = defineSecret('GEMINI_API_KEY');
const ingestSecret  = defineSecret('INGEST_SHARED_SECRET');

/** Constant-time string compare that never throws on length mismatch. */
function secretsMatch(provided: string, expected: string): boolean {
    if (!expected) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // timingSafeEqual requires equal-length buffers; bail early (still constant-time
    // for the common equal-length case, which is the only one that can succeed).
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/**
 * ingestRecording — receives a finished call recording from the static-IP relay.
 *
 * Why this exists: the telephony provider whitelists its recording API by source
 * IP, and Cloud Functions have a dynamic egress IP. The relay (Make.com — static
 * IP, whitelisted at the provider) does the IP-blocked fetch and hands the audio
 * here, where we keep all the Firebase work (Storage + Gemini + lead upsert +
 * finalising the call doc).
 *
 * The CDR webhook already wrote calls/{callId} with status 'processing' and
 * resolved routing (agencyId/agentId), so this function trusts the call doc —
 * not the relay-forwarded body.
 *
 * Expected JSON body (from the relay):
 *   { callId, callUid, agencyId, agentId, callerPhone, source, contentType,
 *     // EXACTLY ONE transport:
 *     storagePath?,   // relay uploaded the file to Storage (no 10MB limit) — preferred
 *     audioBase64?,   // inline bytes (short calls only)
 *   }
 * Header: x-ingest-secret: <INGEST_SHARED_SECRET>
 */
export const ingestRecording = onRequest(
    {
        secrets: [geminiApiKey, ingestSecret],
        timeoutSeconds: 300,
        memory: '1GiB',
    },
    async (req, res) => {
        if (req.method !== 'POST') {
            res.status(405).send('Method Not Allowed');
            return;
        }

        // ── Auth: shared secret is the primary gate ──────────────────────────────
        const provided = String(req.get('x-ingest-secret') ?? '');
        const expected = ingestSecret.value();
        if (!secretsMatch(provided, expected)) {
            console.warn('[ingestRecording] rejected: bad/missing x-ingest-secret');
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }

        const b: Record<string, any> = (req.body as Record<string, any>) ?? {};
        const callId      = String(b.callId ?? '').trim();
        const callUid     = String(b.callUid ?? '').trim();
        const bodyAgencyId = String(b.agencyId ?? '').trim();
        const callerPhone = String(b.callerPhone ?? '').trim();
        const source      = String(b.source ?? 'telephony').trim();
        const contentType = String(b.contentType ?? 'audio/wav').trim() || 'audio/wav';
        const storagePath = b.storagePath ? String(b.storagePath).trim() : '';
        const audioBase64 = b.audioBase64 ? String(b.audioBase64) : '';

        if (!callId) {
            res.status(400).json({ error: 'Missing callId' });
            return;
        }
        if (!storagePath && !audioBase64) {
            res.status(400).json({ error: 'Provide either storagePath or audioBase64' });
            return;
        }

        const db = admin.firestore();
        const callRef = db.collection('calls').doc(callId);
        const existing = await callRef.get();

        // ── Tenant trust: the call doc (written by the CDR webhook from trusted ───
        // routing) is the source of truth — NOT the relay-forwarded body.
        // A missing doc means this callId was never routed by our webhook → forged.
        if (!existing.exists) {
            console.warn(`[ingestRecording] rejected: no calls/${callId} doc (not routed by CDR webhook)`);
            res.status(409).json({ error: 'Unknown callId' });
            return;
        }
        const callData = existing.data()!;
        const agencyId = String(callData.agency_id ?? '').trim();
        const agentId  = String(callData.agent_id ?? '').trim();
        if (!agencyId) {
            console.warn(`[ingestRecording] rejected: calls/${callId} has no agency_id`);
            res.status(409).json({ error: 'Call has no agency' });
            return;
        }
        // Defence-in-depth: if the relay forwarded an agencyId, it must match the doc.
        if (bodyAgencyId && bodyAgencyId !== agencyId) {
            console.error(`[ingestRecording] rejected: body agencyId=${bodyAgencyId} != doc agency_id=${agencyId} for callId=${callId}`);
            res.status(403).json({ error: 'Agency mismatch' });
            return;
        }

        // ── Idempotency: only a COMPLETED call blocks re-processing. ──────────────
        // 'processing' / 'failed' must stay re-processable so a relay retry (e.g.
        // after a timeout) can finish the job rather than being silently dropped.
        if (callData.status === 'completed') {
            console.log(`[ingestRecording] callId=${callId} already completed — skipping`);
            res.status(200).json({ ok: true, duplicate: true });
            return;
        }

        // ── Path safety: the storagePath transport must point ONLY at this call's ──
        // canonical recording. Otherwise loadRecordingFromStorage would stamp a public
        // download token on an arbitrary object (e.g. another agency's file) — IDOR.
        const canonicalPath = recordingStoragePath(agencyId, callId);
        if (storagePath && storagePath !== canonicalPath) {
            console.error(`[ingestRecording] rejected: storagePath='${storagePath}' != canonical='${canonicalPath}'`);
            res.status(400).json({ error: 'Invalid storagePath' });
            return;
        }

        try {
            // ── 1. Get the audio buffer + a playable recording URL ────────────────
            let buffer: Buffer;
            let recordingUrl: string;

            if (storagePath) {
                // Relay uploaded straight to Storage (preferred — no 10MB request limit).
                ({ buffer, recordingUrl } = await loadRecordingFromStorage(storagePath));
            } else {
                buffer = Buffer.from(audioBase64, 'base64');
                ({ recordingUrl } = await saveRecordingToStorage({
                    agencyId,
                    callId,
                    buffer,
                    contentType,
                }));
            }

            await callRef.set({ recording_url: recordingUrl, status: 'processing' }, { merge: true });

            // ── 2. Gemini: single-pass transcription + lead extraction ────────────
            let aiResult: Partial<CallLeadPayload> = {};
            try {
                aiResult = await extractLeadDataFromAudio(
                    buffer.toString('base64'),
                    contentType,
                    geminiApiKey.value(),
                );
            } catch (aiErr) {
                // Don't lose the recording/lead just because AI failed — log and continue.
                console.error(`[ingestRecording] Gemini failed for callId=${callId}:`, aiErr);
            }

            // ── 3. Upsert the lead (one doc per caller phone per agency) ──────────
            let leadId: string | null = null;
            let leadCreated = false;
            if (callerPhone) {
                ({ leadId, leadCreated } = await upsertLead({
                    db,
                    callerPhone,
                    agencyId,
                    agentId,
                    source,
                    fullName: aiResult.clientName ?? null,
                    callId,
                    extractedData: aiResult,
                }));
            } else {
                console.warn(`[ingestRecording] callId=${callId} has no callerPhone — recording stored, lead skipped`);
            }

            // ── 4. Finalise the call log ──────────────────────────────────────────
            await callRef.update({
                recording_url: recordingUrl,
                lead_id:       leadId,
                leadCreated,
                clientName:    aiResult.clientName ?? null,
                transcript:    aiResult.transcription ?? null,
                summary:       aiResult.summary ?? null,
                status:        'completed',
            });

            console.log(`[ingestRecording] callId=${callId} uid=${callUid} → leadId=${leadId} done`);
            res.status(200).json({ ok: true, leadId, leadCreated });
        } catch (err) {
            console.error(`[ingestRecording] pipeline error callId=${callId}:`, err);
            // Leave the call re-processable: 'failed' is NOT blocked by the idempotency guard.
            await callRef.set({ status: 'failed' }, { merge: true }).catch(() => {});
            res.status(500).json({ error: 'ingest failed' });
        }
    },
);
