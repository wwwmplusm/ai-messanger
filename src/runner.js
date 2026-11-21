import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { connectCodex } from './codex.js';
import { filename, HttpError, json, maxFileBytes, maxTurnMs, readJson, replyError, required, sameSecret } from './shared.js';

const home = resolve(required('DATA_DIR'));
const secret = required('RUNNER_SECRET');
const executable = process.env.CODEX_BIN || 'codex';
const workspaceRoot = join(home, 'work');
const authUrl = 'https://auth.openai.com/codex/device';
const codexHome = join(home, '.codex');
const loginTimeout = 15 * 60_000;
const maxRequest = Math.ceil(maxFileBytes * 8 / 3) + 250_000;
const model = 'gpt-6.2-sol';
const handbook = new URL('../AGENTS.md', import.meta.url);
const developerInstructions = await readFile(handbook, 'utf8');

await mkdir(codexHome, { recursive: true, mode: 0o700 });
await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
await writeFile(join(codexHome, 'config.toml'), `
approval_policy = "never"
cli_auth_credentials_store = "file"
default_permissions = "task"

[agents]
enabled = false

[features]
apps = false
plugins = false
browser_use = false
computer_use = false
image_generation = false

[permissions.task]
extends = ":workspace"

[permissions.task.filesystem]
":root" = "deny"
":minimal" = "read"
"${codexHome}/tmp" = "read"
"${codexHome}/auth.json" = "deny"
"/vps-info" = "read"

[permissions.task.network]
enabled = false
`, { mode: 0o600 });

let connection;
let login = { status: 'idle' };
let running = false;

async function client() {
  connection ??= connectCodex({ executable, home, cwd: workspaceRoot });
  try {
    const rpc = await connection;
    if (!rpc.isAlive()) {
      connection = undefined;
      return client();
    }
    return rpc;
  } catch (error) {
    connection = undefined;
    throw error;
  }
}

async function authState(rpc) {
  if (login.status === 'pending' && Date.now() < login.expires) return login;
  if (login.status === 'pending') {
    await rpc.call('account/login/cancel', { loginId: login.id }).catch(() => {});
    login = { status: 'expired' };
  }
  const { account } = await rpc.call('account/read', { refreshToken: false });
  if (account?.type === 'chatgpt') return { status: 'connected' };
  return login.status === 'connected' ? { status: 'idle' } : login;
}

async function beginLogin(rpc, restart) {
  if (running || login.status === 'starting') throw new HttpError(409, 'Агент занят. Попробуйте чуть позже.');
  const previous = login;
  if (previous.status === 'pending' && Date.now() < previous.expires && !restart) return previous;
  login = { status: 'starting' };
  try {
    if (previous.status === 'pending') {
      await rpc.call('account/login/cancel', { loginId: previous.id }).catch(() => {});
    }
    const response = await rpc.call('account/login/start', { type: 'chatgptDeviceCode' });
    if (response.type !== 'chatgptDeviceCode' || response.verificationUrl !== authUrl
      || !/^[A-Z0-9-]{5,20}$/i.test(response.userCode)) throw new Error('Неожиданный ответ Codex');
    login = {
      status: 'pending', id: response.loginId, code: response.userCode,
      url: authUrl, expires: Date.now() + loginTimeout,
    };
    function finish(method, params) {
      if (method !== 'account/login/completed' || params.loginId !== response.loginId) return;
      if (login.id === response.loginId) login = { status: params.success ? 'connected' : 'failed' };
      cleanup();
    }
    function cleanup() {
      rpc.events.off('notification', finish);
      rpc.events.off('disconnect', disconnected);
      clearTimeout(timeout);
    }
    function disconnected() {
      if (login.id === response.loginId) login = { status: 'failed' };
      cleanup();
    }
    const timeout = setTimeout(cleanup, loginTimeout + 5_000);
    timeout.unref();
    rpc.events.on('notification', finish);
    rpc.events.once('disconnect', disconnected);
    return login;
  } catch {
    login = { status: 'failed' };
    throw new HttpError(502, 'OpenAI не выдал код. Проверьте, разрешён ли вход по коду в настройках ChatGPT, и повторите.');
  }
}

const outputSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    action: { type: 'string', enum: ['done', 'ask_owner', 'request_peer'] },
    request: { type: 'string' },
    artifact: { type: 'string' },
  },
  required: ['message', 'action', 'request', 'artifact'],
  additionalProperties: false,
};

async function saveInput(cwd, input, prefix) {
  if (!input) return;
  if (typeof input.bytes !== 'string') throw new HttpError(400, 'Неверный формат файла.');
  const name = prefix + filename(input.name);
  const bytes = Buffer.from(input.bytes, 'base64');
  if (bytes.length > maxFileBytes) throw new HttpError(413, 'Файл больше 8 МБ.');
  try {
    await writeFile(join(cwd, name), bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const path = join(cwd, name);
  if (await realpath(path) !== path) throw new HttpError(400, 'Файл должен находиться в папке задачи.');
  return { name, path };
}

async function loadArtifact(cwd, name) {
  if (typeof name !== 'string' || !name || basename(name) !== name) return;
  let file;
  try {
    file = await open(join(cwd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxFileBytes) return;
    return { name: filename(name), bytes: (await file.readFile()).toString('base64') };
  } catch {
    return;
  } finally {
    await file?.close();
  }
}

async function runTurn(rpc, threadId, input) {
  let turnId;
  const messages = [];
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  function listen(method, params) {
    if (params?.threadId !== threadId) return;
    if (method === 'item/completed' && params.item.type === 'agentMessage') {
      messages.push({ turnId: params.turnId, phase: params.item.phase, text: params.item.text });
    }
    if (method === 'turn/completed') finish(params.turn);
  }
  const disconnected = () => finish(null);
  rpc.events.on('notification', listen);
  rpc.events.once('disconnect', disconnected);
  const timer = setTimeout(disconnected, maxTurnMs);
  timer.unref();
  try {
    const { turn } = await rpc.call('turn/start', { threadId, input, outputSchema, model, effort: 'low' });
    turnId = turn.id;
    const result = await completed;
    if (!result) {
      if (rpc.isAlive()) {
        await rpc.call('turn/interrupt', { threadId, turnId }).catch(() => {});
        rpc.close();
      }
      throw new HttpError(504, 'Codex не закончил ход вовремя. Владелец может запустить его снова.');
    }
    if (result.id !== turnId || result.status !== 'completed') {
      throw new HttpError(502, 'Codex не завершил ход. Проверьте аккаунт и лимиты, затем запустите снова.');
    }
    const answers = messages.filter((item) => item.turnId === turnId);
    const message = answers.findLast((item) => item.phase === 'final_answer')?.text ?? answers.at(-1)?.text;
    let parsed;
    try { parsed = JSON.parse(message); } catch {
      if (message?.trim()) return { message, action: 'done', request: '', artifact: '' };
    }
    if (!parsed || typeof parsed.message !== 'string' || !parsed.message.trim()
      || !outputSchema.properties.action.enum.includes(parsed.action) || typeof parsed.request !== 'string') {
      throw new HttpError(502, 'Codex вернул пустой или неполный ответ. Владелец может запустить его снова.');
    }
    return parsed;
  } catch (error) {
    if (!turnId) rpc.close();
    throw error;
  } finally {
    clearTimeout(timer);
    rpc.events.off('notification', listen);
    rpc.events.off('disconnect', disconnected);
  }
}

async function runJob(rpc, body) {
  if (running || ['starting', 'pending'].includes(login.status)) {
    throw new HttpError(409, 'Агент занят или ожидает входа в OpenAI.');
  }
  if (!Number.isSafeInteger(body.taskId) || body.taskId < 1 || !Number.isSafeInteger(body.jobId)
    || body.jobId < 1 || typeof body.prompt !== 'string') throw new HttpError(400, 'Неверная задача.');
  running = true;
  try {
    if ((await authState(rpc)).status !== 'connected') {
      throw new HttpError(409, 'Владельцу нужно подключить Codex через /setup.');
    }
    const cwd = join(workspaceRoot, String(body.taskId));
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (await realpath(cwd) !== cwd) throw new HttpError(400, 'Неверная папка задачи.');
    await copyFile(handbook, join(cwd, 'AGENTS.md'), constants.COPYFILE_EXCL).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const original = await saveInput(cwd, body.attachment, 'input-');
    const handoff = await saveInput(cwd, body.handoff, `peer-${body.jobId}-`);
    const options = { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never', permissions: 'task', model, developerInstructions };
    const { thread } = body.threadId
      ? await rpc.call('thread/resume', { ...options, threadId: body.threadId, excludeTurns: true })
      : await rpc.call('thread/start', options);
    const files = [original, handoff].filter(Boolean);
    const text = body.prompt + (files.length ? '\n\nФайлы в рабочей папке: ' + files.map((file) => file.name).join(', ') : '');
    const input = [
      { type: 'text', text, text_elements: [] },
      ...files.filter((file) => /\.(png|jpe?g|webp)$/i.test(file.name)).map((file) => ({ type: 'localImage', path: file.path })),
    ];
    const result = await runTurn(rpc, thread.id, input);
    const artifact = await loadArtifact(cwd, result.artifact);
    return {
      threadId: thread.id, action: result.action, request: result.request.slice(0, 1000),
      message: result.message.slice(0, 16_000), artifact,
    };
  } finally {
    running = false;
  }
}

const server = createServer(async (req, res) => {
  try {
    if (!sameSecret(req.headers.authorization, `Bearer ${secret}`)) throw new HttpError(401, 'Нет доступа.');
    const routes = ['GET /auth', 'POST /login', 'POST /run'];
    const route = `${req.method} ${req.url}`;
    if (!routes.includes(route)) throw new HttpError(404, 'Страница не найдена.');
    const body = req.method === 'POST' ? await readJson(req, route === 'POST /run' ? maxRequest : 4096) : null;
    const rpc = await client();
    if (route === 'GET /auth') json(res, 200, await authState(rpc));
    if (route === 'POST /login') json(res, 200, await beginLogin(rpc, body.restart === true));
    if (route === 'POST /run') json(res, 200, await runJob(rpc, body));
  } catch (error) {
    replyError(res, error);
  }
});
server.listen(Number(process.env.PORT || 8081), '0.0.0.0');
console.log('Codex runner готов.');
