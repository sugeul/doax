/** Location of the static self-description every JSON response points to (spec §10A). */
export function manifestoUrl(domain: string): string {
    const origin = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
    return `${origin.replace(/\/+$/, "")}/manifesto.json`;
}

/** Adds the mandatory top-level `manifesto` field to a JSON response body. */
export function withManifesto<T extends object>(domain: string, body: T): T & { manifesto: string } {
    return { ...body, manifesto: manifestoUrl(domain) };
}

/** Content of `manifesto.json` (spec §10A). Static; never varies by request. */
export interface Manifesto {
    system: string;
    component: string;
    operator: string;
    /** Where the specification is published. */
    specification: string;
    /** The version of the specification this component implements (spec §10A). */
    specificationVersion: string;
    gettingStarted: string;
    /**
      * Extensions to the specification this deployment applies, and where they are documented
      * (spec §10A). Absent when the deployment applies none.
      */
    extensions?: string;
    /**
      * How to sign in to *this* Registry and route a namespace to it (spec §10A): a private
      * Registry is reached under its own origin, so `gettingStarted` alone (the public site)
      * does not tell a newcomer how to sign in here.
      */
    signIn?: string;
    [extra: string]: unknown;
}

export const SYSTEM_DESCRIPTION =
    "doax is a registry of data and action resources that AI agents and other Ephemeral Delegated Actors use on behalf of a human, " +
    "with every access audited and every resource declaring the authentication tier it demands.";

export const SPECIFICATION_URL = "https://doax.io/spec";
export const SPECIFICATION_VERSION = "0.1";

/** Builds a manifesto for one component. Shared so every component describes the system the same way. */
export function buildManifesto(component: string, operator: string, extra: Record<string, unknown> = {}): Manifesto {
    return {
        system: SYSTEM_DESCRIPTION,
        component,
        operator,
        specification: SPECIFICATION_URL,
        specificationVersion: SPECIFICATION_VERSION,
        gettingStarted: "https://doax.io",
        ...extra,
    };
}
