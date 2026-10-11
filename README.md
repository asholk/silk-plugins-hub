# Silk Hub

Install and update your company's private Obsidian plugins from a Silk Hub server, with a changelog for every release.

Your administrator decides which plugins each company can use. You sign in, connect your companies by their codes and install the plugins you need right from the settings, without copying files by hand.

## Features

- **Company catalog.** Connect one or several companies by the code your administrator gives you. Their plugin lists are merged; each plugin shows which company offers it.
- **Install, update, turn on and off, uninstall** from one list in the settings.
- **Plugin page and instructions.** **Details** shows what a plugin does and what's new in its latest version. **Instructions** is a step-by-step guide with screenshots.
- **Changelog.** Every version lists what changed and why. Open it with the **Open changelog** command.
- **Updates.** The hub checks for updates when the vault opens and, if you allow it, on a schedule. Automatic installation is off by default; with it off, you review and confirm every update.
- **Safe installs.** Every downloaded file is checked against its SHA-256 checksum. The previous version is backed up, and you can roll back with the **Roll back a plugin to the previous version** command.

## Requirements

> [!important] An account is required
> The plugin works only with a [Silk Hub server](https://github.com/asholk/silk-plugins-hub-server) run by your company. You need an account on that server that your administrator has added to a company. Without a server and an account, the plugin has nothing to show.

- Obsidian 1.13.0 or later.

## Install

Open **Settings → Community plugins → Browse**, search for **Silk Hub**, select **Install**, then **Enable**.

To test beta versions before they reach the directory, install the plugin with [BRAT](https://github.com/TfTHacker/obsidian42-brat): run **BRAT: Add a beta plugin for testing** and enter the address of this repository.

## Get started

1. Open **Settings → Silk Hub**.
2. Enter the server address your administrator gave you.
3. Select **Sign in with Google** and finish signing in in your browser.
4. Enter your company code and select **Connect**. Repeat for every company you work with.
5. Select **Install** next to the plugins you need.

## Run your own server

The server is open source: [asholk/silk-plugins-hub-server](https://github.com/asholk/silk-plugins-hub-server). It runs locally with Node.js or in Yandex Cloud as a serverless function, and plugin repositories publish releases to it from CI. Administrators manage companies, users and plugins with the Silk Hub Admin plugin.

## Network use and privacy

This plugin connects to the internet. It only talks to the Silk Hub server whose address you enter in the settings, and to the file storage that server links to:

- to sign you in (through Google, in your browser);
- to load your companies' plugin catalogs, plugin pages, instructions and changelogs;
- to send the ids and versions of company plugins installed in this vault, so the server can tell which updates you need;
- to download plugin files by short-lived signed links.

It doesn't send your notes or any other vault content, and it has no client-side telemetry. Your sign-in session is kept in Obsidian's secret storage, not in the plugin's data file.

The server is run by your company, not by the author of this plugin. It knows your email address, your companies and the versions of company plugins you have installed. Ask your administrator how your company handles this data.

## What the plugin installs

The hub installs plugins your company publishes into this vault's plugins folder. They are code from your company, not from the Obsidian community directory, so install only plugins your company trusts. Every file is checked against the SHA-256 checksum the server publishes before anything is written.

Silk Hub never installs or updates itself: its own updates come through Obsidian's community plugins, like any other plugin.

## For developers

```bash
npm install
npm run dev       # rebuilds main.js on changes
npm run build     # type check and production build
npm run lint      # Obsidian's community plugin rules
```

### Releasing

1. Update `minAppVersion` in `manifest.json` if needed.
2. Run `npm version patch` (or `minor`, `major`). It updates `manifest.json`, `versions.json` and creates a tag without a "v".
3. Run `git push --follow-tags`.

The **Release** workflow builds the plugin and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`. Obsidian and BRAT pick it up from there.

## License

[MIT](LICENSE)
