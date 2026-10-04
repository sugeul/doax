import { parseArgs } from "node:util";
import { type CliConfig, loadCliConfig } from "@doax/config";
import { formatResourceRef, parseResourceRef } from "@doax/protocol";

export const VERSION = "0.1.0";

const USAGE = `doax ${VERSION} — Executor CLI for the doax registry

Usage:
    doax status                            Show the registry this CLI talks to and whether it answers
    doax ref <@namespace/name[@version]>   Parse and print a resource reference
    doax --version
    doax --help

Environment:
    DOAX_REGISTRY   Registry origin (default: https://doax.io). Point it at a private install.
`;

export interface CliResult {
    exitCode: number;
    stdout?: string;
    stderr?: string;
}

export interface CliDeps {
    config: CliConfig;
    fetch: typeof fetch;
}

const defaultDeps = (): CliDeps => ({ config: loadCliConfig(process.env), fetch: globalThis.fetch });

/** Runs the CLI against argv (without the node and script entries) and returns what to print. */
export async function run(argv: string[], deps: CliDeps = defaultDeps()): Promise<CliResult> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "v" },
        },
        allowPositionals: true,
        strict: false,
    });

    if (values.version) return { exitCode: 0, stdout: VERSION };
    if (values.help || positionals.length === 0) return { exitCode: 0, stdout: USAGE };

    const [command, ...rest] = positionals;
    switch (command) {
        case "ref":
            return ref(rest[0]);
        case "status":
            return status(deps);
        default:
            return { exitCode: 2, stderr: `doax: unknown command "${command}"\n` + USAGE };
    }
}

function ref(input: string | undefined): CliResult {
    if (!input) return { exitCode: 2, stderr: "doax ref: missing resource reference\n" + USAGE };
    try {
        const parsed = parseResourceRef(input);
        return { exitCode: 0, stdout: JSON.stringify({ ...parsed, canonical: formatResourceRef(parsed) }, null, 2) };
    } catch (err) {
        return { exitCode: 1, stderr: (err as Error).message };
    }
}

async function status({ config, fetch }: CliDeps): Promise<CliResult> {
    try {
        const res = await fetch(`${config.registry}/`);
        const body = (await res.json()) as Record<string, unknown>;
        return {
            exitCode: res.ok ? 0 : 1,
            stdout: JSON.stringify({ registry: config.registry, reachable: res.ok, ...body }, null, 2),
        };
    } catch (err) {
        return { exitCode: 1, stderr: `doax status: ${config.registry} is unreachable (${(err as Error).message})` };
    }
}
