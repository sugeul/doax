import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliConfig } from "@doax/config";
import { type CliDeps, handle, type JsonRpcMessage, type Mode, run } from "doax-cli/mcp";

/**
 * doax MCP Gateway core — transport-independent. The HTTP server (main.ts) and the Lambda handler
 * (lambda.ts) both call handleRpc(). It reuses the executor core through the same handle() the stdio
 * `doax mcp` uses; the additions are a per-request caller identity (the bearer is forwarded to the
 * registry; nothing is held server-side) and the two-step human-in-the-loop for effecting work.
 */

export const REGISTRY = (process.env.DOAX_REGISTRY ?? "https://registry.doax.io").replace(/\/+$/, "");
// Ephemeral home: the digest package cache is fine to share, but there is no credentials.json — so a
// credential-needing read hands back the guarded command instead of running under a server-side secret.
const HOME = mkdtempSync(join(tmpdir(), "doax-mcp-gateway-"));
const MODE: Mode = { single: false };

/** Per-request identity: forward the caller's bearer to the registry; the gateway holds nothing. */
function depsFor(token: string | undefined): CliDeps {
    const fetchAsCaller: typeof fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!token || !url.startsWith(REGISTRY)) return globalThis.fetch(input, init);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
        return globalThis.fetch(input, { ...init, headers });
    };
    return { config: loadCliConfig({ DOAX_REGISTRY: REGISTRY }), fetch: fetchAsCaller, home: HOME, prompt: undefined };
}

function paramArgs(params: unknown): string[] {
    if (!params || typeof params !== "object") return [];
    return Object.entries(params as Record<string, unknown>).flatMap(([k, v]) => ["--param", `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`]);
}
const asText = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], isError });
const safeJson = (s: string): unknown => {
    try {
        return JSON.parse(s);
    } catch {
        return s;
    }
};

/* two-step human-in-the-loop for effecting work (architecture §3.2; approval, spec §6.4) */

const DRY_RUN_TOOL = {
    name: "doax_dry_run",
    description: "Preview an action with no side effects (its native/predictive dry-run). The safe first step of the two-step human-in-the-loop.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, params: { type: "object" } }, required: ["ref"] },
};
const EXECUTE_TOOL = {
    name: "doax_execute",
    description:
        "Run an action — gated behind human approval. Without `approval` it returns the dry-run preview and asks for it; a human (not the agent) must approve. Effecting execution turns on once the gateway's approval channel is configured.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, params: { type: "object" }, approval: { type: "string" } }, required: ["ref"] },
};

async function dryRun(deps: CliDeps, ref: string, params: unknown): Promise<string> {
    const r = await run(["execute", ref, ...paramArgs(params), "--dry-run", "--json", "--no-input"], deps);
    return r.exitCode === 0 ? (r.stdout ?? "{}") : (r.stderr ?? "dry-run failed");
}

async function executeStep(deps: CliDeps, args: Record<string, unknown>) {
    const preview = await dryRun(deps, String(args.ref ?? ""), args.params);
    if (!args.approval) {
        return asText(
            JSON.stringify(
                { status: "approval_required", preview: safeJson(preview), howto: "A human — not the agent — must approve this action, then re-call doax_execute with the approval handle." },
                null,
                2,
            ),
        );
    }
    // The agent presented an approval, but this gateway cannot yet verify it came from the human (§4/§5),
    // so it refuses rather than trust the caller: effecting execution stays off until the channel exists.
    return asText("Effecting execution over MCP needs the gateway's human-approval channel, which is not yet enabled. Reads and dry-runs are served.", true);
}

/** Reuse handle() for everything but the two-step tools. */
async function route(deps: CliDeps, msg: JsonRpcMessage): Promise<unknown> {
    if (msg.method === "tools/list") {
        const base = (await handle(deps, MODE, msg)) as { tools: { name: string }[] };
        return { tools: [...base.tools.filter((t) => t.name !== "doax_execute"), DRY_RUN_TOOL, EXECUTE_TOOL] };
    }
    if (msg.method === "tools/call") {
        const name = String(msg.params?.name);
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
        if (name === "doax_dry_run") return asText(await dryRun(deps, String(args.ref ?? ""), args.params));
        if (name === "doax_execute") return await executeStep(deps, args);
    }
    return await handle(deps, MODE, msg);
}

/** Handle one JSON-RPC message for a caller identified by their doax bearer token (may be undefined). */
export async function handleRpc(token: string | undefined, msg: JsonRpcMessage): Promise<unknown> {
    return route(depsFor(token), msg);
}

export function bearer(header: string | undefined): string | undefined {
    const m = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
    return m ? m[1] : undefined;
}

export const rpcError = (id: JsonRpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export type { JsonRpcMessage };
