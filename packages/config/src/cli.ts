export interface CliConfig {
    /** Origin of the registry the CLI talks to. A private install points this at its own server. */
    registry: string;
}

export const PUBLIC_REGISTRY = "https://doax.ai";

export function loadCliConfig(env: Record<string, string | undefined> = {}): CliConfig {
    return { registry: (env.DOAX_REGISTRY ?? PUBLIC_REGISTRY).replace(/\/+$/, "") };
}
