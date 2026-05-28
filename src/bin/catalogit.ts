#!/usr/bin/env node
import { catalogitCli } from "../cli.js";

const exitCode = await catalogitCli(process.argv.slice(2));
process.exit(exitCode);
