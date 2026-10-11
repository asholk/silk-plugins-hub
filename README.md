# Silk Plugins Hub

Install and update your company's private Obsidian plugins from a Silk Plugins Hub server, with a changelog for every release.

Your administrator decides which plugins each company can use. You sign in, connect your companies by their codes and install the plugins you need right from the settings, without copying files by hand.

## Features

- **Company catalog.** Connect one or several companies by the code your administrator gives you. Their plugin lists are merged; each plugin shows which company offers it.
- **Install, update, turn on and off, uninstall** from one list in the settings.
- **Plugin page and instructions.** **Details** shows what a plugin does and what's new in its latest version. **Instructions** is a step-by-step guide with screenshots.
- **Changelog.** Every version lists what changed and why. Open it with the **Open changelog** command.
- **Updates.** The hub checks for updates when the vault opens and, if you allow it, on a schedule. Automatic installation is off by default; with it off, you review and confirm every update.
- **Safe installs.** Every downloaded file is checked against its SHA-256 checksum. The previous version is backed up, and you can roll back with the **Roll back a plugin to the previous version** command.

## Requirements

- Obsidian 1.11.4 or later.
- A Silk Plugins Hub server run by your company, and an account your administrator has added to a company.

## Install with BRAT

The plugin isn't in the community plugin directory yet. Install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and turn on **BRAT** from **Settings → Community plugins**.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Enter the address of this repository and select **Add plugin**.
4. Turn on **Silk Plugins Hub** in **Settings → Community plugins**.

BRAT also keeps the hub itself up to date.

## Get started

1. Open **Settings → Silk Plugins Hub**.
2. Enter the server address your administrator gave you.
3. Select **Sign in with Google** and finish signing in in your browser.
4. Enter your company code and select **Connect**. Repeat for every company you work with.
5. Select **Install** next to the plugins you need.

## Network use and privacy

This plugin connects to the internet. It only talks to the Silk Plugins Hub server whose address you enter in the settings:

- to sign you in (through Google, in your browser);
- to load your companies' plugin catalogs, plugin pages, instructions and changelogs;
- to send the ids and versions of company plugins installed in this vault, so the server can tell which updates you need;
- to download plugin files.

It doesn't send your notes or any other vault content, and it has no telemetry. Your sign-in session is kept in Obsidian's secret storage, not in the plugin's data file.

The hub installs plugins your company publishes. They are code from your company, not from the Obsidian community directory, so install only plugins your company trusts.

## For developers

```bash
npm install
npm run dev       # rebuilds main.js on changes
npm run build     # type check and production build
```

### Releasing

1. Update `minAppVersion` in `manifest.json` if needed.
2. Run `npm version patch` (or `minor`, `major`). It updates `manifest.json`, `versions.json` and creates a tag without a "v".
3. Run `git push --follow-tags`.

The **Release** workflow builds the plugin and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`. BRAT picks it up from there.

## License

[MIT](LICENSE)
