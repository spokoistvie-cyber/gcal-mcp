// Общий слой доступа к Google Calendar: токены, обновление, вызов API.
// Никаких внешних зависимостей — только node:fs и fetch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const TOKEN_PATH = path.join(DIR, 'token.json');
export const CRED_PATH = path.join(DIR, 'credentials.json');
export const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export function loadCredentials() {
  if (!fs.existsSync(CRED_PATH)) {
    throw new Error(`Нет файла credentials.json в папке ${DIR}. Скачай OAuth client (Desktop app) в Google Cloud Console и положи туда.`);
  }
  const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  const c = raw.installed || raw.web;
  if (!c || !c.client_id || !c.client_secret) {
    throw new Error('credentials.json не похож на OAuth client: нет installed/web с client_id и client_secret.');
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

export function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`token.json повреждён: ${e.message}`);
  }
}

export function saveToken(t) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), 'utf8');
}

/** Календарь не авторизован — вызывающий код сам поднимает вход в браузере. */
export class AuthRequiredError extends Error {
  constructor(message = 'Нужна авторизация Google Calendar') {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = 'AUTH_REQUIRED';
  }
}

export async function getAccessToken() {
  const t = loadToken();
  if (!t) throw new AuthRequiredError('Календарь ещё не подключён');
  if (t.access_token && t.expiry_date && t.expiry_date > Date.now() + 60_000) return t.access_token;
  if (!t.refresh_token) throw new AuthRequiredError('В token.json нет refresh_token');
  const { clientId, clientSecret } = loadCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: t.refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === 'invalid_grant') {
      throw new AuthRequiredError('refresh_token больше не действует (Testing-режим или отозван)');
    }
    throw new Error(`Обновление токена не удалось: ${j.error || r.status} ${j.error_description || ''}`);
  }
  const next = { ...t, access_token: j.access_token, expiry_date: Date.now() + (j.expires_in || 3600) * 1000 };
  if (j.refresh_token) next.refresh_token = j.refresh_token;
  saveToken(next);
  return next.access_token;
}

export async function api(pathname, { method = 'GET', query, body } = {}) {
  const token = await getAccessToken();
  const url = new URL('https://www.googleapis.com/calendar/v3' + pathname);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  if (!r.ok) {
    const msg = json?.error?.message || text.slice(0, 400);
    throw new Error(`Google API ${r.status}: ${msg}`);
  }
  return json;
}

export const TZ = 'Europe/Moscow';

export function fmtDate(iso, { withTime = true, withYear = false } = {}) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts = {
    timeZone: TZ,
    day: '2-digit', month: '2-digit', weekday: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  };
  return new Intl.DateTimeFormat('ru-RU', opts).format(d).replace(',', '');
}

export function eventSpan(ev) {
  if (ev.start?.date) return `${fmtDate(ev.start.date, { withTime: false })} — весь день`;
  const a = fmtDate(ev.start?.dateTime);
  const b = ev.end?.dateTime ? new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(ev.end.dateTime)) : '';
  return b ? `${a}–${b}` : a;
}

// Приводит вход пользователя к формату Google: дата или dateTime с часовым поясом.
export function toEventTime(value, tz = TZ) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  const hasOffset = /[+-]\d{2}:\d{2}$/.test(value) || value.endsWith('Z');
  if (hasOffset) return { dateTime: value };
  return { dateTime: value, timeZone: tz };
}
