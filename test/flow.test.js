import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const group = { id: -9350001, type: 'group', title: 'Проект' };
const users = [11, 22, 33].map((id) => ({ id, is_bot: false, first_name: `User ${id}` }));
const self = { id: 88, is_bot: true, first_name: 'AI Messenger', username: 'fixture_bot' };
const personalBot = { id: 89, is_bot: true, first_name: 'Personal', username: 'fixture_personal_bot' };
const personalToken = '89:fixture-personal-token';

async function until(check, description) {
  for (let i = 0; i < 250; i++) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw new Error('Не дождались: ' + description);
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function sparePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('приглашение личного бота, два изолированных Codex и согласие владельцев на запуск', { timeout: 25_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-messanger-test-'));
  const children = [];
  const diagnostics = [];
  const messages = [];
  const statusEdits = [];
  const updates = [];
  const callbacks = [];
  const confirmedUpdates = new Map();
  let nextMessage = 100;
  let nextUpdate = 0;
  function launch(script, env) {
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, ...env } });
    child.stderr.on('data', (chunk) => diagnostics.push(chunk.toString()));
    children.push(child);
    return child;
  }

  const telegram = createServer(async (req, res) => {
    if (req.url.endsWith('/documents/brief.txt')) return res.end('Текст задания');
    const method = req.url.split('/').at(-1);
    const sender = req.url.startsWith(`/bot${personalToken}/`) ? personalBot : self;
    const pieces = [];
    for await (const piece of req) pieces.push(piece);
    const content = Buffer.concat(pieces).toString();
    const data = req.headers['content-type']?.includes('application/json') && content ? JSON.parse(content) : {};
    let result = true;
    switch (method) {
      case 'getMe': result = sender; break;
      case 'getWebhookInfo': result = { url: '' }; break;
      case 'getChatMember':
        result = { status: data.user_id === users[0].id ? 'administrator' : 'member' };
        break;
      case 'getFile': result = { file_path: 'documents/brief.txt' }; break;
      case 'sendMessage':
      case 'sendDocument':
        result = {
          message_id: ++nextMessage, date: 1, from: sender,
          chat: data.chat_id === group.id || method === 'sendDocument' ? group : { id: data.chat_id, type: 'private' },
          text: data.text, reply_markup: data.reply_markup,
        };
        messages.push(result);
        break;
      case 'editMessageReplyMarkup':
        result = messages.find((entry) => entry.message_id === data.message_id);
        if (result) result.reply_markup = data.reply_markup;
        break;
      case 'editMessageText':
        result = messages.find((entry) => entry.message_id === data.message_id);
        if (result) {
          statusEdits.push(data.text);
          result.text = data.text;
        }
        break;
      case 'answerCallbackQuery': callbacks.push(data); break;
      case 'getUpdates': {
        const minimum = Math.max(data.offset ?? 0, confirmedUpdates.get(sender.id) ?? 0);
        confirmedUpdates.set(sender.id, minimum);
        await delay(20);
        result = updates.filter((update) => update.update_id >= minimum);
        break;
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    telegram.closeAllConnections();
    telegram.close();
    await rm(dir, { recursive: true, force: true });
    if (diagnostics.length) t.diagnostic(diagnostics.join(''));
  });
  const telegramPort = await listen(telegram);
  const webPort = await sparePort();
  const publicUrl = 'http://127.0.0.1:' + webPort;
  const workerEnv = {};
  const homes = [];
  for (const slot of [1, 2]) {
    const port = await sparePort();
    const home = join(dir, `agent-${slot}`);
    homes.push(home);
    workerEnv[`RUNNER_${slot}_URL`] = 'http://127.0.0.1:' + port;
    workerEnv[`RUNNER_${slot}_SECRET`] = 'slot-' + slot;
    launch('src/runner.js', { DATA_DIR: home, PORT: port, RUNNER_SECRET: 'slot-' + slot, CODEX_BIN: resolve('test/fixtures/codex.js') });
  }
  const botEnv = {
    ...workerEnv, DATA_DIR: join(dir, 'bot'), PORT: webPort, PUBLIC_URL: publicUrl,
    TELEGRAM_BOT_TOKEN: '88:fixture', TELEGRAM_GROUP_ID: group.id,
    TELEGRAM_API_ROOT: 'http://127.0.0.1:' + telegramPort,
    TELEGRAM_ARCHIVE_DIR: join(dir, 'archive'),
    AGENT_BOT_ENCRYPTION_KEY: 'a'.repeat(64),
  };
  const botProcess = launch('src/bot.js', botEnv);

  function message(from, text, options = {}) {
    const message = { message_id: ++nextMessage, date: 1, from, chat: group, text, ...options };
    updates.push({ update_id: ++nextUpdate, message });
    return message;
  }
  function click(from, message, data) {
    const id = String(++nextUpdate);
    updates.push({ update_id: nextUpdate, callback_query: { id, from, message, data, chat_instance: 'group' } });
    return id;
  }
  function waitReply(filter, description) {
    return until(() => messages.find(filter), description);
  }
  async function getEvents(slot) {
    const log = await readFile(join(homes[slot - 1], 'events'), 'utf8').catch(() => '');
    return log.trim().split('\n').filter(Boolean).map(JSON.parse);
  }
  async function turns(slot) {
    return (await getEvents(slot)).filter(({ method }) => method === 'turn/start');
  }
  async function web(path, { body, cookie } = {}) {
    const headers = { Origin: publicUrl, ...(cookie ? { Cookie: cookie } : {}) };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(publicUrl + '/api/setup/' + path, {
      method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
    });
  }
  await until(async () => (await fetch(publicUrl + '/health').catch(() => null))?.ok, 'сервер регистрации');
  assert.match(await (await fetch(publicUrl)).text(), /Твой агент/);
  assert.equal((await web('status')).status, 401);

  const cookies = [];
  for (const [index, user] of users.slice(0, 2).entries()) {
    const greeting = message(user, 'Привет');
    const privateChat = { id: user.id, type: 'private' };
    if (index === 0) {
      message(users[0], '/allow', { reply_to_message: greeting });
      await waitReply((entry) => entry.text?.includes(`tg://user?id=${user.id}`) && entry.text.includes('слот готов'), 'одобренный слот');
      message(user, '/start setup', { chat: privateChat });
    } else {
      message(users[0], '/invite@fixture_bot', { reply_to_message: greeting });
      const sharedInvite = await waitReply((entry) => entry.text?.includes('?start=join_'), 'ссылка для передачи');
      const payload = new URL(sharedInvite.text.split('\n').at(-1)).searchParams.get('start');
      const database = new DatabaseSync(join(botEnv.DATA_DIR, 'bot.sqlite'));
      database.prepare('UPDATE onboarding_invites SET expires = ? WHERE user_id = ?').run(Date.now() - 1_000, user.id);
      message(user, '/start ' + payload, { chat: privateChat });
      await waitReply((entry) => entry.chat.id === user.id && entry.text?.includes('ссылка недействительна'), 'просроченная ссылка');
      message(user, '/setup', { chat: privateChat });
      await waitReply((entry) => entry.chat.id === user.id && entry.text?.includes('/invite'), 'просроченная ссылка не занимает слот');
      database.prepare('UPDATE onboarding_invites SET expires = ? WHERE user_id = ?').run(Date.now() + 60_000, user.id);
      database.close();
      message(users[0], '/start ' + payload, { chat: { id: users[0].id, type: 'private' } });
      await waitReply((entry) => entry.chat.id === users[0].id && entry.text?.includes('ссылка недействительна'), 'чужой не может открыть приглашение');
      message(user, '/start ' + payload, { chat: privateChat });
    }
    const invite = await waitReply((entry) => entry.chat.id === user.id && entry.reply_markup, 'личная ссылка');
    const code = new URL(invite.reply_markup.inline_keyboard[0][0].url).hash.slice(1);
    const claim = await web('claim', { body: { code } });
    assert.equal(claim.status, 200);
    assert.equal((await web('claim', { body: { code } })).status, 410);
    const cookie = claim.headers.get('set-cookie').split(';')[0];
    cookies.push(cookie);
    if (index === 1) {
      assert.equal((await web('bot', { body: { token: personalToken } })).status, 401);
      assert.equal((await web('bot', { cookie, body: { token: 'wrong' } })).status, 400);
      const connected = await web('bot', { cookie, body: { token: personalToken } });
      assert.equal(connected.status, 200);
      assert.deepEqual(await connected.json(), { username: personalBot.username });
      const duplicate = await web('bot', { cookie: cookies[0], body: { token: personalToken } });
      assert.equal(duplicate.status, 409);
    }
    const name = index === 0 ? 'Архимед' : 'Софья';
    const started = await web('profile', { cookie, body: { name, instructions: 'Покажи ход рассуждения.', mode: 'connect' } });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).auth.code, 'TEST-TEST');
    await writeFile(join(homes[index], 'confirm'), '');
    await until(async () => (await (await web('status', { cookie })).json()).auth?.status === 'connected', 'вход в Codex');
    assert.equal((await (await web('status', { cookie })).json()).profile.name, name);
  }

  message(users[2], '/start', { chat: { id: users[2].id, type: 'private' } });
  await waitReply((entry) => entry.chat.id === users[2].id && entry.text.includes('/allow'), 'чужой не может подключить слот');

  message(users[2], 'Обычное сообщение о работе группы');
  message(personalBot, 'Ответ другого агента в общей группе');
  message(users[2], undefined, { document: { file_id: 'context-file', file_name: 'context.xlsx' } });
  const historyPath = join(dir, 'archive', String(group.id), 'history.jsonl');
  await until(async () => {
    const history = await readFile(historyPath, 'utf8').catch(() => '');
    return history.includes('Обычное сообщение о работе группы') && history.includes('Ответ другого агента в общей группе')
      && history.includes('/context.xlsx');
  }, 'переписка и вложение доступны до запуска');
  assert.equal((await turns(1)).length, 0);
  assert.equal((await turns(2)).length, 0);

  const beforeTask = messages.length;
  message(users[0], undefined, { caption: '/new Проверить проект', document: { file_id: 'file-one', file_name: 'brief.txt' } });
  const draft = await until(() => messages[beforeTask], 'карточка первого хода');
  assert.equal(draft.text, 'Проверить проект\n\nФайл · brief.txt');
  assert.equal(draft.reply_markup, undefined);
  message(users[2], '/run', { reply_to_message: draft });
  await waitReply((entry) => entry.text?.includes('Запуск доступен владельцу'), 'запрет чужой команды /run');

  const review = await waitReply((entry) => entry.text?.includes('запустить своего агента «Софья»'), 'запрос второго агента');
  assert.equal((await turns(1)).length, 1, '/new владельца сразу запускает один ход');
  const firstInput = (await turns(1))[0].params.input[0].text;
  assert.match(firstInput, /Обычное сообщение о работе группы/);
  assert.match(firstInput, /Ответ другого агента в общей группе/);
  assert.match(firstInput, /context\.xlsx/);
  assert.equal((await turns(2)).length, 0, 'запрос агента не запускает модель');
  assert.match(await readFile(join(homes[0], 'work', '1', 'input-brief.txt'), 'utf8'), /Текст задания/);
  assert.ok(messages.some((entry) => entry.text?.includes('Черновик ＠unknown')));

  const wrongOwner = click(users[0], review, review.reply_markup.inline_keyboard[0][0].callback_data);
  await until(() => callbacks.find((entry) => entry.callback_query_id === wrongOwner && entry.show_alert), 'один владелец не запускает другого');
  assert.equal((await turns(2)).length, 0);

  const reviewAction = review.reply_markup.inline_keyboard[0][0].callback_data;
  click(users[1], review, reviewAction);
  click(users[1], review, reviewAction);
  const question = await waitReply((entry) => entry.text?.includes('Какой датасет берём?'), 'вопрос своему владельцу');
  assert.match(question.text, /tg:\/\/user\?id=22/);
  assert.match((await turns(2))[0].params.input[0].text, /peer-\d+-draft.txt/);
  message(users[0], 'Чужой ответ', { reply_to_message: question });
  const attachment = message(users[1], undefined, {
    reply_to_message: question, media_group_id: 'album',
    document: { file_id: 'first', file_name: 'first.txt' },
  });
  await waitReply((entry) => entry.text?.includes('Ответ получен. Собираю файлы альбома'), 'подтверждение получения альбома');
  assert.equal((await turns(2)).length, 1, 'агент ждёт остальные файлы альбома');
  const sibling = message(users[1], undefined, {
    media_group_id: 'album', document: { file_id: 'second', file_name: 'second.txt' },
  });
  await waitReply((entry) => entry.text?.includes('Итог с учётом ответа.'), 'финальный ответ');
  await waitReply((entry) => entry.text === '<b>Софья</b> · Ход завершён', 'итоговый статус хода');
  assert.ok(statusEdits.includes('<b>Софья</b> · Работаю над задачей…'));
  for (const file of [attachment, sibling]) {
    assert.equal(await readFile(join(botEnv.TELEGRAM_ARCHIVE_DIR, String(group.id), 'files',
      String(group.id), String(file.message_id), file.document.file_name), 'utf8'), 'Текст задания');
  }
  assert.equal((await turns(2)).length, 2, 'двойное нажатие и чужой ответ не добавили ход');
  const second = (await turns(2))[1];
  const ownerAnswer = second.params.input[0].text.split('\n').find((line) => line.startsWith('Уточнение к этому ходу:'));
  assert.match(ownerAnswer, /Владелец приложил файл или альбом/);
  assert.doesNotMatch(ownerAnswer, /Чужой ответ/);
  assert.match(await readFile(join(homes[0], 'work', '1', 'AGENTS.md'), 'utf8'), /vps-info/);
  assert.ok((await getEvents(2)).some(({ method, params }) => method === 'thread/resume' && params.threadId === second.params.threadId));

  message(users[2], '/ask Проверь выводы', { reply_to_message: draft });
  const chooser = await waitReply((entry) => entry.text?.includes('Чей агент нужен?'), 'выбор агента участником');
  click(users[2], chooser, chooser.reply_markup.inline_keyboard[0][0].callback_data);
  const requested = await waitReply((entry) => entry.text?.includes('User 33 просит посмотреть задачу.'), 'запрос от участника');
  assert.match(requested.text, /Проверь выводы/);
  assert.equal((await turns(1)).length, 1);
  message(users[0], '/run Проверь цифры', { reply_to_message: requested });
  const next = await until(async () => (await turns(1))[1], '/run владельца');
  assert.match(next.params.input[0].text, /Проверь цифры/);
  const briefByMention = message(users[2], 'Проверь текст через упоминание');
  message(users[0], '@fixture_bot', { reply_to_message: briefByMention });
  const byMention = await until(async () => (await turns(1))[2], 'упоминание владельца');
  assert.match(byMention.params.input[0].text, /Проверь текст через упоминание/);
  for (const { params } of [...await turns(1), ...await turns(2)]) {
    assert.equal(params.model, 'gpt-6.2-sol');
    assert.equal(params.effort, 'low');
  }

  const exited = once(botProcess, 'exit');
  botProcess.kill('SIGTERM');
  await exited;
  const database = await readFile(join(botEnv.DATA_DIR, 'bot.sqlite'));
  assert.equal(database.includes(personalToken), false, 'токен зашифрован в базе');
  launch('src/bot.js', botEnv);
  await until(async () => (await fetch(publicUrl + '/health').catch(() => null))?.ok, 'бот перезапустился');
  const recovered = await (await web('status', { cookie: cookies[1] })).json();
  assert.equal(recovered.personalBot.username, personalBot.username);
  assert.equal(recovered.auth.status, 'connected');

  const beforePersonalTask = messages.length;
  message(users[0], '/new@fixture_personal_bot Попытка чужого запуска');
  message(users[1], '/new@fixture_personal_bot Проверка личного бота');
  await until(() => messages.slice(beforePersonalTask).find((entry) =>
    entry.from.id === personalBot.id && entry.text?.includes('Итог с учётом ответа.')), 'личный бот публикует результат после рестарта');
  assert.equal((await turns(2)).length, 3);
  assert.ok(!messages.slice(beforePersonalTask).some((entry) => entry.text?.includes('Попытка чужого запуска')));
});
