# Rollover Todos (Gagans)

Carry unfinished todos, pins, routine streaks, pagination, and today's edited-note links between daily notes.

Routine tasks are identified only by a leading `{id}` token, for example `{wk}` or `{wo}`. The plugin does not ship a built-in list of routines.

```markdown
#### routine
- [x] {wk} Wake up on time ⚡3↑12
- [ ] {wo} Workout ⚡0↑8
```

## Features

- Roll unfinished tasks from the previous daily note into the latest one
- Update `{id}` routine streaks (`⚡consec↑max`)
- Carry pin wikilinks forward
- Write `prev` / `next` pagination links
- Collect notes created or edited today

## Settings

Folder, filename format, heading names, Sync wait, and ignore folders are all configurable. Leave **Daily Notes Folder** empty to treat any matching date filename as a daily note.

## Install from GitHub

1. Download `main.js` and `manifest.json` from a [release](https://github.com/LaCall-Gagans-Studio/gagans-rollover-todos/releases)
2. Copy them into `<vault>/.obsidian/plugins/gagans-rollover-todos/`
3. Enable the plugin in Settings → Community plugins

## Build

```bash
npm install
npm run build
```
