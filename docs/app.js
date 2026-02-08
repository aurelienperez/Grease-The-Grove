const appEl = document.getElementById("app");
const DAY_MS = 24 * 60 * 60 * 1000;

const defaultProgression = {
  targetRirMin: 3,
  targetRirMax: 5,
  maxWeeklyVolumeIncreasePct: 10,
  painWarn: 3,
  painReduce: 5,
  deloadDays: 7,
  deloadVolumeFactor: 0.65,
  freezeDaysIfPain: 2,
};

const defaultSettings = {
  progressionDefaults: defaultProgression,
  themeOverride: "system",
  dailySetGoal: 5,
};

const state = {
  tab: "today",
  exercises: [],
  logs: [],
  templates: [],
  settings: defaultSettings,
  toastQueue: [],
};

class Exercise {
  constructor({ id, name, category, tags = [], notes = "", variantsSchema = [], progressionProfile }) {
    this.id = id;
    this.name = name;
    this.category = category;
    this.tags = tags;
    this.notes = notes;
    this.variantsSchema = variantsSchema;
    this.progressionProfile = progressionProfile;
  }

  getPrimaryMetricType() {
    throw new Error("Not implemented");
  }

  validateLog() {
    return { valid: true };
  }

  computeNextTarget() {
    throw new Error("Not implemented");
  }

  computeStats() {
    throw new Error("Not implemented");
  }
}

class RepsExercise extends Exercise {
  constructor(input) {
    super(input);
    this.repRange = input.repRange;
    this.repIncrement = input.repIncrement ?? 1;
    this.minRepsFloor = input.minRepsFloor ?? 1;
  }

  getPrimaryMetricType() {
    return "reps";
  }

  validateLog(log) {
    const errors = [];
    if (log.status === "complete" && (!log.reps || log.reps <= 0)) {
      errors.push("Reps are required for a complete set.");
    }
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  computeNextTarget(logs, ctx) {
    const { recentLogs, profile, explanation, frozen, deload } = getRecentCompleteLogs(
      logs,
      ctx,
      this.progressionProfile
    );
    const recentRir = recentLogs.map((log) => log.rir).filter((rir) => rir !== undefined);
    const medianRir = recentRir.length ? median(recentRir) : undefined;
    const lastTarget = recentLogs[0]?.reps ?? this.repRange.min;
    let nextReps = lastTarget;

    if (!frozen && !deload && medianRir !== undefined) {
      if (medianRir > profile.targetRirMax) {
        nextReps += this.repIncrement;
        explanation.push("Effort was easy; nudging reps up.");
      } else if (medianRir < profile.targetRirMin) {
        nextReps -= this.repIncrement;
        explanation.push("Effort was high; reducing reps.");
      }
    }

    nextReps = clamp(nextReps, this.minRepsFloor, this.repRange.max);

    const { volumeThisWeek, volumePrevWeek } = getWeeklyVolume(logs, ctx.now, (log) => log.reps ?? 0);
    const volumeIncreasePct = volumePrevWeek === 0 ? 0 : ((volumeThisWeek - volumePrevWeek) / volumePrevWeek) * 100;

    if (volumePrevWeek > 0 && volumeIncreasePct > profile.maxWeeklyVolumeIncreasePct) {
      nextReps = lastTarget;
      explanation.push("Volume cap hit; holding steady.");
    }

    if (deload) {
      nextReps = Math.max(this.minRepsFloor, Math.round(lastTarget * profile.deloadVolumeFactor));
      explanation.push("Deload active; reducing volume.");
    }

    return {
      metricType: "reps",
      reps: nextReps,
      explanation,
      frozen,
      deload,
    };
  }

  computeStats(logs, window) {
    const now = Date.now();
    const recentLogs = logs.filter((log) => now - log.timestamp <= window * DAY_MS);
    const reps = recentLogs.map((log) => log.reps).filter((value) => value !== undefined);
    const rir = recentLogs.map((log) => log.rir).filter((value) => value !== undefined);
    const pain = recentLogs.map((log) => log.pain0to10).filter((value) => value !== undefined);
    const { volumeThisWeek, volumePrevWeek } = getWeeklyVolume(logs, now, (log) => log.reps ?? 0);
    const painStats = summarizePainFlags(logs);

    return {
      prReps: reps.length ? Math.max(...reps) : undefined,
      avgRir: rir.length ? average(rir) : undefined,
      medianRir: rir.length ? median(rir) : undefined,
      avgPain: pain.length ? average(pain) : undefined,
      volumeThisWeek,
      volumePrevWeek,
      ...painStats,
    };
  }
}

class WeightedRepsExercise extends Exercise {
  constructor(input) {
    super(input);
    this.repRange = input.repRange;
    this.repIncrement = input.repIncrement ?? 1;
    this.loadIncrementKg = input.loadIncrementKg ?? 2.5;
    this.progressionPriority = input.progressionPriority ?? "reps_then_load";
  }

  getPrimaryMetricType() {
    return "weightedReps";
  }

  validateLog(log) {
    const errors = [];
    if (log.status === "complete") {
      if (!log.reps || log.reps <= 0) {
        errors.push("Reps are required for a complete weighted set.");
      }
      if (!log.loadKg || log.loadKg <= 0) {
        errors.push("Load is required for a complete weighted set.");
      }
    }
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  computeNextTarget(logs, ctx) {
    const { recentLogs, profile, explanation, frozen, deload } = getRecentCompleteLogs(
      logs,
      ctx,
      this.progressionProfile
    );
    const recentRir = recentLogs.map((log) => log.rir).filter((rir) => rir !== undefined);
    const medianRir = recentRir.length ? median(recentRir) : undefined;

    const lastLog = recentLogs[0];
    const lastReps = lastLog?.reps ?? this.repRange.min;
    const lastLoad = lastLog?.loadKg ?? this.loadIncrementKg * 4;
    let nextReps = lastReps;
    let nextLoad = lastLoad;

    if (!frozen && !deload && medianRir !== undefined) {
      if (medianRir > profile.targetRirMax) {
        if (lastReps < this.repRange.max) {
          nextReps += this.repIncrement;
          explanation.push("Effort was easy; nudging reps up.");
        } else {
          nextLoad += this.loadIncrementKg;
          nextReps = this.repRange.min;
          explanation.push("Hit top reps; adding load and resetting reps.");
        }
      } else if (medianRir < profile.targetRirMin) {
        nextReps = Math.max(this.repRange.min, lastReps - this.repIncrement);
        explanation.push("Effort was high; reducing reps.");
      }
    }

    const { volumeThisWeek, volumePrevWeek } = getWeeklyVolume(
      logs,
      ctx.now,
      (log) => (log.reps ?? 0) * (log.loadKg ?? 0)
    );
    const volumeIncreasePct = volumePrevWeek === 0 ? 0 : ((volumeThisWeek - volumePrevWeek) / volumePrevWeek) * 100;

    if (volumePrevWeek > 0 && volumeIncreasePct > profile.maxWeeklyVolumeIncreasePct) {
      nextReps = lastReps;
      nextLoad = lastLoad;
      explanation.push("Volume cap hit; holding steady.");
    }

    if (deload) {
      nextReps = Math.max(this.repRange.min, Math.round(lastReps * profile.deloadVolumeFactor));
      nextLoad = Math.max(this.loadIncrementKg, Math.round(lastLoad * profile.deloadVolumeFactor));
      explanation.push("Deload active; reducing volume.");
    }

    return {
      metricType: "weightedReps",
      reps: nextReps,
      loadKg: nextLoad,
      explanation,
      frozen,
      deload,
    };
  }

  computeStats(logs, window) {
    const now = Date.now();
    const recentLogs = logs.filter((log) => now - log.timestamp <= window * DAY_MS);
    const reps = recentLogs.map((log) => log.reps).filter((value) => value !== undefined);
    const loads = recentLogs.map((log) => log.loadKg).filter((value) => value !== undefined);
    const rir = recentLogs.map((log) => log.rir).filter((value) => value !== undefined);
    const pain = recentLogs.map((log) => log.pain0to10).filter((value) => value !== undefined);
    const estimated = recentLogs
      .filter((log) => log.reps && log.loadKg)
      .map((log) => estimate1RM(log.reps ?? 0, log.loadKg ?? 0));

    const { volumeThisWeek, volumePrevWeek } = getWeeklyVolume(
      logs,
      now,
      (log) => (log.reps ?? 0) * (log.loadKg ?? 0)
    );
    const painStats = summarizePainFlags(logs);

    return {
      prReps: reps.length ? Math.max(...reps) : undefined,
      prLoadKg: loads.length ? Math.max(...loads) : undefined,
      bestEstimated1RM: estimated.length ? Math.max(...estimated) : undefined,
      avgRir: rir.length ? average(rir) : undefined,
      medianRir: rir.length ? median(rir) : undefined,
      avgPain: pain.length ? average(pain) : undefined,
      volumeThisWeek,
      volumePrevWeek,
      ...painStats,
    };
  }
}

class IsometricExercise extends Exercise {
  constructor(input) {
    super(input);
    this.durationRangeSec = input.durationRangeSec;
    this.timeIncrementSec = input.timeIncrementSec ?? 5;
  }

  getPrimaryMetricType() {
    return "isometric";
  }

  validateLog(log) {
    const errors = [];
    if (log.status === "complete" && (!log.durationSec || log.durationSec <= 0)) {
      errors.push("Duration is required for a complete isometric set.");
    }
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  computeNextTarget(logs, ctx) {
    const { recentLogs, profile, explanation, frozen, deload } = getRecentCompleteLogs(
      logs,
      ctx,
      this.progressionProfile
    );
    const recentRir = recentLogs.map((log) => log.rir).filter((rir) => rir !== undefined);
    const medianRir = recentRir.length ? median(recentRir) : undefined;

    const lastTarget = recentLogs[0]?.durationSec ?? this.durationRangeSec.min;
    let nextDuration = lastTarget;

    if (!frozen && !deload && medianRir !== undefined) {
      if (medianRir > profile.targetRirMax) {
        nextDuration += this.timeIncrementSec;
        explanation.push("Effort was easy; nudging time up.");
      } else if (medianRir < profile.targetRirMin) {
        nextDuration -= this.timeIncrementSec;
        explanation.push("Effort was high; reducing time.");
      }
    }

    nextDuration = clamp(nextDuration, this.durationRangeSec.min, this.durationRangeSec.max);

    const { volumeThisWeek, volumePrevWeek } = getWeeklyVolume(logs, ctx.now, (log) => log.durationSec ?? 0);
    const volumeIncreasePct = volumePrevWeek === 0 ? 0 : ((volumeThisWeek - volumePrevWeek) / volumePrevWeek) * 100;

    if (volumePrevWeek > 0 && volumeIncreasePct > profile.maxWeeklyVolumeIncreasePct) {
      nextDuration = lastTarget;
      explanation.push("Volume cap hit; holding steady.");
    }

    if (deload) {
      nextDuration = Math.max(this.durationRangeSec.min, Math.round(lastTarget * profile.deloadVolumeFactor));
      explanation.push("Deload active; reducing volume.");
    }

    return {
      metricType: "isometric",
      durationSec: nextDuration,
      explanation,
      frozen,
      deload,
    };
  }

  computeStats(logs, window) {
    const now = Date.now();
    const recentLogs = logs.filter((log) => now - log.timestamp <= window * DAY_MS);
    const durations = recentLogs.map((log) => log.durationSec).filter((value) => value !== undefined);
    const rir = recentLogs.map((log) => log.rir).filter((value) => value !== undefined);
    const pain = recentLogs.map((log) => log.pain0to10).filter((value) => value !== undefined);

    const { volumeThisWeek, volumePrevWeek } = getWeeklyVolume(logs, now, (log) => log.durationSec ?? 0);
    const painStats = summarizePainFlags(logs);

    return {
      prDurationSec: durations.length ? Math.max(...durations) : undefined,
      avgRir: rir.length ? average(rir) : undefined,
      medianRir: rir.length ? median(rir) : undefined,
      avgPain: pain.length ? average(pain) : undefined,
      volumeThisWeek,
      volumePrevWeek,
      ...painStats,
    };
  }
}

function hydrateExercise(record) {
  if (record.type === "reps") return new RepsExercise(record);
  if (record.type === "weighted") return new WeightedRepsExercise(record);
  return new IsometricExercise(record);
}

function getRecentCompleteLogs(logs, ctx, overrideProfile) {
  const profile = overrideProfile ?? ctx.profile;
  const recentLogs = logs
    .filter((log) => log.status === "complete")
    .filter((log) => ctx.now - log.timestamp <= 14 * DAY_MS)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 30);

  const explanation = [];
  const painFlags = logs
    .filter((log) => log.pain0to10 !== undefined)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, profile.freezeDaysIfPain);

  const painHigh = painFlags.some((log) => (log.pain0to10 ?? 0) >= profile.painReduce);
  const painWarnStreak =
    painFlags.length === profile.freezeDaysIfPain &&
    painFlags.every((log) => (log.pain0to10 ?? 0) >= profile.painWarn);

  const deload = painHigh || painWarnStreak;
  const frozen = deload;

  if (deload) {
    explanation.push("Pain guardrails triggered a deload.");
  }

  return { recentLogs, profile, explanation, frozen, deload };
}

function getWeeklyVolume(logs, now, volumeFn) {
  const weekStart = now - 7 * DAY_MS;
  const prevWeekStart = now - 14 * DAY_MS;

  const volumeThisWeek = logs
    .filter((log) => log.timestamp >= weekStart)
    .reduce((sum, log) => sum + volumeFn(log), 0);
  const volumePrevWeek = logs
    .filter((log) => log.timestamp >= prevWeekStart && log.timestamp < weekStart)
    .reduce((sum, log) => sum + volumeFn(log), 0);

  return { volumeThisWeek, volumePrevWeek };
}

function summarizePainFlags(logs) {
  const daySet = new Set();
  const deloadCount = logs.filter((log) => (log.pain0to10 ?? 0) >= 5).length;
  const freezeDays = logs.filter((log) => (log.pain0to10 ?? 0) >= 3).length;
  logs.forEach((log) => {
    const day = new Date(log.timestamp).toISOString().slice(0, 10);
    daySet.add(day);
  });
  const activeDaysPerWeek = Math.round((daySet.size / 4) * 7);
  return { deloadCount, freezeDays, activeDaysPerWeek };
}

function estimate1RM(reps, loadKg) {
  return loadKg * (1 + reps / 30);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatNumber(value, decimals = 1) {
  if (value === undefined || Number.isNaN(value)) return "—";
  return Number(value).toFixed(decimals);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] % 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function toast(message) {
  state.toastQueue.push({ id: uuid(), message });
  render();
  setTimeout(() => {
    state.toastQueue.shift();
    render();
  }, 2200);
}

function applyTheme() {
  if (state.settings.themeOverride === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark) {
      document.documentElement.dataset.theme = "dark";
    } else {
      delete document.documentElement.dataset.theme;
    }
    return;
  }
  document.documentElement.dataset.theme = state.settings.themeOverride;
}

const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open("dojo-db", 2);
  request.onupgradeneeded = (event) => {
    const db = event.target.result;
    if (!db.objectStoreNames.contains("exercises")) {
      db.createObjectStore("exercises", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("logs")) {
      const store = db.createObjectStore("logs", { keyPath: "id" });
      store.createIndex("by-exercise", "exerciseId");
      store.createIndex("by-timestamp", "timestamp");
    }
    if (!db.objectStoreNames.contains("templates")) {
      db.createObjectStore("templates", { keyPath: "id" });
    }
    if (db.objectStoreNames.contains("settings")) {
      db.deleteObjectStore("settings");
    }
    db.createObjectStore("settings", { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function dbGetAll(storeName) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(storeName, value, key) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = key ? store.put(value, key) : store.put(value);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

async function loadStore() {
  const [exercises, logs, templates, settings] = await Promise.all([
    dbGetAll("exercises"),
    dbGetAll("logs"),
    dbGetAll("templates"),
    dbGetAll("settings"),
  ]);
  state.exercises = exercises;
  state.logs = logs.sort((a, b) => b.timestamp - a.timestamp);
  state.templates = templates;
  state.settings = settings.find((item) => item.id === "app")?.value ?? defaultSettings;
  await ensureDefaults();
  applyTheme();
  render();
}

async function saveSettings(settings) {
  state.settings = settings;
  await dbPut("settings", { id: "app", value: settings });
  applyTheme();
  render();
}

async function ensureDefaults() {
  if (state.exercises.length > 0) return;
  const starterExercises = [
    {
      id: uuid(),
      name: "Push-ups",
      category: "push",
      tags: [],
      variantsSchema: [],
      type: "reps",
      repRange: { min: 6, max: 15 },
      repIncrement: 1,
      minRepsFloor: 1,
    },
    {
      id: uuid(),
      name: "Bench Press",
      category: "push",
      tags: [],
      variantsSchema: [],
      type: "weighted",
      repRange: { min: 6, max: 10 },
      loadIncrementKg: 2.5,
      repIncrement: 1,
      progressionPriority: "reps_then_load",
    },
    {
      id: uuid(),
      name: "Wall Sit",
      category: "legs",
      tags: [],
      variantsSchema: [],
      type: "isometric",
      durationRangeSec: { min: 20, max: 60 },
      timeIncrementSec: 5,
    },
  ];
  for (const exercise of starterExercises) {
    state.exercises.push(exercise);
    await dbPut("exercises", exercise);
  }
}

function renderHeader() {
  return `
    <header class="app-header">
      <div>
        <h1>Dojo</h1>
        <p>Train with intent. Track with focus.</p>
      </div>
      <div class="chip">Offline Ready</div>
    </header>
  `;
}

function renderTabBar() {
  return `
    <nav class="tab-bar">
      <button class="${state.tab === "today" ? "active" : ""}" data-tab="today">Today</button>
      <button class="${state.tab === "analytics" ? "active" : ""}" data-tab="analytics">Analytics</button>
      <button class="${state.tab === "settings" ? "active" : ""}" data-tab="settings">Settings</button>
    </nav>
  `;
}

function formatTarget(target) {
  if (target.metricType === "reps") return `${target.reps ?? 0} reps`;
  if (target.metricType === "weightedReps") return `${target.reps ?? 0} reps @ ${target.loadKg ?? 0} kg`;
  return `${target.durationSec ?? 0} sec`;
}

function formatLog(log) {
  if (log.durationSec) return `${log.durationSec} sec`;
  if (log.loadKg) return `${log.reps ?? 0} reps @ ${log.loadKg} kg`;
  return `${log.reps ?? 0} reps`;
}

function renderToday() {
  const exercises = state.exercises.map(hydrateExercise);
  const selectedExerciseId = state.selectedExerciseId ?? state.exercises[0]?.id ?? "";
  const selectedTemplateId = state.selectedTemplateId ?? state.templates[0]?.id ?? "";
  const hasExercises = state.exercises.length > 0;
  const hasTemplates = state.templates.length > 0;
  const templateItems = state.templates.find((template) => template.id === selectedTemplateId)?.items ?? [];
  const isTemplateMode = state.mode === "template";

  const selectionExercises = isTemplateMode
    ? templateItems
        .map((item) => ({
          exercise: exercises.find((exercise) => exercise.id === item.exerciseId),
          templateItem: item,
        }))
        .filter((item) => item.exercise)
    : (hasExercises && selectedExerciseId
      ? [{
          exercise: exercises.find((exercise) => exercise.id === selectedExerciseId),
          templateItem: null,
        }].filter((item) => item.exercise)
      : []);

  const nextTargets = selectionExercises.map(({ exercise, templateItem }) => {
    const logs = state.logs.filter((log) => log.exerciseId === exercise.id);
    const autoTarget = exercise.computeNextTarget(logs, {
      now: Date.now(),
      profile: state.settings.progressionDefaults,
    });
    const target =
      templateItem?.targetMode === "fixed" && templateItem.fixedTarget
        ? { ...templateItem.fixedTarget, explanation: ["Fixed target from template."] }
        : autoTarget;
    return { exercise, target };
  });

  const todayLogs = state.logs.filter(
    (log) => new Date(log.timestamp).toDateString() === new Date().toDateString()
  );

  const progressWidth = state.settings.dailySetGoal
    ? Math.min(100, (todayLogs.length / state.settings.dailySetGoal) * 100)
    : 0;

  return `
    <div class="page">
      <section class="card">
        <div class="mode-switch">
          <button class="mode-button ${state.mode !== "template" ? "active" : ""}" data-mode="single">Single Exercise</button>
          <button class="mode-button ${state.mode === "template" ? "active" : ""}" data-mode="template">Template</button>
        </div>
        ${isTemplateMode ? `
          <label class="field">Template
            <select data-field="template">
              ${state.templates.map((template) => `<option value="${template.id}" ${template.id === selectedTemplateId ? "selected" : ""}>${template.name}</option>`).join("")}
            </select>
          </label>
          ${hasTemplates ? "" : `<p class="muted">No templates yet. Create one to get started.</p>`}
        ` : `
          <label class="field">Exercise
            <select data-field="exercise">
              ${state.exercises.map((exercise) => `<option value="${exercise.id}" ${exercise.id === selectedExerciseId ? "selected" : ""}>${exercise.name}</option>`).join("")}
            </select>
          </label>
          ${hasExercises ? "" : `<p class="muted">No exercises yet. Add one to get started.</p>`}
        `}
      </section>

      <section class="card">
        <h2>Next Set</h2>
        ${nextTargets.length === 0 ? `<p class="muted">Create an exercise or template to get started.</p>` : `
          <div class="next-set-grid">
            ${nextTargets.map(({ exercise, target }) => `
              <div class="next-set-item">
                <div>
                  <h3>${exercise.name}</h3>
                  <p class="kpi">${formatTarget(target)}</p>
                </div>
                <ul>
                  ${target.explanation.map((item) => `<li>${item}</li>`).join("")}
                </ul>
              </div>
            `).join("")}
          </div>
        `}
        <div class="button-row">
          <button class="btn primary" data-action="quick-log" ${nextTargets.length ? "" : "disabled"}>Quick Log</button>
          <button class="btn secondary" data-action="detail-log" ${nextTargets.length ? "" : "disabled"}>Detailed Log</button>
          <button class="btn ghost" data-action="undo-log" ${state.logs.length ? "" : "disabled"}>Undo last log</button>
        </div>
      </section>

      <section class="card">
        <h2>Today Summary</h2>
        <div class="summary-grid">
          <div>
            <p class="label">Sets Done</p>
            <p class="kpi">${todayLogs.length}</p>
          </div>
          <div>
            <p class="label">Daily Goal</p>
            <p class="kpi">${state.settings.dailySetGoal}</p>
          </div>
          <div>
            <p class="label">Progress</p>
            <div class="progress-bar">
              <div class="progress-bar-fill" style="width:${progressWidth}%;"></div>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Today Logs</h2>
        ${todayLogs.length === 0 ? `<p class="muted">No sets yet. Hit Quick Log to get started.</p>` : `
          <div class="log-list">
            ${todayLogs.map((log) => {
              const exercise = state.exercises.find((item) => item.id === log.exerciseId);
              return `
                <div class="log-item">
                  <div>
                    <strong>${exercise?.name ?? "Unknown"}</strong>
                    <div class="muted">${formatLog(log)}</div>
                  </div>
                  <button class="btn ghost" data-delete-log="${log.id}">Delete</button>
                </div>
              `;
            }).join("")}
          </div>
        `}
      </section>
    </div>
  `;
}

function renderChart(data, label) {
  if (!data.length) {
    return `<div class="chart"><div class="chart-header"><span>${label}</span><span class="chart-range">No data</span></div></div>`;
  }
  const minY = Math.min(...data.map((d) => d.y));
  const maxY = Math.max(...data.map((d) => d.y));
  const range = maxY - minY || 1;
  const points = data
    .map((point, index) => {
      const x = (index / (data.length - 1 || 1)) * 100;
      const y = ((maxY - point.y) / range) * 120;
      return `${x},${y}`;
    })
    .join(" ");

  return `
    <div class="chart">
      <div class="chart-header">
        <span>${label}</span>
        <span class="chart-range">${formatNumber(minY)} - ${formatNumber(maxY)}</span>
      </div>
      <svg viewBox="0 0 100 120" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3"></polyline>
      </svg>
    </div>
  `;
}

function renderAnalytics() {
  const selectedExerciseId = state.selectedExerciseId ?? state.exercises[0]?.id ?? "";
  const windowDays = state.windowDays ?? 30;
  const completeOnly = state.completeOnly ?? true;
  const exercise = state.exercises.find((item) => item.id === selectedExerciseId);
  const logs = state.logs.filter((log) => log.exerciseId === selectedExerciseId);
  const filteredLogs = logs.filter((log) => !completeOnly || log.status === "complete");
  const now = Date.now();
  const windowedLogs = filteredLogs.filter((log) => now - log.timestamp <= windowDays * DAY_MS);
  const hydrated = exercise ? hydrateExercise(exercise) : null;
  const stats = hydrated ? hydrated.computeStats(windowedLogs, windowDays) : null;

  const metricSeries = windowedLogs.map((log, index) => ({
    x: index,
    y: log.durationSec ? log.durationSec : (log.reps ?? 0),
  }));
  const loadSeries = windowedLogs.filter((log) => log.loadKg).map((log, index) => ({ x: index, y: log.loadKg }));
  const rirSeries = windowedLogs.filter((log) => log.rir !== undefined).map((log, index) => ({ x: index, y: log.rir }));
  const painSeries = windowedLogs.filter((log) => log.pain0to10 !== undefined).map((log, index) => ({ x: index, y: log.pain0to10 }));
  const volumeSeries = windowedLogs.map((log, index) => ({
    x: index,
    y: log.durationSec
      ? log.durationSec
      : log.loadKg
        ? (log.reps ?? 0) * (log.loadKg ?? 0)
        : (log.reps ?? 0),
  }));

  return `
    <div class="page">
      <section class="card">
        <label class="field">Exercise
          <select data-field="exercise">
            ${state.exercises.map((item) => `<option value="${item.id}" ${item.id === selectedExerciseId ? "selected" : ""}>${item.name}</option>`).join("")}
          </select>
        </label>
        <label class="field">Window
          <select data-field="window">
            ${[7, 30, 90].map((value) => `<option value="${value}" ${value === windowDays ? "selected" : ""}>Last ${value} days</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <input type="checkbox" data-field="complete" ${completeOnly ? "checked" : ""} />
          Complete only
        </label>
      </section>

      <section class="card">
        <h2>Charts</h2>
        <div class="chart-grid">
          ${renderChart(metricSeries, "Primary metric")}
          ${loadSeries.length ? renderChart(loadSeries, "Load (kg)") : ""}
          ${renderChart(rirSeries, "RIR")}
          ${renderChart(painSeries, "Pain")}
          ${renderChart(volumeSeries, "Weekly volume")}
        </div>
      </section>

      <section class="card">
        <h2>Stats</h2>
        ${stats ? `
          <div class="stats-grid">
            <div class="stat"><span class="label">PR Reps</span><span class="kpi">${formatNumber(stats.prReps)}</span></div>
            <div class="stat"><span class="label">PR Duration</span><span class="kpi">${formatNumber(stats.prDurationSec)}</span></div>
            <div class="stat"><span class="label">PR Load</span><span class="kpi">${formatNumber(stats.prLoadKg)}</span></div>
            <div class="stat"><span class="label">Best e1RM</span><span class="kpi">${formatNumber(stats.bestEstimated1RM)}</span></div>
            <div class="stat"><span class="label">Avg RIR</span><span class="kpi">${formatNumber(stats.avgRir)}</span></div>
            <div class="stat"><span class="label">Median RIR</span><span class="kpi">${formatNumber(stats.medianRir)}</span></div>
            <div class="stat"><span class="label">Avg Pain</span><span class="kpi">${formatNumber(stats.avgPain)}</span></div>
            <div class="stat"><span class="label">Active days/week</span><span class="kpi">${formatNumber(stats.activeDaysPerWeek, 0)}</span></div>
          </div>
        ` : `<p class="muted">Select an exercise to see stats.</p>`}
      </section>

      <section class="card">
        <h2>Export</h2>
        <div class="button-row">
          <button class="btn primary" data-action="export-csv">CSV (exercise)</button>
          <button class="btn secondary" data-action="export-global-csv">CSV (global)</button>
          <button class="btn secondary" data-action="export-json">JSON backup</button>
        </div>
      </section>

      <section class="card">
        <h2>Logs</h2>
        ${windowedLogs.length === 0 ? `<p class="muted">No logs in this window.</p>` : `
          <div class="log-list">
            ${windowedLogs.map((log) => `
              <div class="log-item">
                <div>
                  <strong>${formatLog(log)}</strong>
                  <div class="muted">${new Date(log.timestamp).toLocaleString()}</div>
                </div>
                <button class="btn ghost" data-delete-log="${log.id}">Delete</button>
              </div>
            `).join("")}
          </div>
        `}
      </section>
    </div>
  `;
}

function renderSettings() {
  const templateItems = state.templateItems ?? [];
  return `
    <div class="page">
      <section class="card">
        <h2>Create Exercise</h2>
        <label class="field">Name
          <input data-field="exercise-name" value="${state.exerciseName ?? ""}" />
        </label>
        <label class="field">Category
          <select data-field="exercise-category">
            ${["pull", "push", "legs", "core", "cardio", "other"].map((value) => `
              <option value="${value}" ${value === (state.exerciseCategory ?? "pull") ? "selected" : ""}>${value}</option>
            `).join("")}
          </select>
        </label>
        <label class="field">Type
          <select data-field="exercise-type">
            ${["reps", "weighted", "isometric"].map((value) => `
              <option value="${value}" ${value === (state.exerciseType ?? "reps") ? "selected" : ""}>${value}</option>
            `).join("")}
          </select>
        </label>
        ${(state.exerciseType ?? "reps") !== "isometric" ? `
          <div class="field-grid">
            <label class="field">Rep min
              <input type="number" data-field="rep-min" value="${state.repMin ?? 6}" />
            </label>
            <label class="field">Rep max
              <input type="number" data-field="rep-max" value="${state.repMax ?? 12}" />
            </label>
          </div>
        ` : ""}
        ${(state.exerciseType ?? "reps") === "weighted" ? `
          <label class="field">Load increment (kg)
            <input type="number" data-field="load-increment" value="${state.loadIncrement ?? 2.5}" />
          </label>
        ` : ""}
        ${(state.exerciseType ?? "reps") === "isometric" ? `
          <div class="field-grid">
            <label class="field">Duration min (sec)
              <input type="number" data-field="duration-min" value="${state.durationMin ?? 20}" />
            </label>
            <label class="field">Duration max (sec)
              <input type="number" data-field="duration-max" value="${state.durationMax ?? 60}" />
            </label>
            <label class="field">Increment (sec)
              <input type="number" data-field="time-increment" value="${state.timeIncrement ?? 5}" />
            </label>
          </div>
        ` : ""}
        <div class="button-row">
          <button class="btn secondary" data-action="add-variant">Add Variant Field</button>
          <button class="btn primary" data-action="save-exercise">Save Exercise</button>
        </div>
        ${renderVariantFields()}
      </section>

      <section class="card">
        <h2>Exercises</h2>
        ${state.exercises.length === 0 ? `<p class="muted">No exercises yet.</p>` : `
          <div class="list">
            ${state.exercises.map((exercise) => `
              <div class="list-item">
                <div>
                  <strong>${exercise.name}</strong>
                  <div class="muted">${exercise.type}</div>
                </div>
                <button class="btn ghost" data-delete-exercise="${exercise.id}">Delete</button>
              </div>
            `).join("")}
          </div>
        `}
      </section>

      <section class="card">
        <h2>Create Template</h2>
        <label class="field">Name
          <input data-field="template-name" value="${state.templateName ?? ""}" />
        </label>
        <div class="list">
          ${templateItems.map((item, index) => {
            const exercise = state.exercises.find((value) => value.id === item.exerciseId);
            return `
              <div class="list-item">
                <div class="template-item-grid">
                  <select data-template-exercise="${index}">
                    ${state.exercises.map((option) => `
                      <option value="${option.id}" ${option.id === item.exerciseId ? "selected" : ""}>${option.name}</option>
                    `).join("")}
                  </select>
                  <select data-template-mode="${index}">
                    <option value="auto" ${item.targetMode === "auto" ? "selected" : ""}>Auto</option>
                    <option value="fixed" ${item.targetMode === "fixed" ? "selected" : ""}>Fixed</option>
                  </select>
                  ${item.targetMode === "fixed" ? renderFixedTargetInputs(item, exercise, index) : ""}
                </div>
                <button class="btn ghost" data-remove-template-item="${index}">Remove</button>
              </div>
            `;
          }).join("")}
        </div>
        <div class="button-row">
          <button class="btn secondary" data-action="add-template-item">Add Exercise</button>
          <button class="btn primary" data-action="save-template">Save Template</button>
        </div>
      </section>

      <section class="card">
        <h2>Templates</h2>
        ${state.templates.length === 0 ? `<p class="muted">No templates yet.</p>` : `
          <div class="list">
            ${state.templates.map((template) => `
              <div class="list-item">
                <div>
                  <strong>${template.name}</strong>
                  <div class="muted">${template.items.length} exercises</div>
                </div>
                <button class="btn ghost" data-delete-template="${template.id}">Delete</button>
              </div>
            `).join("")}
          </div>
        `}
      </section>

      <section class="card">
        <h2>Engine Defaults</h2>
        <div class="field-grid">
          ${renderEngineField("Target RIR min", "targetRirMin")}
          ${renderEngineField("Target RIR max", "targetRirMax")}
          ${renderEngineField("Max weekly volume %", "maxWeeklyVolumeIncreasePct")}
          ${renderEngineField("Pain warn", "painWarn")}
          ${renderEngineField("Pain reduce", "painReduce")}
        </div>
      </section>

      <section class="card">
        <h2>Theme</h2>
        <div class="button-row">
          ${renderThemeButton("system", "System")}
          ${renderThemeButton("light", "Light")}
          ${renderThemeButton("dark", "Dark")}
        </div>
      </section>

      <section class="card">
        <h2>Data</h2>
        <div class="button-row">
          <button class="btn primary" data-action="export-json">Export JSON</button>
          <label class="btn secondary">
            Import JSON
            <input type="file" accept="application/json" data-action="import-json" hidden />
          </label>
          <button class="btn ghost" data-action="reset-all">Reset All</button>
        </div>
      </section>

      <section class="card">
        <h2>Daily Goal</h2>
        <label class="field">Sets per day
          <input type="number" data-field="daily-goal" value="${state.settings.dailySetGoal}" />
        </label>
        <button class="toggle ${state.settings.dailySetGoal > 0 ? "on" : "off"}" data-action="toggle-goal">
          <span>Keep me motivated</span>
          <div class="toggle-knob"></div>
        </button>
      </section>
    </div>
  `;
}

function renderVariantFields() {
  const fields = state.variantFields ?? [];
  if (!fields.length) return "";
  return fields
    .map((field, index) => `
      <div class="field-grid">
        <label class="field">Label
          <input data-variant-label="${index}" value="${field.label}" />
        </label>
        <label class="field">Type
          <select data-variant-type="${index}">
            ${["text", "number", "select", "boolean"].map((value) => `
              <option value="${value}" ${value === field.type ? "selected" : ""}>${value}</option>
            `).join("")}
          </select>
        </label>
      </div>
    `)
    .join("");
}

function renderFixedTargetInputs(item, exercise, index) {
  if (exercise?.type === "isometric") {
    return `
      <input type="number" placeholder="Seconds" value="${item.fixedTarget?.durationSec ?? 0}" data-template-fixed="${index}" data-metric="duration" />
    `;
  }
  const loadInput = exercise?.type === "weighted"
    ? `<input type="number" placeholder="Load kg" value="${item.fixedTarget?.loadKg ?? 0}" data-template-fixed="${index}" data-metric="load" />`
    : "";
  return `
    <input type="number" placeholder="Reps" value="${item.fixedTarget?.reps ?? 0}" data-template-fixed="${index}" data-metric="reps" />
    ${loadInput}
  `;
}

function renderEngineField(label, key) {
  return `
    <label class="field">${label}
      <input type="number" data-engine="${key}" value="${state.settings.progressionDefaults[key]}" />
    </label>
  `;
}

function renderThemeButton(value, label) {
  const active = state.settings.themeOverride === value;
  return `<button class="btn ${active ? "primary" : "secondary"}" data-action="set-theme" data-value="${value}">${label}</button>`;
}

function renderToasts() {
  if (!state.toastQueue.length) return "";
  return `
    <div class="toast-stack">
      ${state.toastQueue.map((toastItem) => `<div class="toast">${toastItem.message}</div>`).join("")}
    </div>
  `;
}

function render() {
  appEl.innerHTML = `
    ${renderHeader()}
    <main class="app-main">
      ${state.tab === "today" ? renderToday() : ""}
      ${state.tab === "analytics" ? renderAnalytics() : ""}
      ${state.tab === "settings" ? renderSettings() : ""}
    </main>
    ${renderTabBar()}
    ${renderToasts()}
  `;
  bindEvents();
}

function bindEvents() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.onclick = () => {
      state.tab = button.dataset.tab;
      render();
    };
  });

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.onclick = () => {
      state.mode = button.dataset.mode === "template" ? "template" : "single";
      render();
    };
  });

  const exerciseSelect = document.querySelector("select[data-field=exercise]");
  if (exerciseSelect) {
    exerciseSelect.onchange = (event) => {
      state.selectedExerciseId = event.target.value;
      render();
    };
  }

  const templateSelect = document.querySelector("select[data-field=template]");
  if (templateSelect) {
    templateSelect.onchange = (event) => {
      state.selectedTemplateId = event.target.value;
      render();
    };
  }

  const windowSelect = document.querySelector("select[data-field=window]");
  if (windowSelect) {
    windowSelect.onchange = (event) => {
      state.windowDays = Number(event.target.value);
      render();
    };
  }

  const completeCheck = document.querySelector("input[data-field=complete]");
  if (completeCheck) {
    completeCheck.onchange = (event) => {
      state.completeOnly = event.target.checked;
      render();
    };
  }

  document.querySelectorAll("[data-action=quick-log]").forEach((button) => {
    button.onclick = () => quickLog();
  });

  document.querySelectorAll("[data-action=detail-log]").forEach((button) => {
    button.onclick = () => openDetailLog();
  });

  document.querySelectorAll("[data-action=undo-log]").forEach((button) => {
    button.onclick = () => undoLog();
  });

  document.querySelectorAll("[data-delete-log]").forEach((button) => {
    button.onclick = () => deleteLog(button.dataset.deleteLog);
  });

  document.querySelectorAll("[data-action=save-exercise]").forEach((button) => {
    button.onclick = () => saveExercise();
  });

  document.querySelectorAll("[data-action=add-variant]").forEach((button) => {
    button.onclick = () => addVariantField();
  });

  document.querySelectorAll("[data-variant-label]").forEach((input) => {
    input.oninput = (event) => {
      const index = Number(event.target.dataset.variantLabel);
      state.variantFields[index].label = event.target.value;
    };
  });

  document.querySelectorAll("[data-variant-type]").forEach((select) => {
    select.onchange = (event) => {
      const index = Number(event.target.dataset.variantType);
      state.variantFields[index].type = event.target.value;
    };
  });

  document.querySelectorAll("[data-action=add-template-item]").forEach((button) => {
    button.onclick = () => addTemplateItem();
  });

  document.querySelectorAll("[data-action=save-template]").forEach((button) => {
    button.onclick = () => saveTemplate();
  });

  document.querySelectorAll("[data-remove-template-item]").forEach((button) => {
    button.onclick = () => removeTemplateItem(Number(button.dataset.removeTemplateItem));
  });

  document.querySelectorAll("[data-template-exercise]").forEach((select) => {
    select.onchange = (event) => {
      const index = Number(event.target.dataset.templateExercise);
      state.templateItems[index].exerciseId = event.target.value;
      render();
    };
  });

  document.querySelectorAll("[data-template-mode]").forEach((select) => {
    select.onchange = (event) => {
      const index = Number(event.target.dataset.templateMode);
      state.templateItems[index].targetMode = event.target.value;
      if (state.templateItems[index].targetMode === "auto") {
        state.templateItems[index].fixedTarget = undefined;
      }
      render();
    };
  });

  document.querySelectorAll("[data-template-fixed]").forEach((input) => {
    input.oninput = (event) => {
      const index = Number(event.target.dataset.templateFixed);
      const metric = event.target.dataset.metric;
      const value = Number(event.target.value);
      const item = state.templateItems[index];
      const exercise = state.exercises.find((entry) => entry.id === item.exerciseId);
      const metricType = exercise?.type === "weighted" ? "weightedReps" : exercise?.type === "isometric" ? "isometric" : "reps";
      const current = item.fixedTarget ?? { metricType, explanation: [] };
      item.fixedTarget = { ...current, metricType, explanation: [] };
      if (metric === "duration") item.fixedTarget.durationSec = value;
      if (metric === "reps") item.fixedTarget.reps = value;
      if (metric === "load") item.fixedTarget.loadKg = value;
    };
  });

  document.querySelectorAll("[data-delete-exercise]").forEach((button) => {
    button.onclick = () => deleteExercise(button.dataset.deleteExercise);
  });

  document.querySelectorAll("[data-delete-template]").forEach((button) => {
    button.onclick = () => deleteTemplate(button.dataset.deleteTemplate);
  });

  document.querySelectorAll("[data-engine]").forEach((input) => {
    input.onchange = (event) => {
      const key = event.target.dataset.engine;
      const value = Number(event.target.value);
      saveSettings({
        ...state.settings,
        progressionDefaults: { ...state.settings.progressionDefaults, [key]: value },
      });
    };
  });

  document.querySelectorAll("[data-action=set-theme]").forEach((button) => {
    button.onclick = () => {
      saveSettings({ ...state.settings, themeOverride: button.dataset.value });
    };
  });

  document.querySelector("input[data-field=daily-goal]")?.addEventListener("input", (event) => {
    saveSettings({ ...state.settings, dailySetGoal: Number(event.target.value) });
  });

  document.querySelectorAll("[data-action=toggle-goal]").forEach((button) => {
    button.onclick = () => {
      const next = state.settings.dailySetGoal > 0 ? 0 : state.settings.dailySetGoal || 5;
      saveSettings({ ...state.settings, dailySetGoal: next });
    };
  });

  document.querySelectorAll("[data-action=export-json]").forEach((button) => {
    button.onclick = () => exportJson();
  });

  document.querySelectorAll("[data-action=export-csv]").forEach((button) => {
    button.onclick = () => exportCsv();
  });

  document.querySelectorAll("[data-action=export-global-csv]").forEach((button) => {
    button.onclick = () => exportGlobalCsv();
  });

  const importInput = document.querySelector("input[data-action=import-json]");
  if (importInput) {
    importInput.onchange = (event) => importJson(event.target.files?.[0]);
  }

  document.querySelectorAll("[data-action=reset-all]").forEach((button) => {
    button.onclick = () => resetAll();
  });

  document.querySelectorAll("[data-field=exercise-name]").forEach((input) => {
    input.oninput = (event) => {
      state.exerciseName = event.target.value;
    };
  });

  document.querySelectorAll("[data-field=exercise-category]").forEach((select) => {
    select.onchange = (event) => {
      state.exerciseCategory = event.target.value;
    };
  });

  document.querySelectorAll("[data-field=exercise-type]").forEach((select) => {
    select.onchange = (event) => {
      state.exerciseType = event.target.value;
      render();
    };
  });

  document.querySelectorAll("[data-field=rep-min]").forEach((input) => {
    input.oninput = (event) => {
      state.repMin = Number(event.target.value);
    };
  });

  document.querySelectorAll("[data-field=rep-max]").forEach((input) => {
    input.oninput = (event) => {
      state.repMax = Number(event.target.value);
    };
  });

  document.querySelectorAll("[data-field=load-increment]").forEach((input) => {
    input.oninput = (event) => {
      state.loadIncrement = Number(event.target.value);
    };
  });

  document.querySelectorAll("[data-field=duration-min]").forEach((input) => {
    input.oninput = (event) => {
      state.durationMin = Number(event.target.value);
    };
  });

  document.querySelectorAll("[data-field=duration-max]").forEach((input) => {
    input.oninput = (event) => {
      state.durationMax = Number(event.target.value);
    };
  });

  document.querySelectorAll("[data-field=time-increment]").forEach((input) => {
    input.oninput = (event) => {
      state.timeIncrement = Number(event.target.value);
    };
  });

  document.querySelectorAll("[data-field=template-name]").forEach((input) => {
    input.oninput = (event) => {
      state.templateName = event.target.value;
    };
  });
}

async function quickLog() {
  const exercises = state.exercises.map(hydrateExercise);
  const selection = state.mode === "template"
    ? (state.templates.find((template) => template.id === state.selectedTemplateId)?.items ?? [])
    : [{ exerciseId: state.selectedExerciseId }];

  const quickLogs = [];
  for (const item of selection) {
    const exercise = exercises.find((entry) => entry.id === item.exerciseId);
    if (!exercise) continue;
    const logs = state.logs.filter((log) => log.exerciseId === exercise.id);
    const autoTarget = exercise.computeNextTarget(logs, {
      now: Date.now(),
      profile: state.settings.progressionDefaults,
    });
    const target =
      item?.targetMode === "fixed" && item.fixedTarget
        ? { ...item.fixedTarget, explanation: ["Fixed target from template."] }
        : autoTarget;
    const log = {
      id: uuid(),
      timestamp: Date.now(),
      exerciseId: exercise.id,
      reps: target.reps,
      loadKg: target.loadKg,
      durationSec: target.durationSec,
      status: "complete",
    };
    await dbPut("logs", log);
    state.logs.unshift(log);
    quickLogs.push(log);
  }
  toast("Logged! Add RIR/pain or skip.");
  state.quickCheckLogs = quickLogs;
  state.tab = "today";
  renderQuickCheck();
}

function renderQuickCheck() {
  const logs = state.quickCheckLogs ?? [];
  if (!logs.length) return;
  const overlay = document.createElement("div");
  overlay.className = "card";
  overlay.innerHTML = `
    <h2>RIR & Pain Check</h2>
    <div class="log-list">
      ${logs.map((log, index) => {
        const exercise = state.exercises.find((item) => item.id === log.exerciseId);
        return `
          <div class="log-item">
            <div class="log-detail">
              <strong>${exercise?.name ?? "Unknown"}</strong>
              <label>RIR
                <input type="range" min="0" max="10" value="${log.rir ?? 5}" data-quick-rir="${index}" />
              </label>
              <label>Pain
                <input type="range" min="0" max="10" value="${log.pain0to10 ?? 0}" data-quick-pain="${index}" />
              </label>
            </div>
          </div>
        `;
      }).join("")}
    </div>
    <div class="button-row">
      <button class="btn primary" data-quick-action="save">Save</button>
      <button class="btn ghost" data-quick-action="skip">Skip</button>
    </div>
  `;
  const main = document.querySelector(".app-main");
  main.appendChild(overlay);

  overlay.querySelectorAll("input[data-quick-rir]").forEach((input) => {
    input.oninput = (event) => {
      const index = Number(event.target.dataset.quickRir);
      state.quickCheckLogs[index].rir = Number(event.target.value);
    };
  });

  overlay.querySelectorAll("input[data-quick-pain]").forEach((input) => {
    input.oninput = (event) => {
      const index = Number(event.target.dataset.quickPain);
      state.quickCheckLogs[index].pain0to10 = Number(event.target.value);
    };
  });

  overlay.querySelector("button[data-quick-action=save]").onclick = async () => {
    for (const log of state.quickCheckLogs) {
      await dbPut("logs", log);
    }
    state.quickCheckLogs = [];
    toast("RIR and pain saved.");
    render();
  };

  overlay.querySelector("button[data-quick-action=skip]").onclick = () => {
    state.quickCheckLogs = [];
    render();
  };
}

function openDetailLog() {
  const exercises = state.exercises.map(hydrateExercise);
  const selection = state.mode === "template"
    ? (state.templates.find((template) => template.id === state.selectedTemplateId)?.items ?? [])
    : [{ exerciseId: state.selectedExerciseId }];

  const detailLogs = selection
    .map((item) => {
      const exercise = exercises.find((entry) => entry.id === item.exerciseId);
      if (!exercise) return null;
      const logs = state.logs.filter((log) => log.exerciseId === exercise.id);
      const autoTarget = exercise.computeNextTarget(logs, {
        now: Date.now(),
        profile: state.settings.progressionDefaults,
      });
      const target =
        item?.targetMode === "fixed" && item.fixedTarget
          ? { ...item.fixedTarget, explanation: ["Fixed target from template."] }
          : autoTarget;
      return {
        exercise,
        log: {
          id: uuid(),
          timestamp: Date.now(),
          exerciseId: exercise.id,
          reps: target.reps,
          loadKg: target.loadKg,
          durationSec: target.durationSec,
          status: "complete",
        },
      };
    })
    .filter(Boolean);

  const overlay = document.createElement("div");
  overlay.className = "card";
  overlay.innerHTML = `
    <h2>Detailed Log</h2>
    <div class="log-list">
      ${detailLogs.map(({ exercise, log }, index) => `
        <div class="log-item">
          <div class="log-detail">
            <strong>${exercise.name}</strong>
            ${exercise.type === "isometric" ? `
              <input type="number" value="${log.durationSec ?? 0}" data-detail="${index}" data-metric="duration" />
            ` : `
              <input type="number" value="${log.reps ?? 0}" data-detail="${index}" data-metric="reps" />
              ${exercise.type === "weighted" ? `<input type="number" value="${log.loadKg ?? 0}" data-detail="${index}" data-metric="load" />` : ""}
            `}
            <input type="number" placeholder="RIR" value="${log.rir ?? ""}" data-detail="${index}" data-metric="rir" />
            <input type="number" placeholder="Pain" value="${log.pain0to10 ?? ""}" data-detail="${index}" data-metric="pain" />
          </div>
        </div>
      `).join("")}
    </div>
    <div class="button-row">
      <button class="btn primary" data-detail-action="save">Save</button>
      <button class="btn ghost" data-detail-action="cancel">Cancel</button>
    </div>
  `;

  const main = document.querySelector(".app-main");
  main.appendChild(overlay);

  overlay.querySelectorAll("[data-detail]").forEach((input) => {
    input.oninput = (event) => {
      const index = Number(event.target.dataset.detail);
      const metric = event.target.dataset.metric;
      const value = Number(event.target.value);
      if (metric === "reps") detailLogs[index].log.reps = value;
      if (metric === "load") detailLogs[index].log.loadKg = value;
      if (metric === "duration") detailLogs[index].log.durationSec = value;
      if (metric === "rir") detailLogs[index].log.rir = value;
      if (metric === "pain") detailLogs[index].log.pain0to10 = value;
    };
  });

  overlay.querySelector("button[data-detail-action=save]").onclick = async () => {
    for (const entry of detailLogs) {
      const log = entry.log;
      await dbPut("logs", log);
      state.logs.unshift(log);
    }
    toast("Detailed log saved.");
    render();
  };

  overlay.querySelector("button[data-detail-action=cancel]").onclick = () => render();
}

async function undoLog() {
  const last = state.logs[0];
  if (!last) return;
  await dbDelete("logs", last.id);
  state.logs.shift();
  toast("Last log removed.");
  render();
}

async function deleteLog(id) {
  await dbDelete("logs", id);
  state.logs = state.logs.filter((log) => log.id !== id);
  render();
}

async function saveExercise() {
  if (!state.exerciseName?.trim()) return;
  const base = {
    id: uuid(),
    name: state.exerciseName.trim(),
    category: state.exerciseCategory ?? "pull",
    tags: [],
    variantsSchema: state.variantFields ?? [],
  };

  let record;
  if ((state.exerciseType ?? "reps") === "weighted") {
    record = {
      ...base,
      type: "weighted",
      repRange: { min: state.repMin ?? 6, max: state.repMax ?? 12 },
      repIncrement: 1,
      loadIncrementKg: state.loadIncrement ?? 2.5,
      progressionPriority: "reps_then_load",
    };
  } else if ((state.exerciseType ?? "reps") === "isometric") {
    record = {
      ...base,
      type: "isometric",
      durationRangeSec: { min: state.durationMin ?? 20, max: state.durationMax ?? 60 },
      timeIncrementSec: state.timeIncrement ?? 5,
    };
  } else {
    record = {
      ...base,
      type: "reps",
      repRange: { min: state.repMin ?? 6, max: state.repMax ?? 12 },
      repIncrement: 1,
      minRepsFloor: 1,
    };
  }

  await dbPut("exercises", record);
  state.exercises.push(record);
  state.exerciseName = "";
  toast("Exercise saved.");
  render();
}

function addVariantField() {
  if (!state.variantFields) state.variantFields = [];
  state.variantFields.push({ key: `field-${state.variantFields.length + 1}`, label: "Variant", type: "text" });
  render();
}

async function deleteExercise(id) {
  await dbDelete("exercises", id);
  state.exercises = state.exercises.filter((exercise) => exercise.id !== id);
  render();
}

function addTemplateItem() {
  if (!state.templateItems) state.templateItems = [];
  const first = state.exercises[0];
  if (!first) return;
  state.templateItems.push({ exerciseId: first.id, targetMode: "auto" });
  render();
}

function removeTemplateItem(index) {
  state.templateItems.splice(index, 1);
  render();
}

async function saveTemplate() {
  if (!state.templateName?.trim()) return;
  const template = {
    id: uuid(),
    name: state.templateName.trim(),
    items: state.templateItems ?? [],
  };
  await dbPut("templates", template);
  state.templates.push(template);
  state.templateName = "";
  state.templateItems = [];
  toast("Template saved.");
  render();
}

async function deleteTemplate(id) {
  await dbDelete("templates", id);
  state.templates = state.templates.filter((template) => template.id !== id);
  render();
}

function exportCsv() {
  const logs = state.logs.filter((log) => log.exerciseId === (state.selectedExerciseId ?? state.exercises[0]?.id));
  const header = ["timestamp", "exerciseId", "reps", "loadKg", "durationSec", "rir", "pain0to10", "status"];
  const rows = logs.map((log) => [
    log.timestamp,
    log.exerciseId,
    log.reps ?? "",
    log.loadKg ?? "",
    log.durationSec ?? "",
    log.rir ?? "",
    log.pain0to10 ?? "",
    log.status,
  ]);
  const csv = [header, ...rows].map((row) => row.join(",")).join("\n");
  downloadFile("dojo-logs.csv", csv);
}

function exportGlobalCsv() {
  const header = ["timestamp", "exerciseId", "reps", "loadKg", "durationSec", "rir", "pain0to10", "status"];
  const rows = state.logs.map((log) => [
    log.timestamp,
    log.exerciseId,
    log.reps ?? "",
    log.loadKg ?? "",
    log.durationSec ?? "",
    log.rir ?? "",
    log.pain0to10 ?? "",
    log.status,
  ]);
  const csv = [header, ...rows].map((row) => row.join(",")).join("\n");
  downloadFile("dojo-all-logs.csv", csv);
}

function exportJson() {
  const data = {
    exercises: state.exercises,
    logs: state.logs,
    templates: state.templates,
    settings: state.settings,
  };
  downloadFile("dojo-backup.json", JSON.stringify(data, null, 2));
}

async function importJson(file) {
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    if (data.exercises) {
      state.exercises = data.exercises;
      for (const exercise of data.exercises) {
        await dbPut("exercises", exercise);
      }
    }
    if (data.logs) {
      state.logs = data.logs;
      for (const log of data.logs) {
        await dbPut("logs", log);
      }
    }
    if (data.templates) {
      state.templates = data.templates;
      for (const template of data.templates) {
        await dbPut("templates", template);
      }
    }
    if (data.settings) {
      await saveSettings(data.settings);
    }
    toast("Import complete.");
    render();
  } catch {
    alert("Invalid JSON file.");
  }
}

async function resetAll() {
  if (!confirm("Reset all data? This cannot be undone.")) return;
  state.exercises = [];
  state.logs = [];
  state.templates = [];
  state.templateItems = [];
  state.variantFields = [];
  await saveSettings({ ...defaultSettings });
  await ensureDefaults();
  render();
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js");
  });
}

state.mode = "single";
state.exerciseType = "reps";
state.exerciseCategory = "pull";
state.repMin = 6;
state.repMax = 12;
state.loadIncrement = 2.5;
state.durationMin = 20;
state.durationMax = 60;
state.timeIncrement = 5;
state.variantFields = [];
state.templateItems = [];
state.templateName = "";
state.exerciseName = "";
state.selectedExerciseId = null;
state.selectedTemplateId = null;
state.windowDays = 30;
state.completeOnly = true;

loadStore();
