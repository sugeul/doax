import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveTier } from "@doax/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, confirmInvocation, type ExecutorDeps, type ResolvedResource, requestHash } from "./executor.ts";

const tier = (n: 1 | 2 | 3 | 4): EffectiveTier => ({ tier: n, strengthenedBy: [] });

/* A stand-in Authenticator service: `confirm` answers pending, then issues a confirmation only to the verifier
   whose challenge started the exchange — the decision and the binding live here, not in the Executor. */
const AUTHENTICATOR = `
import { createHash } from "node:crypto";
const state = (globalThis.__confirm ??= { calls: [], decision: "approve" });
export async function confirm(input) {
    state.calls.push(input);
    if (!input.handle) {
        state.challenge = input.challenge;
        state.descriptor = input.descriptor;
        return { pending: true, entryPoint: "https://auth.test/confirm", handle: "H1", interval: 1, expiresIn: 30 };
    }
    if (createHash("sha256").update(input.verifier).digest("base64url") !== state.challenge) return { declined: true };
    if (JSON.stringify(input.descriptor) !== JSON.stringify(state.descriptor)) return { declined: true };
    if (state.decision !== "approve") return { declined: true };
    return {
        confirmation: "signed:" + input.descriptor.requestHash,
        id: "c-1",
        authorization: input.tier === 2 ? { token: "az-1", exp: new Date(Date.now() + 3600e3).toISOString() } : undefined,
    };
}`;

const svc = () => (globalThis as unknown as { __confirm: { calls: Record<string, unknown>[]; decision: string } }).__confirm;

const authenticator = (mapsConfirm = true): ResolvedResource =>
    ({
        identity: "@corp/login@1.0.0",
        kind: "authenticator",
        manifest: { interfaceMapping: { describe: { kind: "native" }, authenticate: { kind: "native" }, ...(mapsConfirm && { confirm: { kind: "native" } }) } },
        digest: `sha256-${createHash("sha256").update(AUTHENTICATOR).digest("hex")}`,
        package: "/packages/login.mjs",
        origin: "https://r.test",
    }) as unknown as ResolvedResource;

const resource = (identity: string) => ({ identity }) as unknown as ResolvedResource;

describe("confirmInvocation — the Authenticator service confirms; the Executor relays (§4.7, §7.8)", () => {
    let home: string;
    const deps = (prompt?: ExecutorDeps["prompt"]): ExecutorDeps => ({
        config: { registry: "https://r.test" },
        fetch: (async () => new Response(AUTHENTICATOR)) as typeof fetch,
        home,
        prompt,
    });

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "doax-confirm-"));
        (globalThis as Record<string, unknown>).__confirm = { calls: [], decision: "approve" };
    });
    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    it("needs no confirmation at Tier 3", async () => {
        await expect(confirmInvocation(deps(), resource("@corp/weather@1.0.0"), tier(3), null, "read", {})).resolves.toEqual({});
    });

    it("refuses Tier 1/2 when the Authenticator does not implement confirm", async () => {
        await expect(confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(false), "execute", {})).rejects.toMatchObject({
            faultClass: "confirm-unsupported",
        });
        await expect(confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(2), null, "execute", {})).rejects.toMatchObject({
            faultClass: "confirm-unsupported",
        });
    });

    it("hands a non-interactive caller the pending exchange, and collects the confirmation when it comes back", async () => {
        const input = { amount: 10, to: "x" };
        const pending = await confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", input).catch((e) => e);
        expect(pending).toMatchObject({ faultClass: "confirmation-pending" });
        const { handle, verifier, entryPoint } = pending.detail as { handle: string; verifier: string; entryPoint: string };
        expect(entryPoint).toBe("https://auth.test/confirm");
        expect(svc().calls[0]!.descriptor).toEqual({ resource: "@corp/wire", operation: "execute", requestHash: requestHash("@corp/wire", "execute", input) });

        const done = await confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", input, { handle, verifier });
        expect(done.confirmation).toBe(`signed:${requestHash("@corp/wire", "execute", input)}`);
    });

    it("a party holding only the handle cannot collect: the service checks the verifier", async () => {
        const pending = await confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", {}).catch((e) => e);
        const { handle } = pending.detail as { handle: string };
        await expect(
            confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", {}, { handle, verifier: "guessed" }),
        ).rejects.toMatchObject({ faultClass: "authorization-declined" });
    });

    it("a confirmation is bound to its request: different params are refused", async () => {
        const pending = await confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", { amount: 10 }).catch((e) => e);
        const { handle, verifier } = pending.detail as { handle: string; verifier: string };
        await expect(
            confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", { amount: 9999 }, { handle, verifier }),
        ).rejects.toMatchObject({ faultClass: "authorization-declined" });
    });

    it("a refusal at the service is a declined invocation", async () => {
        svc().decision = "reject";
        const pending = await confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", {}).catch((e) => e);
        const { handle, verifier } = pending.detail as { handle: string; verifier: string };
        await expect(confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", {}, { handle, verifier })).rejects.toMatchObject({
            faultClass: "authorization-declined",
        });
    });

    it("an interactive terminal waits on the entry point and continues once confirmed", async () => {
        const done = await confirmInvocation(deps(async () => ""), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", {});
        expect(done.confirmation).toBeDefined();
    });

    it("Tier 2 holds the service's authorization token for its lifetime, scoped to one resource", async () => {
        const interactive = deps(async () => "");
        const first = await confirmInvocation(interactive, resource("@corp/orders@1.2.0"), tier(2), authenticator(), "execute", {});
        expect(first.authorization).toBe("az-1");
        const calls = svc().calls.length;
        // Same resource, any version: the held token is presented, no new confirm.
        await expect(confirmInvocation(deps(), resource("@corp/orders@1.3.0"), tier(2), authenticator(), "execute", {})).resolves.toEqual({ authorization: "az-1" });
        expect(svc().calls.length).toBe(calls);
        // Another resource needs its own confirmation.
        await expect(confirmInvocation(deps(), resource("@corp/payments@1.0.0"), tier(2), authenticator(), "execute", {})).rejects.toMatchObject({
            faultClass: "confirmation-pending",
        });
    });

    it("Tier 1 never reuses a confirmation", async () => {
        await confirmInvocation(deps(async () => ""), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", {});
        await expect(confirmInvocation(deps(), resource("@corp/wire@1.0.0"), tier(1), authenticator(), "execute", {})).rejects.toMatchObject({
            faultClass: "confirmation-pending",
        });
    });
});

describe("canonicalJson (§6.4)", () => {
    it("sorts keys recursively and drops absent values", () => {
        expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
    });
});
