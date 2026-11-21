#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.HOME;
const approved = join(home, 'confirm');
const log = join(home, 'events');
let connected = false;
let turn = 0;
let cwd;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const { method, id, params } = JSON.parse(line);
  if (!id || !method) return;
  appendFileSync(log, JSON.stringify({ method, params }) + '\n');
  const reply = (result) => send({ id, result });
  if (method === 'account/read') return reply({ account: connected ? { type: 'chatgpt' } : null });
  if (method === 'account/login/start') {
    reply({ type: 'chatgptDeviceCode', loginId: 'fixture-login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-TEST' });
    const poll = setInterval(() => {
      if (!existsSync(approved)) return;
      clearInterval(poll);
      connected = true;
      send({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true } });
    }, 20);
    return;
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    cwd = params.cwd;
    return reply({ thread: { id: params.threadId || 'fixture-thread' } });
  }
  if (method === 'turn/start') {
    const threadId = params.threadId;
    const turnId = String(++turn);
    reply({ turn: { id: turnId } });
    let output = { action: 'done', message: 'Итог с учётом ответа.', request: '', artifact: '' };
    if (turn === 1 && home.endsWith('agent-1')) {
      writeFileSync(join(cwd, 'draft.txt'), 'Черновик');
      output = { action: 'request_peer', message: 'Черновик @unknown', request: 'Проверь аргументацию.', artifact: 'draft.txt' };
    }
    if (turn === 1 && home.endsWith('agent-2')) {
      output = { action: 'ask_owner', message: 'Прочитал черновик.', request: 'Какой датасет берём?', artifact: '' };
    }
    send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(output) } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    return;
  }
  reply({});
});
