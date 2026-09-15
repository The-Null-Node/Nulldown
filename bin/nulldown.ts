#!/usr/bin/env bun

import { runCli } from "../src/cli";

const main = async () => {
  const result = await runCli(process.argv.slice(2));
  process.exitCode = result.exitCode;
};

main();
