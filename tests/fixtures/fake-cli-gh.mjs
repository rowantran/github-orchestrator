#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.GHO_CLI_CALL_LOG, `${JSON.stringify({ command, args })}\n`);
if (command === "gh" && JSON.stringify(args) === JSON.stringify(["api", "--hostname", "github.com", "user", "--jq", ".login"])) {
  process.stdout.write("fixture-owner\n");
} else {
  process.stderr.write(`Unexpected external command in CLI test: ${command} ${args.join(" ")}\n`);
  process.exitCode = 88;
}
