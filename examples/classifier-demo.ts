/**
 * Runnable demo of the Hebrew post classifier + heuristic extractors.
 * No API key needed — this layer is pure TypeScript:
 *
 *   npx ts-node examples/classifier-demo.ts
 */
import {
    classifyPostIntent, classifyListingType,
    extractPhone, extractRooms, extractBudget, extractPrice,
    extractTransactionType, extractFloor, extractCity,
} from '../src/lead-classifier/fbClassifier';

const posts = [
    'למכירה דירת 4 חדרים בשכונת פלורנטין, קומה 3 מתוך 5, 2.5 מיליון. ללא תיווך! 050-123-4567',
    'מחפשים דירה להשכרה ברמת גן, עד 7 אלף, 3 חדרים לפחות. 052 987 6543',
    'מחפש קונה רציני לדופלקס מהמם בהרצליה, בבלעדיות',
    'מישהו מכיר אינסטלטור טוב באזור חולון?',
    'דירה למכירה בתל אביב, מתאים למחפשי שקט', // incidental "מחפשי" — must stay SELLER
];

for (const text of posts) {
    const intent = classifyPostIntent(text);
    console.log(`\n"${text.slice(0, 60)}..."`);
    console.log(`  intent: ${intent}`);
    if (intent === 'SELLER') {
        console.log(`  listingType: ${classifyListingType(text)}  price: ${extractPrice(text)}  tx: ${extractTransactionType(text)}`);
        console.log(`  rooms: ${extractRooms(text)}  floor: ${JSON.stringify(extractFloor(text))}  city: ${extractCity(text)}  phone: ${extractPhone(text)}`);
    }
    if (intent === 'BUYER') {
        console.log(`  budget: ${extractBudget(text)}  rooms: ${extractRooms(text)}  city: ${extractCity(text)}  phone: ${extractPhone(text)}`);
    }
}
