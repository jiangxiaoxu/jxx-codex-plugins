import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { VERSION } from '../src/server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));
const [pkg, portable, codex, mcp, legacy] = await Promise.all([
  json('package.json'), json('plugin.json'), json('.codex-plugin/plugin.json'), json('mcp.json'), json('.mcp.json')
]);
assert.equal(portable.name, 'codex-agent-metrics');
assert.equal(codex.name, portable.name);
assert.equal(pkg.version, portable.version);
assert.equal(codex.version, portable.version);
assert.equal(VERSION, portable.version);
assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
for (const config of [mcp, legacy]) {
  assert.equal(config.mcpServers['codex-agent-metrics'].command, 'node');
  assert.deepEqual(config.mcpServers['codex-agent-metrics'].args, ['${PLUGIN_ROOT}/dist/server.mjs']);
}
assert.ok(portable.extensions['com.openai'].interface.shortDescription.length <= 30);
for (const path of ['dist/server.mjs', 'dist/dashboard.html', 'dist/THIRD_PARTY_NOTICES.txt', 'assets/icon.png']) assert.ok((await readFile(join(root, path))).length > 0, `${path} must be packaged`);
const html = await readFile(join(root, 'dist/dashboard.html'), 'utf8');
assert.ok(!/<(?:script|link)\b[^>]*(?:src|href)=["'](?:https?:|\.\/)/i.test(html), 'UI must not require external assets');
assert.ok(!html.includes('simulated:true'), 'Production UI must not ship mock fallback');
const marketplace = JSON.parse(await readFile(join(root, '../../.agents/plugins/marketplace.json'), 'utf8'));
assert.equal(marketplace.plugins.filter((p) => p.name === 'codex-agent-metrics').length, 1);
assert.equal(marketplace.plugins.find((p) => p.name === 'codex-agent-metrics').source.path, './plugins/codex-agent-metrics');
console.log('Plugin metadata, inventory and packaged assets are valid.');
