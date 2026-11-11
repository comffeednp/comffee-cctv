/**
 * Comffee CCTV bridge: runs on an always-on device at the business and relays camera connections to the
 * hub over an outgoing WebSocket. See bridge/README.md.
 */

import { isSea } from 'node:sea';
import { BridgeClient } from './client.ts';
import { BRIDGE_VERSION, USAGE, parseArgs } from './config.ts';
import { runDetection } from './detect.ts';

function cliArgs(): string[] {
  // As a single executable, argv[1] normally repeats the executable path; handle both layouts.
  const argv = process.argv;
  if (isSea() && argv[1] !== process.execPath) return argv.slice(1);
  return argv.slice(2);
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

const parsed = parseArgs(cliArgs(), process.env);
if (parsed.kind === 'help') {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.kind === 'version') {
  console.log(BRIDGE_VERSION);
  process.exit(0);
}
if (parsed.kind === 'error') {
  console.error(parsed.message);
  process.exit(2);
}

const client = new BridgeClient(parsed.config, { detect: runDetection, log });
log(`Comffee CCTV bridge ${BRIDGE_VERSION} starting; hub ${parsed.config.hub}, name "${parsed.config.name}".`);
client.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('Stopping.');
    client.stop();
    setTimeout(() => process.exit(0), 200).unref();
  });
}
