# gcal-mcp — Google Calendar для MCP-клиентов

Небольшой MCP-сервер (stdio, JSON-RPC) для работы с Google Calendar: читать события, создавать, переносить, красить. Работает с любым MCP-клиентом — DeepSeek Harness, Claude Code, Claude Desktop, Kimi Code CLI.

## Что умеет

| Инструмент | Что делает |
|---|---|
| `list_calendars` | список календарей аккаунта: id, название, права доступа |
| `list_events` | события за период с **цветом** и ID; фильтры `onlyNoColor`, `colorId`, `calendarId: "all"` — сводка по всем календарям сразу |
| `create_event` | создать событие с цветом; без конца — ставит час |
| `update_event` | перенести, переименовать, поменять описание, место или **цвет**; для серий — `scope` |
| `color_events` | **покрасить пачку событий одним вызовом** — вместо тридцати запросов |
| `delete_event` | удалить по ID; для серии — `scope: "series"` |

### Цвета

Палитра Google, номера 1–11. `list_events` показывает их прямо в выдаче — `[6 мандарин]` или `[без цвета]`, поэтому покраску видно, не заглядывая в API. Перед покраской удобно спросить `onlyNoColor: true`, а потом одним `color_events` закрыть весь список.

Подсказки, как выбрать **свою** схему: [ЦВЕТА.md](ЦВЕТА.md). Сервер схему не навязывает.

### Серии

У повторяющихся событий `list_events` показывает `recurringEventId` — это ID серии. Дальше `update_event` с параметром `scope`:

- `instance` (по умолчанию) — только этот раз;
- `series` — вся серия целиком;
- `following` — этот и все следующие (сервер сам обрежет старую серию по `UNTIL` и создаст новую).

Правка по ID экземпляра без `scope` меняет один экземпляр, а не серию — это самая частая причина «покрасил, а осталось серым».

Ограничений по календарям нет: можно работать и со своим основным, и с расшаренными (у них свои ID — их отдаёт `list_calendars`).

## Требования

- **Node.js 20+**
- **Свой проект в Google Cloud** — обязателен. OAuth-клиент выдаётся приложению конкретного проекта, чужой не подойдёт.

## Установка

```bash
git clone https://github.com/<ваш-аккаунт>/gcal-mcp.git
cd gcal-mcp
npm install
```

Дальше — доступ к календарю, один раз.

### 1. Google Cloud Console

1. `console.cloud.google.com` → новый проект.
2. **APIs & Services → Library** → включить **Google Calendar API**.
3. **OAuth consent screen** (новый интерфейс — *Google Auth Platform → Get started*):
   App information → **Audience: External** → Contact information → Create.
4. **Audience → Test users** → добавить свой Gmail. Без этого Google не пустит в приложение, пока оно в Testing.
5. **Publish app** — по желанию. Без публикации refresh-токен живёт 7 дней, потом вход повторяется.
6. **Clients → Create client → Desktop app** → скачать JSON.

Скачанный файл переименовать в `credentials.json` и положить рядом с `server.mjs`.

### 2. Авторизация

```bash
node oauth.mjs
```

Откроется браузер. Выбрать аккаунт → «Дополнительно» → «Перейти в … (небезопасно)» → «Разрешить». Рядом появится `token.json`; дальше обновляется сам.

Проверка: `node server.mjs` печатает `[calendar-mcp] готов, инструментов: 5`.

## Подключение к клиентам

**DeepSeek Harness** — в `~/.dsh/profiles/desktop/cordis.patch.yml`, затем перезапуск:

```yaml
- id: mcp-gcal
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: gcal
    transport: stdio
    command: node
    args:
      - "/абсолютный/путь/до/gcal-mcp/server.mjs"
    toolCallTimeoutMs: 90000
    failOnStartupError: false
```

**Claude Code:**

```bash
claude mcp add gcal -- node /абсолютный/путь/до/server.mjs
```

**Claude Desktop, Kimi и прочие** — JSON:

```json
{
  "mcpServers": {
    "gcal": {
      "command": "node",
      "args": ["/абсолютный/путь/до/gcal-mcp/server.mjs"]
    }
  }
}
```

Авторизация общая: все клиенты читают один и тот же `token.json`, второй раз в браузере разрешать не нужно.

## Обновление

```bash
cd gcal-mcp
git pull
npm install
```

`token.json` и `credentials.json` не трогаются: они в `.gitignore` и лежат рядом.

**Важно: перезапуска приложения недостаточно.** Список инструментов фиксируется в момент старта сессии. После обновления сервера перезапустите клиент **и начните новую сессию** (в DSH — новый чат). В старой сессии схема инструментов останется прежней: новые поля будут молча отбрасываться клиентом, и сервер получит вызов без них. Как это распознать — в «Диагностике» ниже и в стартовой строке сервера: `[gcal-mcp] готов, v1.1.0+3ba0ee9, инструментов: 6`.

## Диагностика

```bash
npm run doctor
```

Проверяет Node, зависимости, `credentials.json`, `token.json` и живой ли доступ к Google. Ничего не меняет.

| Симптом | Причина |
|---|---|
| `Нет файла credentials.json` | файл не скачан или лежит с другим именем |
| `Вызов пустой: пришёл только eventId` | клиент отбросил поля — работает старая схема инструмента → **новая сессия**, не только перезапуск |
| `403: access_denied` в браузере | адрес не добавлен в Test users |
| `invalid_grant` | токен отозван или истёк Testing-режим → `node oauth.mjs` заново |
| `Google API 403` | не включён Calendar API в проекте |
| Инструменты не появились | сервер не стартовал → `node server.mjs` вручную, смотреть ошибку |
| Покрасил — осталось серым | красился один экземпляр серии → `scope: "series"` |
| Пустой ответ вместо событий | не тот `calendarId` → сначала `list_calendars` |

## Безопасность

- `token.json` — полный доступ к календарю. Не публиковать, не пересылать, не коммитить (в `.gitignore`).
- `credentials.json` без `token.json` бесполезен.
- Сервер обращается только к `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`. Никакой телеметрии.
- Отозвать доступ: `myaccount.google.com` → Безопасность → Сторонние приложения.

## Устройство

- `server.mjs` — MCP-сервер: описания инструментов, обработчики, авторизация по требованию.
- `gcal.mjs` — токены, обновление, обёртка над Google API.
- `authflow.mjs` — вход в браузере: loopback-сервер на `127.0.0.1`, обмен кода на токен.
- `oauth.mjs` — ручной запуск того же входа.
- Зависимость одна — официальный `@modelcontextprotocol/sdk`.

## Лицензия

MIT.
