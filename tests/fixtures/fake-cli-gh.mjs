#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.GHO_CLI_CALL_LOG, `${JSON.stringify({ command, args })}\n`);
if (command === "gh" && JSON.stringify(args) === JSON.stringify(["api", "--hostname", "github.com", "user", "--jq", ".login"])) {
  process.stdout.write("fixture-owner\n");
} else if (command === "gh" && process.env.GHO_CLI_SCENARIO === "reviews"
    && JSON.stringify(args.slice(0, 3)) === JSON.stringify(["api", "--hostname", "github.com"])) {
  const endpoint = args[3];
  const base = "repos/fixture-owner/fixture-repo/pulls/5";
  if (endpoint === base) {
    process.stdout.write(JSON.stringify({ number: 5, html_url: "https://github.com/fixture-owner/fixture-repo/pull/5", state: "open", merged: false, draft: true }));
  } else if (endpoint === `${base}/reviews?per_page=100`) {
    process.stdout.write(JSON.stringify([[{ id: 2, body: "[agent:] Still working.", state: "COMMENTED", submitted_at: "2026-01-01T00:00:05Z" }]]));
  } else if (endpoint === `${base}/comments?per_page=100`) {
    process.stdout.write("[[]]");
  } else {
    throw new Error(`Unexpected review endpoint: ${endpoint}`);
  }
} else {
  process.stderr.write(`Unexpected external command in CLI test: ${command} ${args.join(" ")}\n`);
  process.exitCode = 88;
}
