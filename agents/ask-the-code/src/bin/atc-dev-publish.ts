#!/usr/bin/env node
import { devPublishCli } from "../dev-publish.js";

const exitCode = await devPublishCli(process.argv.slice(2));
process.exit(exitCode);
