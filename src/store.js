import { DatabaseSync } from 'node:sqlite';
import { hash, token } from './shared.js';

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (
      slot INTEGER PRIMARY KEY CHECK (slot IN (1, 2)),
      user_id INTEGER NOT NULL UNIQUE,
      telegram_name TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS tokens (
      digest TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES agents(user_id),
      kind TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      topic INTEGER NOT NULL UNIQUE,
      forum INTEGER NOT NULL,
      source INTEGER NOT NULL UNIQUE,
      owner INTEGER NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      attachment_name TEXT,
      attachment BLOB
    );
    CREATE TABLE IF NOT EXISTS task_messages (
      message INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS run_commands (message INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      owner INTEGER NOT NULL REFERENCES agents(user_id),
      kind TEXT NOT NULL,
      note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      prompt_message INTEGER,
      answer TEXT,
      thread_id TEXT,
      result TEXT,
      artifact_name TEXT,
      artifact BLOB
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_job
      ON jobs(task_id, owner) WHERE status IN ('pending', 'question', 'queued', 'running');
    CREATE INDEX IF NOT EXISTS job_queue ON jobs(status, id);
  `);

  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const agent = (id) => get('SELECT * FROM agents WHERE user_id = ?', id);
  const agents = () => all('SELECT * FROM agents ORDER BY slot');
  const task = (id) => get('SELECT * FROM tasks WHERE id = ?', id);
  const job = (id) => get('SELECT id, task_id, owner, kind, note, status, prompt_message, answer, thread_id, result FROM jobs WHERE id = ?', id);

  return {
    group: () => Number(get("SELECT value FROM settings WHERE key = 'group'")?.value || 0),
    bindGroup(id) {
      return run("INSERT OR IGNORE INTO settings VALUES ('group', ?)", String(id)).changes === 1;
    },
    migrateGroup(from, to) {
      run("UPDATE settings SET value = ? WHERE key = 'group' AND value = ?", String(to), String(from));
    },
    agent,
    agents,
    register(userId, name) {
      if (agent(userId)) {
        run('UPDATE agents SET telegram_name = ? WHERE user_id = ?', name, userId);
      } else {
        const slot = [1, 2].find((number) => !agents().some((entry) => entry.slot === number));
        if (!slot) return;
        run('INSERT INTO agents (slot, user_id, telegram_name) VALUES (?, ?, ?)', slot, userId, name);
      }
      return agent(userId);
    },
    saveProfile(id, name, instructions) {
      run('UPDATE agents SET name = ?, instructions = ? WHERE user_id = ?', name, instructions, id);
    },
    invite(id) {
      const code = token();
      run("DELETE FROM tokens WHERE expires < ? OR (user_id = ? AND kind = 'invite')", Date.now(), id);
      run("INSERT INTO tokens VALUES (?, ?, 'invite', ?)", hash(code), id, Date.now() + 10 * 60_000);
      return code;
    },
    exchange(code) {
      if (typeof code !== 'string' || code.length !== 43) return;
      const claim = get("DELETE FROM tokens WHERE digest = ? AND kind = 'invite' AND expires >= ? RETURNING user_id", hash(code), Date.now());
      if (!claim) return;
      const session = token();
      run("DELETE FROM tokens WHERE user_id = ? AND kind = 'browser'", claim.user_id);
      run("INSERT INTO tokens VALUES (?, ?, 'browser', ?)", hash(session), claim.user_id, Date.now() + 35 * 60_000);
      return session;
    },
    browser(session) {
      if (typeof session !== 'string' || session.length !== 43) return;
      const row = get("SELECT user_id FROM tokens WHERE digest = ? AND kind = 'browser' AND expires >= ?", hash(session), Date.now());
      return row && agent(row.user_id);
    },
    task,
    byTopic: (topic) => get('SELECT id, topic, forum, owner, title FROM tasks WHERE topic = ? AND forum = 1', topic),
    byMessage: (message) => get(`SELECT id, topic, forum, owner, title FROM tasks
      WHERE source = ? OR (topic = ? AND forum = 0) OR id = (SELECT task_id FROM task_messages WHERE message = ?)`,
    message, message, message),
    recordMessage(taskId, message) {
      run('INSERT OR IGNORE INTO task_messages VALUES (?, ?)', message, taskId);
    },
    firstRunCommand(message) {
      return run('INSERT OR IGNORE INTO run_commands VALUES (?)', message).changes === 1;
    },
    bySource: (source) => get('SELECT id FROM tasks WHERE source = ?', source),
    createTask({ topic, forum, source, owner, title, brief, attachment }) {
      const id = run(`INSERT INTO tasks (topic, forum, source, owner, title, brief, attachment_name, attachment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, topic, forum ? 1 : 0, source, owner, title, brief,
      attachment?.name ?? null, attachment?.bytes ?? null).lastInsertRowid;
      return task(id);
    },
    job,
    openJob(taskId, owner) {
      const row = get(`SELECT id FROM jobs WHERE task_id = ? AND owner = ?
        AND status IN ('pending', 'question', 'queued', 'running')`, taskId, owner);
      return row && job(row.id);
    },
    request(taskId, owner, kind, note, status = 'pending') {
      const row = get(`INSERT OR IGNORE INTO jobs (task_id, owner, kind, note, status)
        VALUES (?, ?, ?, ?, ?) RETURNING id`, taskId, owner, kind, note, status);
      return row && job(row.id);
    },
    recordPrompt(id, message) {
      run('UPDATE jobs SET prompt_message = ? WHERE id = ?', message, id);
    },
    answer(id, owner, replyTo, answer) {
      return run(`UPDATE jobs SET answer = ?, status = 'pending'
        WHERE id = ? AND owner = ? AND prompt_message = ? AND status = 'question'`, answer, id, owner, replyTo).changes === 1;
    },
    approve(id, owner, note = '') {
      return run(`UPDATE jobs SET status = 'queued', answer = CASE WHEN ? != '' THEN ? ELSE answer END
        WHERE id = ? AND owner = ? AND (status = 'pending' OR (status = 'question' AND ? != ''))`,
      note, note, id, owner, note).changes === 1;
    },
    decline(id, owner) {
      return run(`UPDATE jobs SET status = 'declined' WHERE id = ? AND owner = ? AND status IN ('pending', 'question')`,
        id, owner).changes === 1;
    },
    claim() {
      const row = get(`UPDATE jobs SET status = 'running' WHERE id = (
        SELECT next.id FROM jobs next WHERE next.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM jobs busy WHERE busy.status = 'running'
          AND (busy.owner = next.owner OR busy.task_id = next.task_id))
        ORDER BY next.id LIMIT 1) RETURNING id`);
      return row && job(row.id);
    },
    clearInterrupted() {
      run("UPDATE jobs SET status = 'failed' WHERE status = 'running'");
    },
    fail(id) {
      run("UPDATE jobs SET status = 'failed' WHERE id = ? AND status = 'running'", id);
    },
    finish(id, threadId, result, artifact) {
      run(`UPDATE jobs SET status = 'done', thread_id = ?, result = ?, artifact_name = ?, artifact = ?
        WHERE id = ? AND status = 'running'`, threadId, result, artifact?.name ?? null, artifact?.bytes ?? null, id);
    },
    thread(taskId, owner) {
      return get(`SELECT thread_id FROM jobs WHERE task_id = ? AND owner = ?
        AND thread_id IS NOT NULL ORDER BY id DESC LIMIT 1`, taskId, owner)?.thread_id;
    },
    history(taskId) {
      return all(`SELECT a.name, j.result FROM jobs j JOIN agents a ON a.user_id = j.owner
        WHERE task_id = ? AND j.status = 'done' ORDER BY j.id DESC LIMIT 6`, taskId).reverse();
    },
    peerArtifact(taskId, owner) {
      return get(`SELECT id, artifact_name AS name, artifact AS bytes FROM jobs
        WHERE task_id = ? AND owner != ? AND artifact IS NOT NULL ORDER BY id DESC LIMIT 1`, taskId, owner);
    },
  };
}
