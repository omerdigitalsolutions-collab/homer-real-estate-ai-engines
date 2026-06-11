/**
 * Firestore trigger: assigns every new unassigned lead to an agent.
 * (Trimmed from production: the admin email notification for Facebook-sourced
 * leads — Resend API with an HTML digest — is omitted here for brevity.)
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { distributeToAgent, createAdminAlert } from './distributionEngine';
import { sendWhatsAppMessage, WhatsappIntegration } from '../whatsapp-agent/promptBuilder';

const db = admin.firestore();

export const distributeLead = onDocumentCreated('leads/{leadId}', async (event) => {
    const leadSnap = event.data;
    if (!leadSnap) return;

    const lead = leadSnap.data();
    const leadId = event.params.leadId;
    const agencyId: string | undefined = lead.agencyId;

    // Exit early: already assigned (e.g., created via missed-call handler)
    if (lead.assignedAgentId) return;
    if (!agencyId) return;

    const agencyDoc = await db.doc(`agencies/${agencyId}`).get();
    if (!agencyDoc.exists) return;

    const agencyData = agencyDoc.data()!;
    const config = agencyData.distributionConfig;
    if (!config?.leadsEnabled) return;

    const integration: WhatsappIntegration | undefined = agencyData.whatsappIntegration?.isConnected
        ? (agencyData.whatsappIntegration as WhatsappIntegration)
        : undefined;

    const strictness: 'strict' | 'flexible' = config.strictness === 'strict' ? 'strict' : 'flexible';

    const context = {
        transactionType: lead.requirements?.transactionType,
        desiredCities: (lead.requirements?.desiredCity as string[]) || [],
    };

    const leadRef = db.doc(`leads/${leadId}`);
    const result = await distributeToAgent(agencyId, leadRef, context, 'lead', strictness);

    if (!result) {
        // No eligible agent found → surface to a human instead of dropping the lead
        await createAdminAlert(
            agencyId,
            'unassigned_lead',
            'ליד לא שויך אוטומטית',
            `ליד חדש (${lead.name || 'לא ידוע'}) לא נמצא לו סוכן מתאים — נא לשייך ידנית`,
            `/dashboard/leads/${leadId}`,
        );
        console.log(`[distributeLead] No eligible agent for lead ${leadId} — admin alert created`);
        return;
    }

    // In-app alert for the assigned agent
    await db.collection('alerts').add({
        agencyId,
        targetAgentId: result.assignedAgentId,
        type: 'lead_assigned',
        title: 'ליד חדש שויך אליך',
        message: `ליד חדש (${lead.name || 'לא ידוע'}) שויך אליך אוטומטית`,
        link: `/dashboard/leads/${leadId}`,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // WhatsApp notification to the assigned agent
    if (integration && result.assignedAgentPhone) {
        const cities = context.desiredCities.filter(Boolean).join(', ');
        const msg =
            `🔥 ליד חדש! ${lead.name || 'לקוח'} ${cities ? `מחפש ב${cities}` : ''}. ` +
            `הוא מחכה לשיחה ממך.`;
        await sendWhatsAppMessage(integration, result.assignedAgentPhone, msg)
            .catch(err => console.error('[distributeLead] WhatsApp notification failed:', err));
    }

    console.log(`[distributeLead] Lead ${leadId} → agent ${result.assignedAgentId} (${result.assignedAgentName})`);
});
