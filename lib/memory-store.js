/**
 * memory-store.js — storage adapter for in-memory (Vercel serverless) and localStorage (browser).
 */

import { DEFAULT_SETTINGS, summariseWeek, reviveWeek } from './store-shared.js';

const EMPTY = () => ({ weeks: {}, order: [], settings: {} });

export function createStoreAdapter(backend, { oddsApiKey = '', weekCap = 50, onQuotaExceeded = null } = {}) {
  function load() {
    let db = null;
    try {
      db = backend.read();
    } catch {
      db = null;
    }
    if (!db || typeof db !== 'object') db = EMPTY();
    db.weeks = db.weeks || {};
    db.order = db.order || [];
    db.settings = db.settings || {};
    return db;
  }

  function persist(db) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        backend.write(db);
        return true;
      } catch (err) {
        // Evict oldest completed week if quota exceeded
        const victim = db.order
          .map((id) => db.weeks[id])
          .filter(Boolean)
          .filter((w) => w.status !== 'active')
          .pop();

        if (!victim) {
          if (onQuotaExceeded) onQuotaExceeded({ evicted: 0, error: err.message, fatal: true });
          return false;
        }
        delete db.weeks[victim.id];
        db.order = db.order.filter((x) => x !== victim.id);
        if (onQuotaExceeded) onQuotaExceeded({ evictedWeek: victim.id, error: err.message });
      }
    }
    return false;
  }

  return {
    async saveWeek(week) {
      const db = load();
      db.weeks[week.id] = reviveWeek(JSON.parse(JSON.stringify(week)));
      if (!db.order.includes(week.id)) db.order.unshift(week.id);
      db.order = db.order.slice(0, weekCap);
      persist(db);
      return week;
    },

    async getWeek(id) {
      const db = load();
      const week = db.weeks[id];
      return week ? reviveWeek(week) : null;
    },

    async getActiveWeek() {
      const db = load();
      for (const id of db.order) {
        const w = db.weeks[id];
        if (w && w.status === 'active') return reviveWeek(w);
      }
      return null;
    },

    async listWeeks(limit = 20) {
      const db = load();
      return db.order
        .slice(0, limit)
        .map((id) => db.weeks[id])
        .filter(Boolean)
        .map((w) => summariseWeek(w));
    },

    async deleteWeek(id) {
      const db = load();
      delete db.weeks[id];
      db.order = db.order.filter((x) => x !== id);
      persist(db);
      return true;
    },

    revive: reviveWeek,

    async getSettings() {
      const db = load();
      return {
        ...DEFAULT_SETTINGS,
        oddsApi: {
          key: oddsApiKey || db.settings?.oddsApi?.key || '',
          sports: db.settings?.oddsApi?.sports || [],
        },
        ...db.settings,
      };
    },

    async saveSettings(patch) {
      const db = load();
      db.settings = { ...(db.settings || {}), ...patch };
      persist(db);
      return this.getSettings();
    },
  };
}

export function createMemoryStore(opts = {}) {
  let db = EMPTY();
  return createStoreAdapter(
    {
      read: () => db,
      write: (next) => {
        db = next;
      },
    },
    opts
  );
}

export function createLocalStorageStore(key = 'longshot.store.v1', opts = {}) {
  let memoryFallback = null;
  const evictions = [];

  const available = (() => {
    try {
      if (typeof localStorage === 'undefined') return false;
      const probe = '__ls_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  })();

  const backend = available
    ? {
        read: () => {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : EMPTY();
        },
        write: (db) => localStorage.setItem(key, JSON.stringify(db)),
      }
    : {
        read: () => memoryFallback || EMPTY(),
        write: (db) => {
          memoryFallback = db;
        },
      };

  const store = createStoreAdapter(backend, {
    weekCap: 25,
    onQuotaExceeded: (info) => {
      evictions.push(info);
    },
    ...opts,
  });

  store.backend = available ? 'localStorage' : 'memory';
  store.storageKey = key;
  store.evictions = evictions;
  return store;
}
