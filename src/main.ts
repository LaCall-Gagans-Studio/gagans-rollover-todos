import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	moment,
} from "obsidian";

interface GagansRolloverTodosSettings {
	targetHeading: string;
	routineHeading: string;
	dailyNoteFormat: string;
	tagDateFormat: string;
	dailyNotesFolder: string;
	createDelayMs: number;
	waitForSync: boolean;
	syncWaitTimeoutMs: number;
	syncSettleMs: number;
	editedEnabled: boolean;
	editedHeading: string;
	editedDebounceMs: number;
	editedExcludeDailyNotes: boolean;
	editedIgnoreFolders: string[];
	pinsEnabled: boolean;
	pinsHeading: string;
	paginationEnabled: boolean;
	paginationHeading: string;
	sectionHeadingLevel: number;
}

interface DailyNoteEntry {
	file: TFile;
	date: moment.Moment;
}

interface SyncInstance {
	pause?: boolean;
	syncing?: boolean;
	syncStatus?: string;
	getStatus?: () => unknown;
	on?: (event: string, handler: () => void) => void;
	off?: (event: string, handler: () => void) => void;
}

const DEFAULT_SETTINGS: GagansRolloverTodosSettings = {
  targetHeading: "todo",
  routineHeading: "routine",
  dailyNoteFormat: "YYYY-MM-DD",
  tagDateFormat: "YYYYMMDD",
  dailyNotesFolder: "",
  createDelayMs: 500,
  waitForSync: true,
  syncWaitTimeoutMs: 12e4,
  syncSettleMs: 1500,
  editedEnabled: true,
  editedHeading: "edited",
  editedDebounceMs: 1500,
  editedExcludeDailyNotes: true,
  editedIgnoreFolders: [],
  pinsEnabled: true,
  pinsHeading: "pins",
  paginationEnabled: true,
  paginationHeading: "pagination",
  sectionHeadingLevel: 4
};
const FRONTMATTER_DATE_FORMATS = ["YYYY-MM-DDTHH:mm", "YYYY-MM-DD HH:mm", "YYYY-MM-DD"];
const EMPTY_WIKILINK_REGEX = /^\s*\[\[\s*\]\]\s*$/;
const WIKILINK_LINE_REGEX = /^\s*!?\[\[([^\]]*)\]\]\s*$/;
const MARKDOWN_LINK_LINE_REGEX = /^\s*!?\[([^\]]*)\]\(([^)]+)\)\s*$/;
const ROLLOVER_FRESH_FILE_MS = 6e4;
const SYNC_IDLE_STATUSES = ["fully synced", "synced"];
const SYNC_BUSY_HINTS = ["syncing", "connecting", "loading", "downloading", "uploading"];
const TASK_LINE_REGEX = /^(\s*)- \[([^\]])\]\s*(.*)$/;
const ROLLOVER_TAG_REGEX = /\((?:\d{8}|\[\[[^\]]+\]\])-\)\s*$/;
const ROUTINE_STREAK_REGEX = /\s*⚡\s*(\d+)\s*↑\s*(\d+)\s*$/;
const ROUTINE_ID_REGEX = /^\{([^}]+)\}([\s\S]*)$/;
export default class GagansRolloverTodosPlugin extends Plugin {
	settings: GagansRolloverTodosSettings = { ...DEFAULT_SETTINGS };
	rolledOverPairs: Record<string, number> = {};
	autoRolloverQueue: Promise<unknown> = Promise.resolve();
	pluginReady = false;
	pendingEditedPaths = new Set<string>();
	pendingEditedRenames: Array<{ oldPath: string; newPath: string }> = [];
	pendingEditedDeletes: string[] = [];
	editedFlushTimer: number | null = null;
	writingDailyPaths = new Set<string>();
  async onload() {
    this.autoRolloverQueue = Promise.resolve();
    this.pluginReady = false;
    this.pendingEditedPaths = /* @__PURE__ */ new Set();
    this.pendingEditedRenames = [];
    this.pendingEditedDeletes = [];
    this.editedFlushTimer = null;
    this.writingDailyPaths = /* @__PURE__ */ new Set();
    await this.loadSettings();
    this.addSettingTab(new GagansRolloverTodosSettingTab(this.app, this));
    this.addCommand({
      id: "run-rollover-for-latest-daily-note",
      name: "Run rollover for latest daily note",
      callback: async () => {
        await this.runRolloverForLatestDailyNote(false);
      }
    });
    this.addCommand({
      id: "force-rollover-for-latest-daily-note",
      name: "Force re-run rollover for latest daily note",
      callback: async () => {
        await this.runRolloverForLatestDailyNote(true);
      }
    });
    this.addCommand({
      id: "run-routine-streaks-for-latest-daily-note",
      name: "Update routine streaks for latest daily note",
      callback: async () => {
        await this.runRoutineStreaksForLatestDailyNote(true);
      }
    });
    this.addCommand({
      id: "update-edited-links-for-today",
      name: "Update edited note links for today",
      callback: async () => {
        await this.runEditedLinksForToday(true);
      }
    });
    this.addCommand({
      id: "roll-over-pins-for-latest-daily-note",
      name: "Roll over pins for latest daily note",
      callback: async () => {
        await this.runPinsRolloverForLatestDailyNote(true);
      }
    });
    this.addCommand({
      id: "update-pagination-for-latest-daily-note",
      name: "Update pagination for latest daily note",
      callback: async () => {
        await this.runPaginationForLatestDailyNote(true);
      }
    });
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        void this.handleCreatedFile(file);
        void this.handleEditedNoteEvent(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        void this.handleEditedNoteEvent(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.handleEditedNoteRename(file, oldPath);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        void this.handleEditedNoteDelete(file);
      })
    );
    this.app.workspace.onLayoutReady(() => {
      this.pluginReady = true;
      if (this.settings.editedEnabled === false) {
        return;
      }
      void this.enqueueAutoRollover(async () => {
        await this.backfillEditedLinksForToday();
      });
    });
  }
  /** Obsidian Sync may update data.json from another device. */
  async onExternalSettingsChange() {
    await this.loadSettings();
  }
  async loadSettings() {
    const data = (await this.loadData()) as (Partial<GagansRolloverTodosSettings> & { rolledOverPairs?: Record<string, number> }) | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.editedIgnoreFolders = this.normalizeIgnoreFolders(
      data?.editedIgnoreFolders ?? DEFAULT_SETTINGS.editedIgnoreFolders
    );
    this.rolledOverPairs = data?.rolledOverPairs ?? {};
    await this.pruneMissingRolloverPairs();
  }
  async saveSettings() {
    await this.saveData({ ...this.settings, rolledOverPairs: this.rolledOverPairs });
  }
  async saveRolloverState() {
    await this.saveData({ ...this.settings, rolledOverPairs: this.rolledOverPairs });
  }
  /** Drop pair marks whose source/target file no longer exists (ghost creates). */
  async pruneMissingRolloverPairs() {
    let changed = false;
    for (const key of Object.keys(this.rolledOverPairs)) {
      const [sourcePath, targetPath] = key.split("|");
      const sourceOk = Boolean(this.app.vault.getAbstractFileByPath(sourcePath));
      const targetOk = Boolean(this.app.vault.getAbstractFileByPath(targetPath));
      if (!sourceOk || !targetOk) {
        delete this.rolledOverPairs[key];
        changed = true;
      }
    }
    if (changed) {
      await this.saveRolloverState();
    }
  }
  getRolloverKey(sourceFile, targetFile) {
    return `${sourceFile.path}|${targetFile.path}`;
  }
  hasRolledOver(sourceFile, targetFile) {
    return Boolean(this.rolledOverPairs[this.getRolloverKey(sourceFile, targetFile)]);
  }
  async markRolledOver(sourceFile, targetFile) {
    this.rolledOverPairs[this.getRolloverKey(sourceFile, targetFile)] = Date.now();
    await this.saveRolloverState();
  }
  async clearRolledOver(sourceFile, targetFile) {
    const key = this.getRolloverKey(sourceFile, targetFile);
    if (!(key in this.rolledOverPairs)) {
      return false;
    }
    delete this.rolledOverPairs[key];
    await this.saveRolloverState();
    return true;
  }
  targetHasRolloverFromSource(targetContent, sourceDate) {
    const sourceDateTag = sourceDate.format(this.settings.tagDateFormat);
    const wikilinkTag = `([[${sourceDateTag}]]-)`;
    const plainTag = `(${sourceDateTag}-)`;
    const scope = this.extractScopeByHeading(targetContent, this.settings.targetHeading);
    const haystack = scope ? scope.lines.join("\n") : targetContent;
    return haystack.includes(wikilinkTag) || haystack.includes(plainTag);
  }
  /** True if todo scope already contains any rollover date tag from another device. */
  targetHasAnyRolloverTag(targetContent) {
    const scope = this.extractScopeByHeading(targetContent, this.settings.targetHeading);
    const haystack = scope ? scope.lines.join("\n") : targetContent;
    return /\((?:\d{8}|\[\[[^\]]+\]\])-\)/.test(haystack);
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  /** Access Obsidian Sync internal plugin when available (undocumented API). */
  getSyncInstance(): SyncInstance | null {
    try {
      const app = this.app as App & {
        internalPlugins?: {
          plugins?: {
            sync?: { enabled?: boolean; instance?: SyncInstance };
          };
        };
      };
      const syncPlugin = app.internalPlugins?.plugins?.sync;
      if (!syncPlugin?.enabled) {
        return null;
      }
      return syncPlugin.instance ?? null;
    } catch {
      return null;
    }
  }
  getSyncStatusText(sync) {
    if (!sync) {
      return "";
    }
    try {
      if (typeof sync.getStatus === "function") {
        const status = sync.getStatus();
        if (status != null && status !== "") {
          return String(status);
        }
      }
    } catch {
      // Fall through to syncStatus.
    }
    return sync.syncStatus != null ? String(sync.syncStatus) : "";
  }
  isSyncIdle(sync) {
    if (!sync) {
      return true;
    }
    if (sync.pause) {
      return true;
    }
    if (typeof sync.syncing === "boolean" && sync.syncing) {
      return false;
    }
    const status = this.getSyncStatusText(sync).toLowerCase().trim();
    if (!status) {
      return typeof sync.syncing === "boolean" ? !sync.syncing : true;
    }
    if (SYNC_IDLE_STATUSES.some((idle) => status === idle || status.includes(idle))) {
      return true;
    }
    if (SYNC_BUSY_HINTS.some((hint) => status.includes(hint))) {
      return false;
    }
    // Disconnected / error / unknown: do not block forever.
    return true;
  }
  /**
   * Wait until Obsidian Sync is idle (or timeout / Sync unavailable).
   * Returns after a short settle window so late file downloads can land.
   */
  async waitForSyncReady(options: { timeoutMs?: number; settleMs?: number } = {}) {
    const enabled = this.settings.waitForSync !== false;
    if (!enabled) {
      return { ready: true, reason: "disabled" };
    }
    const sync = this.getSyncInstance();
    if (!sync) {
      return { ready: true, reason: "no-sync" };
    }
    const timeoutMs = Math.max(
      0,
      Number(options.timeoutMs ?? this.settings.syncWaitTimeoutMs) || DEFAULT_SETTINGS.syncWaitTimeoutMs
    );
    const settleMs = Math.max(
      0,
      Number(options.settleMs ?? this.settings.syncSettleMs) || DEFAULT_SETTINGS.syncSettleMs
    );
    const deadline = Date.now() + timeoutMs;
    const waitUntilIdleOnce = () => new Promise((resolve) => {
      if (this.isSyncIdle(sync)) {
        resolve(true);
        return;
      }
      let settled = false;
      const finish = (ok) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearInterval(pollId);
        window.clearTimeout(timeoutId);
        try {
          sync.off?.("status-change", onStatus);
        } catch {
          // ignore
        }
        resolve(ok);
      };
      const onStatus = () => {
        if (this.isSyncIdle(sync)) {
          finish(true);
        } else if (Date.now() >= deadline) {
          finish(false);
        }
      };
      const pollId = window.setInterval(onStatus, 250);
      const timeoutId = window.setTimeout(() => finish(this.isSyncIdle(sync)), Math.max(0, deadline - Date.now()));
      try {
        sync.on?.("status-change", onStatus);
      } catch {
        // Polling still covers status updates.
      }
    });
    let idle = await waitUntilIdleOnce();
    if (!idle) {
      return { ready: false, reason: "timeout" };
    }
    // Stay idle across a settle window; restart wait if sync resumes.
    while (Date.now() < deadline) {
      const before = Date.now();
      await this.sleep(settleMs);
      if (this.isSyncIdle(sync)) {
        return { ready: true, reason: "synced" };
      }
      idle = await waitUntilIdleOnce();
      if (!idle) {
        return { ready: false, reason: "timeout" };
      }
      // Avoid tight loop if settleMs is 0.
      if (Date.now() === before) {
        break;
      }
    }
    return { ready: this.isSyncIdle(sync), reason: this.isSyncIdle(sync) ? "synced" : "timeout" };
  }
  enqueueAutoRollover(task) {
    const run = this.autoRolloverQueue.then(task, task);
    this.autoRolloverQueue = run.then(() => void 0, () => void 0);
    return run;
  }
  async isFreshlyCreatedFile(file) {
    const stat = await this.app.vault.adapter.stat(file.path);
    if (!stat) {
      return false;
    }
    const age = Date.now() - stat.ctime;
    // Windows/sync can report odd ctimes; allow missing/negative age through.
    if (Number.isNaN(age) || age < 0) {
      return true;
    }
    return age <= ROLLOVER_FRESH_FILE_MS;
  }
  isInDailyFolder(file) {
    const folder = (this.settings.dailyNotesFolder || "").replace(/\\/g, "/").replace(/\/$/, "");
    if (!folder) {
      return true;
    }
    const path = file.path.replace(/\\/g, "/");
    return path.startsWith(`${folder}/`);
  }
  async handleCreatedFile(file) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }
    if (!this.isInDailyFolder(file)) {
      return;
    }
    const createdDate = this.parseDailyNoteDate(file);
    if (!createdDate) {
      return;
    }
    // Wait for Daily Notes / Templates to finish writing the body.
    const delay = Math.max(0, Number(this.settings.createDelayMs) || 0);
    if (delay > 0) {
      await this.sleep(delay);
    }
    if (!this.app.vault.getAbstractFileByPath(file.path)) {
      return;
    }
    // Capture freshness before Sync wait (wait can exceed the fresh window).
    if (!await this.isFreshlyCreatedFile(file)) {
      return;
    }
    const createdPath = file.path;
    await this.enqueueAutoRollover(async () => {
      await this.processCreatedDailyNote(createdPath);
    });
  }
  /**
   * After Sync settles, roll into the latest daily only — never from a stale
   * previous note that had not downloaded yet.
   */
  async processCreatedDailyNote(createdPath) {
    const syncResult = await this.waitForSyncReady();
    if (!syncResult.ready && syncResult.reason === "timeout") {
      new Notice(
        "Rollover Todos [Gagans]: Sync did not finish in time; skipped auto rollover. Run manually if needed."
      );
      return;
    }
    // Reload plugin state that may have arrived via Sync (rolledOverPairs).
    await this.loadSettings();
    const createdFile = this.app.vault.getAbstractFileByPath(createdPath);
    if (!(createdFile instanceof TFile)) {
      return;
    }
    let dailyNotes = this.getSortedDailyNotes();
    if (dailyNotes.length < 2) {
      return;
    }
    // Prefer rolling into today's note even if an older synced file triggered create.
    let targetEntry = dailyNotes[dailyNotes.length - 1];
    const createdEntry = dailyNotes.find((entry) => entry.file.path === createdPath);
    if (createdEntry && createdEntry.file.path === targetEntry.file.path) {
      targetEntry = createdEntry;
    } else if (createdEntry && createdEntry.file.path !== targetEntry.file.path) {
      // An older daily arrived via Sync; do not rewrite it. Only act if it is latest.
      return;
    } else if (!createdEntry) {
      // Created file vanished or was renamed during sync; still try latest if it's new today.
      await this.sleep(300);
      dailyNotes = this.getSortedDailyNotes();
      if (dailyNotes.length < 2) {
        return;
      }
      targetEntry = dailyNotes[dailyNotes.length - 1];
    }
    // Calendar previous day may still be mid-download even when Sync says idle.
    await this.waitForCalendarPreviousDay(targetEntry.date);
    dailyNotes = this.getSortedDailyNotes();
    targetEntry = dailyNotes.find((entry) => entry.file.path === targetEntry.file.path) ?? dailyNotes[dailyNotes.length - 1];
    if (dailyNotes.length < 2) {
      return;
    }
    const source = this.findPreviousDailyNote(dailyNotes, targetEntry);
    if (source) {
      // Re-read after sync: target may already contain rolled tasks from another device.
      await this.runRolloverFromSourceToTarget(source.file, targetEntry.file, source.date, false);
      await this.runRoutineStreaksFromSourceToTarget(source.file, targetEntry.file, false);
      await this.runPinsRolloverFromSourceToTarget(source.file, targetEntry.file, false);
    }
    await this.updatePaginationAround(targetEntry.file, false);
    await this.backfillEditedLinks(targetEntry.file, targetEntry.date);
  }
  /** Briefly wait for yesterday's note path to appear (no-op if the day was skipped). */
  async waitForCalendarPreviousDay(targetDate, extraWaitMs = 1e4) {
    const previous = targetDate.clone().subtract(1, "day");
    const expectedPath = this.getDailyNotePathForDate(previous);
    if (!expectedPath || this.app.vault.getAbstractFileByPath(expectedPath)) {
      return true;
    }
    const deadline = Date.now() + Math.max(0, extraWaitMs);
    while (Date.now() < deadline) {
      await this.sleep(500);
      if (this.app.vault.getAbstractFileByPath(expectedPath)) {
        return true;
      }
      const sync = this.getSyncInstance();
      if (sync && !this.isSyncIdle(sync)) {
        await this.waitForSyncReady({
          timeoutMs: Math.max(0, deadline - Date.now()),
          settleMs: Math.min(500, this.settings.syncSettleMs ?? 500)
        });
        if (this.app.vault.getAbstractFileByPath(expectedPath)) {
          return true;
        }
      }
    }
    return Boolean(this.app.vault.getAbstractFileByPath(expectedPath));
  }
  getDailyNotePathForDate(date) {
    const folder = (this.settings.dailyNotesFolder || "").replace(/\\/g, "/").replace(/\/$/, "");
    const name = `${date.format(this.settings.dailyNoteFormat)}.md`;
    return folder ? `${folder}/${name}` : name;
  }
  findPreviousDailyNote(dailyNotes, targetEntry) {
    const index = dailyNotes.findIndex((entry) => entry.file.path === targetEntry.file.path);
    if (index <= 0) {
      return null;
    }
    return dailyNotes[index - 1];
  }
  findNextDailyNote(dailyNotes, targetEntry) {
    const index = dailyNotes.findIndex((entry) => entry.file.path === targetEntry.file.path);
    if (index < 0 || index >= dailyNotes.length - 1) {
      return null;
    }
    return dailyNotes[index + 1];
  }
  async runRolloverForLatestDailyNote(force = false) {
    const syncResult = await this.waitForSyncReady();
    if (!syncResult.ready && syncResult.reason === "timeout") {
      new Notice("Sync did not finish in time; rollover may use incomplete notes.");
    }
    await this.loadSettings();
    const dailyNotes = this.getSortedDailyNotes();
    if (dailyNotes.length < 2) {
      new Notice("At least two daily notes are required for rollover.");
      return;
    }
    const source = dailyNotes[dailyNotes.length - 2];
    const target = dailyNotes[dailyNotes.length - 1];
    if (force) {
      const cleared = await this.clearRolledOver(source.file, target.file);
      if (cleared) {
        new Notice(`Cleared rollover state: ${source.file.basename} → ${target.file.basename}`);
      }
    }
    await this.runRolloverFromSourceToTarget(source.file, target.file, source.date, true, force);
    await this.runRoutineStreaksFromSourceToTarget(source.file, target.file, true);
    await this.runPinsRolloverFromSourceToTarget(source.file, target.file, true);
    await this.updatePaginationAround(target.file, true);
  }
  async runRoutineStreaksForLatestDailyNote(isManual = false) {
    if (isManual) {
      const syncResult = await this.waitForSyncReady();
      if (!syncResult.ready && syncResult.reason === "timeout") {
        new Notice("Sync did not finish in time; streaks may use incomplete notes.");
      }
      await this.loadSettings();
    }
    const dailyNotes = this.getSortedDailyNotes();
    if (dailyNotes.length < 2) {
      if (isManual) {
        new Notice("At least two daily notes are required for routine streaks.");
      }
      return;
    }
    const source = dailyNotes[dailyNotes.length - 2];
    const target = dailyNotes[dailyNotes.length - 1];
    await this.runRoutineStreaksFromSourceToTarget(source.file, target.file, isManual);
  }
  async runRolloverFromSourceToTarget(sourceFile, targetFile, sourceDate, isManual = false, force = false) {
    // Always re-read both sides so Sync updates are visible.
    let targetContent = await this.app.vault.read(targetFile);
    if (!force && this.hasRolledOver(sourceFile, targetFile)) {
      // Stale mark: pair recorded but tasks were wiped (template overwrite / recreate).
      if (!this.targetHasRolloverFromSource(targetContent, sourceDate)) {
        await this.clearRolledOver(sourceFile, targetFile);
      } else {
        if (isManual) {
          new Notice(`Already rolled over: ${sourceFile.basename} → ${targetFile.basename}`);
        }
        return;
      }
    }
    if (!force && this.targetHasRolloverFromSource(targetContent, sourceDate)) {
      await this.markRolledOver(sourceFile, targetFile);
      if (isManual) {
        new Notice(`Already rolled over: ${sourceFile.basename} → ${targetFile.basename}`);
      }
      return;
    }
    // Another device may already have rolled from a different prior day into target.
    if (!force && this.targetHasAnyRolloverTag(targetContent)) {
      await this.markRolledOver(sourceFile, targetFile);
      if (isManual) {
        new Notice(`Target already has rolled-over tasks: ${targetFile.basename}`);
      }
      return;
    }
    // Heading may appear only after template write; retry briefly on auto-create.
    let targetScope = this.extractScopeByHeading(targetContent, this.settings.targetHeading);
    if (!targetScope && !isManual) {
      await this.sleep(400);
      targetContent = await this.app.vault.read(targetFile);
      targetScope = this.extractScopeByHeading(targetContent, this.settings.targetHeading);
      if (!force && this.targetHasRolloverFromSource(targetContent, sourceDate)) {
        await this.markRolledOver(sourceFile, targetFile);
        return;
      }
      if (!force && this.targetHasAnyRolloverTag(targetContent)) {
        await this.markRolledOver(sourceFile, targetFile);
        return;
      }
    }
    const sourceContent = await this.app.vault.read(sourceFile);
    const sourceScope = this.extractScopeByHeading(
      sourceContent,
      this.settings.targetHeading
    );
    if (!sourceScope) {
      new Notice(`Target heading not found in source note: ${sourceFile.basename}`);
      return;
    }
    const sourceDateTag = sourceDate.format(this.settings.tagDateFormat);
    const rolloverTasks = this.extractPendingTasks(sourceScope.lines, sourceDateTag);
    if (rolloverTasks.length === 0) {
      if (isManual) {
        new Notice("No pending tasks to rollover.");
      }
      // Still mark so we do not keep retrying empty sources after Sync.
      if (!isManual) {
        await this.markRolledOver(sourceFile, targetFile);
      }
      return;
    }
    targetScope = this.extractScopeByHeading(targetContent, this.settings.targetHeading);
    const existingLines = targetScope ? targetScope.lines : [];
    const newTasks = this.filterTasksNotInTarget(rolloverTasks, existingLines);
    if (newTasks.length === 0) {
      await this.markRolledOver(sourceFile, targetFile);
      if (isManual) {
        new Notice("No new tasks to rollover (already present).");
      }
      return;
    }
    const updated = this.insertTasksAfterHeading(
      targetContent,
      this.settings.targetHeading,
      newTasks
    );
    if (!updated.changed) {
      new Notice(`Target heading not found in target note: ${targetFile.basename}`);
      return;
    }
    await this.app.vault.modify(targetFile, updated.content);
    // If Daily Notes template overwrites us right after, restore once (still differential).
    await this.sleep(350);
    const afterContent = await this.app.vault.read(targetFile);
    if (!this.targetHasRolloverFromSource(afterContent, sourceDate)) {
      const afterScope = this.extractScopeByHeading(afterContent, this.settings.targetHeading);
      const stillMissing = this.filterTasksNotInTarget(
        rolloverTasks,
        afterScope ? afterScope.lines : []
      );
      if (stillMissing.length > 0) {
        const restored = this.insertTasksAfterHeading(
          afterContent,
          this.settings.targetHeading,
          stillMissing
        );
        if (restored.changed) {
          await this.app.vault.modify(targetFile, restored.content);
        }
      }
    }
    await this.markRolledOver(sourceFile, targetFile);
    new Notice(`Rolled over ${newTasks.length} lines from ${sourceFile.basename}.`);
  }
  async runRoutineStreaksFromSourceToTarget(sourceFile, targetFile, isManual = false) {
    const sourceContent = await this.app.vault.read(sourceFile);
    let targetContent = await this.app.vault.read(targetFile);
    let targetScope = this.extractScopeByHeading(targetContent, this.settings.routineHeading);
    if (!targetScope && !isManual) {
      await this.sleep(400);
      targetContent = await this.app.vault.read(targetFile);
      targetScope = this.extractScopeByHeading(targetContent, this.settings.routineHeading);
    }
    if (!targetScope) {
      if (isManual) {
        new Notice(`Routine heading not found in target note: ${targetFile.basename}`);
      }
      return;
    }
    const sourceScope = this.extractScopeByHeading(sourceContent, this.settings.routineHeading);
    const previousById = this.collectRoutineStatsById(sourceScope ? sourceScope.lines : []);
    const updated = this.applyRoutineStreaks(targetContent, this.settings.routineHeading, previousById);
    if (!updated.changed) {
      if (isManual) {
        new Notice("No routine streak updates.");
      }
      return;
    }
    await this.app.vault.modify(targetFile, updated.content);
    if (isManual) {
      new Notice(`Updated ${updated.updatedCount} routine streak(s).`);
    }
  }
  async runPinsRolloverForLatestDailyNote(isManual = false) {
    if (isManual) {
      const syncResult = await this.waitForSyncReady();
      if (!syncResult.ready && syncResult.reason === "timeout") {
        new Notice("Sync did not finish in time; pins may use incomplete notes.");
      }
      await this.loadSettings();
    }
    const dailyNotes = this.getSortedDailyNotes();
    if (dailyNotes.length < 2) {
      if (isManual) {
        new Notice("At least two daily notes are required to roll over pins.");
      }
      return;
    }
    const source = dailyNotes[dailyNotes.length - 2];
    const target = dailyNotes[dailyNotes.length - 1];
    await this.runPinsRolloverFromSourceToTarget(source.file, target.file, isManual);
  }
  async runPinsRolloverFromSourceToTarget(sourceFile, targetFile, isManual = false) {
    if (this.settings.pinsEnabled === false) {
      return;
    }
    const heading = this.settings.pinsHeading || DEFAULT_SETTINGS.pinsHeading;
    const sourceContent = await this.app.vault.read(sourceFile);
    const sourceScope = this.extractEditedScope(sourceContent, heading);
    const pinLines = sourceScope ? sourceScope.lines : [];
    const incoming = pinLines.filter((line) => {
      return !this.isBlankLine(line) && !this.isEmptyWikilinkLine(line) && this.isEditedLinkLine(line);
    });
    if (incoming.length === 0) {
      if (isManual) {
        new Notice(`No pins to roll over from ${sourceFile.basename}.`);
      }
      return;
    }
    let targetContent = await this.app.vault.read(targetFile);
    let updated = this.replacePinLinks(targetContent, heading, incoming, targetFile);
    if (!updated.changed) {
      if (isManual) {
        new Notice("Pins are already up to date.");
      }
      return;
    }
    await this.modifyDailySafely(targetFile, updated.content);
    if (!isManual) {
      await this.sleep(350);
      const afterContent = await this.app.vault.read(targetFile);
      const restored = this.replacePinLinks(afterContent, heading, incoming, targetFile);
      if (restored.changed) {
        await this.modifyDailySafely(targetFile, restored.content);
        updated = restored;
      }
    }
    if (isManual) {
      new Notice(`Rolled over ${updated.addedCount} pin(s) from ${sourceFile.basename}.`);
    }
  }
  async runPaginationForLatestDailyNote(isManual = false) {
    if (isManual) {
      const syncResult = await this.waitForSyncReady();
      if (!syncResult.ready && syncResult.reason === "timeout") {
        new Notice("Sync did not finish in time; pagination may use incomplete notes.");
      }
      await this.loadSettings();
    }
    const dailyNotes = this.getSortedDailyNotes();
    if (dailyNotes.length < 1) {
      if (isManual) {
        new Notice("No daily notes were found.");
      }
      return;
    }
    await this.updatePaginationAround(dailyNotes[dailyNotes.length - 1].file, isManual);
  }
  async updatePaginationAround(file, isManual = false) {
    if (this.settings.paginationEnabled === false) {
      return;
    }
    const dailyNotes = this.getSortedDailyNotes();
    const entry = dailyNotes.find((item) => item.file.path === file.path);
    if (!entry) {
      return;
    }
    const previous = this.findPreviousDailyNote(dailyNotes, entry);
    const next = this.findNextDailyNote(dailyNotes, entry);
    let changedCount = 0;
    if (await this.updatePaginationForFile(entry.file)) {
      changedCount++;
    }
    if (previous && await this.updatePaginationForFile(previous.file)) {
      changedCount++;
    }
    if (next && await this.updatePaginationForFile(next.file)) {
      changedCount++;
    }
    if (isManual) {
      if (changedCount > 0) {
        new Notice(`Updated pagination on ${changedCount} daily note(s).`);
      } else {
        new Notice("Pagination is already up to date.");
      }
    }
  }
  async updatePaginationForFile(file) {
    const heading = this.settings.paginationHeading || DEFAULT_SETTINGS.paginationHeading;
    const dailyNotes = this.getSortedDailyNotes();
    const entry = dailyNotes.find((item) => item.file.path === file.path);
    if (!entry) {
      return false;
    }
    const previous = this.findPreviousDailyNote(dailyNotes, entry);
    const next = this.findNextDailyNote(dailyNotes, entry);
    const content = await this.app.vault.read(file);
    const updated = this.writePaginationBlock(
      content,
      heading,
      previous ? previous.file : null,
      next ? next.file : null,
      file
    );
    if (!updated.changed) {
      return false;
    }
    await this.modifyDailySafely(file, updated.content);
    return true;
  }
  ensureLinkHeadingBefore(content, heading, beforeNeedles) {
    if (this.extractEditedScope(content, heading)) {
      return content;
    }
    const headingLine = this.formatSectionHeading(heading);
    const lines = content.split(/\r?\n/);
    for (const needle of beforeNeedles) {
      const idx = this.findHeadingIndex(lines, needle);
      if (idx < 0) {
        continue;
      }
      const insert = idx > 0 && this.isBlankLine(lines[idx - 1]) ? [headingLine, ""] : ["", headingLine, ""];
      lines.splice(idx, 0, ...insert);
      return lines.join("\n");
    }
    const trimmedEnd = content.replace(/\s+$/, "");
    return `${trimmedEnd}

${headingLine}
`;
  }
  mergePinLinkLines(existingLines, incomingLines, dailyFile) {
    const merged = [];
    const seen = /* @__PURE__ */ new Set();
    for (const line of [...existingLines, ...incomingLines]) {
      if (this.isBlankLine(line) || this.isEmptyWikilinkLine(line)) {
        continue;
      }
      if (!this.isEditedLinkLine(line)) {
        continue;
      }
      const key = this.getEditedLinkKey(line, dailyFile);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(line.trim());
    }
    return merged;
  }
  replacePinLinks(content, heading, incomingLines, dailyFile) {
    const withHeading = this.ensureLinkHeadingBefore(content, heading, ["todo", "modified", "memo"]);
    const scope = this.extractEditedScope(withHeading, heading);
    if (!scope) {
      return { changed: false, content: withHeading, addedCount: 0 };
    }
    const lines = withHeading.split(/\r?\n/);
    const merged = this.mergePinLinkLines(scope.lines, incomingLines, dailyFile);
    if (merged.length === 0) {
      return { changed: withHeading !== content, content: withHeading, addedCount: 0 };
    }
    const existingKeys = new Set(
      scope.lines.filter((line) => !this.isEmptyWikilinkLine(line) && this.isEditedLinkLine(line)).map((line) => this.getEditedLinkKey(line, dailyFile)).filter(Boolean)
    );
    const addedCount = merged.filter((line) => !existingKeys.has(this.getEditedLinkKey(line, dailyFile))).length;
    const nextLines = [
      ...lines.slice(0, scope.contentStart),
      ...merged,
      ...lines.slice(scope.contentEnd)
    ];
    const nextContent = nextLines.join("\n");
    return {
      changed: nextContent !== withHeading || withHeading !== content,
      content: nextContent,
      addedCount
    };
  }
  getBodyStartIndex(lines) {
    if (lines.length === 0 || lines[0].trim() !== "---") {
      return 0;
    }
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        return i + 1;
      }
    }
    return 0;
  }
  removeHeadingBlock(content, heading) {
    const lines = content.split(/\r?\n/);
    const headingIndex = this.findHeadingIndex(lines, heading);
    if (headingIndex === -1) {
      return content;
    }
    let end = headingIndex + 1;
    while (end < lines.length && this.isBlankLine(lines[end])) {
      end++;
    }
    while (end < lines.length && this.isPaginationContentLine(lines[end])) {
      end++;
    }
    while (end < lines.length && this.isBlankLine(lines[end])) {
      end++;
    }
    let start = headingIndex;
    if (start > 0 && this.isBlankLine(lines[start - 1])) {
      start--;
    }
    lines.splice(start, end - start);
    return lines.join("\n");
  }
  writePaginationBlock(content, heading, previousFile, nextFile, currentFile) {
    const upgraded = this.upgradeSectionHeadings(content);
    const without = this.removeHeadingBlock(upgraded.content, heading);
    const lines = without.split(/\r?\n/);
    while (lines.length > 0 && this.isBlankLine(lines[lines.length - 1])) {
      lines.pop();
    }
    const blockLines = [
      this.formatSectionHeading(heading),
      this.formatPaginationLine("prev", previousFile, currentFile),
      this.formatPaginationLine("next", nextFile, currentFile),
      ""
    ];
    let insertAt = this.getBodyStartIndex(lines);
    while (insertAt < lines.length && this.isBlankLine(lines[insertAt])) {
      insertAt++;
    }
    const nextLines = [
      ...lines.slice(0, insertAt),
      ...blockLines,
      ...lines.slice(insertAt)
    ];
    const nextContent = `${nextLines.join("\n").replace(/\s+$/, "")}
`;
    return { changed: nextContent !== content, content: nextContent };
  }
  getSortedDailyNotes() {
    const entries = this.app.vault.getMarkdownFiles().filter((file) => this.isInDailyFolder(file)).map((file) => {
      const date = this.parseDailyNoteDate(file);
      return date ? { file, date } : null;
    }).filter((entry) => entry !== null);
    entries.sort((a, b) => {
      const byDate = a.date.valueOf() - b.date.valueOf();
      return byDate !== 0 ? byDate : a.file.path.localeCompare(b.file.path);
    });
    return entries;
  }
  parseDailyNoteDate(file) {
    const parsed = moment(file.basename, this.settings.dailyNoteFormat, true);
    return parsed.isValid() ? parsed : null;
  }
  isBlankLine(line) {
    return line.trim().length === 0;
  }
  normalizeHeadingLabel(value) {
    return String(value || "").trim().replace(/^#{1,6}\s+/, "").trim().toLowerCase();
  }
  isHeadingLine(line, heading) {
    const label = this.normalizeHeadingLabel(heading);
    return Boolean(label) && this.normalizeHeadingLabel(line) === label;
  }
  findHeadingIndex(lines, heading) {
    return lines.findIndex((line) => this.isHeadingLine(line, heading));
  }
  getSectionHeadingLevel() {
    const parsed = Number(this.settings.sectionHeadingLevel);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_SETTINGS.sectionHeadingLevel;
    }
    return Math.min(6, Math.max(1, Math.round(parsed)));
  }
  formatSectionHeading(heading) {
    const label = String(heading || "").trim().replace(/^#{1,6}\s+/, "").trim() || "section";
    return `${"#".repeat(this.getSectionHeadingLevel())} ${label}`;
  }
  getKnownSectionLabels() {
    return [
      this.settings.routineHeading || DEFAULT_SETTINGS.routineHeading,
      this.settings.pinsHeading || DEFAULT_SETTINGS.pinsHeading,
      this.settings.targetHeading || DEFAULT_SETTINGS.targetHeading,
      this.settings.editedHeading || DEFAULT_SETTINGS.editedHeading,
      "memo",
      this.settings.paginationHeading || DEFAULT_SETTINGS.paginationHeading
    ];
  }
  upgradeSectionHeadings(content) {
    const lines = content.split(/\r?\n/);
    const labels = this.getKnownSectionLabels();
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      for (const label of labels) {
        if (!this.isHeadingLine(lines[i], label)) {
          continue;
        }
        const next = this.formatSectionHeading(label);
        if (lines[i] !== next) {
          lines[i] = next;
          changed = true;
        }
        break;
      }
    }
    return { changed, content: lines.join("\n") };
  }
  isPaginationContentLine(line) {
    if (this.isBlankLine(line)) {
      return false;
    }
    if (/^\s*(prev|next)\s*:/i.test(line)) {
      return true;
    }
    return this.isEditedLinkLine(line);
  }
  formatPaginationLine(label, file, currentFile) {
    const link = file ? this.formatEditedLink(file, currentFile) : "";
    return link ? `${label} : ${link}` : `${label} :`;
  }
  isEmptyTaskLine(line) {
    const taskMatch = line.match(TASK_LINE_REGEX);
    return Boolean(taskMatch) && taskMatch[3].trim().length === 0;
  }
  /**
   * Scope starts after the line containing targetHeading.
   * Leading blank lines after the heading are skipped.
   * Scope ends at the first blank line after content begins
   * (so checkboxes after a blank separator are excluded).
   */
  extractScopeByHeading(content, targetHeading) {
    const lines = content.split(/\r?\n/);
    const headingIndex = this.findHeadingIndex(lines, targetHeading);
    if (headingIndex === -1) {
      return null;
    }
    let contentStart = headingIndex + 1;
    while (contentStart < lines.length && this.isBlankLine(lines[contentStart])) {
      contentStart++;
    }
    let contentEnd = contentStart;
    while (contentEnd < lines.length && !this.isBlankLine(lines[contentEnd])) {
      contentEnd++;
    }
    return {
      lines: lines.slice(contentStart, contentEnd),
      headingIndex,
      contentStart,
      contentEnd
    };
  }
  extractPendingTasks(scopeLines, sourceDateTag) {
    const result = [];
    const contexts = [];
    for (const currentLine of scopeLines) {
      const currentIndent = this.getIndentWidth(currentLine);
      while (contexts.length > 0 && currentIndent <= contexts[contexts.length - 1].indent) {
        contexts.pop();
      }
      const parentAllows = contexts.every((context) => context.includeSubtree);
      const taskMatch = currentLine.match(TASK_LINE_REGEX);
      if (!taskMatch) {
        if (parentAllows && contexts.length > 0) {
          result.push(currentLine);
        }
        continue;
      }
      const marker = taskMatch[2];
      const body = taskMatch[3];
      const isPending = marker === " ";
      const isEmpty = body.trim().length === 0;
      const includeCurrentTask = parentAllows && isPending && !isEmpty;
      contexts.push({
        indent: currentIndent,
        includeSubtree: includeCurrentTask
      });
      if (includeCurrentTask) {
        const taggedBody = this.appendRolloverDateTagIfNeeded(body, sourceDateTag);
        const rebuiltTask = `${taskMatch[1]}- [ ] ${taggedBody}`;
        result.push(rebuiltTask);
      }
    }
    return result;
  }
  /** Compare tasks ignoring checkbox state and trailing rollover date tags. */
  normalizeTaskIdentity(line) {
    const taskMatch = line.match(TASK_LINE_REGEX);
    if (!taskMatch) {
      const trimmed = line.trim();
      return trimmed ? `text:${trimmed}` : "";
    }
    const indent = this.getIndentWidth(taskMatch[1]);
    const body = taskMatch[3].replace(ROLLOVER_TAG_REGEX, "").replace(ROUTINE_STREAK_REGEX, "").trim();
    if (!body) {
      return "";
    }
    return `task:${indent}:${body}`;
  }
  filterTasksNotInTarget(candidateTasks, existingLines) {
    const existing = new Set();
    for (const line of existingLines) {
      const key = this.normalizeTaskIdentity(line);
      if (key) {
        existing.add(key);
      }
    }
    return candidateTasks.filter((task) => {
      const key = this.normalizeTaskIdentity(task);
      return key && !existing.has(key);
    });
  }
  appendRolloverDateTagIfNeeded(taskBody, sourceDateTag) {
    if (ROLLOVER_TAG_REGEX.test(taskBody)) {
      return taskBody;
    }
    return `${taskBody} ([[${sourceDateTag}]]-)`;
  }
  insertTasksAfterHeading(content, targetHeading, tasks) {
    const lines = content.split(/\r?\n/);
    const scope = this.extractScopeByHeading(content, targetHeading);
    if (!scope) {
      return { changed: false, content };
    }
    // Append to the block, but keep trailing empty checkboxes (template placeholders) below.
    let insertAt = scope.contentEnd;
    while (insertAt > scope.contentStart && this.isEmptyTaskLine(lines[insertAt - 1])) {
      insertAt--;
    }
    const newLines = [
      ...lines.slice(0, insertAt),
      ...tasks,
      ...lines.slice(insertAt)
    ];
    return { changed: true, content: newLines.join("\n") };
  }
  parseRoutineLine(line) {
    const taskMatch = line.match(TASK_LINE_REGEX);
    if (!taskMatch) {
      return null;
    }
    const indent = taskMatch[1];
    const marker = taskMatch[2];
    let body = taskMatch[3];
    let consec = null;
    let max = null;
    const streakMatch = body.match(ROUTINE_STREAK_REGEX);
    if (streakMatch) {
      consec = Number.parseInt(streakMatch[1], 10);
      max = Number.parseInt(streakMatch[2], 10);
      body = body.replace(ROUTINE_STREAK_REGEX, "");
    }
    const idMatch = body.match(ROUTINE_ID_REGEX);
    if (!idMatch) {
      return null;
    }
    return {
      indent,
      marker,
      id: idMatch[1],
      description: idMatch[2].replace(/\s+$/, ""),
      checked: marker === "x" || marker === "X",
      consec: Number.isFinite(consec) ? consec : null,
      max: Number.isFinite(max) ? max : null
    };
  }
  formatRoutineLine(routine, consec, max) {
    return `${routine.indent}- [${routine.marker}] {${routine.id}}${routine.description} ⚡${consec}↑${max}`;
  }
  collectRoutineStatsById(scopeLines) {
    const byId = /* @__PURE__ */ new Map();
    for (const line of scopeLines) {
      const routine = this.parseRoutineLine(line);
      if (!routine) {
        continue;
      }
      // First occurrence wins if duplicate ids appear.
      if (byId.has(routine.id)) {
        continue;
      }
      byId.set(routine.id, {
        checked: routine.checked,
        consec: routine.consec ?? 0,
        max: routine.max ?? 0
      });
    }
    return byId;
  }
  applyRoutineStreaks(content, routineHeading, previousById) {
    const lines = content.split(/\r?\n/);
    const scope = this.extractScopeByHeading(content, routineHeading);
    if (!scope) {
      return { changed: false, content, updatedCount: 0 };
    }
    let changed = false;
    let updatedCount = 0;
    for (let i = scope.contentStart; i < scope.contentEnd; i++) {
      const routine = this.parseRoutineLine(lines[i]);
      if (!routine) {
        continue;
      }
      const previous = previousById.get(routine.id);
      let consec;
      let max;
      if (!previous) {
        consec = 0;
        max = 0;
      } else {
        consec = previous.checked ? previous.consec + 1 : 0;
        max = Math.max(previous.max, consec);
      }
      const nextLine = this.formatRoutineLine(routine, consec, max);
      if (nextLine !== lines[i]) {
        lines[i] = nextLine;
        changed = true;
        updatedCount++;
      }
    }
    return { changed, content: lines.join("\n"), updatedCount };
  }
  getIndentWidth(value) {
    const match = value.match(/^[ \t]*/);
    return match ? match[0].length : 0;
  }
  normalizeIgnoreFolders(value) {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|,/) : DEFAULT_SETTINGS.editedIgnoreFolders;
    const folders = [];
    const seen = /* @__PURE__ */ new Set();
    for (const item of raw) {
      const folder = String(item || "").replace(/\\/g, "/").replace(/\/$/, "").trim();
      if (!folder || seen.has(folder)) {
        continue;
      }
      seen.add(folder);
      folders.push(folder);
    }
    return folders;
  }
  getIgnoreFolders() {
    return this.normalizeIgnoreFolders(this.settings.editedIgnoreFolders);
  }
  normalizeVaultPath(path) {
    return String(path || "").replace(/\\/g, "/");
  }
  isPathInFolder(path, folder) {
    const normalizedPath = this.normalizeVaultPath(path);
    const normalizedFolder = this.normalizeVaultPath(folder).replace(/\/$/, "");
    if (!normalizedFolder) {
      return false;
    }
    return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
  }
  getTodayDate() {
    return moment();
  }
  getTodayDailyFile() {
    const path = this.getDailyNotePathForDate(this.getTodayDate());
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }
  shouldTrackEditedFile(file, dailyFile = null) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return false;
    }
    const path = this.normalizeVaultPath(file.path);
    if (path.startsWith(".obsidian/") || path.includes("/.obsidian/")) {
      return false;
    }
    if (dailyFile && path === this.normalizeVaultPath(dailyFile.path)) {
      return false;
    }
    if (this.settings.editedExcludeDailyNotes !== false && this.isInDailyFolder(file)) {
      return false;
    }
    for (const folder of this.getIgnoreFolders()) {
      if (this.isPathInFolder(path, folder)) {
        return false;
      }
    }
    return true;
  }
  parseFrontmatterDate(value) {
    if (value == null || value === "") {
      return null;
    }
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw instanceof Date) {
      const parsedDate = moment(raw);
      return parsedDate.isValid() ? parsedDate : null;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const parsedNumber = moment(raw);
      return parsedNumber.isValid() ? parsedNumber : null;
    }
    const text = String(raw).trim();
    if (!text) {
      return null;
    }
    const strict = moment(text, FRONTMATTER_DATE_FORMATS, true);
    if (strict.isValid()) {
      return strict;
    }
    const loose = moment(text);
    return loose.isValid() ? loose : null;
  }
  isSameCalendarDay(left, right) {
    return left.format("YYYY-MM-DD") === right.format("YYYY-MM-DD");
  }
  isFileTouchedOnDate(file, date) {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    const created = this.parseFrontmatterDate(frontmatter?.created);
    const updated = this.parseFrontmatterDate(frontmatter?.updated);
    if (created && this.isSameCalendarDay(created, date)) {
      return true;
    }
    if (updated && this.isSameCalendarDay(updated, date)) {
      return true;
    }
    if (created || updated) {
      return false;
    }
    const ctime = file.stat?.ctime;
    const mtime = file.stat?.mtime;
    if (ctime && this.isSameCalendarDay(moment(ctime), date)) {
      return true;
    }
    if (mtime && this.isSameCalendarDay(moment(mtime), date)) {
      return true;
    }
    return false;
  }
  isActivelyBeingEdited(file) {
    const active = this.app.workspace.getActiveFile();
    return Boolean(active && active.path === file.path);
  }
  isEmptyWikilinkLine(line) {
    return EMPTY_WIKILINK_REGEX.test(line);
  }
  isEditedLinkLine(line) {
    return WIKILINK_LINE_REGEX.test(line) || MARKDOWN_LINK_LINE_REGEX.test(line);
  }
  getEditedLinkpath(line) {
    const wiki = line.match(WIKILINK_LINE_REGEX);
    if (wiki) {
      return wiki[1].split("|")[0].trim().replace(/\\/g, "/").replace(/\.md$/i, "");
    }
    const markdown = line.match(MARKDOWN_LINK_LINE_REGEX);
    if (markdown) {
      try {
        return decodeURIComponent(markdown[2]).replace(/\\/g, "/").replace(/\.md$/i, "").split("#")[0];
      } catch {
        return markdown[2].replace(/\\/g, "/").replace(/\.md$/i, "").split("#")[0];
      }
    }
    return "";
  }
  getEditedLinkKey(line, dailyFile) {
    const linkpath = this.getEditedLinkpath(line);
    if (!linkpath) {
      return "";
    }
    const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, dailyFile.path);
    if (dest) {
      return this.normalizeVaultPath(dest.path).toLowerCase();
    }
    return linkpath.toLowerCase();
  }
  formatEditedLink(file, dailyFile) {
    const link = this.app.fileManager.generateMarkdownLink(file, dailyFile.path);
    return link.startsWith("!") ? link.slice(1) : link;
  }
  extractEditedScope(content, heading) {
    const lines = content.split(/\r?\n/);
    const headingIndex = this.findHeadingIndex(lines, heading);
    if (headingIndex === -1) {
      return null;
    }
    let start = headingIndex + 1;
    while (start < lines.length && this.isBlankLine(lines[start])) {
      start++;
    }
    if (start < lines.length && !this.isEditedLinkLine(lines[start])) {
      return {
        lines: [],
        headingIndex,
        contentStart: headingIndex + 1,
        contentEnd: headingIndex + 1
      };
    }
    let end = start;
    while (end < lines.length && this.isEditedLinkLine(lines[end])) {
      end++;
    }
    return {
      lines: lines.slice(start, end),
      headingIndex,
      contentStart: start,
      contentEnd: end
    };
  }
  ensureEditedHeading(content, heading) {
    if (this.extractEditedScope(content, heading)) {
      return content;
    }
    const headingLine = this.formatSectionHeading(heading);
    const lines = content.split(/\r?\n/);
    const memoIndex = this.findHeadingIndex(lines, "memo");
    const block = ["", headingLine];
    if (memoIndex >= 0) {
      const insert = memoIndex > 0 && this.isBlankLine(lines[memoIndex - 1]) ? [headingLine] : block;
      lines.splice(memoIndex, 0, ...insert);
      if (memoIndex === 0 || !this.isBlankLine(lines[memoIndex + insert.length])) {
        lines.splice(memoIndex + insert.length, 0, "");
      }
      return lines.join("\n");
    }
    const trimmedEnd = content.replace(/\s+$/, "");
    return `${trimmedEnd}

${headingLine}
`;
  }
  mergeEditedLinkLines(existingLines, incomingLines, dailyFile) {
    const merged = [];
    const seen = /* @__PURE__ */ new Set();
    for (const line of [...existingLines, ...incomingLines]) {
      if (this.isBlankLine(line) || this.isEmptyWikilinkLine(line)) {
        continue;
      }
      if (!this.isEditedLinkLine(line)) {
        continue;
      }
      const key = this.getEditedLinkKey(line, dailyFile);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(line.trim());
    }
    merged.sort((a, b) => {
      const aName = this.getEditedLinkpath(a).split("/").pop() || a;
      const bName = this.getEditedLinkpath(b).split("/").pop() || b;
      return aName.localeCompare(bName, "ja");
    });
    return merged;
  }
  replaceEditedLinks(content, heading, linkLines, dailyFile) {
    const withHeading = this.ensureEditedHeading(content, heading);
    const scope = this.extractEditedScope(withHeading, heading);
    if (!scope) {
      return { changed: false, content: withHeading, addedCount: 0 };
    }
    const lines = withHeading.split(/\r?\n/);
    const merged = this.mergeEditedLinkLines(scope.lines, linkLines, dailyFile);
    const existingKeys = new Set(
      scope.lines.filter((line) => !this.isEmptyWikilinkLine(line) && this.isEditedLinkLine(line)).map((line) => this.getEditedLinkKey(line, dailyFile)).filter(Boolean)
    );
    const addedCount = merged.filter((line) => !existingKeys.has(this.getEditedLinkKey(line, dailyFile))).length;
    const nextLines = [
      ...lines.slice(0, scope.contentStart),
      ...merged,
      ...lines.slice(scope.contentEnd)
    ];
    const nextContent = nextLines.join("\n");
    return {
      changed: nextContent !== withHeading || withHeading !== content,
      content: nextContent,
      addedCount
    };
  }
  removeEditedLinkKeys(content, heading, keysToRemove, dailyFile) {
    const scope = this.extractEditedScope(content, heading);
    if (!scope || keysToRemove.size === 0) {
      return { changed: false, content };
    }
    const lines = content.split(/\r?\n/);
    const kept = scope.lines.filter((line) => {
      if (this.isEmptyWikilinkLine(line)) {
        return false;
      }
      const key = this.getEditedLinkKey(line, dailyFile);
      return key && !keysToRemove.has(key);
    });
    const nextLines = [
      ...lines.slice(0, scope.contentStart),
      ...kept,
      ...lines.slice(scope.contentEnd)
    ];
    const nextContent = nextLines.join("\n");
    return { changed: nextContent !== content, content: nextContent };
  }
  async modifyDailySafely(file, content) {
    this.writingDailyPaths.add(file.path);
    try {
      await this.app.vault.modify(file, content);
    } finally {
      window.setTimeout(() => {
        this.writingDailyPaths.delete(file.path);
      }, 250);
    }
  }
  scheduleEditedFlush() {
    const delay = Math.max(0, Number(this.settings.editedDebounceMs) || DEFAULT_SETTINGS.editedDebounceMs);
    if (this.editedFlushTimer != null) {
      window.clearTimeout(this.editedFlushTimer);
    }
    this.editedFlushTimer = window.setTimeout(() => {
      this.editedFlushTimer = null;
      void this.enqueueAutoRollover(async () => {
        await this.flushPendingEditedLinks();
      });
    }, delay);
  }
  async handleEditedNoteEvent(file) {
    if (!this.pluginReady || this.settings.editedEnabled === false) {
      return;
    }
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }
    if (this.writingDailyPaths.has(file.path)) {
      return;
    }
    const dailyFile = this.getTodayDailyFile();
    if (!this.shouldTrackEditedFile(file, dailyFile)) {
      return;
    }
    await this.sleep(400);
    const current = this.app.vault.getAbstractFileByPath(file.path);
    if (!(current instanceof TFile)) {
      return;
    }
    const today = this.getTodayDate();
    if (!this.isActivelyBeingEdited(current) && !this.isFileTouchedOnDate(current, today)) {
      return;
    }
    this.pendingEditedPaths.add(current.path);
    this.scheduleEditedFlush();
  }
  async handleEditedNoteRename(file, oldPath) {
    if (!this.pluginReady || this.settings.editedEnabled === false) {
      return;
    }
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }
    this.pendingEditedRenames.push({ oldPath, newPath: file.path });
    if (this.pendingEditedPaths.has(oldPath)) {
      this.pendingEditedPaths.delete(oldPath);
      this.pendingEditedPaths.add(file.path);
    }
    const dailyFile = this.getTodayDailyFile();
    if (this.shouldTrackEditedFile(file, dailyFile)) {
      this.pendingEditedPaths.add(file.path);
    }
    this.scheduleEditedFlush();
  }
  async handleEditedNoteDelete(file) {
    if (!this.pluginReady || this.settings.editedEnabled === false) {
      return;
    }
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }
    this.pendingEditedPaths.delete(file.path);
    this.pendingEditedDeletes.push(file.path);
    this.scheduleEditedFlush();
  }
  async flushPendingEditedLinks() {
    if (this.settings.editedEnabled === false) {
      return;
    }
    const dailyFile = this.getTodayDailyFile();
    if (!dailyFile) {
      return;
    }
    const heading = this.settings.editedHeading || DEFAULT_SETTINGS.editedHeading;
    let content = await this.app.vault.read(dailyFile);
    let changed = false;
    if (this.pendingEditedDeletes.length > 0 || this.pendingEditedRenames.length > 0) {
      const keysToRemove = /* @__PURE__ */ new Set();
      for (const deletedPath of this.pendingEditedDeletes) {
        keysToRemove.add(this.normalizeVaultPath(deletedPath).toLowerCase());
        const basename = deletedPath.split("/").pop()?.replace(/\.md$/i, "");
        if (basename) {
          keysToRemove.add(basename.toLowerCase());
        }
      }
      for (const rename of this.pendingEditedRenames) {
        keysToRemove.add(this.normalizeVaultPath(rename.oldPath).toLowerCase());
        const basename = rename.oldPath.split("/").pop()?.replace(/\.md$/i, "");
        if (basename) {
          keysToRemove.add(basename.toLowerCase());
        }
      }
      const removed = this.removeEditedLinkKeys(content, heading, keysToRemove, dailyFile);
      if (removed.changed) {
        content = removed.content;
        changed = true;
      }
      this.pendingEditedDeletes = [];
      this.pendingEditedRenames = [];
    }
    const incoming = [];
    for (const path of Array.from(this.pendingEditedPaths)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || !this.shouldTrackEditedFile(file, dailyFile)) {
        this.pendingEditedPaths.delete(path);
        continue;
      }
      if (!this.isActivelyBeingEdited(file) && !this.isFileTouchedOnDate(file, this.getTodayDate())) {
        this.pendingEditedPaths.delete(path);
        continue;
      }
      incoming.push(this.formatEditedLink(file, dailyFile));
    }
    if (incoming.length > 0) {
      const updated = this.replaceEditedLinks(content, heading, incoming, dailyFile);
      if (updated.changed) {
        content = updated.content;
        changed = true;
      }
    }
    this.pendingEditedPaths.clear();
    if (changed) {
      await this.modifyDailySafely(dailyFile, content);
    }
  }
  collectEditedLinksForDate(dailyFile, date) {
    const links = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.shouldTrackEditedFile(file, dailyFile)) {
        continue;
      }
      if (!this.isFileTouchedOnDate(file, date)) {
        continue;
      }
      links.push(this.formatEditedLink(file, dailyFile));
    }
    return links;
  }
  async writeEditedLinks(dailyFile, linkLines, isManual = false) {
    const heading = this.settings.editedHeading || DEFAULT_SETTINGS.editedHeading;
    const content = await this.app.vault.read(dailyFile);
    const updated = this.replaceEditedLinks(content, heading, linkLines, dailyFile);
    if (!updated.changed) {
      if (isManual) {
        new Notice("Edited links are already up to date.");
      }
      return;
    }
    await this.modifyDailySafely(dailyFile, updated.content);
    if (isManual) {
      new Notice(`Updated edited links (${updated.addedCount} new) in ${dailyFile.basename}.`);
    }
  }
  async backfillEditedLinks(dailyFile, date, isManual = false) {
    if (this.settings.editedEnabled === false) {
      return;
    }
    const links = this.collectEditedLinksForDate(dailyFile, date);
    await this.writeEditedLinks(dailyFile, links, isManual);
  }
  async backfillEditedLinksForToday(isManual = false) {
    if (this.settings.editedEnabled === false) {
      return;
    }
    const syncResult = await this.waitForSyncReady();
    if (!syncResult.ready && syncResult.reason === "timeout" && isManual) {
      new Notice("Sync did not finish in time; edited links may be incomplete.");
    }
    const dailyFile = this.getTodayDailyFile();
    if (!dailyFile) {
      if (isManual) {
        new Notice("Today's daily note was not found.");
      }
      return;
    }
    const date = this.parseDailyNoteDate(dailyFile) ?? this.getTodayDate();
    await this.backfillEditedLinks(dailyFile, date, isManual);
  }
  async runEditedLinksForToday(isManual = false) {
    await this.enqueueAutoRollover(async () => {
      await this.backfillEditedLinksForToday(isManual);
    });
  }
}
class GagansRolloverTodosSettingTab extends PluginSettingTab {
	plugin: GagansRolloverTodosPlugin;
  constructor(app: App, plugin: GagansRolloverTodosPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Rollover Todos [Gagans]" });
    containerEl.createEl("h3", { text: "Todo管理" });
    new Setting(containerEl).setName("Run rollover").setDesc("Copy unfinished tasks and pins from the previous daily note into the latest one. Skips if already rolled over (unless the mark is stale). Also refreshes routine streaks and pagination.").addButton((button) => {
      button.setButtonText("Run").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.runRolloverForLatestDailyNote(false);
        } finally {
          button.setDisabled(false);
        }
      });
    });
    new Setting(containerEl).setName("Force re-run rollover").setDesc("Clear the saved pair state, then add only tasks that are not already in today's todo (no duplicates). Also refreshes routine streaks, pins, and pagination.").addButton((button) => {
      button.setButtonText("Force re-run").setWarning().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.runRolloverForLatestDailyNote(true);
        } finally {
          button.setDisabled(false);
        }
      });
    });
    new Setting(containerEl).setName("Target Heading").setDesc("Section label for todos. Written as an h4 heading (#### todo). Also matches a plain 'todo' line in older notes. Scope ends at the first blank line after content.").addText(
      (text) => text.setPlaceholder("todo").setValue(this.plugin.settings.targetHeading).onChange(async (value) => {
        this.plugin.settings.targetHeading = value.trim() || DEFAULT_SETTINGS.targetHeading;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Section heading level").setDesc("Markdown heading level used when writing routine / pins / todo / modified / memo / pagination (default 4 → ####).").addText(
      (text) => text.setPlaceholder("4").setValue(String(this.plugin.settings.sectionHeadingLevel ?? 4)).onChange(async (value) => {
        const parsed = Number.parseInt(value.trim(), 10);
        this.plugin.settings.sectionHeadingLevel = Number.isFinite(parsed) && parsed >= 1 && parsed <= 6 ? parsed : DEFAULT_SETTINGS.sectionHeadingLevel;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Daily Notes Folder").setDesc("Only files in this folder are treated as daily notes.").addText(
      (text) => text.setPlaceholder("Daily").setValue(this.plugin.settings.dailyNotesFolder).onChange(async (value) => {
        this.plugin.settings.dailyNotesFolder = value.trim() || DEFAULT_SETTINGS.dailyNotesFolder;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Create delay (ms)").setDesc("Wait after file create so the daily template can finish writing before rollover / routine updates.").addText(
      (text) => text.setPlaceholder("500").setValue(String(this.plugin.settings.createDelayMs ?? 500)).onChange(async (value) => {
        const parsed = Number.parseInt(value.trim(), 10);
        this.plugin.settings.createDelayMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTINGS.createDelayMs;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Wait for Obsidian Sync").setDesc("Before auto/manual rollover, wait until Sync is idle so the previous daily note is complete. Prevents rolling from a stale note on another device after the date changes.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.waitForSync !== false).onChange(async (value) => {
        this.plugin.settings.waitForSync = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Sync wait timeout (ms)").setDesc("Give up waiting for Sync after this many milliseconds (default 120000). Auto rollover is skipped on timeout.").addText(
      (text) => text.setPlaceholder("120000").setValue(String(this.plugin.settings.syncWaitTimeoutMs ?? 12e4)).onChange(async (value) => {
        const parsed = Number.parseInt(value.trim(), 10);
        this.plugin.settings.syncWaitTimeoutMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTINGS.syncWaitTimeoutMs;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Sync settle (ms)").setDesc("Extra quiet period after Sync reports idle, so late downloads can finish before reading daily notes.").addText(
      (text) => text.setPlaceholder("1500").setValue(String(this.plugin.settings.syncSettleMs ?? 1500)).onChange(async (value) => {
        const parsed = Number.parseInt(value.trim(), 10);
        this.plugin.settings.syncSettleMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTINGS.syncSettleMs;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Daily Note Format").setDesc("Filename date format for daily notes (moment.js format).").addText(
      (text) => text.setPlaceholder("YYYY-MM-DD").setValue(this.plugin.settings.dailyNoteFormat).onChange(async (value) => {
        this.plugin.settings.dailyNoteFormat = value.trim() || DEFAULT_SETTINGS.dailyNoteFormat;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Tag Date Format").setDesc("Date format used for rollover task tags.").addText(
      (text) => text.setPlaceholder("YYYYMMDD").setValue(this.plugin.settings.tagDateFormat).onChange(async (value) => {
        this.plugin.settings.tagDateFormat = value.trim() || DEFAULT_SETTINGS.tagDateFormat;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "ルーティーン管理" });
    new Setting(containerEl).setName("Update routine streaks").setDesc("Recalculate ⚡consec↑max on the latest daily note from the previous day's check state.").addButton((button) => {
      button.setButtonText("Update streaks").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.runRoutineStreaksForLatestDailyNote(true);
        } finally {
          button.setDisabled(false);
        }
      });
    });
    new Setting(containerEl).setName("Routine Heading").setDesc("Section label for routines, written as #### routine. Scope ends at the first blank line after content. Tasks need {id} like {wk}.").addText(
      (text) => text.setPlaceholder("routine").setValue(this.plugin.settings.routineHeading).onChange(async (value) => {
        this.plugin.settings.routineHeading = value.trim() || DEFAULT_SETTINGS.routineHeading;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "その日の編集ノート" });
    new Setting(containerEl).setName("Collect edited notes").setDesc("Automatically add wikilinks under the edited heading when a note is created or modified today. Uses frontmatter created/updated when present, so Sync downloads of old notes are ignored.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.editedEnabled !== false).onChange(async (value) => {
        this.plugin.settings.editedEnabled = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Update edited links").setDesc("Scan the vault and refresh today's daily note with notes whose created or updated date is today.").addButton((button) => {
      button.setButtonText("Scan today").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.runEditedLinksForToday(true);
        } finally {
          button.setDisabled(false);
        }
      });
    });
    new Setting(containerEl).setName("Edited Heading").setDesc("Section label written as #### modified. Links are collected on the following lines, until a blank line or a non-link line (such as #### memo).").addText(
      (text) => text.setPlaceholder("edited").setValue(this.plugin.settings.editedHeading || DEFAULT_SETTINGS.editedHeading).onChange(async (value) => {
        this.plugin.settings.editedHeading = value.trim() || DEFAULT_SETTINGS.editedHeading;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Edited debounce (ms)").setDesc("Wait this long after the last create/modify before writing the daily note, so bursts of edits become one write.").addText(
      (text) => text.setPlaceholder("1500").setValue(String(this.plugin.settings.editedDebounceMs ?? 1500)).onChange(async (value) => {
        const parsed = Number.parseInt(value.trim(), 10);
        this.plugin.settings.editedDebounceMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTINGS.editedDebounceMs;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Exclude daily notes").setDesc("Do not list files in the Daily Notes folder (avoids rollover/streak writes showing up as edited notes).").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.editedExcludeDailyNotes !== false).onChange(async (value) => {
        this.plugin.settings.editedExcludeDailyNotes = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Ignore folders").setDesc("One vault-relative folder path per line. Notes in these folders are never added to edited.").addTextArea(
      (text) => {
        text.setPlaceholder("templates").setValue(this.plugin.getIgnoreFolders().join("\n")).onChange(async (value) => {
          this.plugin.settings.editedIgnoreFolders = this.plugin.normalizeIgnoreFolders(value);
          await this.plugin.saveSettings();
        });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
      }
    );
    containerEl.createEl("h3", { text: "ピンの引き継ぎ" });
    new Setting(containerEl).setName("Roll over pins").setDesc("Copy wikilinks under the pins heading from the previous daily note into the latest one. Existing pins are kept; duplicates are skipped.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.pinsEnabled !== false).onChange(async (value) => {
        this.plugin.settings.pinsEnabled = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Roll over pins now").setDesc("Copy pins from the previous daily note into the latest one.").addButton((button) => {
      button.setButtonText("Roll over pins").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.runPinsRolloverForLatestDailyNote(true);
        } finally {
          button.setDisabled(false);
        }
      });
    });
    new Setting(containerEl).setName("Pins Heading").setDesc("Section label written as #### pins. Wikilinks under it are carried into the next daily note.").addText(
      (text) => text.setPlaceholder("pins").setValue(this.plugin.settings.pinsHeading || DEFAULT_SETTINGS.pinsHeading).onChange(async (value) => {
        this.plugin.settings.pinsHeading = value.trim() || DEFAULT_SETTINGS.pinsHeading;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "ページネーション" });
    new Setting(containerEl).setName("Link adjacent daily notes").setDesc("Place #### pagination at the top of the daily note (just after frontmatter), with prev : / next : wikilinks to the previous and next existing daily notes (not necessarily yesterday/tomorrow).").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.paginationEnabled !== false).onChange(async (value) => {
        this.plugin.settings.paginationEnabled = value;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Update pagination now").setDesc("Rewrite pagination on the latest daily note and its neighbors.").addButton((button) => {
      button.setButtonText("Update pagination").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.runPaginationForLatestDailyNote(true);
        } finally {
          button.setDisabled(false);
        }
      });
    });
    new Setting(containerEl).setName("Pagination Heading").setDesc("Section label at the top of the daily note, written as #### pagination. Body is prev : [[date]] and next : [[date]].").addText(
      (text) => text.setPlaceholder("pagination").setValue(this.plugin.settings.paginationHeading || DEFAULT_SETTINGS.paginationHeading).onChange(async (value) => {
        this.plugin.settings.paginationHeading = value.trim() || DEFAULT_SETTINGS.paginationHeading;
        await this.plugin.saveSettings();
      })
    );
  }
};
