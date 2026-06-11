/**
 * ─── Tool Executors (demo implementation) ─────────────────────────────────────
 *
 * Mirrors the production executor layer one-to-one, but runs against the
 * in-memory MockStore instead of tenant-scoped Firestore queries. The parts
 * that matter survive intact:
 *
 *   - Role-based access INSIDE the tools: agents see only their own deals,
 *     commissions and tasks; leaderboard / expenses / delete are admin-only.
 *     The model never enforces permissions — the executor layer does.
 *   - Validation errors are returned TO the model (not thrown), so Gemini can
 *     ask the user for the missing field instead of crashing the turn.
 *   - `queryLeadMatches` reuses the weighted matchmaking engine from
 *     ../matchmaking — the same scoring that runs in Firestore triggers.
 */

import { MockStore, Role, nextId } from './mockStore';
import { evaluateMatch, MatchingProperty } from '../matchmaking';

export interface ToolContext {
    store: MockStore;
    uid: string;
    role: Role;
}

export async function dispatchTool(name: string, args: any, ctx: ToolContext): Promise<any> {
    const { store, uid, role } = ctx;

    switch (name) {
        case 'queryTeam':
            return { team: store.agents.map(a => ({ name: a.name, role: a.role, phone: a.phone })) };

        case 'queryLeads': {
            const leads = args?.status ? store.leads.filter(l => l.status === args.status) : store.leads;
            const byStatus: Record<string, number> = {};
            for (const l of store.leads) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
            return {
                totalLeads: leads.length,
                statusBreakdown: byStatus,
                leads: leads.map(l => ({ id: l.id, fullName: l.fullName, status: l.status })),
            };
        }

        case 'queryProperties': {
            const active = store.properties.filter(p => p.status === 'active');
            return {
                totalActive: active.length,
                topPriced: [...active].sort((a, b) => b.price - a.price).slice(0, 5)
                    .map(p => ({ id: p.id, city: p.city, neighborhood: p.neighborhood, price: p.price, rooms: p.rooms })),
            };
        }

        case 'queryDeals': {
            let deals = args?.stage ? store.deals.filter(d => d.stage === args.stage) : store.deals;
            if (role === 'agent') deals = deals.filter(d => d.agentId === uid); // agents see only their own
            const byStage: Record<string, number> = {};
            let total = 0;
            for (const d of deals) { byStage[d.stage] = (byStage[d.stage] || 0) + 1; total += d.projectedCommission; }
            return {
                totalDeals: deals.length,
                totalCommissionILS: total,
                stageBreakdown: byStage,
                ...(role === 'agent' && { note: 'מציג עסקאות שלך בלבד' }),
            };
        }

        case 'queryIncome': {
            let won = store.deals.filter(d => d.stage === 'Won');
            if (role === 'agent') won = won.filter(d => d.agentId === uid);
            return {
                wonDealsThisMonth: won.length,
                totalCommissionThisMonthILS: won.reduce((s, d) => s + d.projectedCommission, 0),
                ...(role === 'agent' && { note: 'מציג עמלות שלך בלבד' }),
            };
        }

        case 'queryTasks': {
            let tasks = store.tasks.filter(t => t.status === 'open');
            if (role === 'agent') tasks = tasks.filter(t => t.assignedTo === uid);
            return { totalOpenTasks: tasks.length, tasks: tasks.map(t => ({ title: t.title, dueDate: t.dueDate })) };
        }

        case 'createLead': {
            if (!args?.fullName || !args?.phone) return { error: 'חסרים שם מלא או טלפון.' };
            const lead = {
                id: nextId('lead'), fullName: args.fullName, phone: args.phone, status: 'new' as const,
                assignedAgentId: uid, notes: args.notes,
                requirements: {
                    maxBudget: args.budgetMax, minRooms: args.rooms,
                    desiredCity: args.location ? [args.location] : undefined,
                },
            };
            store.leads.push(lead);
            return { success: true, leadId: lead.id };
        }

        case 'createProperty': {
            const missing = ['city', 'propertyType', 'price', 'transactionType'].filter(f => !args?.[f]);
            if (missing.length) return { error: `חסרים שדות חובה: ${missing.join(', ')}` };
            const prop = { id: nextId('prop'), status: 'active' as const, assignedAgentId: uid, ...args };
            store.properties.push(prop);
            return { success: true, propertyId: prop.id };
        }

        case 'createAgent': {
            if (role !== 'admin') return { error: 'רק מנהל יכול להוסיף סוכנים.' };
            if (!args?.name || !args?.phone) return { error: 'חסרים שם או טלפון.' };
            const agent = { uid: nextId('u'), name: args.name, phone: args.phone, email: args.email, role: (args.role === 'admin' ? 'admin' : 'agent') as Role };
            store.agents.push(agent);
            return { success: true, uid: agent.uid };
        }

        case 'queryGoals': {
            const won = store.deals.filter(d => d.stage === 'Won').reduce((s, d) => s + d.projectedCommission, 0);
            return { monthlyGoalILS: store.monthlyGoal, achievedILS: won, progressPercent: Math.round((won / store.monthlyGoal) * 100) };
        }

        case 'queryAgentLeaderboard': {
            if (role !== 'admin') return { error: 'דירוג סוכנים זמין למנהלים בלבד.' };
            const byAgent: Record<string, number> = {};
            for (const d of store.deals.filter(d => d.stage === 'Won')) byAgent[d.agentId] = (byAgent[d.agentId] || 0) + d.projectedCommission;
            const board = Object.entries(byAgent)
                .map(([agentId, commission]) => ({ name: store.agents.find(a => a.uid === agentId)?.name ?? agentId, commissionILS: commission }))
                .sort((a, b) => b.commissionILS - a.commissionILS);
            return { leaderboard: board };
        }

        case 'queryExpenses': {
            if (role !== 'admin') return { error: 'נתוני הוצאות זמינים למנהלים בלבד.' };
            const byCategory: Record<string, number> = {};
            for (const e of store.expenses) byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
            return { totalILS: store.expenses.reduce((s, e) => s + e.amount, 0), byCategory };
        }

        case 'queryMeetings':
            return { meetings: store.meetings.map(m => ({ title: m.title, date: m.date })) };

        case 'queryLeadMatches': {
            const lead = store.leads.find(l => l.id === args?.leadId);
            if (!lead) return { error: `ליד ${args?.leadId} לא נמצא.` };
            if (!lead.requirements) return { error: 'לליד אין דרישות חיפוש מוגדרות.' };
            const matches = store.properties
                .filter(p => p.status === 'active')
                .map(p => {
                    const mp: MatchingProperty = { ...p, transactionType: p.transactionType };
                    const result = evaluateMatch(mp, lead.requirements!);
                    return result ? { propertyId: p.id, city: p.city, price: p.price, ...result } : null;
                })
                .filter((m): m is NonNullable<typeof m> => m !== null)
                .sort((a, b) => b.matchScore - a.matchScore);
            return { leadName: lead.fullName, matches };
        }

        case 'searchEntity': {
            const q = (args?.query ?? '').toString().toLowerCase();
            if (!q) return { error: 'חסר ביטוי חיפוש.' };
            const leads = store.leads.filter(l => l.fullName.toLowerCase().includes(q) || l.phone.includes(q));
            const properties = store.properties.filter(p =>
                p.status !== 'deleted' &&
                [p.city, p.neighborhood, p.street, p.description].some(v => (v ?? '').toLowerCase().includes(q)));
            return {
                leads: leads.map(l => ({ id: l.id, fullName: l.fullName, phone: l.phone, status: l.status })),
                properties: properties.map(p => ({ id: p.id, city: p.city, street: p.street, price: p.price })),
            };
        }

        case 'updateLead': {
            const lead = store.leads.find(l => l.id === args?.leadId);
            if (!lead) return { error: `ליד ${args?.leadId} לא נמצא.` };
            if (args.status) lead.status = args.status;
            if (args.notes) lead.notes = args.notes;
            if (args.assignedAgentId) lead.assignedAgentId = args.assignedAgentId;
            return { success: true };
        }

        case 'createTask': {
            if (!args?.title || !args?.dueDate) return { error: 'חסרים כותרת או תאריך יעד.' };
            if (isNaN(Date.parse(args.dueDate))) return { error: 'dueDate חייב להיות בפורמט ISO 8601, למשל 2026-06-15T10:00:00.' };
            const task = {
                id: nextId('task'), title: args.title, dueDate: args.dueDate,
                assignedTo: args.assignedTo ?? uid, status: 'open' as const,
                relatedLeadId: args.relatedLeadId, relatedPropertyId: args.relatedPropertyId, notes: args.notes,
            };
            store.tasks.push(task);
            return { success: true, taskId: task.id };
        }

        case 'createDeal': {
            const missing = ['propertyId', 'stage', 'projectedCommission'].filter(f => args?.[f] == null);
            if (missing.length) return { error: `חסרים שדות חובה: ${missing.join(', ')}` };
            if (!store.properties.find(p => p.id === args.propertyId)) return { error: `נכס ${args.propertyId} לא נמצא.` };
            const deal = { id: nextId('deal'), agentId: uid, ...args };
            store.deals.push(deal);
            return { success: true, dealId: deal.id };
        }

        case 'updateDeal': {
            const deal = store.deals.find(d => d.id === args?.dealId);
            if (!deal) return { error: `עסקה ${args?.dealId} לא נמצאה.` };
            if (role === 'agent' && deal.agentId !== uid) return { error: 'אפשר לעדכן רק עסקאות שלך.' };
            if (args.stage) deal.stage = args.stage;
            if (args.notes) deal.notes = args.notes;
            if (args.projectedCommission != null) deal.projectedCommission = args.projectedCommission;
            return { success: true };
        }

        case 'generateCatalog': {
            const lead = store.leads.find(l => l.id === args?.leadId);
            if (!lead) return { error: `ליד ${args?.leadId} לא נמצא.` };
            const ids: string[] = args?.propertyIds ?? [];
            const found = ids.filter(id => store.properties.some(p => p.id === id && p.status === 'active'));
            if (!found.length) return { error: 'לא נמצאו נכסים פעילים מהרשימה.' };
            const id = nextId('cat');
            const expiryDays = args?.expiryDays ?? 7;
            const catalog = {
                id, leadId: lead.id, propertyIds: found,
                name: args?.name ?? `קטלוג עבור ${lead.fullName}`,
                expiresAt: new Date(Date.now() + expiryDays * 86_400_000).toISOString(),
                catalogUrl: `https://example.com/catalog/${id}`,
            };
            store.catalogs.push(catalog);
            return { success: true, catalogUrl: catalog.catalogUrl, propertiesIncluded: found.length, expiresAt: catalog.expiresAt };
        }

        case 'sendWhatsAppToLead': {
            const lead = store.leads.find(l => l.id === args?.leadId);
            if (!lead) return { error: `ליד ${args?.leadId} לא נמצא.` };
            if (!args?.message) return { error: 'חסר תוכן הודעה.' };
            // Production: Green API call with per-agency credentials decrypted on the fly (AES-256-CBC)
            store.sentMessages.push({ leadId: lead.id, phone: lead.phone, message: args.message });
            return { success: true, sentTo: lead.fullName };
        }

        case 'updateProperty': {
            const prop = store.properties.find(p => p.id === args?.propertyId);
            if (!prop) return { error: `נכס ${args?.propertyId} לא נמצא.` };
            if (args.price != null) prop.price = args.price;
            if (args.description) prop.description = args.description;
            if (args.status) prop.status = args.status;
            if (args.assignedAgentId) prop.assignedAgentId = args.assignedAgentId;
            return { success: true };
        }

        case 'deleteProperty': {
            if (role !== 'admin') return { error: 'רק מנהל יכול למחוק נכסים.' };
            const prop = store.properties.find(p => p.id === args?.propertyId);
            if (!prop) return { error: `נכס ${args?.propertyId} לא נמצא.` };
            prop.status = 'deleted'; // soft delete — never hard-delete from the model's hand
            return { success: true };
        }

        case 'createCalendarEvent': {
            if (!args?.title || !args?.date) return { error: 'חסרים כותרת או תאריך.' };
            if (isNaN(Date.parse(args.date))) return { error: 'date חייב להיות בפורמט ISO 8601.' };
            const meeting = { id: nextId('meet'), title: args.title, date: args.date, leadId: args.leadId, propertyId: args.propertyId, notes: args.notes };
            store.meetings.push(meeting);
            return { success: true, meetingId: meeting.id };
        }

        default:
            return { error: `Tool ${name} is not available.` };
    }
}
