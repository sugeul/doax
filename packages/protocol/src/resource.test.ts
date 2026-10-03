import { describe, expect, it } from "vitest";
import { formatResourceRef, parseResourceIdentity, parseResourceRef } from "./resource.ts";

describe("resource references", () => {
    it("parses with and without a version", () => {
        expect(parseResourceRef("@corp/orders")).toEqual({ namespace: "corp", name: "orders" });
        expect(parseResourceRef("@corp/orders@1.2.0")).toEqual({ namespace: "corp", name: "orders", version: "1.2.0" });
    });

    it("round-trips through formatting", () => {
        expect(formatResourceRef(parseResourceRef("@koreanmate/train-cancel@1.x"))).toBe("@koreanmate/train-cancel@1.x");
    });

    it("rejects malformed input", () => {
        expect(() => parseResourceRef("corp/orders")).toThrow();
        expect(() => parseResourceIdentity("@corp/orders")).toThrow();
    });
});
