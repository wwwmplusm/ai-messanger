import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { telegramArchive } from '../src/telegram-archive.js';
import { telegramContext } from '../src/telegram-context.js';

test('Telegram context preserves ordinary messages, bot replies and attachments in their group', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-messanger-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = telegramArchive(join(root, 'db.sqlite'), root);
  const telegram = telegramContext({ root, archive, download: async (file) => Buffer.from(file.file_id) });
  const capture = (id, body, chat = -123) => telegram.capture(-123, {
    chat: { id: chat }, message_id: id, date: id, from: { first_name: 'Марк' }, ...body,
  });
  capture(1, { text: 'Обычное сообщение без команды' });
  capture(2, { text: 'Ответ агента', from: { first_name: 'Другой агент', is_bot: true },
    reply_to_message: { message_id: 1 } });
  capture(3, { document: { file_id: 'workbook bytes', file_name: 'table.xlsx' } });
  capture(4, { text: 'Другая группа' }, -456);

  const context = await telegram.prepare(-123);
  const saved = (await readFile(join(root, '-123', 'history.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(saved.map((entry) => entry.id), [1, 2, 3]);
  assert.equal(saved[0].text, 'Обычное сообщение без команды');
  assert.equal(saved[1].bot, true);
  assert.equal(saved[1].replyTo, 1);
  assert.equal(await readFile(join(root, '-123', saved[2].file), 'utf8'), 'workbook bytes');
  assert.deepEqual(JSON.parse(JSON.stringify(context.recent)), saved);
});
