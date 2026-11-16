import { beforeEach, describe, expect, it } from "vitest";
import { createRegistryApp } from "./app.ts";
import { IN_MEMORY } from "./storage/sqlite.ts";

const { app } = createRegistryApp({ domain: "doax.test", operator: "test", databasePath: IN_MEMORY, upstream: null, adminToken: null });

it("includes the manifesto field in every JSON response", async () => {
    for (const path of ["/", "/no-such-path"]) {
        const body = await (await app.request(path)).json();
        expect(body.manifesto).toBe("https://doax.test/manifesto.json");
    }
});

it("reports its storage backend and upstream", async () => {
    expect(await (await app.request("/")).json()).toMatchObject({ storage: "sqlite", upstream: null });
});

it("serves a static manifesto.json", async () => {
    const res = await app.request("/manifesto.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ component: expect.stringContaining("Registry Server") });
});

describe("namespace permissions", () => {
    const ADMIN = "admin-secret";
    let registry: ReturnType<typeof createRegistryApp>["app"];

    beforeEach(() => {
        registry = createRegistryApp({ domain: "doax.test", operator: "test", databasePath: IN_MEMORY, upstream: null, adminToken: ADMIN }).app;
    });

    const json = (body: unknown, token?: string) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });

    const mint = async (principalId: string): Promise<string> => {
        const res = await registry.request("/tokens", {
            method: "POST",
            headers: { "content-type": "application/json", "x-doax-admin-token": ADMIN },
            body: JSON.stringify({ principalId }),
        });
        expect(res.status).toBe(201);
        return (await res.json()).token as string;
    };

    it("only the operator may mint tokens", async () => {
        const res = await registry.request("/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ principalId: "alice" }) });
        expect(res.status).toBe(403);
    });

    it("claiming a namespace requires a token, and the claimant becomes owner", async () => {
        const anon = await registry.request("/namespaces", json({ name: "@acme" }));
        expect(anon.status).toBe(401);

        const alice = await mint("alice");
        const claim = await registry.request("/namespaces", json({ name: "@acme" }, alice));
        expect(claim.status).toBe(201);
        expect(await claim.json()).toMatchObject({ namespace: "@acme", owner: "alice" });

        const again = await registry.request("/namespaces", json({ name: "@acme" }, await mint("bob")));
        expect(again.status).toBe(409);
    });

    it("refuses to claim the shared @global namespace", async () => {
        const res = await registry.request("/namespaces", json({ name: "@global" }, await mint("alice")));
        expect(res.status).toBe(409);
    });

    it("the member list is hidden from non-members and shown to members", async () => {
        const alice = await mint("alice");
        await registry.request("/namespaces", json({ name: "@acme" }, alice));

        const anon = await (await registry.request("/namespaces/@acme")).json();
        expect(anon).toMatchObject({ namespace: "@acme", owner: "alice" });
        expect(anon.members).toBeUndefined();

        const owner = await (await registry.request("/namespaces/@acme", { headers: { authorization: `Bearer ${alice}` } })).json();
        expect(owner.members).toEqual([{ principal_id: "alice", role: "owner" }]);
    });

    it("only the owner may manage members", async () => {
        const alice = await mint("alice");
        await registry.request("/namespaces", json({ name: "@acme" }, alice));
        const bob = await mint("bob");

        const forbidden = await registry.request("/namespaces/@acme/members", { ...json({ principalId: "carol", role: "publisher" }, bob), method: "PUT" });
        expect(forbidden.status).toBe(403);

        const added = await registry.request("/namespaces/@acme/members", { ...json({ principalId: "carol", role: "publisher" }, alice), method: "PUT" });
        expect(added.status).toBe(200);

        const members = (await (await registry.request("/namespaces/@acme", { headers: { authorization: `Bearer ${alice}` } })).json()).members;
        expect(members).toContainEqual({ principal_id: "carol", role: "publisher" });

        const removed = await registry.request("/namespaces/@acme/members", { ...json({ principalId: "carol", role: "none" }, alice), method: "PUT" });
        expect(removed.status).toBe(200);
        const after = (await (await registry.request("/namespaces/@acme", { headers: { authorization: `Bearer ${alice}` } })).json()).members;
        expect(after).toEqual([{ principal_id: "alice", role: "owner" }]);
    });

    it("the operator can manage members without a namespace role", async () => {
        await registry.request("/namespaces", json({ name: "@acme" }, await mint("alice")));
        const res = await registry.request("/namespaces/@acme/members", {
            method: "PUT",
            headers: { "content-type": "application/json", "x-doax-admin-token": ADMIN },
            body: JSON.stringify({ principalId: "dave", role: "reader" }),
        });
        expect(res.status).toBe(200);
    });
});
