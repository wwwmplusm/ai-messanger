import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Bot } from 'grammy';
import { HttpError } from './shared.js';

export function personalBots({ store, mainBot, apiRoot, onMessage }) {
  const configuredKey = process.env.AGENT_BOT_ENCRYPTION_KEY;
  const key = /^[0-9a-f]{64}$/i.test(configuredKey ?? '') ? Buffer.from(configuredKey, 'hex') : null;
  const running = new Map();
  let stopping = false;

  function encrypt(value, userId, botId) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${userId}:${botId}`));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  function decrypt({ user_id, bot_id, credential }) {
    if (!key) return;
    const bytes = Buffer.from(credential, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${user_id}:${bot_id}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }

  function build(token) {
    return new Bot(token, { client: { apiRoot } });
  }

  async function checkWebhook(bot) {
    const info = await bot.api.getWebhookInfo(AbortSignal.timeout(10_000));
    if (info.url) throw new HttpError(409, 'У бота уже настроен webhook. Отключи его в прежнем сервисе и попробуй снова.');
  }

  function logError(error) {
    console.error('Ошибка личного Telegram-бота', error.error_code || error.name);
  }

  function activate(userId, bot, token) {
    const previous = running.get(userId);
    const entry = { bot, token };
    running.set(userId, entry);
    bot.on('message', (ctx) => {
      if (running.get(userId) === entry && ctx.from?.id === userId) return onMessage(ctx, bot);
    });
    bot.catch(({ error }) => logError(error));
    void (async () => {
      try {
        if (previous) await previous.bot.stop();
        if (stopping || running.get(userId) !== entry) return;
        await bot.start({ allowed_updates: ['message'] });
      } catch (error) {
        logError(error);
      } finally {
        if (running.get(userId) === entry) running.delete(userId);
      }
    })();
  }

  return {
    enabled: Boolean(key),
    isRunning: (userId) => running.get(userId)?.bot.isRunning() ?? false,
    async send(userId, sendWith) {
      const personal = running.get(userId)?.bot.api;
      if (personal) {
        try {
          return await sendWith(personal);
        } catch (error) {
          if (![400, 401, 403].includes(error.error_code)) throw error;
          logError(error);
        }
      }
      return sendWith(mainBot.api);
    },
    async restore() {
      await Promise.all(store.personalBots().map(async (row) => {
        try {
          const token = decrypt(row);
          if (!token) throw new Error();
          const bot = build(token);
          await checkWebhook(bot);
          if (!running.has(row.user_id)) activate(row.user_id, bot, token);
        } catch (error) {
          logError(error);
        }
      }));
    },
    async connect(userId, token) {
      if (!key) throw new HttpError(503, 'Подключение личных ботов пока не включено на сервере.');
      if (!store.group()) throw new HttpError(409, 'Сначала администратор должен подключить общую группу.');
      if (typeof token !== 'string' || !/^\d{1,20}:[A-Za-z0-9_-]{10,100}$/.test(token)) {
        throw new HttpError(400, 'Вставь токен, который выдал BotFather.');
      }
      const bot = build(token);
      try {
        await bot.init(AbortSignal.timeout(10_000));
      } catch (error) {
        if ([401, 404].includes(error.error_code)) throw new HttpError(400, 'Telegram не принял токен. Проверь его в BotFather.');
        throw new HttpError(502, 'Telegram сейчас недоступен. Попробуй ещё раз.');
      }
      const { id, username } = bot.botInfo;
      if (id === mainBot.botInfo.id) throw new HttpError(409, 'Этот бот уже используется как общий бот группы.');
      try {
        await checkWebhook(bot);
        const member = await bot.api.getChatMember(store.group(), id, AbortSignal.timeout(10_000));
        if (!['administrator', 'creator', 'member'].includes(member.status)
          && !(member.status === 'restricted' && member.is_member && member.can_send_messages)) {
          throw new HttpError(400, `Сначала добавь @${username} в общую Telegram-группу и разреши ему отправлять сообщения.`);
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if ([400, 403].includes(error.error_code)) {
          throw new HttpError(400, `Сначала добавь @${username} в общую Telegram-группу.`);
        }
        throw new HttpError(502, 'Не удалось проверить бота в Telegram. Попробуй ещё раз.');
      }
      if (stopping) throw new HttpError(503, 'Сервис перезапускается. Попробуй ещё раз.');
      if (!store.savePersonalBot(userId, id, username, encrypt(token, userId, id))) {
        throw new HttpError(409, 'Этот бот уже закреплён за другим агентом.');
      }
      if (running.get(userId)?.token !== token) activate(userId, bot, token);
      return { username };
    },
    stop() {
      stopping = true;
      return Promise.allSettled(Array.from(running.values(), ({ bot }) => bot.stop()));
    },
  };
}
