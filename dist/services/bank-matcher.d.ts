export interface MatchCandidate {
    account: string;
    primary_name: string;
    payee_name?: string | null;
    /** Customer/supplier search keys (sn_key1..4 / pn_key1..4). */
    search_keys?: string[];
    bank_account?: string | null;
    bank_sort?: string | null;
    /** sn_vendor — customer's reference for us. */
    vendor_ref?: string | null;
}
export interface MatchResult {
    account: string | null;
    name: string | null;
    score: number;
    /** 'primary' | 'payee' | 'vendor_ref' | 'key1' | 'key2' | ... | '' */
    source: string;
}
export declare const EMPTY_MATCH: MatchResult;
export declare function normaliseName(name: string): string;
export declare function calculateMatchScore(bankName: string, candidateName: string): number;
export declare class BankMatcher {
    private readonly minScore;
    readonly customers: Map<string, MatchCandidate>;
    readonly suppliers: Map<string, MatchCandidate>;
    constructor(minScore?: number);
    loadCustomers(customers: MatchCandidate[]): void;
    loadSuppliers(suppliers: MatchCandidate[]): void;
    matchCustomer(name: string): MatchResult & {
        is_match: boolean;
    };
    matchSupplier(name: string): MatchResult & {
        is_match: boolean;
    };
}
/**
 * Load the customer set from Opera (sname) into MatchCandidate shape.
 * Excludes dormant + stopped accounts per CLAUDE.md rule.
 */
export declare function loadCustomerCandidates(operaDb: import('knex').Knex): Promise<MatchCandidate[]>;
/**
 * Load the supplier set from Opera (pname) into MatchCandidate shape.
 * Excludes dormant + stopped accounts per CLAUDE.md rule.
 */
export declare function loadSupplierCandidates(operaDb: import('knex').Knex): Promise<MatchCandidate[]>;
//# sourceMappingURL=bank-matcher.d.ts.map