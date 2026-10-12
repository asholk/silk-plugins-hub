import { apiVersion, App, normalizePath, Platform } from "obsidian";

/** Per-device switch, kept out of data.json like the other per-device choices. */
const DEV_MODE_KEY = "silk-hub-dev-mode";
const LOG_FILE = "debug.log";
/** Lines kept in memory for the "Copy debug log" command. */
const MAX_LINES = 5000;
/** The fallback timer fires this often; a longer gap means the main thread was busy. */
const TICK_MS = 100;
const STALL_MS = 300;

interface NodeFs {
  appendFileSync(path: string, data: string): void;
  writeFileSync(path: string, data: string): void;
}

/**
 * Developer mode: every step of installing, starting and stopping plugins, every server request and
 * every redraw of the settings page goes to the developer console and to debug.log in the Silk Hub folder.
 * A watchdog reports when the main thread was blocked and which steps were running at that moment,
 * so a freeze points at the step that caused it.
 *
 * On desktop each line is written to the file synchronously, so it's there even if Obsidian
 * has to be killed. On a phone lines are flushed every second.
 */
class DevLog {
  enabled = false;
  private app: App | null = null;
  private path = "";
  private fs: NodeFs | null = null;
  private lines: string[] = [];
  private unflushed: string[] = [];
  private flushTimer: number | null = null;
  private watchdog: number | null = null;
  private observer: PerformanceObserver | null = null;
  private active = new Map<number, { name: string; startedAt: number }>();
  /** Recently finished steps, to name the ones a long task overlapped. */
  private finished: { name: string; startedAt: number; endedAt: number }[] = [];
  private nextStepId = 1;
  private startedAt = performance.now();

  init(app: App, pluginDir: string): void {
    this.app = app;
    this.path = normalizePath(`${pluginDir}/${LOG_FILE}`);
    if (Platform.isDesktopApp) {
      const base = (app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
      const req = (window as unknown as { require?: (m: string) => unknown }).require;
      if (base && req) {
        this.fs = req("fs") as NodeFs;
        this.path = `${base}/${this.path}`;
      }
    }
    if (app.loadLocalStorage(DEV_MODE_KEY) === "true") this.start();
  }

  setEnabled(value: boolean): void {
    this.app?.saveLocalStorage(DEV_MODE_KEY, value ? "true" : null);
    if (value && !this.enabled) this.start();
    if (!value && this.enabled) {
      this.log("developer mode off");
      this.stop();
    }
  }

  /** Stops timers when Silk Hub unloads; the setting stays. */
  unload(): void {
    if (!this.enabled) return;
    this.log("Silk Hub unloaded");
    this.stop();
  }

  log(message: string): void {
    if (!this.enabled) return;
    const line = `${new Date().toISOString().slice(11, 23)} +${Math.round(performance.now() - this.startedAt)}ms ${message}`;
    console.debug(`[Silk Hub] ${line}`);
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.write(line);
  }

  /** Logs the start and the end of a step with its duration; while it runs, the watchdog names it. */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    const id = this.nextStepId++;
    const startedAt = performance.now();
    this.active.set(id, { name, startedAt });
    this.log(`▶ ${name}`);
    try {
      const result = await fn();
      this.log(`✔ ${name} ${Math.round(performance.now() - startedAt)}ms`);
      return result;
    } catch (err) {
      this.log(`✖ ${name} ${Math.round(performance.now() - startedAt)}ms: ${(err as Error)?.message ?? String(err)}`);
      throw err;
    } finally {
      this.active.delete(id);
      this.finished.push({ name, startedAt, endedAt: performance.now() });
      if (this.finished.length > 200) this.finished.shift();
    }
  }

  /** The log kept in memory since developer mode was turned on. */
  text(): string {
    return this.lines.join("\n");
  }

  private start(): void {
    this.enabled = true;
    this.startedAt = performance.now();
    this.lines = [];
    if (this.fs) {
      try {
        this.fs.writeFileSync(this.path, "");
      } catch (err) {
        console.error("Silk Hub: can't write the debug log", err);
        this.fs = null;
      }
    } else {
      void this.app?.vault.adapter.write(this.path, "").catch(() => undefined);
    }
    const platform = Object.entries(Platform)
      .filter(([, on]) => on === true)
      .map(([name]) => name)
      .join(" ");
    this.log(`developer mode on: ${platform}, Obsidian ${apiVersion}`);
    this.log(`log file: ${this.path}`);
    this.startWatchdog();
  }

  private stop(): void {
    this.flush();
    this.enabled = false;
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    this.watchdog = null;
    this.observer?.disconnect();
    this.observer = null;
    this.active.clear();
    this.finished = [];
  }

  /**
   * Long task timing (Chromium: desktop and Android) measures the blocked time itself. A timer is only a fallback:
   * Obsidian slows timers of a window in the background (the main window while settings are open in their own),
   * so its gaps also show up when nothing is blocked.
   */
  private startWatchdog(): void {
    if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < STALL_MS) continue;
          const steps = this.stepsDuring(entry.startTime, entry.startTime + entry.duration);
          this.log(`⚠ main thread blocked ${Math.round(entry.duration)}ms; Silk Hub steps at that time: ${steps}`);
        }
      });
      this.observer.observe({ type: "longtask" });
      return;
    }
    let last = performance.now();
    this.watchdog = window.setInterval(() => {
      const now = performance.now();
      const gap = now - last - TICK_MS;
      last = now;
      if (gap >= STALL_MS && activeDocument?.visibilityState !== "hidden") {
        this.log(`⚠ main thread blocked ~${Math.round(gap)}ms (timer gap); Silk Hub steps at that time: ${this.stepsDuring(now - gap, now)}`);
      }
    }, TICK_MS);
  }

  /** Steps that were running at some point between `from` and `to`. */
  private stepsDuring(from: number, to: number): string {
    const now = performance.now();
    const running = [...this.active.values()].filter((s) => s.startedAt <= to).map((s) => ({ ...s, endedAt: now }));
    const steps = [...this.finished.filter((s) => s.endedAt >= from && s.startedAt <= to), ...running];
    if (steps.length === 0) return "none";
    return steps.map((s) => `${s.name} (${Math.round(s.endedAt - s.startedAt)}ms)`).join(", ");
  }

  private write(line: string): void {
    if (this.fs) {
      try {
        this.fs.appendFileSync(this.path, line + "\n");
      } catch {
        // The log is best effort; the console still has the line.
      }
      return;
    }
    this.unflushed.push(line);
    this.flushTimer ??= window.setTimeout(() => this.flush(), 1000);
  }

  private flush(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.unflushed.length === 0 || !this.app) return;
    const chunk = this.unflushed.join("\n") + "\n";
    this.unflushed = [];
    void this.app.vault.adapter.append(this.path, chunk).catch(() => undefined);
  }
}

export const devLog = new DevLog();
