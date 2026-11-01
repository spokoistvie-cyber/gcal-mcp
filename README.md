# gcal-mcp — Google Calendar для MCP-клиентов

Небольшой MCP-сервер (stdio, JSON-RPC) для работы с Google Calendar: читать события, создавать, переносить, красить. Работает с любым MCP-клиентом — DeepSeek Harness, Claude Code, Claude Desktop, Kimi Code CLI.

## Что умеет

| Инструмент | Что делает |
|---|---|
| `list_calendars` | список календарей аккаунта: id, название, права доступа |
| `list_events` | события за период, по возрастанию времени, с ID для правок |
| `create_event` | создать событие; без конца — ставит час |
| `update_event` | перенести, переименовать, поменять описание, место или **цвет** |
| `delete_event` | удалить по ID |

Цвета — палитра Google, номера 1–11. Расшифровка и пример схемы раскраски: [ЦВЕТА.md](ЦВЕТА.md).

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

Перезапустить клиент (в DSH — полностью приложение, не окно). `token.json` и `credentials.json` не трогаются: они в `.gitignore` и лежат рядом.

## Диагностика

| Симптом | Причина |
|---|---|
| `Нет файла credentials.json` | файл не скачан или лежит с другим именем |
| `403: access_denied` в браузере | адрес не добавлен в Test users |
| `invalid_grant` | токен отозван или истёк Testing-режим → `node oauth.mjs` заново |
| `Google API 403` | не включён Calendar API в проекте |
| Инструменты не появились | сервер не стартовал → запустить `node server.mjs` вручную, смотреть ошибку |
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
