import * as admin from 'firebase-admin';
import { randomUUID } from 'crypto';
import { CallLeadPayload } from './audioExtraction';

/**
 * Shared recording-pipeline helpers.
 *
 * Used by both the telephony CDR webhook and the ingest function (which
 * receives the audio back from the static-IP relay), so both use the exact
 * same Storage layout, download-URL scheme and lead-upsert logic.
 *
 * Storage convention (kept stable for the CallCenter UI):
 *   agencies/{agencyId}/recordings/{callId}.wav
 */

/** Builds the canonical Storage path for a call recording. */
export function recordingStoragePath(agencyId: string, callId: string): string {
    return `agencies/${agencyId}/recordings/${callId}.wav`;
}

/** Builds a Firebase token download URL for an object that has a download token. */
function downloadUrl(bucketName: string, storagePath: string, token: string): string {
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
}

/**
 * Saves a recording buffer to Firebase Storage and returns a public token URL.
 * Used for the inline (audioBase64) transport, where the function holds the bytes.
 */
export async function saveRecordingToStorage(params: {
    agencyId: string;
    callId: string;
    buffer: Buffer;
    contentType?: string;
}): Promise<{ storagePath: string; recordingUrl: string }> {
    const { agencyId, callId, buffer, contentType = 'audio/wav' } = params;
    const storagePath = recordingStoragePath(agencyId, callId);
    const bucket = admin.storage().bucket();
    const token = randomUUID();

    await bucket.file(storagePath).save(buffer, {
        metadata: {
            contentType,
            metadata: { firebaseStorageDownloadTokens: token },
        },
    });

    return { storagePath, recordingUrl: downloadUrl(bucket.name, storagePath, token) };
}

/**
 * Returns a playable token URL for an object the relay already uploaded to
 * Storage (the storagePath transport). Reuses the existing download token if
 * present, otherwise stamps a fresh one, and also downloads the bytes so the
 * caller can run AI extraction on them.
 */
export async function loadRecordingFromStorage(
    storagePath: string,
): Promise<{ buffer: Buffer; recordingUrl: string }> {
    const bucket = admin.storage().bucket();
    const file = bucket.file(storagePath);

    const [metadata] = await file.getMetadata();
    const existingTokens = (metadata.metadata?.firebaseStorageDownloadTokens as string | undefined) ?? '';
    let token = existingTokens.split(',')[0] || '';

    if (!token) {
        token = randomUUID();
        await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    }

    const [buffer] = await file.download();
    return { buffer, recordingUrl: downloadUrl(bucket.name, storagePath, token) };
}

/**
 * Upserts a lead keyed on (agencyId + caller phone).
 * Combining agency + phone prevents collisions when the same caller contacts
 * multiple agencies, while still deduplicating repeat calls to the same agency.
 */
export async function upsertLead(params: {
    db:          admin.firestore.Firestore;
    callerPhone: string;
    agencyId:    string;
    agentId:     string;
    source:      string;
    fullName:    string | null;
    callId:      string;
    extractedData?: Partial<CallLeadPayload>;
}): Promise<{ leadId: string; leadCreated: boolean }> {
    const { db, callerPhone, agencyId, agentId, source, fullName, callId, extractedData } = params;

    // Normalise to local Israeli format (0XXXXXXXXX) so the doc ID and phone
    // field match the format used by the WhatsApp bot and the Leads page.
    const digits = callerPhone.replace(/\D/g, '');
    const localPhone = digits.startsWith('972') ? '0' + digits.substring(3) : digits;

    const existingSnap = await db
        .collection('leads')
        .where('agencyId', '==', agencyId)
        .where('phone', '==', localPhone)
        .limit(1)
        .get();

    if (!existingSnap.empty) {
        const leadDoc = existingSnap.docs[0];
        const existingData = leadDoc.data();

        // Per-call idempotency: the carrier retries the CDR callback up to 5×, which
        // can trigger a second relay run → a second ingest for the SAME callId while
        // the first is still 'processing'. If we've already counted this exact call,
        // don't double-increment callCount or re-append the same notes. We still
        // refresh the AI-extracted requirements below (cheap, idempotent overwrite).
        const isRepeatCall = existingData.lastCallId === callId || existingData.last_call_id === callId;

        const updatedReqs: Record<string, unknown> = { ...existingData.requirements };
        if (extractedData) {
            if (extractedData.budget_max !== undefined && extractedData.budget_max !== null) updatedReqs.maxBudget = extractedData.budget_max;
            if (extractedData.rooms !== undefined && extractedData.rooms !== null) {
                updatedReqs.minRooms = extractedData.rooms;
                updatedReqs.maxRooms = extractedData.rooms;
            }
            if (extractedData.preferred_location) updatedReqs.desiredCity = [extractedData.preferred_location];
            if (extractedData.transaction_type) updatedReqs.transactionType = extractedData.transaction_type;
            if (extractedData.property_type) updatedReqs.propertyType = [extractedData.property_type];
            if (extractedData.floor_min !== undefined && extractedData.floor_min !== null) updatedReqs.floorMin = extractedData.floor_min;
            if (extractedData.floor_max !== undefined && extractedData.floor_max !== null) updatedReqs.floorMax = extractedData.floor_max;
            if (extractedData.min_size_sqm !== undefined && extractedData.min_size_sqm !== null) updatedReqs.minSizeSqf = extractedData.min_size_sqm;
            if (extractedData.must_have_elevator !== undefined) updatedReqs.mustHaveElevator = extractedData.must_have_elevator;
            if (extractedData.must_have_parking !== undefined) updatedReqs.mustHaveParking = extractedData.must_have_parking;
            if (extractedData.must_have_balcony !== undefined) updatedReqs.mustHaveBalcony = extractedData.must_have_balcony;
            if (extractedData.must_have_safe_room !== undefined) updatedReqs.mustHaveSafeRoom = extractedData.must_have_safe_room;
            if (extractedData.condition) updatedReqs.condition = extractedData.condition;
            if (extractedData.urgency) updatedReqs.urgency = extractedData.urgency;
        }

        const existingNotes = (existingData.notes as string | null) ?? '';
        const datestamp = new Date().toLocaleDateString('he-IL');
        let notesSuffix = '';
        // Don't re-append the same call's summary on a retry.
        if (!isRepeatCall && (extractedData?.summary || extractedData?.extra_notes)) {
            notesSuffix = `\n\n[${datestamp}] ${extractedData.summary || ''}${extractedData.extra_notes ? `\n${extractedData.extra_notes}` : ''}`;
        }
        const updatedNotes = existingNotes ? existingNotes + notesSuffix : notesSuffix.trim();

        await leadDoc.ref.update({
            // Only fill in name if it was unknown before (or override if current is phone)
            ...(fullName && (existingData.name === localPhone || !existingData.name) ? { full_name: fullName, name: fullName } : {}),
            requirements: updatedReqs,
            notes: updatedNotes || null,
            last_call_id: callId,
            lastCallId: callId,
            updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
            lastCallAt:   admin.firestore.FieldValue.serverTimestamp(),
            // Count each distinct call once — a retry of the same callId must not bump it.
            ...(isRepeatCall ? {} : { callCount: admin.firestore.FieldValue.increment(1) }),
        });
        return { leadId: leadDoc.id, leadCreated: false };
    }

    const notesContent = [extractedData?.summary, extractedData?.extra_notes].filter(Boolean).join('\n') || null;

    const newLeadRef = await db.collection('leads').add({
        agencyId,
        phone:           localPhone,
        full_name:       fullName || localPhone,
        name:            fullName || localPhone,
        email:           null,
        source,
        assignedAgentId: agentId,
        status:          'new',
        // Default requirements block so the lead renders correctly on the Leads page
        requirements: {
            desiredCity: extractedData?.preferred_location ? [extractedData.preferred_location] : [],
            maxBudget: extractedData?.budget_max ?? null,
            minRooms: extractedData?.rooms ?? null,
            maxRooms: extractedData?.rooms ?? null,
            minSizeSqf: extractedData?.min_size_sqm ?? null,
            floorMin: extractedData?.floor_min ?? null,
            floorMax: extractedData?.floor_max ?? null,
            propertyType: extractedData?.property_type ? [extractedData.property_type] : [],
            mustHaveElevator: extractedData?.must_have_elevator ?? false,
            mustHaveParking: extractedData?.must_have_parking ?? false,
            mustHaveBalcony: extractedData?.must_have_balcony ?? false,
            mustHaveSafeRoom: extractedData?.must_have_safe_room ?? false,
            condition: extractedData?.condition ?? 'any',
            urgency: extractedData?.urgency ?? 'flexible',
            transactionType: extractedData?.transaction_type ?? null,
        },
        notes:           notesContent,
        last_call_id:    callId,
        lastCallId:      callId,
        createdAt:       admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
        lastCallAt:      admin.firestore.FieldValue.serverTimestamp(),
        callCount:       1,
        isBotActive:     false,
    });

    return { leadId: newLeadRef.id, leadCreated: true };
}
