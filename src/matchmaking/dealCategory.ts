/**
 * Shared deal-category classification used by the matchmaking engine.
 */

export const COMMERCIAL_PROPERTY_TYPES = ['מסחרי', 'משרד', 'חנות', 'תעשייה', 'קליניקה', 'מחסן'] as const;

/**
 * Fine-grained deal category. Commercial is split by the underlying transaction
 * so a commercial property for rent vs for sale are distinct.
 */
export type DealCategory = 'sale' | 'rent' | 'commercial_sale' | 'commercial_rent';

/** Coarse filter used by lead requirements (sale / rent / any commercial). */
export type DealFilter = 'sale' | 'rent' | 'commercial';

/**
 * Whether a property's building kind is commercial. Recognises the Hebrew kinds
 * plus the literal 'commercial' tag written by the Facebook/website scrapers.
 */
export function isCommercialPropertyType(propertyType?: string | null): boolean {
    const pt = (propertyType ?? '').toString().trim();
    if (pt.toLowerCase() === 'commercial') return true;
    return COMMERCIAL_PROPERTY_TYPES.includes(pt as typeof COMMERCIAL_PROPERTY_TYPES[number]);
}

/**
 * Single source of truth for classifying a property's deal category.
 * Commercial is derived from `propertyType`; the rent/sale axis comes from
 * `transactionType` and is preserved for commercial properties too. Legacy docs
 * may store transactionType as 'sale' / 'buy' — those are treated as sale.
 */
export function getDealCategory(p: { propertyType?: string | null; transactionType?: string | null }): DealCategory {
    const isRent = p.transactionType === 'rent';
    if (isCommercialPropertyType(p.propertyType)) {
        return isRent ? 'commercial_rent' : 'commercial_sale';
    }
    return isRent ? 'rent' : 'sale';
}

/** True when a fine-grained category is any commercial sub-type. */
export function isCommercialCategory(c: DealCategory): boolean {
    return c === 'commercial_sale' || c === 'commercial_rent';
}

/**
 * Whether a property's fine-grained category satisfies a coarse deal filter.
 * A `commercial` filter matches both commercial sub-types; `sale`/`rent` match
 * only their residential counterparts (commercial is its own bucket).
 */
export function dealCategoryMatches(category: DealCategory, filter: string): boolean {
    if (filter === 'commercial') return isCommercialCategory(category);
    return category === filter;
}
