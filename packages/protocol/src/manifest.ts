import type { ExecutionLocation, ResourceKind } from "./resource.ts";
import type { Tier } from "./tier.ts";

/** How one Fixed Interface operation is realized by the Package (spec §4.6). */
export type InterfaceBinding =
    | { kind: "native" }
    | { kind: "mcp-tool"; tool: string }
    | { kind: "mcp-resource"; uri: string };

/** Fixed Interface operations per kind (spec §4.6). */
export const FIXED_INTERFACE = {
    "data-source": ["describe", "metadata", "read"],
    action: ["describe", "dry-run", "execute"],
    executor: ["describe", "capabilities", "dispatch"],
    authenticator: ["describe", "authenticate"],
} as const satisfies Record<ResourceKind, readonly string[]>;

export type FixedOperation<K extends ResourceKind = ResourceKind> = (typeof FIXED_INTERFACE)[K][number];

export interface ExpectedFault {
    faultClass: string;
    trigger: string;
    callerVisibleEffect: string;
    expectedFrequency: string;
    recommendedCallerAction: string;
}

export interface ServiceLevelDeclaration {
    /** Mandatory; an empty array is a claim that no fault surfaces (spec §13.2). */
    expectedFaults: ExpectedFault[];
    degradationBehavior: string;
    dependencyLevels: Record<string, string>;
    measurement: string;
    supportCommitment: string;
    /** Kind-specific items (spec §13.1.2 – §13.1.3, §6A.7). */
    [item: string]: unknown;
}

/** Common Manifest fields (spec §4.3, Appendix A). Kind-specific fields are added as the spec is implemented. */
export interface ManifestBase<K extends ResourceKind = ResourceKind> {
    identity: string;
    kind: K;
    summary: string;
    description: string;
    owner: string;
    requiredTier: Tier;
    auditScope: string[];
    integrity: string;
    dependencies: string[];
    interfaceMapping: Record<FixedOperation<K>, InterfaceBinding>;
    serviceLevel: ServiceLevelDeclaration;
}

export interface DataSourceManifest extends ManifestBase<"data-source"> {
    executionLocation: ExecutionLocation;
    authenticator: string | "none";
}

export interface ActionManifest extends ManifestBase<"action"> {
    executionLocation: ExecutionLocation;
    authenticator: string | "none";
    dryRunMode: "none" | "predictive" | "native";
    idempotency: "idempotent" | "keyed" | "non-idempotent";
    recoveryAction: string | "none";
    approvalGate?: boolean;
}

export interface ExecutorManifest extends ManifestBase<"executor"> {
    authenticator: string;
}

export interface AuthenticatorManifest extends ManifestBase<"authenticator"> {
    executionLocation?: ExecutionLocation;
    subject: "personal" | "organization" | "machine";
    authentication: Record<string, unknown>;
}

export type Manifest = DataSourceManifest | ActionManifest | ExecutorManifest | AuthenticatorManifest;
