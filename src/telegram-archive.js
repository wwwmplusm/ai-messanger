import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export function telegramArchive(database, root) {
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS telegram_messages (
      chat INTEGER NOT NULL, source INTEGER NOT NULL, message INTEGER NOT NULL,
      timestamp INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (chat, source, message)
    );
    CREATE INDEX IF NOT EXISTS telegram_chronology ON telegram_messages (chat, timestamp, source, message);
  `);
  const upsert = db.prepare(`INSERT INTO telegram_messages VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat, source, message) DO UPDATE SET timestamp=excluded.timestamp, payload=excluded.payload`);
  const previous = db.prepare('SELECT payload FROM telegram_messages WHERE chat=? AND source=? AND message=?');
  const chronological = db.prepare('SELECT payload FROM telegram_messages WHERE chat=? ORDER BY timestamp, source, message');
  const latest = db.prepare(`SELECT payload FROM telegram_messages WHERE chat=?
    ORDER BY timestamp DESC, source DESC, message DESC LIMIT 24`);
  const timers = new Map();

  function flush(chat) {
    clearTimeout(timers.get(chat));
    timers.delete(chat);
    const dir = join(root, String(chat));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'history.jsonl');
    writeFileSync(path + '.tmp', chronological.all(chat).map(({ payload }) => payload).join('\n') + '\n');
    renameSync(path + '.tmp', path);
  }

  function schedule(chat) {
    if (timers.has(chat)) return;
    const timer = setTimeout(() => {
      try { flush(chat); } catch (error) { console.error('Архив Telegram', error.code || error.name); }
    }, 500);
    timer.unref();
    timers.set(chat, timer);
  }

  return {
    remember(chat, entry) {
      const prior = previous.get(chat, entry.source, entry.id);
      if (prior) {
        const payload = JSON.parse(prior.payload);
        entry = { ...payload, ...entry, file: entry.file ?? payload.file };
      }
      upsert.run(chat, entry.source, entry.id, entry.timestamp, JSON.stringify(entry));
      schedule(chat);
    },
    flush,
    recent(chat) {
      return latest.all(chat).reverse().map(({ payload }) => {
        const entry = JSON.parse(payload);
        return { ...entry, text: entry.text?.slice(0, 1200) };
      });
    },
  };
}
