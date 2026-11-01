#!/usr/bin/env node
import { resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import packageInfo from '../package.json' with { type: 'json' };
import { createRecallServer } from './app.mjs';
import { defaultBridgeFile } from './bridge.mjs';

const usage = '回响只读 MCP（Node.js 22+）\n用法: node server.mjs [--bridge-file <bridge.json>]\n请保持回响桌面应用打开。';
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  process.stdout.write(`${usage}\n`);
} else if (args.length !== 0 && !(args.length === 2 && args[0] === '--bridge-file' && args[1] && !args[1].startsWith('--'))) {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
} else {
  const bridgeFile = args.length ? resolve(args[1]) : defaultBridgeFile();
  const handle = serveStdio(() => createRecallServer({ bridgeFile, entryUrl: import.meta.url, version: packageInfo.version }), {
    onerror: () => process.stderr.write('回响 MCP 通信错误。\n'),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void handle.close(); });
}
