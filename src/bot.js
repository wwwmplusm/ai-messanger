import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { filename, html, HttpError, maxFileBytes, required, runnerRequest, sameSecret } from './shared.js';
import { openStore } from './store.js';
import { serveSetup } from './web.js';

const botToken = required('TELEGRAM_BOT_TOKEN');
const publicUrl = new URL(required('PUBLIC_URL')).origin;
const data = required('DATA_DIR');
const apiRoot = process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org';
const bot = new Bot(botToken, { client: { apiRoot } });
await mkdir(data, { recursive: true, mode: 0o700 });
const store = openStore(join(data, 'bot.sqlite'));
if (process.env.TELEGRAM_GROUP_ID) {
  const group = Number(process.env.TELEGRAM_GROUP_ID);
  if (!Number.isSafeInteger(group) || group >= 0) throw new Error('TELEGRAM_GROUP_ID должен быть отрицательным числом.');
  store.bindGroup(group);
}
store.clearInterrupted();

const plain = (value) => html(String(value).replace(/@(?=[a-z0-9_])/gi, '＠'));
const mention = (agent) => `<a href="tg://user?id=${agent.user_id}">${html(agent.telegram_name)}</a>`;
const label = (agent) => agent.name || `Агент · ${agent.telegram_name}`;
const person = (user) => [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 64);
const fromGroup = (ctx) => ctx.chat?.id === store.group();
const messageOptions = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const topicOrReply = (task) => task.forum
  ? { message_thread_id: task.topic }
  : { reply_parameters: { message_id: task.topic, allow_sending_without_reply: true } };
const taskFor = (message) => {
  if (!message) return;
  return (message.message_thread_id && store.byTopic(message.message_thread_id))
    || store.byMessage(message.message_id)
    || (message.reply_to_message && store.byMessage(message.reply_to_message.message_id));
};

async function post(task, text, extra = {}) {
  const sent = await bot.api.sendMessage(store.group(), text, {
    ...topicOrReply(task), ...messageOptions, ...extra,
  });
  store.recordMessage(task.id, sent.message_id);
  return sent;
}

async function publishRequest(task, job) {
  const owner = store.agent(job.owner);
  const asking = job.status === 'question';
  const keyboard = new InlineKeyboard();
  if (!asking) keyboard.text(`Запустить «${label(owner)}»`, `run:${job.id}`);
  keyboard.text('Отклонить', `decline:${job.id}`);
  const header = asking ? 'нужен твой ответ' : `запустить своего агента «${plain(label(owner))}»?`;
  const sent = await post(task, `${mention(owner)}, ${header}\n\n${plain(job.note)}${asking ? '\n\nОтветь на это сообщение.' : ''}`, {
    reply_markup: keyboard,
  });
  store.recordPrompt(job.id, sent.message_id);
}

async function request(task, owner, kind, note, status = 'pending') {
  const job = store.request(task.id, owner.user_id, kind, note, status);
  if (!job) return false;
  try {
    await publishRequest(task, job);
    return true;
  } catch (error) {
    store.decline(job.id, owner.user_id);
    throw error;
  }
}

function requestKeyboard(task) {
  const buttons = new InlineKeyboard();
  for (const owner of store.agents()) {
    if (owner.name) buttons.text(`Попросить «${label(owner)}»`, `ask:${task.id}:${owner.slot}`).row();
  }
  return buttons;
}

async function isAdmin(chat, user) {
  const member = await bot.api.getChatMember(chat, user);
  return ['creator', 'administrator'].includes(member.status);
}

async function setup(ctx) {
  if (ctx.chat.type !== 'private') {
    if (fromGroup(ctx)) await ctx.reply('Открой личный чат с ботом, чтобы подключить или переименовать агента.', {
      reply_markup: new InlineKeyboard().url('Настроить агента', `https://t.me/${bot.botInfo.username}?start=setup`),
    });
    return;
  }
  if (!store.agent(ctx.from.id)) {
    return ctx.reply('Попроси администратора ответить /allow на твоё сообщение в группе.');
  }
  const member = await bot.api.getChatMember(store.group(), ctx.from.id);
  if (['left', 'kicked'].includes(member.status) || (member.status === 'restricted' && !member.is_member)) {
    return ctx.reply('Подключение доступно участникам группы.');
  }
  store.register(ctx.from.id, person(ctx.from));
  const link = `${publicUrl}/#${store.invite(ctx.from.id)}`;
  return ctx.reply('Открой личную ссылку, чтобы задать имя и подключить свой аккаунт Codex. Ссылка действует 10 минут.', {
    reply_markup: new InlineKeyboard().url('Открыть настройку', link),
    protect_content: true,
  });
}

async function listAgents(ctx) {
  const states = await Promise.all(store.agents().map(async (owner) => {
    const { status } = await runnerRequest(owner, '/auth').catch(() => ({}));
    const state = status === 'connected' && owner.name ? 'подключён' : 'ожидает настройки';
    return `${plain(label(owner))} · ${plain(owner.telegram_name)} · ${state}`;
  }));
  return ctx.reply(states.join('\n') || 'Администратор может закрепить два слота командой /allow.', { parse_mode: 'HTML' });
}

async function attachmentFrom(message) {
  const photo = message.photo?.at(-1);
  const item = message.document ?? photo;
  if (!item) return;
  if (item.file_size > maxFileBytes) throw new HttpError(413, 'Можно приложить один файл до 8 МБ.');
  const file = await bot.api.getFile(item.file_id);
  if (file.file_size > maxFileBytes) throw new HttpError(413, 'Можно приложить один файл до 8 МБ.');
  const response = await fetch(`${apiRoot}/file/bot${botToken}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new HttpError(502, 'Не удалось получить файл из Telegram.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxFileBytes) throw new HttpError(413, 'Можно приложить один файл до 8 МБ.');
  return { name: filename(item.file_name ?? 'photo.jpg'), bytes };
}

const creating = new Set();
async function newTask(ctx, input) {
  const message = ctx.message;
  if (store.bySource(message.message_id) || creating.has(message.message_id)) return;
  if (!store.agents().some((owner) => owner.name)) return ctx.reply('Сначала подключите хотя бы одного агента через /setup.');
  const ancestor = message.reply_to_message;
  const description = input || ancestor?.text || ancestor?.caption || '';
  if (!description && ![message, ancestor].some((entry) => entry?.document || entry?.photo)) {
    return ctx.reply('Напиши /new и условие задачи или добавь /new в подпись к файлу.');
  }
  creating.add(message.message_id);
  try {
    const attachment = await attachmentFrom(message) ?? (ancestor && await attachmentFrom(ancestor));
    const brief = description || 'Выполни задание из приложенного файла.';
    const title = Array.from(description.split('\n')[0].trim() || attachment?.name || 'Задача').slice(0, 95).join('');
    const forum = Boolean(ctx.chat.is_forum);
    const card = plain(brief.slice(0, 2300)) + (attachment ? '\n\nФайл · ' + plain(attachment.name) : '');
    const anchor = forum ? await bot.api.createForumTopic(ctx.chat.id, title) : await ctx.reply(card, messageOptions);
    const task = store.createTask({
      topic: forum ? anchor.message_thread_id : anchor.message_id,
      forum, source: message.message_id, owner: ctx.from.id, title, brief, attachment,
    });
    const owner = store.agent(ctx.from.id);
    const draft = owner?.name && store.request(task.id, owner.user_id, 'draft', 'Подготовь первый вариант решения.');
    const reply_markup = draft ? undefined : requestKeyboard(task);
    if (forum) await post(task, card, { reply_markup });
    else if (reply_markup) await bot.api.editMessageReplyMarkup(ctx.chat.id, anchor.message_id, { reply_markup });
    if (draft && store.approve(draft.id, ctx.from.id)) pump();
  } finally {
    creating.delete(message.message_id);
  }
}

async function runOwn(ctx, task, input) {
  const owner = store.agent(ctx.from.id);
  if (!owner?.name) return ctx.reply('Запуск доступен владельцу подключённого агента.');
  if (!store.firstRunCommand(ctx.message.message_id)) return;
  const replied = ctx.message.reply_to_message;
  const note = input || (replied?.from?.is_bot ? '' : replied?.text || replied?.caption || '');
  const job = store.openJob(task.id, owner.user_id)
    ?? store.request(task.id, owner.user_id, ctx.from.id === task.owner ? 'draft' : 'work', 'Владелец запустил агента командой /run.');
  if (job && store.approve(job.id, owner.user_id, note.slice(0, 4000))) {
    pump();
    if (job.prompt_message) {
      await bot.api.editMessageReplyMarkup(store.group(), job.prompt_message).catch(() => {});
    }
  } else {
    await ctx.reply(job?.status === 'question'
      ? 'Добавь ответ после /run или ответь прямо на вопрос агента.'
      : 'Этот агент уже в очереди или работает по задаче.');
  }
}

bot.on('message', async (ctx) => {
  const msg = ctx.message;
  if (fromGroup(ctx) && msg.migrate_to_chat_id) store.migrateGroup(ctx.chat.id, msg.migrate_to_chat_id);
  if (!ctx.from || ctx.from.is_bot || msg.sender_chat) return;
  const text = msg.text ?? msg.caption ?? '';
  const match = text.match(/^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (match?.[2] && match[2].toLowerCase() !== bot.botInfo.username.toLowerCase()) return;
  const command = match?.[1]?.toLowerCase();
  const input = match?.[3]?.trim() || '';
  if (['start', 'setup'].includes(command)) return setup(ctx);
  if (command === 'bind' && !store.group() && ctx.chat.type !== 'private'
    && process.env.GROUP_SETUP_CODE && sameSecret(input, process.env.GROUP_SETUP_CODE)
    && await isAdmin(ctx.chat.id, ctx.from.id) && store.bindGroup(ctx.chat.id)) {
    return ctx.reply('Группа подключена. Ответь /allow на сообщение каждого из двух владельцев Codex.');
  }
  if (!fromGroup(ctx)) return;
  if (command === 'allow') {
    if (!await isAdmin(ctx.chat.id, ctx.from.id)) return ctx.reply('Слоты назначает администратор группы.');
    const user = msg.reply_to_message?.from ?? ctx.from;
    if (!user || user.is_bot || msg.reply_to_message?.sender_chat) return ctx.reply('Ответь /allow на сообщение человека.');
    const owner = store.register(user.id, person(user));
    if (!owner) return ctx.reply('Оба слота уже закреплены.');
    return ctx.reply(`${mention(owner)}, твой слот готов. Открой ссылку в личном чате с ботом.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().url('Настроить агента', `https://t.me/${bot.botInfo.username}?start=setup`),
    });
  }
  if (command === 'agents') return listAgents(ctx);
  if (command === 'new') {
    try {
      return await newTask(ctx, input);
    } catch (error) {
      if (error instanceof HttpError) return ctx.reply(error.message);
      throw error;
    }
  }
  const task = taskFor(msg);
  if (!task) {
    if (['ask', 'run'].includes(command)) return ctx.reply('Ответь этой командой на карточку задачи или напиши её внутри темы.');
    return;
  }
  store.recordMessage(task.id, msg.message_id);
  if (command === 'run') return runOwn(ctx, task, input);
  if (command === 'ask') {
    const other = store.agents().find((owner) => owner.user_id !== ctx.from.id && owner.name);
    if (other && store.agent(ctx.from.id)) {
      const sent = await request(task, other, 'review', input || 'Посмотри задачу и дай свой комментарий.');
      if (!sent) await ctx.reply('У этого владельца уже есть открытый запрос по задаче.');
      return;
    }
    return post(task, 'Чей агент нужен?' + (input ? '\n\n' + plain(input.slice(0, 1000)) : ''), {
      reply_markup: requestKeyboard(task),
    });
  }
  const job = store.openJob(task.id, ctx.from.id);
  if (job?.status === 'question' && text.trim() && store.answer(job.id, ctx.from.id, msg.reply_to_message?.message_id ?? 0, text.slice(0, 4000))) {
    pump();
    await bot.api.editMessageReplyMarkup(store.group(), job.prompt_message).catch(() => {});
  }
});

bot.on('callback_query:data', async (ctx) => {
  if (!fromGroup(ctx)) return ctx.answerCallbackQuery();
  const data = ctx.callbackQuery.data;
  const ask = data.match(/^ask:(\d+):([12])$/);
  if (ask) {
    const task = store.task(Number(ask[1]));
    const owner = store.agents().find((entry) => entry.slot === Number(ask[2]) && entry.name);
    if (!task || !owner || taskFor(ctx.callbackQuery.message)?.id !== task.id) return ctx.answerCallbackQuery('Запрос недоступен.');
    const note = ctx.callbackQuery.message?.text?.match(/^Чей агент нужен\?\n\n([\s\S]+)$/)?.[1];
    const sent = await request(task, owner, 'review', `${person(ctx.from)} просит посмотреть задачу.${note ? '\n' + note : ''}`);
    return ctx.answerCallbackQuery(sent ? 'Запрос отправлен. Решение за владельцем.' : 'Запрос уже открыт.');
  }
  const decision = data.match(/^(run|decline):(\d+)$/);
  if (!decision) return ctx.answerCallbackQuery();
  const job = store.job(Number(decision[2]));
  if (!job || job.owner !== ctx.from.id) {
    return ctx.answerCallbackQuery({ text: 'Управлять запуском может только владелец агента.', show_alert: true });
  }
  const accept = decision[1] === 'run';
  const changed = accept ? store.approve(job.id, ctx.from.id) : store.decline(job.id, ctx.from.id);
  if (!changed) return ctx.answerCallbackQuery('Запрос уже обработан.');
  if (accept) pump();
  await ctx.answerCallbackQuery(accept ? 'Агент поставлен в очередь.' : 'Запрос отклонён.');
  await ctx.editMessageReplyMarkup().catch(() => {});
});

function toWire(name, bytes) {
  return bytes ? { name, bytes: Buffer.from(bytes).toString('base64') } : undefined;
}

function makePrompt(task, owner, job) {
  const role = {
    draft: 'Подготовь решение. Если черновик полезно проверить, попроси ревью второго агента.',
    review: 'Проверь работу по критериям из условия. Если нужны существенные правки, попроси второго агента доработать.',
    revision: 'Учти замечания и представь итоговое решение.',
    work: 'Действуй по запросу владельца и по условию задачи.',
  }[job.kind];
  return `Ты агент «${owner.name}» в общей учебной задаче. Отвечай на языке участников.
${role}
Ход запускается действием владельца. Ты можешь предложить следующее действие.
Выбирай action: done — результат готов; request_peer — нужен ход второго агента; ask_owner — остановись и задай один конкретный вопрос своему владельцу.
В message напиши содержательный результат текущего хода. В request укажи текст вопроса или запроса. Для done верни пустой request.
В artifact укажи имя одного созданного файла в корне рабочей папки для передачи в Telegram и второму агенту или оставь пустым.
Профиль владельца: ${JSON.stringify(owner.instructions)}
Условие: ${JSON.stringify(task.brief)}
Причина текущего хода: ${JSON.stringify(job.note)}
Уточнение к этому ходу: ${JSON.stringify(job.answer ?? '')}
Предыдущие ходы: ${JSON.stringify(store.history(task.id).map(({ name, result }) => ({ name, result: result.slice(0, 7500) })))}`;
}

async function execute(job) {
  const task = store.task(job.task_id);
  const owner = store.agent(job.owner);
  try {
    const peerFile = store.peerArtifact(task.id, owner.user_id);
    const result = await runnerRequest(owner, '/run', {
      taskId: task.id,
      jobId: job.id,
      threadId: store.thread(task.id, owner.user_id),
      prompt: makePrompt(task, owner, job),
      attachment: toWire(task.attachment_name, task.attachment),
      handoff: peerFile && toWire(peerFile.name, peerFile.bytes),
    });
    const artifact = result.artifact && { name: result.artifact.name, bytes: Buffer.from(result.artifact.bytes, 'base64') };
    store.finish(job.id, result.threadId, result.message, artifact);
    const chars = Array.from(result.message);
    for (let index = 0; index < chars.length; index += 3200) {
      const content = chars.slice(index, index + 3200).join('');
      await post(task, `<b>${plain(label(owner))}</b>\n\n${plain(content)}`);
    }
    if (artifact) {
      const sent = await bot.api.sendDocument(store.group(), new InputFile(artifact.bytes, artifact.name), topicOrReply(task));
      store.recordMessage(task.id, sent.message_id);
    }
    if (result.action === 'ask_owner' && result.request.trim()) {
      await request(task, owner, job.kind, result.request, 'question');
    }
    if (result.action === 'request_peer' && result.request.trim()) {
      const peer = store.agents().find((agent) => agent.user_id !== owner.user_id && agent.name);
      if (peer) await request(task, peer, job.kind === 'review' ? 'revision' : 'review', `${label(owner)} · ${result.request}`);
    }
  } catch (error) {
    store.fail(job.id);
    const message = error instanceof HttpError ? error.message : 'Не удалось завершить ход или опубликовать ответ.';
    await post(task, `${mention(owner)}, ${plain(message)}\nОтветь /run на карточку или запрос, чтобы запустить ещё раз.`).catch(() => {});
    console.error('Ошибка хода', job.id, error.name, error.code || '');
  }
}

let stopping = false;
function pump() {
  if (stopping) return;
  let job;
  while ((job = store.claim())) {
    void execute(job).finally(pump);
  }
}

bot.catch(({ error }) => console.error('Ошибка Telegram', error.method || error.name, error.error_code || ''));
await bot.init();
const web = serveSetup({ store, publicUrl, botUsername: bot.botInfo.username, port: Number(process.env.PORT || 8080) });
await bot.api.setMyCommands([
  { command: 'new', description: 'Создать задачу' },
  { command: 'run', description: 'Запустить своего агента по задаче' },
  { command: 'ask', description: 'Попросить другого владельца запустить агента' },
  { command: 'agents', description: 'Кто подключён' },
  { command: 'setup', description: 'Подключить или переименовать своего агента' },
]).catch(() => {});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    web.close();
    void bot.stop();
  });
}
pump();
console.log('Telegram-бот готов.');
await bot.start({ allowed_updates: ['message', 'callback_query'] });
