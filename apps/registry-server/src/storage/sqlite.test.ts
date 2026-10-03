import { describe, expect, it } from "vitest";
import { IN_MEMORY, RegistryDatabase } from "./sqlite.ts";

describe("RegistryDatabase", () => {
    it("refuses to update or delete audit events", () => {
        const { db } = new RegistryDatabase(IN_MEMORY);
        db.prepare(
            "INSERT INTO audit_events (event_id, timestamp, class, actor, resource, body) VALUES (?, ?, ?, ?, ?, ?)",
        ).run("e1", "2026-10-03T00:00:00Z", "resolve", "alice", "@corp/orders@1.0.0", "{}");

        expect(() => db.prepare("UPDATE audit_events SET actor = 'mallory' WHERE event_id = 'e1'").run()).toThrow(
            /append-only/,
        );
        expect(() => db.prepare("DELETE FROM audit_events WHERE event_id = 'e1'").run()).toThrow(/append-only/);
        expect(db.prepare("SELECT actor FROM audit_events WHERE event_id = 'e1'").get()).toEqual({ actor: "alice" });
    });

    it("is idempotent to open twice", () => {
        const first = new RegistryDatabase(IN_MEMORY);
        first.close();
        expect(() => new RegistryDatabase(IN_MEMORY)).not.toThrow();
    });
});
