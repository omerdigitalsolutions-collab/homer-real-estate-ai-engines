/**
 * In-memory CRM store standing in for Firestore so the copilot demo runs
 * with zero infrastructure. In production every executor below maps to a
 * tenant-scoped Firestore query (`agencies/{agencyId}/...`).
 *
 * All data here is synthetic.
 */

export type Role = 'admin' | 'agent';

export interface Agent {
    uid: string;
    name: string;
    phone: string;
    email?: string;
    role: Role;
}

export interface Lead {
    id: string;
    fullName: string;
    phone: string;
    status: 'new' | 'in_progress' | 'won' | 'lost';
    assignedAgentId?: string;
    notes?: string;
    requirements?: {
        transactionType?: 'sale' | 'rent' | 'commercial';
        desiredCity?: string[];
        maxBudget?: number;
        minRooms?: number;
        maxRooms?: number;
    };
}

export interface Property {
    id: string;
    city: string;
    neighborhood?: string | null;
    street?: string | null;
    propertyType: string;
    price: number;
    rooms?: number | null;
    transactionType: 'forsale' | 'rent';
    status: 'active' | 'inactive' | 'deleted';
    assignedAgentId?: string;
    description?: string;
    hasElevator?: boolean | null;
    hasParking?: boolean | null;
    hasBalcony?: boolean | null;
}

export interface Deal {
    id: string;
    propertyId: string;
    stage: string;
    projectedCommission: number;
    agentId: string;
    buyerId?: string;
    sellerId?: string;
    notes?: string;
    closedAt?: string;
}

export interface Task {
    id: string;
    title: string;
    dueDate: string;
    assignedTo: string;
    status: 'open' | 'done';
    relatedLeadId?: string;
    relatedPropertyId?: string;
    notes?: string;
}

export interface Meeting {
    id: string;
    title: string;
    date: string;
    leadId?: string;
    propertyId?: string;
    notes?: string;
}

export interface Expense {
    id: string;
    category: string;
    amount: number;
    date: string;
}

export interface Catalog {
    id: string;
    leadId: string;
    propertyIds: string[];
    name: string;
    expiresAt: string;
    catalogUrl: string;
}

export interface MockStore {
    agents: Agent[];
    leads: Lead[];
    properties: Property[];
    deals: Deal[];
    tasks: Task[];
    meetings: Meeting[];
    expenses: Expense[];
    catalogs: Catalog[];
    sentMessages: Array<{ leadId: string; phone: string; message: string }>;
    monthlyGoal: number;
}

let counter = 100;
export const nextId = (prefix: string) => `${prefix}_${counter++}`;

const thisMonth = (day: number, hour = 10) => {
    const d = new Date();
    d.setDate(day); d.setHours(hour, 0, 0, 0);
    return d.toISOString();
};

export function createSeededStore(): MockStore {
    return {
        agents: [
            { uid: 'u_admin', name: 'דנה מנהלת', phone: '0500000001', email: 'dana@example.com', role: 'admin' },
            { uid: 'u_yossi', name: 'יוסי סוכן', phone: '0500000002', email: 'yossi@example.com', role: 'agent' },
            { uid: 'u_maya', name: 'מאיה סוכנת', phone: '0500000003', email: 'maya@example.com', role: 'agent' },
        ],
        leads: [
            {
                id: 'lead_1', fullName: 'אבי כהן', phone: '0501111111', status: 'new', assignedAgentId: 'u_yossi',
                requirements: { transactionType: 'sale', desiredCity: ['תל אביב'], maxBudget: 3_000_000, minRooms: 3, maxRooms: 4 },
            },
            {
                id: 'lead_2', fullName: 'רונית לוי', phone: '0502222222', status: 'in_progress', assignedAgentId: 'u_maya',
                requirements: { transactionType: 'rent', desiredCity: ['רמת גן'], maxBudget: 7_500, minRooms: 2 },
            },
            { id: 'lead_3', fullName: 'משה פרץ', phone: '0503333333', status: 'won', assignedAgentId: 'u_yossi' },
        ],
        properties: [
            {
                id: 'prop_1', city: 'תל אביב', neighborhood: 'פלורנטין', street: 'ויטל', propertyType: 'דירה',
                price: 2_850_000, rooms: 3.5, transactionType: 'forsale', status: 'active', assignedAgentId: 'u_yossi',
                hasElevator: true, hasParking: false, hasBalcony: true,
            },
            {
                id: 'prop_2', city: 'תל אביב', neighborhood: 'הצפון הישן', street: 'דיזנגוף', propertyType: 'דירה',
                price: 4_200_000, rooms: 4, transactionType: 'forsale', status: 'active', assignedAgentId: 'u_maya',
                hasElevator: true, hasParking: true, hasBalcony: false,
            },
            {
                id: 'prop_3', city: 'רמת גן', neighborhood: 'מרום נווה', street: null, propertyType: 'דירה',
                price: 6_800, rooms: 3, transactionType: 'rent', status: 'active', assignedAgentId: 'u_maya',
                hasElevator: null, hasParking: true, hasBalcony: true,
            },
        ],
        deals: [
            { id: 'deal_1', propertyId: 'prop_1', stage: 'Offer', projectedCommission: 57_000, agentId: 'u_yossi', buyerId: 'lead_1' },
            { id: 'deal_2', propertyId: 'prop_2', stage: 'Won', projectedCommission: 84_000, agentId: 'u_maya', buyerId: 'lead_3', closedAt: thisMonth(3) },
        ],
        tasks: [
            { id: 'task_1', title: 'להתקשר לאבי כהן', dueDate: thisMonth(15, 9), assignedTo: 'u_yossi', status: 'open', relatedLeadId: 'lead_1' },
        ],
        meetings: [
            { id: 'meet_1', title: 'סיור בדירה בפלורנטין', date: thisMonth(new Date().getDate(), 17), leadId: 'lead_1', propertyId: 'prop_1' },
        ],
        expenses: [
            { id: 'exp_1', category: 'שיווק', amount: 4_500, date: thisMonth(1) },
            { id: 'exp_2', category: 'תפעול משרד', amount: 2_200, date: thisMonth(5) },
        ],
        catalogs: [],
        sentMessages: [],
        monthlyGoal: 150_000,
    };
}
