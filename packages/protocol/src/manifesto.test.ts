import { expect, it } from "vitest";
import { buildManifesto, manifestoUrl, SPECIFICATION_URL, SPECIFICATION_VERSION, withManifesto } from "./manifesto.ts";

it("points every response at {domain}/manifesto.json", () => {
    expect(manifestoUrl("doax.io")).toBe("https://doax.io/manifesto.json");
    expect(manifestoUrl("http://localhost:8080/")).toBe("http://localhost:8080/manifesto.json");
    expect(withManifesto("doax.io", { ok: true })).toEqual({ ok: true, manifesto: "https://doax.io/manifesto.json" });
});

it("names the specification and the version it implements, and lets a deployment add its own entry points", () => {
    const m = buildManifesto("Registry Server", "someone", { extensions: "https://example.com/extensions", signIn: "doax login --registry https://example.com --web" });
    expect(m.specification).toBe(SPECIFICATION_URL);
    expect(m.specificationVersion).toBe(SPECIFICATION_VERSION);
    expect(m.extensions).toBe("https://example.com/extensions");
    expect(m.signIn).toContain("--web");
});
