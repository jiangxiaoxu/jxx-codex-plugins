import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Monitor } from './monitor/index.mjs';
import { Diagnostics } from './diagnostics.mjs';
import { createServer, VERSION } from './server.mjs';

const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const stateDir = process.env.CODEX_AGENT_METRICS_STATE_DIR || join(codexHome, 'state', 'plugins', 'codex-agent-metrics');
const diagnostics = new Diagnostics({ stateDir, version: VERSION });
diagnostics.write('info', 'service.start', { nodeVersion: process.version, source: codexHome });
process.on('uncaughtExceptionMonitor', (error) => diagnostics.write('error', 'process.uncaught_exception', { error }));
process.once('exit', (code) => {
  diagnostics.write('info', 'service.exit', { code });
  diagnostics.close();
});
try {
  const monitor = new Monitor({ codexHome, stateDir, diagnostics });
  const server = createServer(monitor, { diagnostics });
  const transport = new StdioServerTransport();
  server.server.oninitialized = () => diagnostics.write('info', 'mcp.initialized');
  server.server.onerror = (error) => diagnostics.write('error', 'mcp.protocol_error', { error });
  server.server.onclose = async () => {
    diagnostics.write('info', 'mcp.transport_closed');
    await monitor.stop();
    diagnostics.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    diagnostics.write('info', 'service.signal', { reason: signal });
    await monitor.stop();
    await server.close();
    diagnostics.close();
  });
  await server.connect(transport);
  diagnostics.write('info', 'mcp.transport_connected');
  diagnostics.write('info', 'service.idle', { state: 'paused' });
} catch (error) {
  diagnostics.write('error', 'service.start_failed', { error });
  diagnostics.close();
  process.exitCode = 1;
}
