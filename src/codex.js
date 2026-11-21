import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function connectCodex({ executable, home, cwd }) {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
    cwd,
    env: { HOME: home, CODEX_HOME: home + '/.codex', LANG: 'C.UTF-8', PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const events = new EventEmitter();
  let nextId = 0;
  let alive = true;
  const pending = new Map();

  function disconnect() {
    if (!alive) return;
    alive = false;
    for (const { reject } of pending.values()) reject(new Error('Codex остановился'));
    events.emit('disconnect');
  }
  child.once('close', disconnect);
  child.once('error', disconnect);
  child.stdin.on('error', disconnect);

  function write(message) {
    if (alive) child.stdin.write(JSON.stringify(message) + '\n');
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      write({ id: message.id, error: { code: -32601, message: 'Интерактивные инструменты недоступны.' } });
    } else if (message.method) {
      events.emit('notification', message.method, message.params);
    } else if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      if (message.error) reject(new Error('Codex отклонил запрос'));
      else resolve(message.result);
    }
  });

  async function call(method, params) {
    if (!alive) throw new Error('Codex остановился');
    const id = ++nextId;
    let timeout;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timeout = setTimeout(() => reject(new Error('Codex не ответил')), 20_000);
        write({ id, method, params });
      });
    } finally {
      clearTimeout(timeout);
      pending.delete(id);
    }
  }

  function close() {
    child.kill();
    disconnect();
  }

  try {
    await call('initialize', {
      clientInfo: { name: 'ai_messanger', title: 'AI Messenger', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    write({ method: 'initialized' });
    return { call, events, close, isAlive: () => alive };
  } catch (error) {
    close();
    throw error;
  }
}
