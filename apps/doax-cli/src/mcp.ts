import { createInterface } from "node:readline";
import { formatResourceRef, parseResourceRef } from "@doax/protocol";
import { type CliDeps, type CliResult, run, VERSION } from "./cli.ts";

/**
  * The agent bridge (architecture §3): doax speaks MCP over stdio, but only as a thin front-end
  * to the CLI's `run()`. Every tool and resource delegates to `run([...,"--json","--no-input"])`,
  * so tier, authentication, integrity and audit stay in the one executor core (architecture §2):
  * the MCP never re-implements them, and never weakens a tier.
  *
  * Two shapes, one binary:
  *   doax mcp                    the gateway — search + describe + read, all keyed by resource ref
  *   doax mcp @ns/name[@version] one resource — its own tools, pre-bound to that ref
  *
  * The transport is the stdio flavour of MCP: one JSON-RPC 2.0 message per line, in and out.
  */

const PROTOCOL_VERSION = "2025-06-18";

export interface Mode {
    single: boolean;
    /** single-resource mode: the canonical ref, its kind, and its namespace/name. */
    ref?: string;
    kind?: string;
    namespace?: string;
    name?: string;
}

export interface JsonRpcMessage {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
}

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

/* ---------- delegation to the CLI ---------- */

/** Turn a params object into repeated `--param k=v` the CLI understands (non-strings as JSON). */
function paramArgs(params: unknown): string[] {
    if (!params || typeof params !== "object") return [];
    const out: string[] = [];
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
        out.push("--param", `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
    return out;
}

/** The exact `doax …` command a caller should run for anything MCP will not inline. */
function doaxCommand(verb: string, ref: string, params: unknown, extra: string[]): string {
    return ["doax", verb, ref, ...paramArgs(params), ...extra].join(" ");
}

const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], isError });

/** A read failed: decide whether it is a hand-back-to-the-CLI case (interactive/authorization) or a real error. */
function readFailure(stderr: string | undefined, command: string) {
    let detail: Record<string, unknown> = {};
    try {
        detail = JSON.parse(stderr ?? "{}") as Record<string, unknown>;
    } catch {
        /* non-JSON stderr (e.g. wrong-kind message) — treat as a plain error below */
    }
    const faultClass = detail.faultClass as string | undefined;
    const handBack =
        detail.willRequireInteraction === true ||
        faultClass === "credential-missing" ||
        faultClass === "authorization-required" ||
        faultClass === "authorization-declined";
    if (handBack) {
        const fix = typeof detail.fix === "string" ? detail.fix : command;
        return text(`Needs the guarded CLI path (${faultClass ?? "interaction"}). Run:\n  ${fix}`);
    }
    return text(typeof detail.error === "string" ? detail.error : (stderr ?? "read failed"), true);
}

/* ---------- tools ---------- */

const KIND_ENUM = ["data-source", "action", "executor", "authenticator"];

function gatewayTools(): ToolDef[] {
    return [
        {
            name: "doax_search",
            description: "Search doax resources visible to you on the configured registry. Returns matches with identity, kind, tier and summary.",
            inputSchema: {
                type: "object",
                properties: { query: { type: "string" }, kind: { type: "string", enum: KIND_ENUM, description: "optional kind filter" } },
                required: ["query"],
            },
        },
        {
            name: "doax_describe",
            description: "Resolve one resource and return its manifest: kind, required tier, authenticator, interface mapping and service level.",
            inputSchema: { type: "object", properties: { ref: { type: "string", description: "@namespace/name[@version]" } }, required: ["ref"] },
        },
        {
            name: "doax_read",
            description:
                "Read a data-source resource and return its data inline. If the resource needs interactive auth or per-call authorization, returns the exact `doax read` command to run instead — it never weakens the tier.",
            inputSchema: {
                type: "object",
                properties: {
                    ref: { type: "string", description: "@namespace/name[@version]" },
                    params: { type: "object", description: 'read parameters, e.g. {"channel":"C0123456789"}' },
                    metadata: { type: "boolean", description: "read the data-source's metadata instead of its data" },
                },
                required: ["ref"],
            },
        },
        {
            name: "doax_execute",
            description:
                "Return the guarded `doax execute` command for an action resource. doax never performs an effecting operation over MCP; the command runs through the CLI's authorization, approval and audit path.",
            inputSchema: {
                type: "object",
                properties: {
                    ref: { type: "string", description: "@namespace/name[@version]" },
                    params: { type: "object" },
                    dry_run: { type: "boolean", description: "preview with no side effects" },
                },
                required: ["ref"],
            },
        },
    ];
}

/** One resource's own tools, pre-bound to its ref and shaped by its kind. `describe` is always present. */
function singleTools(mode: Mode): ToolDef[] {
    const describe: ToolDef = {
        name: "describe",
        description: `Resolve ${mode.ref} and return its manifest.`,
        inputSchema: { type: "object", properties: {} },
    };
    if (mode.kind === "data-source") {
        return [
            {
                name: "read",
                description: `Read ${mode.ref} and return its data inline. If it needs interactive auth, returns the exact \`doax read\` command instead.`,
                inputSchema: {
                    type: "object",
                    properties: { params: { type: "object", description: "read parameters" }, metadata: { type: "boolean" } },
                },
            },
            describe,
        ];
    }
    if (mode.kind === "action") {
        return [
            {
                name: "execute",
                description: `Return the guarded \`doax execute\` command for ${mode.ref}. Effecting operations never run over MCP.`,
                inputSchema: { type: "object", properties: { params: { type: "object" }, dry_run: { type: "boolean" } } },
            },
            describe,
        ];
    }
    return [describe];
}

async function callTool(deps: CliDeps, mode: Mode, name: string, args: Record<string, unknown>): Promise<ReturnType<typeof text>> {
    const op = mode.single ? name : name.replace(/^doax_/, "");

    // Search takes a query, not a ref — it runs before the ref guard the other ops need.
    if (op === "search") {
        const kind = args.kind as string | undefined;
        const res = await run(["search", String(args.query ?? ""), ...(kind ? ["--kind", kind] : []), "--json"], deps);
        return res.exitCode === 0 ? text(res.stdout ?? "") : text(res.stderr ?? "search failed", true);
    }

    // In single-resource mode the ref is fixed; in gateway mode it comes in the arguments.
    const ref = mode.single ? mode.ref! : (args.ref as string);
    if (!ref) return text("missing resource ref", true);

    switch (op) {
        case "describe": {
            const res = await run(["resolve", ref, "--json"], deps);
            return res.exitCode === 0 ? text(res.stdout ?? "") : text(res.stderr ?? "describe failed", true);
        }
        case "read": {
            const extra = [...paramArgs(args.params), ...(args.metadata ? ["--metadata"] : [])];
            const res = await run(["read", ref, ...extra, "--json", "--no-input"], deps);
            if (res.exitCode === 0) return text(res.stdout ?? "");
            return readFailure(res.stderr, doaxCommand("read", ref, args.params, args.metadata ? ["--metadata"] : []));
        }
        case "execute": {
            // The transport boundary is the risk boundary (architecture §3.2): effecting work goes through the CLI.
            const command = doaxCommand("execute", ref, args.params, args.dry_run ? ["--dry-run"] : []);
            return text(`This is an effecting operation; doax does not run it over MCP. Run it through the guarded CLI path:\n  ${command}`);
        }
        default:
            return text(`unknown tool "${name}"`, true);
    }
}

/* ---------- resources ---------- */

function listResources(mode: Mode) {
    if (mode.single) {
        return [{ uri: `doax://resource/${mode.namespace}/${mode.name}`, name: mode.ref!, description: "This resource's manifest.", mimeType: "application/json" }];
    }
    return [
        { uri: "doax://registries", name: "Configured registries", description: "The registries this doax talks to and how namespaces route to them (read-only).", mimeType: "application/json" },
        { uri: "doax://whoami", name: "Identity", description: "Who you are signed in as, per registry.", mimeType: "application/json" },
    ];
}

function listResourceTemplates(mode: Mode) {
    if (mode.single) return [];
    return [
        {
            uriTemplate: "doax://resource/{namespace}/{name}",
            name: "Resource manifest",
            description: "The manifest of one resource: kind, tier, interface mapping, service level.",
            mimeType: "application/json",
        },
    ];
}

async function readResource(deps: CliDeps, uri: string) {
    const emit = (value: string) => ({ contents: [{ uri, mimeType: "application/json", text: value }] });
    if (uri === "doax://registries") {
        const res = await run(["registry", "list", "--json"], deps);
        return emit(res.stdout ?? res.stderr ?? "{}");
    }
    if (uri === "doax://whoami") {
        const res = await run(["whoami", "--json"], deps);
        return emit(res.stdout ?? res.stderr ?? "{}");
    }
    const match = /^doax:\/\/resource\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/.exec(uri);
    if (match) {
        const res = await run(["resolve", `@${match[1]}/${match[2]}`, "--json"], deps);
        return emit(res.stdout ?? res.stderr ?? "{}");
    }
    return null;
}

/* ---------- JSON-RPC over stdio ---------- */

export async function handle(deps: CliDeps, mode: Mode, msg: JsonRpcMessage): Promise<unknown> {
    switch (msg.method) {
        case "initialize":
            return {
                protocolVersion: (msg.params?.protocolVersion as string) ?? PROTOCOL_VERSION,
                capabilities: { tools: {}, resources: {} },
                serverInfo: { name: mode.single ? `doax:${mode.ref}` : "doax", version: VERSION },
            };
        case "ping":
            return {};
        case "tools/list":
            return { tools: mode.single ? singleTools(mode) : gatewayTools() };
        case "tools/call": {
            const result = await callTool(deps, mode, String(msg.params?.name), (msg.params?.arguments as Record<string, unknown>) ?? {});
            return result;
        }
        case "resources/list":
            return { resources: listResources(mode) };
        case "resources/templates/list":
            return { resourceTemplates: listResourceTemplates(mode) };
        case "resources/read": {
            const uri = String(msg.params?.uri ?? "");
            const result = await readResource(deps, uri);
            if (!result) throw { code: -32602, message: `unknown resource: ${uri}` };
            return result;
        }
        default:
            throw { code: -32601, message: `method not found: ${msg.method}` };
    }
}

/** Serve MCP over stdin/stdout until stdin closes. `rest` is the `doax mcp` tail; a lone ref selects single-resource mode. */
/** Build the server Mode from the `doax mcp` tail: a lone ref selects single-resource mode, else gateway. */
export async function resolveMode(rest: string[], deps: CliDeps): Promise<Mode> {
    const refArg = rest.find((arg) => !arg.startsWith("-"));
    if (!refArg) return { single: false };
    const parsed = parseResourceRef(refArg); // throws on a malformed ref, before we start the loop
    const resolved = await run(["resolve", refArg, "--json"], deps);
    let kind = "unknown";
    if (resolved.exitCode === 0 && resolved.stdout) {
        try {
            kind = (JSON.parse(resolved.stdout) as { kind?: string }).kind ?? "unknown";
        } catch {
            /* resolve printed something unexpected; describe still works */
        }
    } else {
        process.stderr.write(`doax mcp: could not resolve ${refArg}: ${resolved.stderr ?? "unknown error"}\n`);
    }
    return { single: true, ref: formatResourceRef(parsed), kind, namespace: parsed.namespace, name: parsed.name };
}

export async function serveMcp(rest: string[], deps: CliDeps): Promise<void> {
    const mode = await resolveMode(rest, deps);

    const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
    const rl = createInterface({ input: process.stdin });
    let queue: Promise<void> = Promise.resolve();

    rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        queue = queue.then(async () => {
            let msg: JsonRpcMessage;
            try {
                msg = JSON.parse(trimmed) as JsonRpcMessage;
            } catch {
                return; // not JSON — ignore, per the transport
            }
            const isRequest = msg.id !== undefined && msg.id !== null;
            try {
                const result = await handle(deps, mode, msg);
                if (isRequest) write({ jsonrpc: "2.0", id: msg.id, result });
            } catch (err) {
                const e = err as { code?: number; message?: string };
                if (isRequest) write({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? String(err) } });
            }
        });
    });

    await new Promise<void>((resolve) => rl.on("close", () => resolve()));
    await queue;
}

export { run } from "./cli.ts";
export type { CliDeps, CliResult };
