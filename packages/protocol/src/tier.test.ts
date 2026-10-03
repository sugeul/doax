import { describe, expect, it } from "vitest";
import { computeEffectiveTier } from "./tier.ts";

describe("computeEffectiveTier", () => {
    it("keeps the declared tier when nothing is stronger", () => {
        expect(computeEffectiveTier(2, [{ source: "namespace-floor", tier: 3 }])).toEqual({
            tier: 2,
            strengthenedBy: [],
        });
    });

    it("never weakens the declared tier", () => {
        expect(computeEffectiveTier(1, [{ source: "executor", tier: 4 }]).tier).toBe(1);
    });

    it("takes the strongest requirement and records why", () => {
        const stepUp = { source: "step-up", tier: 1, detail: "order above threshold" } as const;
        const result = computeEffectiveTier(3, [{ source: "executor", tier: 2 }, stepUp]);
        expect(result).toEqual({ tier: 1, strengthenedBy: [stepUp] });
    });
});
