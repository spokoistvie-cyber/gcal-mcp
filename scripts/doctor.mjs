#!/usr/bin/env node
// Диагностика: npm run doctor
// Проверяет окружение, файлы доступов и живой ли календарь. Ничего не меняет.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, loadCredentials, loadToken, TOKEN_PATH, CRED_PATH } from '../gcal.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0;

const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => { failed++; console.log(`  ✗ ${s}`); };
const warn = (s) => console.log(`  ! ${s}`);

console.log('\ngcal-mcp — проверка\n');

// 1. Node
const major = Number(process.versions.node.split('.')[0]);
console.log('Node.js');
major >= 20 ? ok(`${process.version}`) : bad(`${process.version} — нужен 20+`);

// 2. Версия сервера
console.log('\nПакет');
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
  ok(`версия ${pkg.version}`);
} catch { bad('не читается package.json'); }

// 3. Зависимости
console.log('\nЗависимости');
try {
  const sdk = JSON.parse(fs.readFileSync(path.join(DIR, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8'));
  ok(`@modelcontextprotocol/sdk ${sdk.version}`);
} catch { bad('не установлен SDK — выполните npm install'); }

// 4. credentials.json
console.log('\ncredentials.json');
if (!fs.existsSync(CRED_PATH)) {
  bad(`файла нет: ${CRED_PATH}`);
} else {
  try {
    const c = loadCredentials();
    ok(`есть, client_id …${String(c.clientId).slice(-12)}`);
  } catch (e) { bad(e.message); }
}

// 5. token.json и живой доступ
console.log('\ntoken.json');
const token = fs.existsSync(TOKEN_PATH) ? loadToken() : null;
if (!token) {
  bad('нет — выполните: node oauth.mjs');
} else {
  token.refresh_token ? ok('есть refresh_token') : warn('нет refresh_token — после часа работы потребуется вход заново');
  try {
    const j = await api('/users/me/calendarList', { query: { maxResults: 100 } });
    const items = j.items || [];
    ok(`доступ к Google работает, календарей: ${items.length}`);
    for (const c of items.slice(0, 10)) console.log(`      • ${c.summary} (${c.accessRole})`);
    if (items.length > 10) console.log(`      … ещё ${items.length - 10}`);
  } catch (e) {
    bad(`Google API: ${e.message}`);
  }
}

console.log('');
if (failed) {
  console.log(`Проблем: ${failed}. Смотрите README, раздел «Диагностика».`);
  process.exit(1);
}
console.log('Всё в порядке.');
