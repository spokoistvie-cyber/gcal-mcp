#!/usr/bin/env node
// MCP-сервер «Google Calendar». Транспорт stdio, протокол MCP.
// Ручная проверка: node server.mjs  (общается JSON-RPC по stdin/stdout)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { api, eventSpan, fmtDate, toEventTime, TZ, AuthRequiredError } from './gcal.mjs';
import { startAuthFlow } from './authflow.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------- версия ----------
function readVersion() {
  let v = '?';
  try {
    v = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8')).version || '?';
  } catch { /* без package.json */ }
  let hash = '';
  try {
    const head = fs.readFileSync(path.join(DIR, '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5).trim() : head;
    const file = ref.includes('/') ? path.join(DIR, '.git', ref) : path.join(DIR, '.git', 'HEAD');
    hash = fs.readFileSync(file, 'utf8').trim().slice(0, 7);
  } catch { /* распакованный архив — нормально */ }
  return hash ? `${v}+${hash}` : v;
}
const VERSION = readVersion();

// ---------- цвета ----------
const COLORS = {
  1: 'лаванда', 2: 'шалфей', 3: 'виноград', 4: 'фламинго', 5: 'банан', 6: 'мандарин',
  7: 'павлин', 8: 'графит', 9: 'черника', 10: 'базилик', 11: 'томат',
};
const colorLabel = (id) => (id && COLORS[id] ? `[${id} ${COLORS[id]}]` : '[без цвета]');

const COLOR = {
  type: 'string',
  enum: Object.keys(COLORS),
  description: 'Цвет, строка "1"–"11": 1 лаванда, 2 шалфей (зелёный), 3 виноград (сиреневый), 4 фламинго (коралловый), 5 банан (жёлтый), 6 мандарин (оранжевый), 7 павлин (бирюза), 8 графит (серый), 9 черника (синий), 10 базилик (тёмно-зелёный), 11 томат (красный).',
};

const CAL = {
  type: 'string',
  description: 'ID календаря. "primary" — основной, "all" — сразу все календари аккаунта.',
};

const TIME = {
  type: 'string',
  description: 'Момент времени: ISO с зоной (2026-11-02T10:00:00+03:00) или дата (2026-11-02) для события на весь день.',
};

const SCOPE = {
  type: 'string',
  enum: ['instance', 'series', 'following'],
  description: 'Что менять у повторяющегося: instance — только этот раз (по умолчанию), series — всю серию, following — этот и все следующие.',
};

const TOOLS = [
  {
    name: 'list_calendars',
    description: 'Календари аккаунта: id, название, права. Нужно, чтобы узнать ID перед чтением чужого календаря.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_events',
    description: 'События за период по возрастанию времени. Показывает цвет и ID; у повторяющихся — recurringEventId серии.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: CAL,
        timeMin: { type: 'string', description: 'Начало периода, ISO. По умолчанию — сейчас.' },
        timeMax: { type: 'string', description: 'Конец периода, ISO. По умолчанию — +7 дней.' },
        query: { type: 'string', description: 'Поиск по тексту события.' },
        maxResults: { type: 'number', description: 'Сколько событий вернуть, по умолчанию 50 (для "all" — на календарь).' },
        onlyNoColor: { type: 'boolean', description: 'Только события без цвета — перед покраской.' },
        colorId: COLOR,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_event',
    description: 'Создать событие. Без конца — ставится час от начала.',
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
    description: 'Изменить событие: перенести, переименовать, поменять описание, место или цвет. Меняются только переданные поля. Для серий — scope.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: CAL,
        eventId: { type: 'string', description: 'ID события или экземпляра из list_events.' },
        scope: SCOPE,
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
    name: 'color_events',
    description: 'Покрасить много событий одним вызовом. Возвращает отчёт: сколько покрашено и где ошибки.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: CAL,
        ids: { type: 'array', items: { type: 'string' }, description: 'ID событий из list_events.' },
        colorId: COLOR,
        scope: SCOPE,
      },
      required: ['ids', 'colorId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_event',
    description: 'Удалить событие. Для серии — scope: series.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: CAL,
        eventId: { type: 'string', description: 'ID события из list_events.' },
        scope: { type: 'string', enum: ['instance', 'series'], description: 'instance — только этот раз (по умолчанию), series — всю серию.' },
      },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const errText = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function line(ev, prefix = '') {
  const title = ev.summary || '(без названия)';
  const where = ev.location ? ` · ${ev.location}` : '';
  const series = ev.recurringEventId ? `\n     серия: ${ev.recurringEventId}` : '';
  return `${prefix}• ${eventSpan(ev)} — ${title}${where} ${colorLabel(ev.colorId)}\n  id: ${ev.id}${series}`;
}

function plusHour(t) {
  if (t?.date) {
    const d = new Date(t.date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return { date: d.toISOString().slice(0, 10) };
  }
  return { ...t, dateTime: new Date(new Date(t.dateTime).getTime() + 3600_000).toISOString() };
}

const enc = encodeURIComponent;
const evPath = (cal, id) => `/calendars/${enc(cal)}/events${id ? '/' + enc(id) : ''}`;
const getEvent = (cal, id) => api(evPath(cal, id));
const patchEvent = (cal, id, body) => api(evPath(cal, id), { method: 'PATCH', body });

async function listCalendars() {
  const j = await api('/users/me/calendarList', { query: { maxResults: 100 } });
  return j.items || [];
}

// ---------- серии ----------
async function applyWithScope(cal, eventId, patch, scope) {
  const inst = await getEvent(cal, eventId);
  const masterId = inst.recurringEventId || (inst.recurrence ? inst.id : null);

  if (!scope || scope === 'instance' || !masterId) {
    return { event: await patchEvent(cal, eventId, patch), scope: 'instance' };
  }

  const master = await getEvent(cal, masterId);

  if (scope === 'series') {
    return { event: await patchEvent(cal, masterId, patch), scope: 'series' };
  }

  // following: обрезаем старую серию и создаём новую с этого экземпляра
  const rule = (master.recurrence || [])[0] || `RRULE:FREQ=WEEKLY;BYDAY=${['SU','MO','TU','WE','TH','FR','SA'][new Date(inst.start.dateTime || inst.start.date).getUTCDay()]}`;
  const until = new Date(new Date(inst.start.dateTime || inst.start.date).getTime() - 1000);
  const untilStr = until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const truncated = (rule.replace(/;?UNTIL=[^;]*/g, '') || 'RRULE:FREQ=WEEKLY') + `;UNTIL=${untilStr}`;
  await patchEvent(cal, masterId, { recurrence: [truncated] });

  const newRule = rule.replace(/;?UNTIL=[^;]*/g, '') || 'RRULE:FREQ=WEEKLY';
  const created = await api(evPath(cal), {
    method: 'POST',
    body: {
      summary: patch.summary ?? inst.summary,
      description: patch.description ?? inst.description,
      location: patch.location ?? inst.location,
      colorId: patch.colorId ?? inst.colorId,
      start: patch.start ?? inst.start,
      end: patch.end ?? inst.end,
      recurrence: [newRule],
    },
  });
  return { event: created, scope: 'following' };
}

// ---------- обработчики ----------
async function handle(name, a = {}) {
  const calendarId = a.calendarId || 'primary';

  if (name === 'list_calendars') {
    const items = await listCalendars();
    if (!items.length) return text('Календари не найдены.');
    return text(items.map((c) =>
      `• ${c.summary}${c.primary ? ' (основной)' : ''} — доступ: ${c.accessRole}\n  id: ${c.id}`).join('\n'));
  }

  if (name === 'list_events') {
    const timeMin = a.timeMin || new Date().toISOString();
    const timeMax = a.timeMax || new Date(new Date(timeMin).getTime() + 7 * 864e5).toISOString();
    const perCal = a.maxResults || 50;

    const cals = calendarId === 'all'
      ? (await listCalendars()).filter((c) => !c.id.includes('holiday'))
      : [{ id: calendarId, summary: null }];

    const collected = [];
    for (const c of cals) {
      try {
        const j = await api(evPath(c.id), { query: {
          timeMin, timeMax, singleEvents: true, orderBy: 'startTime',
          maxResults: perCal, q: a.query, timeZone: TZ } });
        for (const e of j.items || []) {
          if (e.status === 'cancelled') continue;
          if (a.onlyNoColor && e.colorId) continue;
          if (a.colorId && e.colorId !== String(a.colorId)) continue;
          collected.push({ ...e, __cal: c.summary });
        }
      } catch (e) {
        collected.push({ __error: `календарь ${c.summary || c.id}: ${e.message}` });
      }
    }

    const errors = collected.filter((e) => e.__error).map((e) => e.__error);
    const events = collected.filter((e) => !e.__error)
      .sort((x, y) => new Date(x.start.dateTime || x.start.date) - new Date(y.start.dateTime || y.start.date));

    const head = `${events.length} событий (${fmtDate(timeMin, { withYear: true })} — ${fmtDate(timeMax, { withYear: true })})`;
    if (!events.length) return text(`${head}: ничего не найдено.` + (errors.length ? `\n${errors.join('\n')}` : ''));

    const body = events.map((e) => line(e, e.__cal ? `[${e.__cal}] ` : '')).join('\n');
    const tail = errors.length ? `\n\nне прочитано:\n${errors.join('\n')}` : '';
    return text(`${head}:\n${body}${tail}`);
  }

  if (name === 'create_event') {
    const start = toEventTime(a.start);
    const end = a.end ? toEventTime(a.end) : plusHour(start);
    const j = await api(evPath(calendarId), { method: 'POST', body: {
      summary: a.summary, description: a.description, location: a.location,
      colorId: a.colorId, start, end } });
    return text(`Создано: ${eventSpan(j)} — ${j.summary} ${colorLabel(j.colorId)}\n  id: ${j.id}\n  ${j.htmlLink || ''}`);
  }

  if (name === 'update_event') {
    const known = ['calendarId', 'eventId', 'scope', 'summary', 'start', 'end', 'description', 'location', 'colorId'];
    const patch = {};
    if (a.summary !== undefined) patch.summary = a.summary;
    if (a.description !== undefined) patch.description = a.description;
    if (a.location !== undefined) patch.location = a.location;
    if (a.colorId !== undefined) patch.colorId = String(a.colorId);
    if (a.start !== undefined) patch.start = toEventTime(a.start);
    if (a.end !== undefined) patch.end = toEventTime(a.end);

    if (patch.colorId && !COLORS[patch.colorId]) {
      return errText(`Неизвестный цвет "а.colorId": допустимо 1–11.`);
    }

    if (!Object.keys(patch).length) {
      const sent = Object.keys(a).filter((k) => !known.includes(k));
      if (sent.length) {
        return errText(
          `Получены поля: ${sent.join(', ')} — но ни одно из них инструмент не знает.\n` +
          `Ожидаются: summary, start, end, description, location, colorId.\n` +
          `Похоже, клиент отправил их по старой схеме. Перезапуска приложения мало — нужна НОВАЯ сессия: ` +
          `список инструментов фиксируется при её старте.`);
      }
      return errText(
        `Вызов пустой: пришёл только eventId, ни одного поля для изменения.\n` +
        `Если вы передавали colorId (или другое поле) — клиент его отбросил: в этой сессии схема инструмента старая.\n` +
        `Перезапуска DSH недостаточно, нужна НОВАЯ сессия — инструменты регистрируются при её старте.`);
    }

    const { event, scope } = await applyWithScope(calendarId, a.eventId, patch, a.scope);
    const scopeNote = scope === 'series' ? ' (вся серия)' : scope === 'following' ? ' (этот и следующие)' : '';
    return text(`Обновлено${scopeNote}: ${eventSpan(event)} — ${event.summary} ${colorLabel(event.colorId)}\n  id: ${event.id}`);
  }

  if (name === 'color_events') {
    const color = String(a.colorId || '');
    if (!COLORS[color]) return errText(`Неизвестный цвет "${a.colorId}": допустимо 1–11.`);
    const ids = Array.isArray(a.ids) ? a.ids.filter(Boolean) : [];
    if (!ids.length) return errText('Не передано ни одного id.');

    const ok = [];
    const bad = [];
    for (const id of ids) {
      try {
        const { event } = await applyWithScope(calendarId, id, { colorId: color }, a.scope);
        ok.push(`${colorLabel(color)} ${event.summary || id}`);
      } catch (e) {
        bad.push(`${id} — ${e.message}`);
      }
    }
    const head = `Покрашено ${ok.length} из ${ids.length} в ${colorLabel(color)}.`;
    const tail = bad.length ? `\nНе получилось:\n${bad.map((b) => '  • ' + b).join('\n')}` : '';
    return bad.length ? errText(head + tail) : text(head + (ok.length ? `\n${ok.map((s) => '  • ' + s).join('\n')}` : ''));
  }

  if (name === 'delete_event') {
    const target = a.scope === 'series'
      ? (await getEvent(calendarId, a.eventId)).recurringEventId || a.eventId
      : a.eventId;
    await api(evPath(calendarId, target), { method: 'DELETE' });
    return text(`Удалено: ${a.eventId}${a.scope === 'series' ? ' (вся серия)' : ''}`);
  }

  throw new Error(`Неизвестный инструмент: ${name}`);
}

// ---------- регистрация ----------
serverSetup();

function serverSetup() {
  const server = new Server(
    { name: 'gcal-mcp', version: VERSION.split('+')[0] },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  const AUTH_WAIT_MS = 45_000;
  let inFlight = 0;

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

      if (flowError) return errText(`Не удалось подключить календарь: ${flowError.message}`);
      const link = flow.url ? `\nЕсли окно не открылось — открой ссылку: ${flow.url}` : '';
      return errText(`Подключаю Google Calendar: открыл браузер, выбери аккаунт и нажми «Разрешить».${link}\nКак подтвердишь — повтори запрос.`);
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    inFlight++;
    try {
      return await callWithAuth(name, args || {});
    } catch (e) {
      return errText(`Ошибка: ${e.message}`);
    } finally {
      inFlight--;
    }
  });

  process.on('uncaughtException', (e) => console.error('[gcal-mcp] ' + e.message));
  process.on('unhandledRejection', (e) => console.error('[gcal-mcp] ' + (e?.message || e)));

  server.connect(new StdioServerTransport()).then(() => {
    console.error(`[gcal-mcp] готов, v${VERSION}, инструментов: ${TOOLS.length}`);
  });

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
}
