// Автоматический вход в Google: поднимает loopback-сервер, открывает браузер
// и ждёт, пока пользователь нажмёт «Разрешить». Один поток на процесс.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { loadCredentials, saveToken, loadToken, SCOPES, TOKEN_PATH } from './gcal.mjs';

const FIRST_PORT = Number(process.env.GCAL_PORT || 42813);
const PORT_ATTEMPTS = 5;
const FLOW_TIMEOUT_MS = Number(process.env.GCAL_AUTH_TIMEOUT_MS || 15 * 60_000);

/** Текущий незавершённый вход: { url, done }. Повторный вызов вернёт его же. */
let flow = null;

export function startAuthFlow() {
  if (!flow) flow = createFlow();
  return flow;
}

function openBrowser(url) {
  if (process.env.GCAL_NO_BROWSER) return;
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ссылку всё равно покажем в ответе инструмента */
  }
}

function buildAuthUrl({ clientId, redirectUri }) {
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
}

function createFlow() {
  let settle = null;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const state = { url: null, done, close: null, finished: false };

  const finish = (ok, payload) => {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(state.timer);
    try { state.close?.(); } catch { /* уже закрыт */ }
    if (flow === state) flow = null;
    ok ? settle.resolve(payload) : settle.reject(payload);
  };

  const listen = (port, left) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, state.url || 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');

      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>Доступ не выдан: ${err}</h2><p>Вкладку можно закрыть и повторить запрос.</p>`);
        finish(false, new Error(`Google вернул отказ: ${err}`));
        return;
      }
      if (!code) { res.writeHead(404); res.end('ok'); return; }

      try {
        const creds = loadCredentials();
        const body = new URLSearchParams({
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: state.url,
          grant_type: 'authorization_code',
        });
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`${j.error || r.status}: ${j.error_description || ''}`);

        const prev = loadToken() || {};
        const token = {
          access_token: j.access_token,
          refresh_token: j.refresh_token || prev.refresh_token,
          expiry_date: Date.now() + (j.expires_in || 3600) * 1000,
          scope: j.scope,
          saved_at: new Date().toISOString(),
        };
        saveToken(token);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Готово — календарь подключён.</h2><p>Можно закрыть вкладку и вернуться в чат.</p>');
        finish(true, token);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Не удалось обменять код</h2><p>Подробности в чате.</p>');
        finish(false, e);
      }
    });

    state.close = () => server.close();
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && left > 0) { listen(port + 1, left - 1); return; }
      finish(false, e);
    });
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      state.url = `http://127.0.0.1:${actual}`;
      try {
        const creds = loadCredentials();
        state.authUrl = buildAuthUrl({ clientId: creds.clientId, redirectUri: state.url });
        openBrowser(state.authUrl);
      } catch (e) {
        finish(false, e);
        return;
      }
      state.timer = setTimeout(() => {
        finish(false, new Error(`Не дождался подтверждения за ${Math.round(FLOW_TIMEOUT_MS / 60_000)} мин — авторизацию прервал`));
      }, FLOW_TIMEOUT_MS);
      state.timer.unref?.();
    });
  };

  listen(FIRST_PORT, PORT_ATTEMPTS);
  return state;
}
