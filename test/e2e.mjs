// End-to-end check of the Hub plugin against a real Hub Service instance:
// sign-in → company → choose plugins → install → new release → auto-update → revoke → rollback.
// Run: node test/e2e.mjs   (needs ../hub-service and ../hub-test-plugin built)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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
const { buildApp, openFiles } = await import(pathToFileURL(path.join(root, "hub-service/src/server.js")).href);
const { loadConfig } = await import(pathToFileURL(path.join(root, "hub-service/src/config.js")).href);
const { storeRelease } = await import(pathToFileURL(path.join(root, "hub-service/src/releases.js")).href);
const config = loadConfig({ SESSION_SECRET: crypto.randomBytes(32).toString("hex"), DEV_LOGIN: "1", DATA_DIR: path.join(tmp, "data"), PORT: "0" });
const { app: server, ctx } = await buildApp(config, { logger: false });
await server.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${server.server.address().port}`;
config.baseUrl = base;
// Download links point at the real port, known only after listen().
ctx.files = openFiles(config);
const { store } = ctx;

await store.put("companies", { id: 1, slug: "hub", name: "HUB", email_domains: "" });
await store.put("plugins", { id: "hub-test-plugin", name: "Hub Test Plugin", description: "test", instructions: "" });
await store.put("company_plugins", { company_id: 1, plugin_id: "hub-test-plugin", required: false });
const setRelease = async (version, patch, pluginId = "hub-test-plugin") =>
  store.put("releases", { ...(await store.get("releases", { plugin_id: pluginId, version })), ...patch });

const testPluginDir = path.join(root, "hub-test-plugin");
function release(version, notes) {
  const manifest = JSON.parse(fs.readFileSync(path.join(testPluginDir, "manifest.json"), "utf8"));
  manifest.version = version;
  const mainJs = fs.readFileSync(path.join(testPluginDir, "main.js"), "utf8") + `\n// build ${version}\n`;
  return storeRelease(ctx, "hub-test-plugin", {
    tag: version,
    notes,
    files: { "main.js": Buffer.from(mainJs), "manifest.json": Buffer.from(JSON.stringify(manifest)) },
  });
}
await release("1.0.0", "Changelog:\n- Новое: команда «Показать версию»");

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
await esbuild.build({
  entryPoints: [path.join(here, "../src/install/communityPlugins.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(tmp, "community.mjs"),
  alias: { obsidian: path.join(here, "fake-obsidian.js") },
  logLevel: "error",
});
const opened = [];
globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, open: (url) => opened.push(url), require: createRequire(import.meta.url) };
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
  step("Перед входом проверяется адрес сервера");
  for (const [address, expected] of [
    ["hub.example", "не адрес сервера"],
    [`${base}/nope`, "не сервер Silk Hub"],
    ["http://127.0.0.1:9", "не отвечает"],
  ]) {
    hub.settings.serverUrl = address;
    await hub.startSignIn();
    assert.equal(opened.length, 0, `браузер не открыт для ${address}`);
    assert.ok(lastNotice()?.includes(expected), `${address}: ${lastNotice()}`);
    ok(`${address} → ${lastNotice()}`);
  }
  hub.settings.serverUrl = base;

  step("Вход через браузер (dev-вход вместо Google) и возврат по obsidian://");
  await hub.startSignIn();
  assert.equal(opened.length, 1);
  const start = await fetch(opened[0], { redirect: "manual" });
  const state = new URL(start.headers.get("location"), base).searchParams.get("state");
  const page = await (await fetch(`${base}/auth/dev`, { method: "POST", body: new URLSearchParams({ state, email: "user@example.com" }) })).text();
  const link = page.match(/href="(obsidian:\/\/silk-hub-auth\?[^"]+)"/)[1].replace(/&amp;/g, "&");
  const params = Object.fromEntries(new URL(link).searchParams);
  ok(`браузер вернул ссылку ${link.slice(0, 40)}…`);

  step("Пользователь не привязан к компании");
  const noticesBefore = log.notices.length;
  hub.protocolHandlers["silk-hub-auth"](params);
  for (let i = 0; i < 100 && log.notices.length === noticesBefore; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(hub.settings.accountEmail, "user@example.com");
  assert.ok(app.secretStorage.getSecret("silk-plugins-hub-session"), "refresh-токен в SecretStorage");
  assert.ok(!JSON.stringify(hub.data).includes("Token"), "токены не попали в data.json");
  assert.deepEqual(hub.settings.companyIds, []);
  ok(`вход выполнен: ${lastNotice()}`);
  ok("refresh-токен лежит в SecretStorage, а не в data.json");

  step("Администратор добавляет пользователя в компанию HUB");
  const u = (await store.list("users", { email: "user@example.com" }))[0];
  await store.put("memberships", { user_id: u.id, company_id: 1 });
  const me = await hub.client.me();
  assert.deepEqual(me.companies.map((c) => c.name), ["HUB"]);
  assert.equal(await hub.client.lookupCompany("acme"), null);
  const company = await hub.client.lookupCompany("HUB");
  hub.settings.companyIds = [company.id];
  const catalog = await hub.client.catalog(hub.settings.companyIds);
  assert.equal(catalog[0].latest.version, "1.0.0");
  ok(`компания видна, в каталоге: ${catalog.map((p) => `${p.name} ${p.latest.version}`).join(", ")}`);

  step("Краткая инструкция и карточка плагина");
  await store.put("plugins", { ...(await store.get("plugins", { id: "hub-test-plugin" })), instructions: "Нажмите значок на боковой панели" });
  await setRelease("1.0.0", { card: ["# Hub Test Plugin", "", "Подробное описание"].join("\n") });
  const [withCard] = await hub.client.catalog([1]);
  assert.equal(withCard.instructions, "Нажмите значок на боковой панели");
  assert.equal(withCard.hasCard, true);
  const card = await hub.client.doc("hub-test-plugin", "card");
  assert.match(card.markdown, /Подробное описание/);
  ok(`инструкция: «${withCard.instructions}», карточка из версии ${card.version}`);

  step("Кнопка «Установить» у плагина");
  const done = await hub.updates.installOne("hub-test-plugin");
  assert.equal(done, true);
  assert.equal(installedVersion(), "1.0.0");
  assert.deepEqual(hub.settings.selected, ["hub-test-plugin"]);
  assert.ok(log.pluginCalls.includes("enableAndSave:hub-test-plugin"));
  assert.match(lastNotice(), /Hub Test Plugin 1.0.0 установлен/);
  ok("установлен 1.0.0 и включён");

  step("Переключатель «Включён»");
  const { setPluginEnabled, isPluginEnabled } = await import(pathToFileURL(path.join(tmp, "community.mjs")).href);
  await setPluginEnabled(app, "hub-test-plugin", false);
  assert.equal(isPluginEnabled(app, "hub-test-plugin"), false);
  await setPluginEnabled(app, "hub-test-plugin", true);
  assert.equal(isPluginEnabled(app, "hub-test-plugin"), true);
  ok("выключен и снова включён");

  step("Нет обновлений");
  await hub.updates.check(true);
  assert.equal(lastNotice(), "Все плагины компании актуальны.");
  ok(lastNotice());

  step("Выходит 1.1.0, автообновление выключено: только уведомление");
  await release("1.1.0", "Changelog:\n- Новое: экспорт в PDF\n- Исправлено: сортировка тегов");
  await hub.updates.check(false);
  assert.equal(installedVersion(), "1.0.0");
  assert.match(lastNotice(), /Доступны обновления плагинов: 1/);
  assert.equal(hub.statusBar.text, "⬆ 1");
  assert.ok(hub.statusBar.classes.has("has-updates"), "the update counter is green");
  ok(`${lastNotice()} | строка состояния: ${hub.statusBar.text}`);

  step("Пропустить версию");
  await hub.updates.skip(hub.updates.pending[0]);
  const before = log.notices.length;
  await hub.updates.check(false);
  assert.equal(log.notices.length, before, "о пропущенной версии не напоминаем");
  ok("пропущенная версия 1.1.0 больше не предлагается при фоновой проверке");

  step("Автообновление включено, выходит 1.2.0: ставится при открытии хранилища");
  hub.settings.autoUpdate = true;
  await release("1.2.0", "Changelog:\n- Улучшено: быстрее запуск");
  log.pluginCalls.length = 0;
  await hub.updates.check(false);
  assert.equal(installedVersion(), "1.2.0");
  assert.deepEqual(log.pluginCalls, ["disable:hub-test-plugin", "loadManifests", "enable:hub-test-plugin"]);
  assert.match(lastNotice(), /Обновлено: Hub Test Plugin 1.2.0/);
  assert.ok(fs.existsSync(path.join(pluginDir, ".hub-backup/manifest.json")));
  ok(`${lastNotice()}`);
  ok("плагин перезапущен, резервная копия 1.0.0 сохранена");

  step("Новый обязательный плагин при автообновлении требует подтверждения");
  await store.put("plugins", { id: "hub-required", name: "Required Plugin", description: "", instructions: "" });
  await store.put("company_plugins", { company_id: 1, plugin_id: "hub-required", required: true });
  await storeRelease(ctx, "hub-required", {
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
  await store.delete("company_plugins", { company_id: 1, plugin_id: "hub-required" });

  step("Подмена файла на сервере: хеш не совпадает, установка отменяется");
  await release("1.3.0", "Changelog:\n- Новое: что-то");
  fs.appendFileSync(path.join(config.dataDir, "files/plugins/hub-test-plugin/1.3.0/main.js"), "\n// tampered");
  await hub.updates.check(false);
  assert.equal(installedVersion(), "1.2.0");
  assert.ok(log.notices.some((n) => /checksum mismatch/.test(n.message)));
  ok("1.3.0 не установлен, осталась 1.2.0: «checksum mismatch for main.js»");
  await setRelease("1.3.0", { revoked: true });

  step("Администратор отзывает 1.2.0: предлагается откат на 1.1.0");
  await setRelease("1.2.0", { revoked: true });
  await hub.updates.check(false);
  assert.equal(installedVersion(), "1.1.0");
  ok(`установлена ${installedVersion()}: ${lastNotice()}`);

  step("Команда «Откатить плагин к предыдущей версии»");
  const version = await hub.installer.rollback("hub-test-plugin");
  assert.equal(version, "1.2.0");
  ok(`восстановлена резервная копия: ${version}`);

  step("Компания убрала плагин из списка");
  await store.delete("company_plugins", { company_id: 1, plugin_id: "hub-test-plugin" });
  await hub.updates.check(false);
  assert.deepEqual(hub.settings.selected, []);
  assert.ok(fs.existsSync(pluginDir), "плагин не удалён");
  ok(lastNotice());

  step("Кнопка «Обновить» и «Удалить»");
  await store.put("company_plugins", { company_id: 1, plugin_id: "hub-test-plugin", required: false });
  hub.settings.selected = ["hub-test-plugin"];
  await release("1.4.0", "Changelog:\n- Новое: быстрый старт — чтобы не ждать загрузки");
  assert.equal(await hub.updates.installOne("hub-test-plugin"), true);
  assert.equal(installedVersion(), "1.4.0");
  const [latestRelease] = await hub.client.changelog("hub-test-plugin");
  assert.deepEqual(latestRelease.changes[0], { type: "new", text: "быстрый старт", why: "чтобы не ждать загрузки" });
  ok(lastNotice());
  await hub.updates.uninstall("hub-test-plugin", "Hub Test Plugin");
  assert.ok(!fs.existsSync(pluginDir), "папка плагина удалена");
  assert.deepEqual(hub.settings.selected, []);
  ok(lastNotice());

  step("Несколько плагинов сразу: ставятся по очереди, а не параллельно");
  const simplePlugin = async (id, version, extra = {}) => {
    if (!(await store.get("plugins", { id }))) {
      await store.put("plugins", { id, name: `Plugin ${id}`, description: "", instructions: "" });
      await store.put("company_plugins", { company_id: 1, plugin_id: id, required: false });
    }
    await storeRelease(ctx, id, {
      tag: version,
      notes: "",
      files: {
        "main.js": Buffer.from(`module.exports = class {}; // ${version}`),
        "manifest.json": Buffer.from(JSON.stringify({ id, name: `Plugin ${id}`, version, minAppVersion: "1.0.0", ...extra })),
      },
    });
  };
  const ids = ["hub-a", "hub-b", "hub-c", "hub-d"];
  for (const id of ids) await simplePlugin(id, "1.0.0");
  // Developer mode on for this step: every step lands in debug.log.
  fs.mkdirSync(path.join(vault, ".obsidian/plugins/silk-plugins-hub"), { recursive: true });
  await hub.settingTab.setControlValue("devMode", true);
  log.maxLoading = 0;
  log.pluginCalls.length = 0;
  const results = await Promise.all(ids.map((id) => hub.updates.installOne(id)));
  assert.deepEqual(results, [true, true, true, true]);
  assert.equal(log.maxLoading, 1, "одновременно загружается только один плагин");
  for (const id of ids) assert.ok(app.plugins.plugins[id] && app.plugins.enabledPlugins.has(id), `${id} включён`);
  const order = log.pluginCalls.filter((c) => c.startsWith("enableAndSave:")).map((c) => c.split(":")[1]);
  assert.deepEqual(order, ids);
  ok(`4 плагина установлены по очереди: ${order.join(" → ")}`);
  assert.equal(await Promise.all([hub.queue.run("hub-a", "x", async () => 1), hub.queue.run("hub-a", "y", async () => 2)]).then((r) => r.join()), "1,1");
  ok("повторное действие с тем же плагином ждёт уже запущенное, а не начинает второе");
  await hub.settingTab.setControlValue("devMode", false);
  const debugLog = fs.readFileSync(path.join(vault, ".obsidian/plugins/silk-plugins-hub/debug.log"), "utf8");
  for (const line of ["▶ POST /api/updates/check", "▶ download hub-a/main.js", "▶ write hub-a/main.js", "✔ enablePluginAndSave hub-d", "queue: + hub-b", "developer mode off"]) {
    assert.ok(debugLog.includes(line), `в журнале есть «${line}»`);
  }
  ok(`режим разработчика: ${debugLog.trim().split(/\r?\n/).length} строк в debug.log, каждый шаг с длительностью`);

  step("Плагин установился, но не запустился: так и сообщаем");
  await simplePlugin("hub-broken", "1.0.0");
  app.plugins.failEnable.add("hub-broken");
  assert.equal(await hub.updates.installOne("hub-broken"), true);
  assert.ok(fs.existsSync(path.join(vault, ".obsidian/plugins/hub-broken/main.js")), "файлы на месте");
  assert.ok(!app.plugins.enabledPlugins.has("hub-broken"), "не отмечен включённым");
  assert.match(lastNotice(), /установлен, но не запустился/);
  ok(lastNotice());
  const { setPluginEnabled: setEnabled2, EnableError } = await import(pathToFileURL(path.join(tmp, "community.mjs")).href);
  await assert.rejects(setEnabled2(app, "hub-broken", true), EnableError);
  assert.ok(!app.plugins.enabledPlugins.has("hub-broken"));
  ok("переключатель сообщает об ошибке и остаётся выключенным");

  step("Обновление не запустилось: возвращается прежняя версия");
  await simplePlugin("hub-a", "1.1.0");
  app.plugins.failEnable.add("hub-a");
  hub.settings.selected = [...new Set([...hub.settings.selected, "hub-a"])];
  assert.equal(await hub.updates.installOne("hub-a"), false);
  app.plugins.failEnable.delete("hub-a");
  assert.equal(JSON.parse(fs.readFileSync(path.join(vault, ".obsidian/plugins/hub-a/manifest.json"), "utf8")).version, "1.0.0");
  assert.match(lastNotice(), /новая версия не запустилась, возвращена прежняя/);
  ok(lastNotice());

  step("Новый плагин, который не удалось записать, не остаётся наполовину");
  await simplePlugin("hub-half", "1.0.0");
  const writeBinary = app.vault.adapter.writeBinary;
  app.vault.adapter.writeBinary = async (rel, data) => {
    if (rel.endsWith("manifest.json")) throw new Error("disk full");
    return writeBinary.call(app.vault.adapter, rel, data);
  };
  assert.equal(await hub.updates.installOne("hub-half"), false);
  app.vault.adapter.writeBinary = writeBinary;
  assert.ok(!fs.existsSync(path.join(vault, ".obsidian/plugins/hub-half")), "папка убрана");
  ok("папка неудачной установки удалена");

  step("Телефон: плагины только для компьютера не ставятся");
  await simplePlugin("hub-desk", "1.0.0", { isDesktopOnly: true });
  const deskCatalog = await hub.client.catalog([1]);
  assert.equal(deskCatalog.find((p) => p.id === "hub-desk").latest.desktopOnly, true);
  assert.ok(deskCatalog.find((p) => p.id === "hub-a").latest.size > 0);
  fake.Platform.isDesktopApp = false;
  assert.equal(await hub.updates.installOne("hub-desk"), false);
  assert.match(lastNotice(), /только в приложении для компьютера/);
  assert.ok(!fs.existsSync(path.join(vault, ".obsidian/plugins/hub-desk")));
  ok(lastNotice());

  step("Телефон: установка без включения");
  hub.enableAfterInstall = false;
  await simplePlugin("hub-later", "1.0.0");
  assert.equal(await hub.updates.installOne("hub-later"), true);
  assert.ok(fs.existsSync(path.join(vault, ".obsidian/plugins/hub-later/main.js")));
  assert.ok(!app.plugins.enabledPlugins.has("hub-later"));
  assert.match(lastNotice(), /Включите его переключателем/);
  assert.equal(JSON.stringify(hub.data).includes("enableAfterInstall"), false, "настройка не попадает в data.json");
  ok(lastNotice());
  hub.enableAfterInstall = true;
  fake.Platform.isDesktopApp = true;

  step("Параллельные запросы при истёкшем токене: одно обновление, пользователь не выходит");
  hub.client.accessToken = null;
  hub.client.accessExpiresAt = 0;
  const parallel = await Promise.all([hub.client.me(), hub.client.me(), hub.client.catalog([1]), hub.client.me()]);
  assert.equal(parallel[0].user.email, "user@example.com");
  assert.ok(hub.client.signedIn, "сессия жива");
  ok("четыре запроса, одно обновление токена, вход сохранён");

  step("Выход");
  await hub.signOut();
  assert.equal(app.secretStorage.getSecret("silk-plugins-hub-session"), null);
  ok("токен удалён");

  console.log("\nВсе проверки пройдены.");
} finally {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
