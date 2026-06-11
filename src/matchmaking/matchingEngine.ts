import { isCityMatch } from './stringUtils';
import { getDealCategory, dealCategoryMatches, DealFilter } from './dealCategory';

const PRICE_MARGIN = 1.07;
const ROOMS_TOLERANCE = 0.5;

export interface MatchingRequirements {
    desiredCity?: string[];
    desiredNeighborhoods?: string[];
    desiredStreet?: string[];
    maxBudget?: number | null;
    minRooms?: number | null;
    maxRooms?: number | null;
    /** Deal category the lead is after (sale / rent / commercial). */
    transactionType?: DealFilter | string;
    /** Building kinds the lead wants (e.g. דירה, פנטהאוז). */
    propertyType?: string[];
    mustHaveElevator?: boolean;
    mustHaveParking?: boolean;
    mustHaveBalcony?: boolean;
    mustHaveSafeRoom?: boolean;
    weights?: {
        budget: number;
        rooms: number;
        location: number;
        amenities: number;
    };
}

export interface MatchingProperty {
    id: string;
    city?: string;
    neighborhood?: string | null;
    street?: string | null;
    price: number;
    rooms?: number | null;
    transactionType: 'forsale' | 'rent' | 'sale'; // 'sale' kept for legacy global-city docs
    propertyType?: string | null; // Hebrew building kind — drives commercial classification
    hasElevator?: boolean | null;
    hasParking?: boolean | null;
    hasBalcony?: boolean | null;
    hasMamad?: boolean | null;   // was: hasSafeRoom
}

export interface MatchResult {
    matchScore: number;
    category: 'high' | 'medium';
    isNeighborhoodMatch: boolean;
    isStreetMatch: boolean;
    requiresVerification: string[];
}

/**
 * Shared scoring logic for both Property-to-Lead and Lead-to-Property matching.
 */
export function evaluateMatch(property: MatchingProperty, requirements: MatchingRequirements): MatchResult | null {
    const req = requirements;
    const weights = req.weights ?? { budget: 5, rooms: 5, location: 5, amenities: 5 };
    
    const requiresVerification: string[] = [];
    let weightedPoints = 0;
    let totalPossibleWeight = 0;
    
    // ── 1. Deal type — sale / rent / commercial (STRICT) ──────────────────────
    const propCategory = getDealCategory({
        propertyType: property.propertyType ?? null,
        transactionType: property.transactionType,
    });

    // Preferred path: lead specifies an explicit deal category. A 'commercial'
    // intent matches both commercial sub-types (sale + rent).
    const wantedCategory = (req.transactionType || '').toString().toLowerCase();
    if (wantedCategory === 'sale' || wantedCategory === 'rent' || wantedCategory === 'commercial') {
        if (!dealCategoryMatches(propCategory, wantedCategory)) return null;
    } else {
        // Legacy fallback: older leads stored sale/rent intent in `propertyType`.
        const wantedTypes = req.propertyType ?? [];
        const dealTypeEntries = wantedTypes.filter(t => {
            const tl = (t || '').toString().toLowerCase();
            return tl === 'sale' || tl === 'forsale' || tl === 'rent' ||
                tl.includes('מכיר') || tl.includes('קני') || tl.includes('שכיר') || tl.includes('שכר');
        });
        if (dealTypeEntries.length > 0) {
            const typeMatch = dealTypeEntries.some(t => {
                const tl = (t || '').toString().toLowerCase();
                if (tl === 'sale' || tl === 'forsale' || tl.includes('מכיר') || tl.includes('קני')) return dealCategoryMatches(propCategory, 'sale');
                if (tl === 'rent' || tl.includes('שכיר') || tl.includes('שכר')) return dealCategoryMatches(propCategory, 'rent');
                return false;
            });
            if (!typeMatch) return null;
        } else {
            // No deal intent expressed at all (legacy / imported lead). Default to
            // 'sale' so sale and rent listings aren't silently mixed together.
            if (!dealCategoryMatches(propCategory, 'sale')) return null;
        }
    }

    // ── 2. Location (City + Neighborhood + Street) ────────────────────────────
    const desiredCities = req.desiredCity || [];
    const desiredNeighborhoods = req.desiredNeighborhoods || [];
    const desiredStreets = req.desiredStreet || [];
    const hasLocationConstraint = desiredCities.length > 0 || desiredNeighborhoods.length > 0 || desiredStreets.length > 0;

    if (!isCityMatch(desiredCities, property.city || '')) {
        return null;
    }

    let neighborhoodScore = 1.0;
    let isNeighborhoodMatch = false;
    let isStreetMatch = false;

    if (desiredNeighborhoods.length > 0) {
        if (property.neighborhood) {
            const propNeighborhood = property.neighborhood.toLowerCase().trim();
            const found = desiredNeighborhoods.some(q => {
                const qLower = (q || '').toLowerCase().trim();
                if (!qLower) return false;
                return qLower.includes(propNeighborhood) || propNeighborhood.includes(qLower);
            });
            if (found) {
                neighborhoodScore = 1.0;
                isNeighborhoodMatch = true;
            } else {
                neighborhoodScore = 0.5;
                isNeighborhoodMatch = false;
            }
        } else {
            // Property has no neighborhood data — can't confirm, partial credit + verification
            neighborhoodScore = 0.6;
            isNeighborhoodMatch = false;
            requiresVerification.push('neighborhood');
        }

        // Neighborhood-only filters (no desiredCity) must hard-match to avoid
        // matching "רמת אביב" in Haifa when the lead asked for it in Tel Aviv.
        if (desiredCities.length === 0 && !isNeighborhoodMatch) {
            return null;
        }
    } else {
        isNeighborhoodMatch = true;
    }

    // Street sub-scoring: refines location within the neighborhood
    let streetScore = 1.0;
    if (desiredStreets.length > 0) {
        if (property.street) {
            const propStreet = property.street.toLowerCase().trim();
            const found = desiredStreets.some(q => {
                const qLower = (q || '').toLowerCase().trim();
                if (!qLower) return false;
                return qLower.includes(propStreet) || propStreet.includes(qLower);
            });
            if (found) {
                streetScore = 1.0;
                isStreetMatch = true;
            } else {
                streetScore = 0.5;
            }
        } else {
            streetScore = 0.6;
            requiresVerification.push('street');
        }
    } else {
        isStreetMatch = true;
    }

    // Combine neighborhood + street into a single location score
    const locationScore = desiredStreets.length > 0
        ? neighborhoodScore * 0.6 + streetScore * 0.4
        : neighborhoodScore;

    if (hasLocationConstraint) {
        const locationWeight = weights.location || 1;
        totalPossibleWeight += locationWeight;
        weightedPoints += locationScore * locationWeight;
    }

    // ── 3. Price ──────────────────────────────────────────────────────────────
    if (req.maxBudget != null && req.maxBudget > 0) {
        const budgetWeight = weights.budget || 1;
        totalPossibleWeight += budgetWeight;
        
        const effectiveBudget = req.maxBudget * PRICE_MARGIN;
        if (property.price > effectiveBudget) return null;

        let priceScore = 0;
        if (property.price <= req.maxBudget) {
            priceScore = 1.0;
        } else {
            const zoneProgress = (property.price - req.maxBudget) / (req.maxBudget * 0.07);
            priceScore = Math.max(0, 1.0 - zoneProgress);
        }
        weightedPoints += priceScore * budgetWeight;
    }

    // ── 4. Rooms ──────────────────────────────────────────────────────────────
    const desiredMin = req.minRooms != null ? req.minRooms : null;
    const desiredMax = req.maxRooms != null ? req.maxRooms : null;
    if (desiredMin != null || desiredMax != null) {
        const roomsWeight = weights.rooms || 1;
        totalPossibleWeight += roomsWeight;

        if (property.rooms == null) {
            // Unknown room count — flag for verification instead of silently passing
            requiresVerification.push('rooms');
            weightedPoints += 0.5 * roomsWeight;
        } else {
            const roomsOk =
                (desiredMin == null || property.rooms >= desiredMin - ROOMS_TOLERANCE) &&
                (desiredMax == null || property.rooms <= desiredMax + ROOMS_TOLERANCE);
            if (!roomsOk) return null;

            const strictOk =
                (desiredMin == null || property.rooms >= desiredMin) &&
                (desiredMax == null || property.rooms <= desiredMax);

            const roomsScore = strictOk ? 1.0 : 0.5;
            weightedPoints += roomsScore * roomsWeight;
        }
    }

    // ── 5. Amenities ──────────────────────────────────────────────────────────
    const amenityChecks = [
        { reqField: 'mustHaveElevator', propField: 'hasElevator', label: 'hasElevator' },
        { reqField: 'mustHaveParking', propField: 'hasParking', label: 'hasParking' },
        { reqField: 'mustHaveBalcony', propField: 'hasBalcony', label: 'hasBalcony' },
        { reqField: 'mustHaveSafeRoom', propField: 'hasMamad', label: 'hasMamad' },
    ] as const;

    const requiredAmenities = amenityChecks.filter(a => (req as any)[a.reqField] === true);
    if (requiredAmenities.length > 0) {
        const amenityWeight = weights.amenities || 1;
        totalPossibleWeight += amenityWeight;
        
        let amenityScoreSum = 0;
        for (const { reqField, propField, label } of requiredAmenities) {
            const propValue = (property as any)[propField];
            if (propValue === false) {
                return null;
            } else if (propValue === true) {
                amenityScoreSum += 1.0;
            } else {
                requiresVerification.push(label);
                amenityScoreSum += 0.5;
            }
        }
        const avgAmenityScore = amenityScoreSum / requiredAmenities.length;
        weightedPoints += avgAmenityScore * amenityWeight;
    }

    // No scorable criteria at all → not a real match, don't surface to agents
    if (totalPossibleWeight === 0) return null;

    const matchScore = Math.min(100, Math.round((weightedPoints / totalPossibleWeight) * 100));

    if (matchScore < 50) return null;
    const category = matchScore >= 80 ? 'high' : 'medium';

    return {
        matchScore,
        category,
        isNeighborhoodMatch,
        isStreetMatch,
        requiresVerification
    };
}
