import { expect, it } from "vitest";
import { manifestoUrl, withManifesto } from "./manifesto.ts";

it("points every response at {domain}/manifesto.json", () => {
    expect(manifestoUrl("doax.ai")).toBe("https://doax.ai/manifesto.json");
    expect(manifestoUrl("http://localhost:8080/")).toBe("http://localhost:8080/manifesto.json");
    expect(withManifesto("doax.ai", { ok: true })).toEqual({ ok: true, manifesto: "https://doax.ai/manifesto.json" });
});
