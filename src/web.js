import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { HttpError, json, readJson, replyError, runnerRequest } from './shared.js';

const assets = new Map(await Promise.all([
  ['/', '../public/index.html', 'text/html; charset=utf-8'],
  ['/setup.js', '../public/setup.js', 'text/javascript; charset=utf-8'],
  ['/setup.css', '../public/setup.css', 'text/css; charset=utf-8'],
  ['/icon.svg', '../assets/icon.svg', 'image/svg+xml'],
].map(async ([url, path, type]) => [url, { type, body: await readFile(new URL(path, import.meta.url)) }])));

export function serveSetup({ store, personal, publicUrl, botUsername, port }) {
  const url = new URL(publicUrl);
  const secure = url.protocol === 'https:';
  const cookie = secure ? '__Host-agent_setup' : 'agent_setup';

  return createServer(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const { pathname } = new URL(req.url, url);
      if (req.method === 'GET' && assets.has(pathname)) {
        const { type, body } = assets.get(pathname);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      if (pathname === '/health') return json(res, 200, { status: 'ok' });
      if (req.method === 'POST' && req.headers.origin !== url.origin) throw new HttpError(403, 'Недопустимый источник запроса.');
      if (req.method === 'POST' && pathname === '/api/setup/claim') {
        const { code } = await readJson(req);
        const session = store.exchange(code);
        if (!session) throw new HttpError(410, 'Ссылка истекла или уже использована. Откройте новую через /setup в Telegram.');
        res.setHeader('Set-Cookie', `${cookie}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2100${secure ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      const session = req.headers.cookie?.split('; ').find((entry) => entry.startsWith(cookie + '='))?.slice(cookie.length + 1);
      const owner = store.browser(session);
      if (!owner) throw new HttpError(401, 'Откройте личную ссылку через /setup в Telegram.');

      if (req.method === 'GET' && pathname === '/api/setup/status') {
        const auth = await runnerRequest(owner, '/auth');
        const ownBot = store.personalBot(owner.user_id);
        return json(res, 200, {
          profile: { name: owner.name, instructions: owner.instructions, telegramName: owner.telegram_name },
          personalBot: {
            enabled: personal.enabled, username: ownBot?.username ?? null, running: personal.isRunning(owner.user_id),
          },
          auth,
          telegram: `https://t.me/${ownBot?.username ?? botUsername}`,
        });
      }
      if (req.method === 'POST' && pathname === '/api/setup/bot') {
        const { token } = await readJson(req);
        return json(res, 200, await personal.connect(owner.user_id, typeof token === 'string' ? token.trim() : token));
      }
      if (req.method === 'POST' && pathname === '/api/setup/profile') {
        const body = await readJson(req, 12_000);
        const name = String(body.name ?? '').trim().replace(/\s+/gu, ' ');
        const instructions = String(body.instructions ?? '').trim();
        if (!name || name.length > 32 || /[@\p{Cc}\p{Cf}]/u.test(name) || instructions.length > 2000) {
          throw new HttpError(400, 'Введите имя до 32 символов без @. Инструкции могут занимать до 2000 символов.');
        }
        if (store.agents().some((agent) => agent.user_id !== owner.user_id && agent.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
          throw new HttpError(409, 'Это имя уже занято другим агентом.');
        }
        store.saveProfile(owner.user_id, name, instructions);
        if (body.mode === 'save') return json(res, 200, { auth: { status: 'connected' } });
        const auth = await runnerRequest(owner, '/login', { restart: body.mode === 'restart' });
        return json(res, 200, { auth });
      }
      throw new HttpError(404, 'Страница не найдена.');
    } catch (error) {
      replyError(res, error);
    }
  }).listen(port, '0.0.0.0');
}
