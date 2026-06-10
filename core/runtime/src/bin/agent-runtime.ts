#!/usr/bin/env node
import { runLocalCli } from "../runtime/run-local-cli.js";

const exitCode = await runLocalCli(process.argv.slice(2));
process.exit(exitCode);
