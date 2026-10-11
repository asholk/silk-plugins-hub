// Minimal stand-in for the "obsidian" module, enough to run the plugin's logic in Node.
// The vault lives on disk, plugin management calls are recorded for assertions.
import fs from "node:fs";
import path from "node:path";

export const apiVersion = "1.14.4";
// Shared through globalThis: the plugin bundle inlines its own copy of this module.
export const log = (globalThis.__fakeObsidianLog ??= { notices: [], modals: [], opened: [], pluginCalls: [] });

export const getLanguage = () => "ru";
export const normalizePath = (p) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export const setIcon = () => {};

export async function requestUrl({ url, method = "GET", headers = {}, body, contentType }) {
  const res = await fetch(url, {
    method,
    headers: contentType ? { ...headers, "Content-Type": contentType } : headers,
    body,
  });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  return {
    status: res.status,
    text,
    arrayBuffer: buf,
    get json() {
      return JSON.parse(text);
    },
  };
}

function fakeEl() {
  const el = {
    classes: new Set(),
    text: "",
    visible: true,
    listeners: {},
    addClass: (...c) => c.forEach((x) => el.classes.add(x)),
    toggle: (v) => (el.visible = v),
    setText: (t) => (el.text = t),
    setAttribute: () => {},
    addEventListener: (type, fn) => (el.listeners[type] = fn),
    click: () => el.listeners.click?.(),
  };
  return el;
}

export class Notice {
  constructor(message) {
    this.message = String(message);
    this.messageEl = fakeEl();
    log.notices.push(this);
  }
  hide() {}
}

export class Events {}
export class Component {
  load() {}
  unload() {}
}
export const MarkdownRenderer = { render: async () => {} };
export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}
export class Setting {}
export class ButtonComponent {}
export class ItemView {}
export class Modal {
  constructor(app) {
    this.app = app;
  }
  open() {
    log.modals.push(this);
  }
  close() {}
}
export class SuggestModal extends Modal {
  setPlaceholder() {}
}

class Adapter {
  constructor(root) {
    this.root = root;
  }
  p(rel) {
    return path.join(this.root, rel);
  }
  async exists(rel) {
    return fs.existsSync(this.p(rel));
  }
  async read(rel) {
    return fs.readFileSync(this.p(rel), "utf8");
  }
  async readBinary(rel) {
    const b = fs.readFileSync(this.p(rel));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  async writeBinary(rel, data) {
    fs.writeFileSync(this.p(rel), Buffer.from(data));
  }
  async mkdir(rel) {
    fs.mkdirSync(this.p(rel), { recursive: true });
  }
  async remove(rel) {
    fs.rmSync(this.p(rel));
  }
  async rmdir(rel, recursive) {
    fs.rmSync(this.p(rel), { recursive });
  }
  async copy(from, to) {
    fs.copyFileSync(this.p(from), this.p(to));
  }
  async list(rel) {
    const entries = fs.readdirSync(this.p(rel), { withFileTypes: true });
    return {
      folders: entries.filter((e) => e.isDirectory()).map((e) => `${rel}/${e.name}`),
      files: entries.filter((e) => e.isFile()).map((e) => `${rel}/${e.name}`),
    };
  }
}

/** Fake App over a vault folder on disk. */
export function createApp(vaultDir) {
  const adapter = new Adapter(vaultDir);
  const secrets = new Map();
  const plugins = {
    manifests: {},
    enabledPlugins: new Set(),
    async loadManifests() {
      log.pluginCalls.push("loadManifests");
      const dir = path.join(vaultDir, ".obsidian/plugins");
      for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const file = path.join(dir, id, "manifest.json");
        if (fs.existsSync(file)) this.manifests[id] = JSON.parse(fs.readFileSync(file, "utf8"));
      }
    },
    async enablePluginAndSave(id) {
      log.pluginCalls.push(`enableAndSave:${id}`);
      this.enabledPlugins.add(id);
      return true;
    },
    async enablePlugin(id) {
      log.pluginCalls.push(`enable:${id}`);
      this.enabledPlugins.add(id);
      return true;
    },
    async disablePluginAndSave(id) {
      log.pluginCalls.push(`disableAndSave:${id}`);
      this.enabledPlugins.delete(id);
    },
    async uninstallPlugin(id) {
      log.pluginCalls.push(`uninstall:${id}`);
      this.enabledPlugins.delete(id);
      fs.rmSync(path.join(vaultDir, ".obsidian/plugins", id), { recursive: true, force: true });
    },
    async disablePlugin(id) {
      log.pluginCalls.push(`disable:${id}`);
      this.enabledPlugins.delete(id);
    },
  };
  return {
    vault: { configDir: ".obsidian", adapter },
    secretStorage: {
      setSecret: (id, v) => secrets.set(id, v),
      getSecret: (id) => secrets.get(id) || null,
      listSecrets: () => [...secrets.keys()],
    },
    plugins,
    setting: { open: () => log.opened.push("settings"), openTabById: () => {} },
    workspace: { onLayoutReady: () => {}, getLeavesOfType: () => [] },
  };
}

export class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.data = null;
    this.protocolHandlers = {};
    this.commands = [];
  }
  async loadData() {
    return this.data;
  }
  async saveData(d) {
    this.data = JSON.parse(JSON.stringify(d));
  }
  addSettingTab() {}
  registerView() {}
  registerInterval(id) {
    return id;
  }
  registerObsidianProtocolHandler(action, fn) {
    this.protocolHandlers[action] = fn;
  }
  addStatusBarItem() {
    this.statusBar = fakeEl();
    return this.statusBar;
  }
  addCommand(c) {
    this.commands.push(c);
  }
}
