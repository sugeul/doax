import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const IN_MEMORY = ":memory:";

/**
  * Embedded storage for the Registry Server. Zero external dependencies: `node:sqlite` ships with Node 24.
  * The audit log is append-only at the database level (spec §8.1): UPDATE and DELETE are refused by triggers,
  * so no code path in this process can edit or remove an event.
  */
export class RegistryDatabase {
    readonly db: DatabaseSync;

    constructor(path: string) {
        if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        this.migrate();
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS audit_events (
                event_id   TEXT PRIMARY KEY,
                timestamp  TEXT NOT NULL,
                class      TEXT NOT NULL,
                actor      TEXT NOT NULL,
                resource   TEXT NOT NULL,
                body       TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS audit_events_by_time ON audit_events (timestamp);
            CREATE INDEX IF NOT EXISTS audit_events_by_actor ON audit_events (actor, timestamp);
            CREATE INDEX IF NOT EXISTS audit_events_by_resource ON audit_events (resource, timestamp);

            CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update
                BEFORE UPDATE ON audit_events
                BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
            CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete
                BEFORE DELETE ON audit_events
                BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
        `);
    }

    close(): void {
        this.db.close();
    }
}
