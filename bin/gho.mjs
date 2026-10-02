#!/usr/bin/env node
import { main } from '../dist/orchestrator/cli.js';
main().catch(error => { console.error(`gho: ${error.message}`); process.exitCode = 1; });
