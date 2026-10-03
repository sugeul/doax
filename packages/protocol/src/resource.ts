/** Resource kinds (spec §4.2). */
export const RESOURCE_KINDS = ["data-source", "action", "executor", "authenticator"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** `@namespace/name@version` (spec §4.1). */
export interface ResourceIdentity {
    namespace: string;
    name: string;
    version: string;
}

/** `@namespace/name` with an optional version, as accepted by resolution. */
export interface ResourceRef {
    namespace: string;
    name: string;
    version?: string;
}

const SEGMENT = "[a-z0-9][a-z0-9._-]*";
const REF_PATTERN = new RegExp(`^@(${SEGMENT})/(${SEGMENT})(?:@([^@\\s/]+))?$`);

export function parseResourceRef(input: string): ResourceRef {
    const match = REF_PATTERN.exec(input);
    if (!match) throw new Error(`Invalid resource reference: ${input}`);
    const [, namespace, name, version] = match;
    return version === undefined ? { namespace: namespace!, name: name! } : { namespace: namespace!, name: name!, version };
}

export function parseResourceIdentity(input: string): ResourceIdentity {
    const ref = parseResourceRef(input);
    if (ref.version === undefined) throw new Error(`Resource identity requires a version: ${input}`);
    return { namespace: ref.namespace, name: ref.name, version: ref.version };
}

export function formatResourceRef(ref: ResourceRef): string {
    const base = `@${ref.namespace}/${ref.name}`;
    return ref.version === undefined ? base : `${base}@${ref.version}`;
}

export type ExecutionLocation = "caller-device" | "trusted-executor";

/** Visibility and verification are independent axes (spec §4.5). */
export type Visibility = "public" | "namespace-only" | "grant-list";
export type VerificationStatus = "unverified" | "under-review" | "verified" | "rejected";
export type LifecycleState = "active" | "deprecated" | "yanked";
