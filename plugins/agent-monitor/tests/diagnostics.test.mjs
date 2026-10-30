import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Diagnostics } from '../src/diagnostics.mjs';

async function temporary(t) {
  const folder = await mkdtemp(path.join(tmpdir(), 'agent-monitor-diagnostics-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test('diagnostics filter debug events and retain bounded structured recent history', async (t) => {
  const stateDir = await temporary(t);
  const diagnostics = new Diagnostics({ stateDir, version: '0.1.1' });
  diagnostics.write('debug', 'not-enabled', { durationMs: 9 });
  const collectionCounts = { skippedCompressedFiles: 13, newFiles: 2, removedFiles: 1, changedFiles: 4, failedFiles: 0, newResponses: 6, filesDiscovered: 18 };
  for (let count = 0; count < 105; count++) diagnostics.write('info', 'collection.complete', { count, agents: 17, nodeVersion: 'v25.3.0', hostName: 'test-host', counts: collectionCounts });
  diagnostics.close();
  const rows = (await readFile(diagnostics.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 105);
  assert.equal(rows[0].version, '0.1.1');
  assert.equal(rows[0].pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(rows[0].timestamp)));
  const recent = diagnostics.snapshot();
  assert.equal(recent.version, '0.1.1');
  assert.equal(rows[0].fields.nodeVersion, 'v25.3.0');
  assert.equal(rows[0].fields.hostName, 'test-host');
  assert.deepEqual(rows[0].fields.counts, collectionCounts);
  assert.equal(recent.events.length, 100);
  assert.equal(recent.events[0].fields.count, 5);
  recent.events[0].fields.count = -1;
  assert.equal(diagnostics.snapshot().events[0].fields.count, 5);
});

test('diagnostics redact credentials and omit conversation payloads in file and stderr', async (t) => {
  const stateDir = await temporary(t);
  const moduleUrl = new URL('../src/diagnostics.mjs', import.meta.url).href;
  const script = `
    const {Diagnostics}=await import(${JSON.stringify(moduleUrl)});
    const log=new Diagnostics({stateDir:${JSON.stringify(stateDir)},version:'0.1.1',level:'debug'});
    const error=new Error('Bearer AUTHSECRET https://user:PASSSECRET@example.test/mcp?token=URLSECRET&safe=PARAMSECRET api_key=APISECRET');
    error.code='ABORT_ERR';error.cause=error;
    log.write('info','startup',{source:'stdio',durationMs:3});
    log.write('error','read.failed',{error,prompt:'PROMPTSECRET',arguments:{token:'ARGSECRET'},result:'RESULTSECRET',password:'PASSFIELDSECRET',counts:{files:4,content:'NESTEDSECRET'}});
    try { JSON.parse('JSONSECRET'); } catch (parseError) { log.write('error','protocol.parse_failed',{error:parseError}); }
    try { JSON.parse('{"safe":1,}'); } catch (parseError) { log.write('error','protocol.parse_position',{error:parseError}); }
    log.write('warn','flattened.failure',{name:error.name,code:error.code,message:error.message,stack:error.stack,counts:{files:4}});
    log.close();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.ok(child.stderr.includes('read.failed'));
  assert.ok(!child.stderr.includes('startup'));
  const files = await readdir(path.join(stateDir, 'logs'));
  const text = await readFile(path.join(stateDir, 'logs', files[0]), 'utf8');
  for (const secret of ['AUTHSECRET', 'PASSSECRET', 'URLSECRET', 'PARAMSECRET', 'APISECRET', 'PROMPTSECRET', 'ARGSECRET', 'RESULTSECRET', 'PASSFIELDSECRET', 'NESTEDSECRET', 'JSONSECRET']) {
    assert.ok(!text.includes(secret), secret);
    assert.ok(!child.stderr.includes(secret), secret);
  }
  const errorRecord = text.trim().split('\n').map(JSON.parse).at(-1);
  const parsedRecords = text.trim().split('\n').map(JSON.parse);
  const parseFailure = parsedRecords.find((record) => record.event === 'protocol.parse_failed');
  assert.equal(parseFailure.fields.error.name, 'SyntaxError');
  assert.equal(parseFailure.fields.error.message, 'Input parsing failed');
  assert.ok(parseFailure.fields.error.stack.includes('at JSON.parse'));
  const parsePosition = parsedRecords.find((record) => record.event === 'protocol.parse_position');
  assert.match(parsePosition.fields.error.message, /position \d+/);
  assert.equal(errorRecord.fields.error.code, 'ABORT_ERR');
  assert.equal(errorRecord.fields.counts.files, 4);
  assert.equal(errorRecord.fields.prompt, undefined);
});

test('rotation bounds file sizes and retains only this logger file family', async (t) => {
  const stateDir = await temporary(t);
  const diagnostics = new Diagnostics({ stateDir, version: '0.1.1', limitBytes: 700, keepFiles: 3 });
  const directory = path.dirname(diagnostics.logPath);
  const foreign = path.join(directory, 'agent-monitor-foreign-process.jsonl');
  await writeFile(foreign, 'other process history');
  for (let count = 0; count < 24; count++) diagnostics.write('info', 'collection.refresh', { count, source: 'x'.repeat(100) });
  diagnostics.close();
  const ownPrefix = path.basename(diagnostics.logPath, '.jsonl');
  const ownFiles = (await readdir(directory)).filter((name) => name.startsWith(ownPrefix));
  assert.equal(ownFiles.length, 3);
  for (const name of ownFiles) {
    assert.ok((await stat(path.join(directory, name))).size <= 700);
    (await readFile(path.join(directory, name), 'utf8')).trim().split('\n').forEach((line) => assert.equal(JSON.parse(line).event, 'collection.refresh'));
  }
  assert.equal(await readFile(foreign, 'utf8'), 'other process history');
  assert.equal(diagnostics.snapshot().events.at(-1).fields.count, 23);
});

test('an unwritable diagnostics location reports failure once and does not stop the process', async (t) => {
  const folder = await temporary(t);
  const blocked = path.join(folder, 'not-a-directory');
  await writeFile(blocked, 'blocked');
  const moduleUrl = new URL('../src/diagnostics.mjs', import.meta.url).href;
  const script = `
    const {Diagnostics}=await import(${JSON.stringify(moduleUrl)});
    const log=new Diagnostics({stateDir:${JSON.stringify(blocked)},version:'0.1.1'});
    for(let count=0;count<3;count++)log.write('info','still-running',{count});
    log.close();
    process.stdout.write(JSON.stringify({alive:true,count:log.snapshot().events.length,failed:log.snapshot().writeFailed}));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { alive: true, count: 3, failed: true });
  assert.equal(child.stderr.trim().split('\n').length, 1);
});
