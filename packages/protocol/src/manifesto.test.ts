import { expect, it } from "vitest";
import { manifestoUrl, withManifesto } from "./manifesto.ts";

it("points every response at {domain}/manifesto.json", () => {
    expect(manifestoUrl("doax.io")).toBe("https://doax.io/manifesto.json");
    expect(manifestoUrl("http://localhost:8080/")).toBe("http://localhost:8080/manifesto.json");
    expect(withManifesto("doax.io", { ok: true })).toEqual({ ok: true, manifesto: "https://doax.io/manifesto.json" });
});
