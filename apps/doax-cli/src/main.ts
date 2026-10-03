#!/usr/bin/env node
import { run } from "./cli.ts";

const result = await run(process.argv.slice(2));
if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exitCode = result.exitCode;
