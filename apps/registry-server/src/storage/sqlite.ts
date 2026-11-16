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

            -- Namespace permissions (spec §4.1, §8.2a, §10). A namespace is owned by one account
            -- and carries members with a role; authority over it is Registry-side state, never in the
            -- token (§7.2, §7.5). Phase 1 identifies the caller by a Bearer PAT; §7.2 OIDC tokens swap in later.
            CREATE TABLE IF NOT EXISTS principals (
                principal_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS access_tokens (
                token_hash   TEXT PRIMARY KEY,
                principal_id TEXT NOT NULL REFERENCES principals(principal_id),
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at   TEXT
            );
            CREATE INDEX IF NOT EXISTS access_tokens_by_principal ON access_tokens (principal_id);
            CREATE TABLE IF NOT EXISTS namespaces (
                name       TEXT PRIMARY KEY,
                owner      TEXT NOT NULL REFERENCES principals(principal_id),
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS namespace_members (
                namespace    TEXT NOT NULL REFERENCES namespaces(name),
                principal_id TEXT NOT NULL REFERENCES principals(principal_id),
                role         TEXT NOT NULL CHECK (role IN ('owner', 'publisher', 'reader')),
                PRIMARY KEY (namespace, principal_id)
            );

            -- @global: the shared namespace every authenticated principal may publish into;
            -- it can never be claimed or member-managed (see SHARED_NAMESPACES in auth.ts).
            INSERT OR IGNORE INTO principals (principal_id, display_name) VALUES ('operator', 'registry operator');
            INSERT OR IGNORE INTO namespaces (name, owner) VALUES ('@global', 'operator');
        `);
    }

    close(): void {
        this.db.close();
    }
}
