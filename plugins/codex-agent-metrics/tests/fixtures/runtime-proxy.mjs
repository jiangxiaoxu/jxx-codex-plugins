import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const server = createServer();
const sockets = new WebSocketServer({ noServer: true });
const stream = Duplex.from({ readable: process.stdin, writable: process.stdout });
server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws)));
sockets.on('connection', ws => {
  let listed = 0;
  let threads = fixture.threads;
  let transitioned = false;
  ws.on('message', bytes => {
    const request = JSON.parse(bytes.toString());
    const respond = result => ws.send(JSON.stringify({ id: request.id, result }));
    if (request.method === 'initialize') respond({ codexHome: fixture.home, userAgent: 'codex_cli_rs/0.166.0' });
    else if (request.method === 'initialized') return;
    else if (request.method === 'thread/loaded/list') {
      if (++listed > 1 && !fixture.transitions) { ws.close(); return; }
      respond({ data: threads.map(thread => thread.id), nextCursor: null });
    } else if (request.method === 'thread/read') {
      const thread = threads.find(thread => thread.id === request.params.threadId);
      if (thread?.vanish) {
        threads = threads.filter(item => item.id !== thread.id);
        ws.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Thread has unloaded' } }));
        return;
      }
      if (!thread || thread.forbidden || request.params.includeTurns !== false) {
        ws.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Attempted excluded or full-history read' } }));
      } else if (fixture.transitions && !transitioned) {
        transitioned = true;
        const previous = { ...thread };
        thread.status = { type: 'idle' };
        ws.send(JSON.stringify({ method: 'thread/status/changed', params: { threadId: thread.id, status: thread.status } }));
        respond({ thread: previous });
      } else respond({ thread });
    } else ws.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Observer attempted a non-read method' } }));
  });
});
server.emit('connection', stream);
