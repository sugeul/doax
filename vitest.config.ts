import { defineConfig } from "vitest/config";

// Resolve workspace packages to their TypeScript sources, so tests need no build step.
export default defineConfig({
    resolve: { conditions: ["@doax/source"] },
    ssr: { resolve: { conditions: ["@doax/source"] } },
    test: {
        include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    },
});
