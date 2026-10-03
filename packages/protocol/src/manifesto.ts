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
    specification: string;
    gettingStarted: string;
    [extra: string]: unknown;
}

export const SYSTEM_DESCRIPTION =
    "doax is a registry of data and action resources that AI agents use on behalf of a human, " +
    "with every access audited and every resource declaring the authentication tier it demands.";

export const SPECIFICATION_URL = "https://doax.ai/spec";

/** Builds a manifesto for one component. Shared so every component describes the system the same way. */
export function buildManifesto(component: string, operator: string, extra: Record<string, unknown> = {}): Manifesto {
    return {
        system: SYSTEM_DESCRIPTION,
        component,
        operator,
        specification: SPECIFICATION_URL,
        gettingStarted: "https://doax.ai",
        ...extra,
    };
}
