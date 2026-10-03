/**
  * Authentication tiers (spec §7.3). Lower number is stronger:
  * 1 interactive, 2 long-lived + per-call check, 3 long-lived, 4 unauthenticated.
  */
export type Tier = 1 | 2 | 3 | 4;

/** Where a tier requirement came from, recorded in audit when it strengthens the result (spec §7.4). */
export type TierSource =
    | "namespace-floor"
    | "resource"
    | "dependency"
    | "step-up"
    | "authenticator"
    | "executor";

export interface TierRequirement {
    source: TierSource;
    tier: Tier;
    /** Free-text detail, e.g. the dependency identity or the step-up reason. */
    detail?: string;
}

export interface EffectiveTier {
    tier: Tier;
    /** Requirements stronger than the resource's own declared tier; empty when nothing strengthened it. */
    strengthenedBy: TierRequirement[];
}

export function strongerTier(a: Tier, b: Tier): Tier {
    return a < b ? a : b;
}

/**
  * Effective tier is the strongest of all requirements; nothing can weaken it (spec §7.4).
  * `declared` is the resource's own required tier; `others` are every other input.
  */
export function computeEffectiveTier(declared: Tier, others: readonly TierRequirement[]): EffectiveTier {
    let tier = declared;
    for (const req of others) tier = strongerTier(tier, req.tier);
    return {
        tier,
        strengthenedBy: others.filter((req) => req.tier < declared && req.tier === tier),
    };
}
