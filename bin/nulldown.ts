#!/usr/bin/env bun

import { runCli } from "../src/cli";

const main = async () => {
  await runCli(process.argv.slice(2));
};

main();
