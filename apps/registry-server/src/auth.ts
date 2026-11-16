import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
  * Authority over a namespace is Registry-side state (spec §7.2, §7.5): the token says only which
  * namespaces a Principal may touch, never the role they hold there. These helpers answer the role
  * question against the namespace tables. Phase 1 identifies the caller by a Bearer PAT; §7.2
  * OIDC tokens swap in later behind the same `principalFrom`.
  */

/** @global is open to every authenticated principal; it can never be claimed or member-managed. */
export const SHARED_NAMESPACES = new Set(["@global"]);

/** `@name`, the on-the-wire namespace spelling (spec §4.1). */
export const NAMESPACE_NAME = /^@[a-z0-9][a-z0-9._-]*$/;
export const PRINCIPAL_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** Roles a member may hold in a namespace (spec §8.2a). */
export const ROLES = ["owner", "publisher", "reader"] as const;
export type Role = (typeof ROLES)[number];

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Resolve the Bearer principal from the Authorization header, or null for an anonymous caller. */
export function principalFrom(db: DatabaseSync, authorization: string | undefined): string | null {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!match) return null;
    const row = db
        .prepare("SELECT principal_id FROM access_tokens WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > datetime('now'))")
        .get(hashToken(match[1]!)) as { principal_id: string } | undefined;
    return row?.principal_id ?? null;
}

/** True when the principal holds one of `roles` in the namespace. */
export function hasRole(db: DatabaseSync, principal: string, namespace: string, roles: Role[]): boolean {
    const placeholders = roles.map(() => "?").join(", ");
    const row = db
        .prepare(`SELECT 1 FROM namespace_members WHERE namespace = ? AND principal_id = ? AND role IN (${placeholders})`)
        .get(namespace, principal, ...roles);
    return row !== undefined;
}

/** Mint a PAT for a principal (creating the principal if new) and return the plaintext token once. */
export function issueToken(db: DatabaseSync, principalId: string): string {
    db.prepare("INSERT OR IGNORE INTO principals (principal_id) VALUES (?)").run(principalId);
    const token = randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO access_tokens (token_hash, principal_id) VALUES (?, ?)").run(hashToken(token), principalId);
    return token;
}

/** The operator presents a configured admin token out of band to bootstrap and override. */
export const isAdmin = (adminToken: string | null, header: string | undefined): boolean =>
    Boolean(adminToken) && header === adminToken;
