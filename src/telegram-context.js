import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { filename } from './shared.js';

export function telegramContext({ archive, root, download }) {
  const pending = new Map();

  function capture(chat, message, fallback, fetchFile = download) {
    if (!archive || !message?.message_id || message.chat?.id !== chat) return;
    const item = message.document ?? message.photo?.at(-1) ?? message.video ?? message.audio
      ?? message.voice ?? message.animation ?? message.video_note ?? message.sticker;
    const text = message.text ?? message.caption ?? fallback;
    if (!text && !item) return;
    const entry = {
      source: chat, id: message.message_id, timestamp: message.date || Math.floor(Date.now() / 1000),
      author: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || message.sender_chat?.title || 'Telegram',
      ...(message.from?.username && { username: message.from.username }),
      ...(message.from?.is_bot && { bot: true }),
      ...(message.message_thread_id && { topic: message.message_thread_id }),
      ...(message.reply_to_message?.message_id && { replyTo: message.reply_to_message.message_id }),
      ...(message.media_group_id && { album: message.media_group_id }),
      ...(text && { text }),
    };
    if (item) entry.media = filename(item.file_name || (message.photo ? 'photo.jpg' : message.voice ? 'voice.ogg' : 'telegram-file'));
    archive.remember(chat, entry);
    if (!item?.file_id) return;
    const relative = `files/${chat}/${entry.id}/${entry.media}`;
    const path = join(root, String(chat), relative);
    if (pending.has(path)) return;
    const work = (async () => {
      if (!await stat(path).then((file) => file.isFile(), () => false)) {
        const bytes = await fetchFile(item, 20 * 1024 * 1024);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes, { flag: 'wx' }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
      archive.remember(chat, { ...entry, file: relative });
    })().catch((error) => console.error('Вложение Telegram', entry.id, error.error_code || error.status || error.code || error.name))
      .finally(() => pending.delete(path));
    pending.set(path, { chat, work });
  }

  return {
    capture,
    async prepare(chat) {
      if (!archive) return;
      await Promise.all([...pending.values()].filter((entry) => entry.chat === chat).map((entry) => entry.work));
      archive.flush(chat);
      return { recent: archive.recent(chat), chat };
    },
  };
}
