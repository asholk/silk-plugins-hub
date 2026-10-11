// End-to-end check of the Hub plugin against a real Hub Service instance:
// sign-in → company → choose plugins → install → new release → auto-update → revoke → rollback.
// Run: node test/e2e.mjs   (needs ../hub-service and ../hub-test-plugin built)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-e2e-"));
const vault = path.join(tmp, "vault");
fs.mkdirSync(path.join(vault, ".obsidian/plugins"), { recursive: true });

const step = (name) => console.log(`\n▶ ${name}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

// --- Hub Service on a random port with a throwaway database ---
const { buildApp } = await import(pathToFileURL(path.join(root, "hub-service/src/server.js")).href);
const { loadConfig } = await import(pathToFileURL(path.join(root, "hub-service/src/config.js")).href);
const { storeRelease } = await import(pathToFileURL(path.join(root, "hub-service/src/releases.js")).href);
const config = loadConfig({ SESSION_SECRET: crypto.randomBytes(32).toString("hex"), DEV_LOGIN: "1", DATA_DIR: path.join(tmp, "data"), PORT: "0" });
const { app: server, ctx } = await buildApp(config, { logger: false });
await server.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${server.server.address().port}`;
config.baseUrl = base;
const { db } = ctx;

db.prepare("INSERT INTO companies (slug, name) VALUES ('hub', 'HUB')").run();
db.prepare("INSERT INTO plugins (id, name, description) VALUES ('hub-test-plugin', 'Hub Test Plugin', 'test')").run();
db.prepare("INSERT INTO company_plugins (company_id, plugin_id, required) VALUES (1, 'hub-test-plugin', 0)").run();

const testPluginDir = path.join(root, "hub-test-plugin");
function release(version, notes) {
  const manifest = JSON.parse(fs.readFileSync(path.join(testPluginDir, "manifest.json"), "utf8"));
  manifest.version = version;
  const mainJs = fs.readFileSync(path.join(testPluginDir, "main.js"), "utf8") + `\n// build ${version}\n`;
  return storeRelease(db, config.dataDir, "hub-test-plugin", {
    tag: version,
    notes,
    files: { "main.js": Buffer.from(mainJs), "manifest.json": Buffer.from(JSON.stringify(manifest)) },
  });
}
release("1.0.0", "Changelog:\n- Новое: команда «Показать версию»");

// --- Plugin bundle with the fake obsidian module ---
const bundle = path.join(tmp, "plugin.mjs");
await esbuild.build({
  entryPoints: [path.join(here, "../src/main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  alias: { obsidian: path.join(here, "fake-obsidian.js") },
  logLevel: "error",
});
const opened = [];
globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, open: (url) => opened.push(url) };
const { default: Hub } = await import(pathToFileURL(bundle).href);
const fake = await import(pathToFileURL(path.join(here, "fake-obsidian.js")).href);
const { log, createApp } = fake;

const app = createApp(vault);
const manifest = JSON.parse(fs.readFileSync(path.join(here, "../manifest.json"), "utf8"));
const hub = new Hub(app, manifest);
hub.data = { serverUrl: base };
await hub.onload();
const lastNotice = () => log.notices.at(-1)?.message;
const pluginDir = path.join(vault, ".obsidian/plugins/hub-test-plugin");
const installedVersion = () => JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf8")).version;

try {
  step("Вход через браузер (dev-вход вместо Google) и возврат по obsidian://");
  await hub.startSignIn();
  assert.equal(opened.length, 1);
  const start = await fetch(opened[0], { redirect: "manual" });
  const state = new URL(start.headers.get("location"), base).searchParams.get("state");
  const page = await (await fetch(`${base}/auth/dev`, { method: "POST", body: new URLSearchParams({ state, email: "user@example.com" }) })).text();
  const link = page.match(/href="(obsidian:\/\/corp-hub-auth\?[^"]+)"/)[1].replace(/&amp;/g, "&");
  const params = Object.fromEntries(new URL(link).searchParams);
  ok(`браузер вернул ссылку ${link.slice(0, 40)}…`);

  step("Пользователь не привязан к компании");
  const noticesBefore = log.notices.length;
  hub.protocolHandlers["corp-hub-auth"](params);
  for (let i = 0; i < 100 && log.notices.length === noticesBefore; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(hub.settings.accountEmail, "user@example.com");
  assert.ok(app.secretStorage.getSecret("corporate-plugin-hub-session"), "refresh-токен в SecretStorage");
  assert.ok(!JSON.stringify(hub.data).includes("Token"), "токены не попали в data.json");
  assert.equal(hub.settings.companyId, null);
  ok(`вход выполнен: ${lastNotice()}`);
  ok("refresh-токен лежит в SecretStorage, а не в data.json");

  step("Администратор добавляет пользователя в компанию HUB");
  db.prepare("INSERT INTO memberships (user_id, company_id) SELECT id, 1 FROM users WHERE email = 'user@example.com'").run();
  const me = await hub.client.me();
  assert.deepEqual(me.companies.map((c) => c.name), ["HUB"]);
  hub.settings.companyId = me.companies[0].id;
  const catalog = await hub.client.catalog(1);
  assert.equal(catalog[0].latest.version, "1.0.0");
  ok(`компания видна, в каталоге: ${catalog.map((p) => `${p.name} ${p.latest.version}`).join(", ")}`);

  step("Выбор плагина и установка (как кнопка «Установить выбранные»)");
  hub.settings.selected = ["hub-test-plugin"];
  await hub.updates.check(true);
  assert.equal(log.modals.length, 1, "открылось окно обновлений");
  assert.equal(hub.updates.pending[0].reason, "install");
  ok(`окно показывает: ${hub.updates.pending.map((u) => `${u.name} ${u.version} (${u.changelog[0].changes[0].text})`).join(", ")}`);
  await hub.updates.apply(hub.updates.pending);
  assert.equal(installedVersion(), "1.0.0");
  assert.ok(log.pluginCalls.includes("enableAndSave:hub-test-plugin"));
  ok("установлен 1.0.0 и включён");

  step("Нет обновлений");
  await hub.updates.check(true);
  assert.equal(lastNotice(), "Все плагины компании актуальны.");
  ok(lastNotice());

  step("Выходит 1.1.0, автообновление выключено: только уведомление");
  release("1.1.0", "Changelog:\n- Новое: экспорт в PDF\n- Исправлено: сортировка тегов");
  await hub.updates.check(false);
  assert.equal(installedVersion(), "1.0.0");
  assert.match(lastNotice(), /Доступны обновления плагинов: 1/);
  assert.equal(hub.statusBar.text, "⬆ 1");
  ok(`${lastNotice()} | строка состояния: ${hub.statusBar.text}`);

  step("Пропустить версию");
  await hub.updates.skip(hub.updates.pending[0]);
  const before = log.notices.length;
  await hub.updates.check(false);
  assert.equal(log.notices.length, before, "о пропущенной версии не напоминаем");
  ok("пропущенная версия 1.1.0 больше не предлагается при фоновой проверке");

  step("Автообновление включено, выходит 1.2.0: ставится при открытии хранилища");
  hub.settings.autoUpdate = true;
  release("1.2.0", "Changelog:\n- Улучшено: быстрее запуск");
  log.pluginCalls.length = 0;
  await hub.updates.check(false);
  assert.equal(installedVersion(), "1.2.0");
  assert.deepEqual(log.pluginCalls, ["disable:hub-test-plugin", "loadManifests", "enable:hub-test-plugin"]);
  assert.match(lastNotice(), /Обновлено: Hub Test Plugin 1.2.0/);
  assert.ok(fs.existsSync(path.join(pluginDir, ".hub-backup/manifest.json")));
  ok(`${lastNotice()}`);
  ok("плагин перезапущен, резервная копия 1.0.0 сохранена");

  step("Новый обязательный плагин при автообновлении требует подтверждения");
  db.prepare("INSERT INTO plugins (id, name) VALUES ('hub-required', 'Required Plugin')").run();
  db.prepare("INSERT INTO company_plugins (company_id, plugin_id, required) VALUES (1, 'hub-required', 1)").run();
  storeRelease(db, config.dataDir, "hub-required", {
    tag: "1.0.0",
    notes: "",
    files: {
      "main.js": Buffer.from("module.exports = class extends require('obsidian').Plugin {};"),
      "manifest.json": Buffer.from(JSON.stringify({ id: "hub-required", name: "Required Plugin", version: "1.0.0", minAppVersion: "1.0.0" })),
    },
  });
  await hub.updates.check(false);
  assert.ok(!fs.existsSync(path.join(vault, ".obsidian/plugins/hub-required")), "не установлен без подтверждения");
  assert.match(lastNotice(), /Доступны обновления плагинов: 1/);
  ok(`не поставлен молча: ${lastNotice()}`);
  db.prepare("DELETE FROM company_plugins WHERE plugin_id = 'hub-required'").run();

  step("Подмена файла на сервере: хеш не совпадает, установка отменяется");
  release("1.3.0", "Changelog:\n- Новое: что-то");
  const asset = db.prepare("SELECT a.path FROM assets a JOIN releases r ON r.id = a.release_id WHERE r.version = '1.3.0' AND a.name = 'main.js'").get();
  fs.appendFileSync(path.join(config.dataDir, asset.path), "\n// tampered");
  await hub.updates.check(false);
  assert.equal(installedVersion(), "1.2.0");
  assert.ok(log.notices.some((n) => /checksum mismatch/.test(n.message)));
  ok("1.3.0 не установлен, осталась 1.2.0: «checksum mismatch for main.js»");
  db.prepare("UPDATE releases SET revoked = 1 WHERE version = '1.3.0'").run();

  step("Администратор отзывает 1.2.0: предлагается откат на 1.1.0");
  db.prepare("UPDATE releases SET revoked = 1 WHERE version = '1.2.0'").run();
  await hub.updates.check(false);
  assert.equal(installedVersion(), "1.1.0");
  ok(`установлена ${installedVersion()}: ${lastNotice()}`);

  step("Команда «Откатить плагин к предыдущей версии»");
  const version = await hub.installer.rollback("hub-test-plugin");
  assert.equal(version, "1.2.0");
  ok(`восстановлена резервная копия: ${version}`);

  step("Компания убрала плагин из списка");
  db.prepare("DELETE FROM company_plugins WHERE plugin_id = 'hub-test-plugin'").run();
  await hub.updates.check(false);
  assert.deepEqual(hub.settings.selected, []);
  assert.ok(fs.existsSync(pluginDir), "плагин не удалён");
  ok(lastNotice());

  step("Выход");
  await hub.signOut();
  assert.equal(app.secretStorage.getSecret("corporate-plugin-hub-session"), null);
  ok("токен удалён");

  console.log("\nВсе проверки пройдены.");
} finally {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
