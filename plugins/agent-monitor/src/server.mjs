import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const VERSION = '0.1.1';
export const UI_URI = 'ui://agent-monitor/dashboard';
const mimeType = 'text/html;profile=mcp-app';
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const listSchema = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().nullable().optional()
};

export function createServer(monitor, { uiUrl = new URL('../dist/dashboard.html', import.meta.url), diagnostics } = {}) {
  const server = new McpServer({ name: 'agent-monitor', version: VERSION });
  let html;
  const result = (data, text = 'Agent Monitor data.') => ({
    content: [{ type: 'text', text }],
    structuredContent: data
  });
  const tool = (name, description, inputSchema, run) => {
    server.registerTool(name, {
      description, inputSchema, annotations: readOnly,
      _meta: { ui: { visibility: ['app'] } }
    }, async (args) => {
      const started = performance.now();
      try {
        if (name !== 'monitor_diagnostics') monitor.activate();
        const data = await run(args);
        diagnostics?.write('debug', 'mcp.call_completed', { tool: name, durationMs: performance.now() - started });
        return result(data);
      } catch (error) {
        diagnostics?.write('error', 'mcp.call_failed', { tool: name, durationMs: performance.now() - started, error });
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
    });
  };
  server.registerResource('dashboard', UI_URI, { mimeType }, async () => {
    const started = performance.now();
    try { html ??= await readFile(uiUrl, 'utf8'); }
    catch (error) {
      diagnostics?.write('error', 'mcp.resource_failed', { source: UI_URI, error });
      throw error;
    }
    diagnostics?.write('info', 'mcp.resource_read', { source: UI_URI, bytes: Buffer.byteLength(html), durationMs: performance.now() - started });
    return { contents: [{
      uri: UI_URI, mimeType, text: html,
      _meta: {
        ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen', 'inline'] }
      }
    }] };
  });
  server.registerTool('monitor_open', {
    title: 'Agent Monitor',
    description: 'Open the current host\'s read-only Codex agent monitor. View total output speed, model contribution, root threads, subagents, token usage and recorded execution modes.',
    inputSchema: {}, annotations: readOnly,
    _meta: {
      ui: { resourceUri: UI_URI, visibility: ['model', 'app'] },
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] }
    }
  }, async () => {
    const started = performance.now();
    try {
      monitor.activate();
      const snapshot = await monitor.getSnapshot({ limit: 10 });
      diagnostics?.write('info', 'mcp.entrypoint_opened', { tool: 'monitor_open', state: snapshot.collection?.state, threads: snapshot.totals?.threadCount, durationMs: performance.now() - started });
      return result(snapshot, 'Opened Agent Monitor. Compressed rollouts are excluded. Rates may include explicitly marked in-flight estimates.');
    } catch (error) {
      diagnostics?.write('error', 'mcp.entrypoint_failed', { tool: 'monitor_open', durationMs: performance.now() - started, error });
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  });
  tool('monitor_snapshot', 'Read current-host aggregate rates and a cursor page of root threads.', {
    ...listSchema,
    order: z.enum(['priority', 'recent']).optional(),
    scope: z.enum(['all', 'active']).optional()
  }, (args) => monitor.getSnapshot(args));
  tool('monitor_thread', 'Read a root thread and a cursor page of its agents.', {
    ...listSchema, threadId: z.string().min(1), scope: z.enum(['all', 'active', 'completed']).optional()
  }, (args) => monitor.getThread(args));
  tool('monitor_agent', 'Read one agent and its recent speed history.', {
    agentId: z.string().min(1)
  }, (args) => monitor.getAgent(args));
  tool('monitor_history', 'Read daily token usage and speed aggregates. Dates use YYYY-MM-DD.', {
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  }, (args) => monitor.getHistory(args));
  tool('monitor_diagnostics', 'Read local diagnostic metadata and recent service events. Conversation bodies and credentials are excluded.', {}, () => ({
    version: VERSION,
    ...(diagnostics?.snapshot() ?? { logPath: null, level: null, events: [], writeFailed: false })
  }));
  return server;
}
