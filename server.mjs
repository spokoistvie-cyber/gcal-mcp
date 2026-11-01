#!/usr/bin/env node
// MCP-сервер «Google Calendar» для Галины. Транспорт stdio, протокол MCP.
// Запуск вручную для проверки: node server.mjs  (общается JSON-RPC по stdin/stdout)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { api, eventSpan, fmtDate, toEventTime, TZ, AuthRequiredError } from './gcal.mjs';
import { startAuthFlow } from './authflow.mjs';

const server = new Server(
  { name: 'galina-calendar', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const CAL = {
  type: 'string',
  description: 'ID календаря. По умолчанию "primary" (основной). Список — через list_calendars.',
};

const TIME = {
  type: 'string',
  description: 'Момент времени: ISO с зоной (2026-11-02T10:00:00+03:00) или дата (2026-11-02) для события на весь день.',
};

const COLOR = {
  type: 'string',
  enum: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],
  description: 'Цвет события: 1 лаванда, 2 шалфей (зелёный), 3 виноград (сиреневый), 4 фламинго (коралловый), 5 банан (жёлтый), 6 мандарин (оранжевый), 7 павлин (бирюза), 8 графит (серый), 9 черника (синий), 10 базилик (тёмно-зелёный), 11 томат (красный).',
};

const TOOLS = [
  {
    name: 'list_calendars',
    description: 'Показать календари аккаунта: id, название, доступ. Нужно, чтобы узнать ID перед чтением чужого календаря.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_events',
    description: 'События за период по возрастанию времени. Возвращает eventId — он нужен для update_event и delete_event.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: CAL,
        timeMin: { type: 'string', description: 'Начало периода, ISO. По умолчанию — сейчас.' },
        timeMax: { type: 'string', description: 'Конец периода, ISO. По умолчанию — +7 дней от начала.' },
        query: { type: 'string', description: 'Поиск по тексту события.' },
        maxResults: { type: 'number', description: 'Сколько событий вернуть, по умолчанию 50.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_event',
    description: 'Создать событие. Если не указан конец — ставится час от начала (для событий на весь день — один день).',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: CAL,
        summary: { type: 'string', description: 'Название события.' },
        start: TIME,
        end: TIME,
        description: { type: 'string', description: 'Описание, ссылки, повестка.' },
        location: { type: 'string', description: 'Место или ссылка на Zoom.' },
        colorId: COLOR,
      },
      required: ['summary', 'start'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_event',
    description: 'Изменить событие: перенести, переименовать, поменять описание, место или цвет. Меняются только переданные поля.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: CAL,
        eventId: { type: 'string', description: 'ID события из list_events.' },
        summary: { type: 'string', description: 'Новое название.' },
        start: TIME,
        end: TIME,
        description: { type: 'string' },
        location: { type: 'string' },
        colorId: COLOR,
      },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_event',
    description: 'Удалить событие по eventId.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: CAL,
        eventId: { type: 'string', description: 'ID события из list_events.' },
      },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
];

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

function line(ev) {
  const title = ev.summary || '(без названия)';
  const where = ev.location ? ` · ${ev.location}` : '';
  return `• ${eventSpan(ev)} — ${title}${where}\n  id: ${ev.id}`;
}

function plusHour(t) {
  if (t?.date) {
    const d = new Date(t.date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return { date: d.toISOString().slice(0, 10) };
  }
  const d = new Date(t.dateTime);
  return { ...t, dateTime: new Date(d.getTime() + 3600_000).toISOString() };
}

async function handle(name, a = {}) {
  const calendarId = a.calendarId || 'primary';

  if (name === 'list_calendars') {
    const j = await api('/users/me/calendarList', { query: { maxResults: 100 } });
    const items = j.items || [];
    if (!items.length) return text('Календари не найдены.');
    return text(items.map((c) =>
      `• ${c.summary}${c.primary ? ' (основной)' : ''} — доступ: ${c.accessRole}\n  id: ${c.id}`).join('\n'));
  }

  if (name === 'list_events') {
    const timeMin = a.timeMin || new Date().toISOString();
    const defMax = new Date(new Date(timeMin).getTime() + 7 * 864e5).toISOString();
    const j = await api(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: {
        timeMin,
        timeMax: a.timeMax || defMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: a.maxResults || 50,
        q: a.query,
        timeZone: TZ,
      },
    });
    const items = (j.items || []).filter((e) => e.status !== 'cancelled');
    if (!items.length) return text(`Событий нет: ${fmtDate(timeMin, { withYear: true })} — ${fmtDate(a.timeMax || defMax, { withYear: true })}.`);
    return text(`${items.length} событий (${fmtDate(timeMin, { withYear: true })} — ${fmtDate(a.timeMax || defMax, { withYear: true })}):\n` + items.map(line).join('\n'));
  }

  if (name === 'create_event') {
    const start = toEventTime(a.start);
    const end = a.end ? toEventTime(a.end) : plusHour(start);
    const j = await api(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      body: {
        summary: a.summary,
        description: a.description,
        location: a.location,
        colorId: a.colorId,
        start,
        end,
      },
    });
    return text(`Создано: ${eventSpan(j)} — ${j.summary}${j.colorId ? ` (цвет ${j.colorId})` : ''}\n  id: ${j.id}\n  ${j.htmlLink || ''}`);
  }

  if (name === 'update_event') {
    const patch = {};
    if (a.summary !== undefined) patch.summary = a.summary;
    if (a.description !== undefined) patch.description = a.description;
    if (a.location !== undefined) patch.location = a.location;
    if (a.colorId !== undefined) patch.colorId = a.colorId;
    if (a.start !== undefined) patch.start = toEventTime(a.start);
    if (a.end !== undefined) patch.end = toEventTime(a.end);
    if (!Object.keys(patch).length) return text('Нечего менять: не передано ни одного поля.');
    const j = await api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(a.eventId)}`, {
      method: 'PATCH',
      body: patch,
    });
    return text(`Обновлено: ${eventSpan(j)} — ${j.summary}${j.colorId ? ` (цвет ${j.colorId})` : ''}\n  id: ${j.id}`);
  }

  if (name === 'delete_event') {
    await api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(a.eventId)}`, { method: 'DELETE' });
    return text(`Удалено: ${a.eventId}`);
  }

  throw new Error(`Неизвестный инструмент: ${name}`);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const AUTH_WAIT_MS = 45_000;

// Первое обращение к календарю без токена само поднимает вход в браузере.
async function callWithAuth(name, args) {
  try {
    return await handle(name, args);
  } catch (e) {
    if (!(e instanceof AuthRequiredError)) throw e;

    const flow = startAuthFlow();
    let flowError = null;
    const authorized = await Promise.race([
      flow.done.then(() => true).catch((err) => { flowError = err; return false; }),
      new Promise((r) => setTimeout(() => r(false), AUTH_WAIT_MS)),
    ]);

    if (authorized) return await handle(name, args);

    if (flowError) {
      return {
        content: [{ type: 'text', text: `Не удалось подключить календарь: ${flowError.message}` }],
        isError: true,
      };
    }
    const link = flow.url ? `\nЕсли окно не открылось — открой ссылку вручную: ${flow.url}` : '';
    return {
      content: [{
        type: 'text',
        text: `Подключаю Google Calendar: открыл браузер, выбери аккаунт и нажми «Разрешить».${link}\nКак подтвердишь — повтори запрос; второй раз разрешение не понадобится.`,
      }],
      isError: true,
    };
  }
}

let inFlight = 0;

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  inFlight++;
  try {
    return await callWithAuth(name, args || {});
  } catch (e) {
    return { content: [{ type: 'text', text: `Ошибка: ${e.message}` }], isError: true };
  } finally {
    inFlight--;
  }
});

process.on('uncaughtException', (e) => console.error('[calendar-mcp] ' + e.message));
process.on('unhandledRejection', (e) => console.error('[calendar-mcp] ' + (e?.message || e)));

await server.connect(new StdioServerTransport());
console.error('[calendar-mcp] готов, инструментов: ' + TOOLS.length);

// Клиент закрыл stdin — доработать начатые вызовы и выйти, не обрывая их.
function shutdownWhenIdle() {
  const deadline = Date.now() + 15_000;
  const tick = () => {
    if (inFlight === 0 || Date.now() > deadline) process.exit(0);
    else setTimeout(tick, 100);
  };
  setTimeout(tick, 150);
}
process.stdin.on('end', shutdownWhenIdle);
process.stdin.on('close', shutdownWhenIdle);
