/**
 * ─── Customer-Bot Gemini Function Declarations + Chat States ─────────────────
 *
 * The customer-facing bot is a hybrid: a persisted state machine drives the
 * macro flow (what stage of the funnel the customer is in), while Gemini
 * function calling handles the micro decisions inside each stage.
 *
 * Buyer states:  IDLE → COLLECTING_REQS → SCHEDULING_CALL → IDLE
 * Seller states: IDLE → COLLECTING_SELLER_INFO → SCHEDULING_SELLER_CALL → IDLE
 *
 * The state is persisted on the lead document with a `lastStateAt` timestamp
 * and a 24h inactivity TTL, so a customer replying tomorrow morning resumes
 * exactly where they left off — and a stale state never hijacks a new topic.
 */

import { FunctionDeclaration, SchemaType } from '@google/generative-ai';

export type ChatState =
  | 'IDLE'
  | 'COLLECTING_NAME'
  | 'COLLECTING_REQS'
  | 'ASKING_EXTRA_CRITERIA'
  | 'SCHEDULING_CALL'
  | 'COLLECTING_SELLER_INFO'
  | 'SCHEDULING_SELLER_CALL'
  | 'CLOSED';

export interface StoredChatState {
  state: ChatState;
  lastStateAt: number;
  pendingSellerAddress?: string;
  pendingSellerType?: string;
  extraCriteriaAsked?: boolean;
  closedAt?: number;
  sellerInfoAttempts?: number;
  pendingIntent?: 'buyer' | 'seller'; // intent captured before name was collected
}

// ─── Gemini Function Declarations ─────────────────────────────────────────────

export const scheduleMeetingDeclaration: FunctionDeclaration = {
  name: 'schedule_meeting',
  description: 'קובע פגישה, סיור בנכס, או שיחת טלפון ביומן המתווך, בתאריך ושעה מוסכמים עם הלקוח.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      date:        { type: SchemaType.STRING, description: 'תאריך הפגישה YYYY-MM-DD' },
      time:        { type: SchemaType.STRING, description: 'שעת הפגישה HH:MM' },
      meetingType: { type: SchemaType.STRING, description: '"visit" לסיור, "call" לשיחת טלפון' },
      propertyId:  { type: SchemaType.STRING, description: 'מזהה נכס (אופציונלי)' },
      duration:    { type: SchemaType.NUMBER, description: 'משך בדקות (ברירת מחדל 60)' },
    },
    required: ['date', 'time', 'meetingType'],
  },
};

export const updateLeadRequirementsDeclaration: FunctionDeclaration = {
  name: 'update_lead_requirements',
  description: 'שמור את דרישות הלקוח שאספת. קרא ברגע שיש לך לפחות פרמטר אחד (חדרים / תקציב / סוג / עיר / שכונה / רחוב). עיר אינה חובה — ניתן לחפש בכל נכסי הסוכנות.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      desiredCity:          { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING }, description: 'ערים מועדפות (עברית) — אופציונלי' },
      desiredNeighborhoods: { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING }, description: 'שכונות מועדפות (עברית) — אופציונלי' },
      desiredStreet:        { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING }, description: 'רחובות מועדפים (עברית) — שמור את שם הרחוב בלבד בלי המספר. לדוגמה: "הרצל" ולא "הרצל 5".' },
      maxBudget:            { type: SchemaType.NUMBER,  description: 'תקציב מקסימלי בשקלים' },
      minRooms:             { type: SchemaType.NUMBER,  description: 'מינימום חדרים' },
      maxRooms:             { type: SchemaType.NUMBER,  description: 'מקסימום חדרים' },
      propertyType:         { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING }, description: '"sale" לקנייה, "rent" לשכירות' },
      mustHaveParking:      { type: SchemaType.BOOLEAN },
      mustHaveElevator:     { type: SchemaType.BOOLEAN },
      mustHaveBalcony:      { type: SchemaType.BOOLEAN },
      mustHaveSafeRoom:     { type: SchemaType.BOOLEAN },
    },
    required: [],
  },
};

export const createCatalogDeclaration: FunctionDeclaration = {
  name: 'create_catalog',
  description: 'צור קטלוג נכסים מותאם ללקוח לפי הדרישות השמורות. קרא לאחר update_lead_requirements.',
  parameters: { type: SchemaType.OBJECT, properties: {} },
};

export const notifyAssignedAgentDeclaration: FunctionDeclaration = {
  name: 'notify_assigned_agent',
  description:
    'שלח התראת WhatsApp לסוכן האחראי על נכס בלעדי כשהלקוח שואל עליו ספציפית. קרא רק כאשר ענית על שאלה לגבי נכס שמופיע ב-RAG context עם המזהה שלו, ואחרי שכבר נתת ללקוח את הפרטים.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      propertyId: { type: SchemaType.STRING, description: 'המזהה של הנכס מהקונטקסט (השדה [מזהה: ...])' },
    },
    required: ['propertyId'],
  },
};

export const checkAvailabilityDeclaration: FunctionDeclaration = {
  name: 'check_availability',
  description: 'בדוק זמינות ביומן מנהל המשרד לתיאום פגישה. מחזיר עד 3 חלונות זמן פנויים בימי העסקים הקרובים. קרא לפני schedule_meeting כדי להציג ללקוח זמנים ריאליים שבהם המשרד פנוי.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      preferredDate: {
        type: SchemaType.STRING,
        description: 'תאריך מועדף להתחלת החיפוש YYYY-MM-DD (אופציונלי — ברירת מחדל: היום)',
      },
    },
    required: [],
  },
};

export const searchPropertyByLocationDeclaration: FunctionDeclaration = {
  name: 'search_property_by_location',
  description:
    'חפש נכס ספציפי לפי שכונה, רחוב, או עיר כאשר הלקוח שואל על נכס שאינו ברשימת הנכסים המצורפת. ' +
    'קרא רק כאשר הלקוח ציין שם שכונה / רחוב / פרויקט ספציפי שאינו מופיע ב-RAG context.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      neighborhood: { type: SchemaType.STRING, description: 'שם השכונה (אופציונלי)' },
      street:       { type: SchemaType.STRING, description: 'שם הרחוב בלבד, ללא מספר (אופציונלי)' },
      city:         { type: SchemaType.STRING, description: 'שם העיר (אופציונלי)' },
    },
    required: [],
  },
};

export const weBotFunctionDeclarations: FunctionDeclaration[] = [
  scheduleMeetingDeclaration,
  updateLeadRequirementsDeclaration,
  createCatalogDeclaration,
  notifyAssignedAgentDeclaration,
  checkAvailabilityDeclaration,
  searchPropertyByLocationDeclaration,
];
