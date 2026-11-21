import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';

export const maxFileBytes = 8 * 1024 * 1024;
export const maxTurnMs = 12 * 60 * 1000;
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string'
  && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export const html = (value) => String(value).replace(/[&<>"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
})[character]);

export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Укажите ${name}`);
  return value;
}

export function filename(value) {
  const cleaned = basename(String(value || 'file').replaceAll('\\', '/'))
    .replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 100);
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : 'file';
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJson(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Неверный формат запроса.');
  }
}

export function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

export function replyError(res, error) {
  const code = error instanceof HttpError ? error.status : 500;
  if (code === 500) console.error('Ошибка сервиса', error.name, error.code || '');
  json(res, code, { error: code === 500 ? 'Внутренняя ошибка. Попробуйте ещё раз.' : error.message });
}

export async function runnerRequest(owner, path, body) {
  const { request } = await import('undici');
  const timeout = path === '/run' ? maxTurnMs + 90_000 : 25_000;
  const response = await request(new URL(path, required(`RUNNER_${owner.slot}_URL`)), {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${required(`RUNNER_${owner.slot}_SECRET`)}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
    headersTimeout: timeout,
    bodyTimeout: timeout,
    signal: AbortSignal.timeout(timeout),
  }).catch((error) => {
    console.error('Связь с агентом', owner.slot, path, error.code || error.name);
    throw new HttpError(503, 'Агент недоступен. Попробуйте ещё раз.');
  });
  const result = await response.body.json();
  if (response.statusCode >= 400) throw new HttpError(response.statusCode, result.error);
  return result;
}
