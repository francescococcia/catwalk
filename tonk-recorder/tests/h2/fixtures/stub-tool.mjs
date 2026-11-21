#!/usr/bin/env node
// Stub for the space-fetched tool.mjs, used by tests/h2 adapter tests.
// Appends one JSON line {argv, stdin} to $STUB_LOG and prints a marker on
// stdout so tests can assert the adapter forwarded output + exit code.
import { appendFileSync, readFileSync } from 'node:fs';

const log = process.env.STUB_LOG;
const stdin = readFileSync(0, 'utf8');
if (log) appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\n');
process.stdout.write('{"stub":"tool.mjs output"}\n');
process.exit(Number(process.env.STUB_EXIT ?? 0));
