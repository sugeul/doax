import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveTier } from "@doax/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmTier, type ExecutorDeps, type ResolvedResource } from "./executor.ts";

const tier = (n: 1 | 2 | 3 | 4): EffectiveTier => ({ tier: n, strengthenedBy: [] });

const resource = (identity: string, standingAuthWindowSeconds?: number): ResolvedResource =>
    ({ identity, standingAuthWindowSeconds } as unknown as ResolvedResource);

describe("confirmTier — Tier 2 standing-authorization window (§7.4a)", () => {
    let home: string;
    const base = (prompt?: ExecutorDeps["prompt"]): ExecutorDeps => ({ config: { registry: "https://r.test" }, fetch: (async () => new Response()) as typeof fetch, home, prompt });

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "doax-grant-"));
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    it("remembers a Tier 2 authorization for the namespace window, so the next call skips the re-check", async () => {
        const deps = base(); // no prompt: a non-interactive agent caller
        const res = resource("@corp/orders@1.2.0", 3600);
        // First call authorizes via --yes and records the grant.
        await expect(confirmTier(deps, res, tier(2), true, "execute @corp/orders")).resolves.toBeUndefined();
        // Second call, no --yes and no prompt, still proceeds because the grant is live.
        await expect(confirmTier(deps, res, tier(2), false, "execute @corp/orders")).resolves.toBeUndefined();
    });

    it("scopes the grant to one resource — a different resource still needs its own authorization", async () => {
        const deps = base();
        await confirmTier(deps, resource("@corp/orders@1.2.0", 3600), tier(2), true, "execute @corp/orders");
        await expect(confirmTier(deps, resource("@corp/payments@1.0.0", 3600), tier(2), false, "execute @corp/payments")).rejects.toMatchObject({
            faultClass: "authorization-required",
        });
    });

    it("ignores the version: a grant for one version covers the next", async () => {
        const deps = base();
        await confirmTier(deps, resource("@corp/orders@1.2.0", 3600), tier(2), true, "execute @corp/orders");
        await expect(confirmTier(deps, resource("@corp/orders@1.3.0", 3600), tier(2), false, "execute @corp/orders")).resolves.toBeUndefined();
    });

    it("with no window declared, every Tier 2 call is re-checked", async () => {
        const deps = base();
        await confirmTier(deps, resource("@corp/orders@1.2.0"), tier(2), true, "execute @corp/orders");
        await expect(confirmTier(deps, resource("@corp/orders@1.2.0"), tier(2), false, "execute @corp/orders")).rejects.toMatchObject({
            faultClass: "authorization-required",
        });
    });

    it("never lets a standing authorization stand for Tier 1 — it is always per-call", async () => {
        const deps = base();
        // Even with a window configured, a prior --yes must not carry over to the next Tier 1 call.
        await confirmTier(deps, resource("@corp/wire@1.0.0", 3600), tier(1), true, "execute @corp/wire");
        await expect(confirmTier(deps, resource("@corp/wire@1.0.0", 3600), tier(1), false, "execute @corp/wire")).rejects.toMatchObject({
            faultClass: "authorization-required",
        });
    });

    it("prompts when interactive, records the grant on yes, and refuses on decline", async () => {
        const yes = base(async () => "y");
        await expect(confirmTier(yes, resource("@corp/orders@1.2.0", 3600), tier(2), false, "execute @corp/orders")).resolves.toBeUndefined();
        // The yes created a grant, so a later non-interactive call proceeds.
        await expect(confirmTier(base(), resource("@corp/orders@1.2.0", 3600), tier(2), false, "execute @corp/orders")).resolves.toBeUndefined();

        const no = base(async () => "n");
        await expect(confirmTier(no, resource("@corp/refunds@1.0.0", 3600), tier(2), false, "execute @corp/refunds")).rejects.toMatchObject({
            faultClass: "authorization-declined",
        });
    });

    it("needs no check at all for Tier 3", async () => {
        await expect(confirmTier(base(), resource("@corp/weather@1.0.0"), tier(3), false, "read @corp/weather")).resolves.toBeUndefined();
    });
});
