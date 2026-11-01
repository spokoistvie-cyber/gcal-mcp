// Ручной запуск авторизации: node oauth.mjs
// То же самое сервер делает сам при первом обращении к календарю.
import { startAuthFlow } from './authflow.mjs';
import { TOKEN_PATH } from './gcal.mjs';

const f = startAuthFlow();

setTimeout(() => {
  if (f.authUrl) console.log(`\nСтраница согласия (если браузер не открылся сам):\n${f.authUrl}\n`);
  if (f.url) console.log(`Ожидаю возврат на ${f.url}\n`);
}, 900);

try {
  await f.done;
  console.log(`Готово. Токен сохранён: ${TOKEN_PATH}`);
  process.exit(0);
} catch (e) {
  console.error('Авторизация не пройдена: ' + e.message);
  process.exit(1);
}
