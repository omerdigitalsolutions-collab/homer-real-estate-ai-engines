/**
 * ─── Shared CRM Tool Declarations ─────────────────────────────────────────────
 *
 * These declarations are shared between two channels in production:
 *   1. The in-dashboard AI copilot (Firebase callable, web chat)
 *   2. The internal WhatsApp agent bot (agents texting the office number)
 *
 * One tool layer, two surfaces — the model decides which tool to call,
 * the executor layer enforces tenancy and role-based access.
 */

import { SchemaType, Tool } from '@google/generative-ai';

export const chatBotTools: Tool[] = [
    {
        functionDeclarations: [
            {
                name: 'queryTeam',
                description: 'Fetch the users/agents in the real estate agency. Useful to know who is on the team.',
                parameters: { type: SchemaType.OBJECT, properties: {} },
            },
            {
                name: 'queryLeads',
                description: 'Fetch leads in the pipeline. Gives a summary of total leads and counts by status.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        status: { type: SchemaType.STRING, description: 'Optional status filter. Common values: new, in_progress, won, lost' },
                    },
                },
            },
            {
                name: 'queryProperties',
                description: 'Fetch active properties. Returns total count and details of the highest priced ones.',
                parameters: { type: SchemaType.OBJECT, properties: {} },
            },
            {
                name: 'queryDeals',
                description: 'Fetch deals (pipeline). You can optionally pass stage="Won" to check won deals.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        stage: { type: SchemaType.STRING, description: 'Optional stage filter. e.g. "Won"' },
                    },
                },
            },
            {
                name: 'queryIncome',
                description: 'Calculates the total commission from Won deals in the current month.',
                parameters: { type: SchemaType.OBJECT, properties: {} },
            },
            {
                name: 'queryTasks',
                description: 'Fetch open tasks in the CRM.',
                parameters: { type: SchemaType.OBJECT, properties: {} },
            },
            {
                name: 'createLead',
                description: 'Creates a new lead in the CRM. You MUST have the full name and phone number to call this tool.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        fullName:    { type: SchemaType.STRING, description: 'Required. Full name of the client.' },
                        phone:       { type: SchemaType.STRING, description: 'Required. Phone number.' },
                        propertyType:{ type: SchemaType.STRING, description: 'Optional. e.g. apartment, house, plot, commercial.' },
                        rooms:       { type: SchemaType.NUMBER, description: 'Optional. Number of rooms desired.' },
                        budgetMax:   { type: SchemaType.NUMBER, description: 'Optional. Maximum budget in ILS.' },
                        location:    { type: SchemaType.STRING, description: 'Optional. Preferred street or city.' },
                        notes:       { type: SchemaType.STRING, description: 'Optional. Extra requirements or context.' },
                    },
                    required: ['fullName', 'phone'],
                },
            },
            {
                name: 'createProperty',
                description: 'Creates a new property listing. You MUST have city, propertyType, price, and transactionType.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        city:            { type: SchemaType.STRING, description: 'Required. City/town.' },
                        propertyType:    { type: SchemaType.STRING, description: 'Required. e.g. דירה, בית, דופלקס, מסחרי.' },
                        price:           { type: SchemaType.NUMBER, description: 'Required. Price in ILS.' },
                        transactionType: { type: SchemaType.STRING, description: 'Required. "forsale" or "rent".' },
                        street:          { type: SchemaType.STRING, description: 'Optional. Street name.' },
                        neighborhood:    { type: SchemaType.STRING, description: 'Optional. Neighborhood.' },
                        rooms:           { type: SchemaType.NUMBER, description: 'Optional. Number of rooms.' },
                        floor:           { type: SchemaType.NUMBER, description: 'Optional. Floor number.' },
                        totalFloors:     { type: SchemaType.NUMBER, description: 'Optional. Total floors in building.' },
                        squareMeters:    { type: SchemaType.NUMBER, description: 'Optional. Size in sqm.' },
                        hasElevator:     { type: SchemaType.BOOLEAN },
                        hasParking:      { type: SchemaType.BOOLEAN },
                        hasBalcony:      { type: SchemaType.BOOLEAN },
                        description:     { type: SchemaType.STRING, description: 'Optional. Free-text description.' },
                    },
                    required: ['city', 'propertyType', 'price', 'transactionType'],
                },
            },
            {
                name: 'createAgent',
                description: 'Creates a new agent/user in the agency. You MUST have name and phone.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        name:  { type: SchemaType.STRING, description: 'Required. Full name.' },
                        phone: { type: SchemaType.STRING, description: 'Required. Phone number.' },
                        email: { type: SchemaType.STRING, description: 'Optional. Email address.' },
                        role:  { type: SchemaType.STRING, description: 'Optional. "admin" or "agent". Defaults to "agent".' },
                    },
                    required: ['name', 'phone'],
                },
            },
        ],
    },
    {
        functionDeclarations: [
            {
                name: 'queryGoals',
                description: 'Fetch agency and personal goals (monthly/yearly) and current progress towards them.',
                parameters: { type: SchemaType.OBJECT, properties: {} },
            },
            {
                name: 'queryAgentLeaderboard',
                description: 'Fetch a ranking of agents by their sales performance.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        period: { type: SchemaType.STRING, description: 'Optional. "month" or "year". Defaults to month.' },
                    },
                },
            },
            {
                name: 'queryExpenses',
                description: 'Fetch and summarize agency expenses for a period.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        period: { type: SchemaType.STRING, description: 'Optional. "month" or "year". Defaults to month.' },
                    },
                },
            },
            {
                name: 'queryMeetings',
                description: 'Fetch upcoming meetings and appointments.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        period: { type: SchemaType.STRING, description: 'Optional. "today", "tomorrow", or "week". Defaults to today.' },
                    },
                },
            },
            {
                name: 'queryLeadMatches',
                description: "Find properties that match a specific lead's requirements.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        leadId: { type: SchemaType.STRING, description: 'Required. The lead ID.' },
                    },
                    required: ['leadId'],
                },
            },
            {
                name: 'searchEntity',
                description: 'Search for a lead or property by name, phone, or address.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        query: { type: SchemaType.STRING, description: 'Search term (name, phone, address).' },
                    },
                    required: ['query'],
                },
            },
        ],
    },
    {
        functionDeclarations: [
            {
                name: 'updateLead',
                description: "Update an existing lead's status, notes, or assigned agent. Use searchEntity first to get the leadId.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        leadId:          { type: SchemaType.STRING, description: 'Required. The lead ID.' },
                        status:          { type: SchemaType.STRING, description: 'Optional. New status: new, in_progress, won, lost.' },
                        notes:           { type: SchemaType.STRING, description: 'Optional. Updated notes.' },
                        assignedAgentId: { type: SchemaType.STRING, description: 'Optional. Agent UID to assign.' },
                    },
                    required: ['leadId'],
                },
            },
            {
                name: 'createTask',
                description: 'Create a new task or reminder in the CRM. dueDate must be ISO 8601.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        title:             { type: SchemaType.STRING, description: 'Required. Task title.' },
                        dueDate:           { type: SchemaType.STRING, description: 'Required. ISO 8601 date-time, e.g. 2025-06-10T10:00:00.' },
                        assignedTo:        { type: SchemaType.STRING, description: 'Optional. Agent UID. Defaults to current user.' },
                        relatedLeadId:     { type: SchemaType.STRING, description: 'Optional. Lead ID.' },
                        relatedPropertyId: { type: SchemaType.STRING, description: 'Optional. Property ID.' },
                        notes:             { type: SchemaType.STRING, description: 'Optional. Extra notes.' },
                    },
                    required: ['title', 'dueDate'],
                },
            },
            {
                name: 'createDeal',
                description: 'Create a new deal in the CRM pipeline.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        propertyId:          { type: SchemaType.STRING, description: 'Required. Property ID.' },
                        stage:               { type: SchemaType.STRING, description: 'Required. e.g. Lead, Offer, Contract, Won, Lost.' },
                        projectedCommission: { type: SchemaType.NUMBER, description: 'Required. Estimated commission in ILS.' },
                        isVatIncluded:       { type: SchemaType.BOOLEAN },
                        buyerId:             { type: SchemaType.STRING, description: 'Optional. Lead ID of the buyer.' },
                        sellerId:            { type: SchemaType.STRING, description: 'Optional. Lead ID of the seller.' },
                    },
                    required: ['propertyId', 'stage', 'projectedCommission'],
                },
            },
            {
                name: 'updateDeal',
                description: "Update an existing deal's stage, notes, or commission.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        dealId:              { type: SchemaType.STRING, description: 'Required. Deal ID.' },
                        stage:               { type: SchemaType.STRING, description: 'Optional. New stage.' },
                        notes:               { type: SchemaType.STRING, description: 'Optional. Notes.' },
                        projectedCommission: { type: SchemaType.NUMBER, description: 'Optional. Updated commission in ILS.' },
                    },
                    required: ['dealId'],
                },
            },
            {
                name: 'generateCatalog',
                description: 'Create a shared property catalog for a lead and return a shareable URL. ALWAYS include the returned catalogUrl in your reply.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        leadId:      { type: SchemaType.STRING, description: 'Required. Lead ID.' },
                        propertyIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: 'Required. Array of property IDs.' },
                        name:        { type: SchemaType.STRING, description: 'Optional. Catalog name.' },
                        expiryDays:  { type: SchemaType.NUMBER, description: 'Optional. Days until expiry. Defaults to 7.' },
                    },
                    required: ['leadId', 'propertyIds'],
                },
            },
            {
                name: 'sendWhatsAppToLead',
                description: "Send a WhatsApp message to a lead using the agency's connected WhatsApp number.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        leadId:  { type: SchemaType.STRING, description: 'Required. Lead ID.' },
                        message: { type: SchemaType.STRING, description: 'Required. The message text to send.' },
                    },
                    required: ['leadId', 'message'],
                },
            },
            {
                name: 'updateProperty',
                description: 'Update fields of an existing property listing.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        propertyId:      { type: SchemaType.STRING, description: 'Required. Property ID.' },
                        price:           { type: SchemaType.NUMBER, description: 'Optional. New price in ILS.' },
                        description:     { type: SchemaType.STRING, description: 'Optional. Updated description.' },
                        status:          { type: SchemaType.STRING, description: 'Optional. New status: active, inactive.' },
                        assignedAgentId: { type: SchemaType.STRING, description: 'Optional. Agent UID.' },
                    },
                    required: ['propertyId'],
                },
            },
            {
                name: 'deleteProperty',
                description: 'Soft-delete a property. Confirm with the user before calling.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        propertyId: { type: SchemaType.STRING, description: 'Required. Property ID.' },
                    },
                    required: ['propertyId'],
                },
            },
            {
                name: 'createCalendarEvent',
                description: 'Schedule a meeting or appointment in the CRM calendar. date must be ISO 8601.',
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        title:      { type: SchemaType.STRING, description: 'Required. Meeting title.' },
                        date:       { type: SchemaType.STRING, description: 'Required. ISO 8601 date-time, e.g. 2025-06-12T15:00:00.' },
                        leadId:     { type: SchemaType.STRING, description: 'Optional. Lead ID for context.' },
                        propertyId: { type: SchemaType.STRING, description: 'Optional. Property ID for context.' },
                        notes:      { type: SchemaType.STRING, description: 'Optional. Notes about the meeting.' },
                    },
                    required: ['title', 'date'],
                },
            },
        ],
    },
];
