#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { main } from "./index.js";

async function fleet(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "codex") {
    const separator = rest[0] === "--" ? rest.slice(1) : rest;
    return main(["session", "start", "--agent", "codex", "--", "codex", ...separator]);
  }
  console.error("usage: fleet codex [-- <codex args...>]");
  return 2;
}

if (isDirectRun()) {
  const code = await fleet(process.argv.slice(2));
  process.exitCode = code;
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(fs.realpathSync.native(process.argv[1])).href;
}
