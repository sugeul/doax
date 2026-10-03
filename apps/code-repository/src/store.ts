import { mkdirSync } from "node:fs";

/**
  * Packages live on the local filesystem under `{packagesDir}/@namespace/name/version/`.
  * Immutability (spec §11) is enforced by the store API: a version directory is written once and never reopened for writing.
  */
export class PackageStore {
    readonly packagesDir: string;

    constructor(packagesDir: string) {
        this.packagesDir = packagesDir;
        mkdirSync(packagesDir, { recursive: true });
    }
}
