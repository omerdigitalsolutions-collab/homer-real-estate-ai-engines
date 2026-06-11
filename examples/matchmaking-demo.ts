/**
 * Runnable demo of the weighted matchmaking engine.
 *
 *   npx ts-node examples/matchmaking-demo.ts
 *
 * A buyer lead with requirements is scored against a small pool of
 * properties. Notice the linear budget degradation (7% margin), the
 * ±0.5 rooms tolerance, and the `requiresVerification` flags raised
 * when the property is missing data the lead cares about.
 */
import { evaluateMatch, MatchingProperty, MatchingRequirements } from '../src/matchmaking';

const lead: MatchingRequirements = {
    transactionType: 'sale',
    desiredCity: ['תל אביב'],
    desiredNeighborhoods: ['פלורנטין'],
    maxBudget: 3_000_000,
    minRooms: 3,
    maxRooms: 4,
    mustHaveElevator: true,
    weights: { budget: 5, rooms: 5, location: 5, amenities: 5 },
};

const pool: MatchingProperty[] = [
    {
        id: 'P-1 perfect fit',
        city: 'תל אביב',
        neighborhood: 'פלורנטין',
        price: 2_850_000,
        rooms: 3.5,
        transactionType: 'forsale',
        hasElevator: true,
    },
    {
        id: 'P-2 over budget (within 7% margin)',
        city: 'תל-אביב', // hyphen variant — city normalization handles it
        neighborhood: 'פלורנטין',
        price: 3_150_000,
        rooms: 4,
        transactionType: 'forsale',
        hasElevator: true,
    },
    {
        id: 'P-3 missing data → requiresVerification',
        city: 'תל אביב',
        neighborhood: null,
        price: 2_500_000,
        rooms: null,
        transactionType: 'forsale',
        hasElevator: null,
    },
    {
        id: 'P-4 wrong deal type (rent)',
        city: 'תל אביב',
        neighborhood: 'פלורנטין',
        price: 8_000,
        rooms: 3,
        transactionType: 'rent',
        hasElevator: true,
    },
    {
        id: 'P-5 hard fail: no elevator',
        city: 'תל אביב',
        neighborhood: 'פלורנטין',
        price: 2_700_000,
        rooms: 3,
        transactionType: 'forsale',
        hasElevator: false,
    },
];

console.log('Lead requirements:', JSON.stringify(lead, null, 2), '\n');

for (const property of pool) {
    const result = evaluateMatch(property, lead);
    if (!result) {
        console.log(`✗ ${property.id} — rejected (strict gate or score < 50)`);
        continue;
    }
    const flags = result.requiresVerification.length
        ? `  ⚠ verify: ${result.requiresVerification.join(', ')}`
        : '';
    console.log(`✓ ${property.id} — score ${result.matchScore} (${result.category})${flags}`);
}
