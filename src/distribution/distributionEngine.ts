/**
 * ─── Concurrency-Safe Distribution Engine ────────────────────────────────────
 *
 * Assigns a new lead/property to the best available agent. The entire
 * read-filter-pick-write cycle runs inside a single Firestore transaction:
 * when two leads arrive in the same millisecond, naive parallel execution
 * would read the same "least recently assigned" agent twice and double-book
 * him. The transaction serializes the contention — the second invocation
 * retries against the updated `lastLeadAssignedAt` and picks the next agent.
 */

import * as admin from 'firebase-admin';
import { isCityMatch } from '../matchmaking/stringUtils';

const db = admin.firestore();

interface AgentCandidate {
    ref: admin.firestore.DocumentReference;
    uid: string;
    name: string;
    phone?: string;
    specializations: string[];
    serviceAreas: string[];
    lastLeadAssignedAt: admin.firestore.Timestamp | null;
    lastPropertyAssignedAt: admin.firestore.Timestamp | null;
}

export interface DistributionResult {
    assignedAgentId: string;
    assignedAgentName: string;
    assignedAgentPhone?: string;
}

export interface LeadDistributionContext {
    transactionType?: string;
    desiredCities: string[];
}

export interface PropertyDistributionContext {
    transactionType?: string;
    city: string;
}

function normalizeTransactionType(tt: string): string {
    if (tt === 'forsale') return 'sale';
    return tt; // 'sale', 'rent', 'commercial' pass through
}

function applySmartFilter(
    candidates: AgentCandidate[],
    transactionType?: string,
    cities?: string[],
): AgentCandidate[] {
    let filtered = candidates;

    // Agents with no specializations are generalists — keep them for any lead type
    if (transactionType) {
        const normalizedType = normalizeTransactionType(transactionType);
        filtered = filtered.filter(a =>
            a.specializations.length === 0 || a.specializations.includes(normalizedType)
        );
    }

    // Agents with no service areas cover everywhere — keep them for any city
    if (cities && cities.length > 0) {
        filtered = filtered.filter(a =>
            a.serviceAreas.length === 0 || cities.some(city => isCityMatch(a.serviceAreas, city))
        );
    }

    return filtered; // may be empty — caller decides based on strictness
}

/**
 * Core distribution algorithm. Runs inside a Firestore transaction to prevent
 * race conditions when multiple leads arrive simultaneously.
 *
 * Returns the assigned agent info, or null if no eligible agent found.
 */
export async function distributeToAgent(
    agencyId: string,
    targetDocRef: admin.firestore.DocumentReference,
    context: LeadDistributionContext | PropertyDistributionContext,
    mode: 'lead' | 'property',
    strictness: 'strict' | 'flexible',
): Promise<DistributionResult | null> {
    const cities = mode === 'lead'
        ? (context as LeadDistributionContext).desiredCities
        : [(context as PropertyDistributionContext).city].filter(Boolean);

    let result: DistributionResult | null = null;

    await db.runTransaction(async (t) => {
        // ALL READS FIRST (Firestore transaction requirement)
        const agentsSnap = await t.get(
            db.collection('users')
                .where('agencyId', '==', agencyId)
                .where('isActive', '==', true)
                .limit(20)
        );

        if (agentsSnap.empty) return;

        // Filter: treat isAvailableForLeads === undefined as true
        const candidates: AgentCandidate[] = agentsSnap.docs
            .filter(doc => doc.data().isAvailableForLeads !== false)
            .map(doc => {
                const d = doc.data();
                return {
                    ref: doc.ref,
                    uid: doc.id,
                    name: d.name || '',
                    phone: d.phone,
                    specializations: d.specializations || [],
                    serviceAreas: d.serviceAreas || [],
                    lastLeadAssignedAt: d.lastLeadAssignedAt || null,
                    lastPropertyAssignedAt: d.lastPropertyAssignedAt || null,
                };
            });

        if (candidates.length === 0) return;

        let matched = applySmartFilter(candidates, context.transactionType, cities);

        if (matched.length === 0) {
            if (strictness === 'strict') return; // No match in strict mode → caller creates admin alert
            matched = candidates; // Flexible: fall back to all available agents
        }

        // Round-robin: agent with oldest assignment timestamp goes first (null = never assigned → first)
        const lastField = mode === 'lead' ? 'lastLeadAssignedAt' : 'lastPropertyAssignedAt';
        matched.sort((a, b) => {
            const aMs = (a[lastField as keyof AgentCandidate] as admin.firestore.Timestamp | null)?.toMillis() ?? 0;
            const bMs = (b[lastField as keyof AgentCandidate] as admin.firestore.Timestamp | null)?.toMillis() ?? 0;
            return aMs - bMs;
        });

        const agent = matched[0];

        // WRITES (after all reads)
        if (mode === 'lead') {
            t.update(targetDocRef, { assignedAgentId: agent.uid });
            t.update(agent.ref, { lastLeadAssignedAt: admin.firestore.FieldValue.serverTimestamp() });
        } else {
            t.update(targetDocRef, {
                'management.assignedAgentId': agent.uid,
                'management.assignedAgentName': agent.name,
            });
            t.update(agent.ref, { lastPropertyAssignedAt: admin.firestore.FieldValue.serverTimestamp() });
        }

        result = {
            assignedAgentId: agent.uid,
            assignedAgentName: agent.name,
            assignedAgentPhone: agent.phone,
        };
    });

    return result;
}

export async function createAdminAlert(
    agencyId: string,
    type: string,
    title: string,
    message: string,
    link: string,
): Promise<void> {
    await db.collection('alerts').add({
        agencyId,
        targetAgentId: 'all',
        type,
        title,
        message,
        link,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}
