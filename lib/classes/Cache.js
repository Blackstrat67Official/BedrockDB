import { Storage } from "./Storage.js";

/**
 * Cache - High-Performance Indexed & Policy-Driven Memory Layer for Storage
 *
 * Features:
 * - Selective Preloading (define what enters the cache via WHERE filters)
 * - O(1) Secondary Indexes (instant lookups by uuid, name, etc. without Storage.select)
 * - Retention & Eviction Control (pinned items, LRU maxSize, TTL, retain/evict)
 * - Write-Behind Mode (mutate in RAM at 20 TPS and flush() dirty rows to scoreboard)
 * - Memoized Query Cache (Cache.remember with tag-based auto-invalidation)
 */
export class Cache {
    /**
     * Table configurations and indexed stores
     * @type {Map<string, {
     *   config: {
     *     where?: object | function,
     *     indexes: string[],
     *     maxSize: number,
     *     ttl: number,
     *     pinned: boolean,
     *     writeBehind: boolean,
     *     autoSync: boolean
     *   },
     *   records: Map<number, { data: any, cachedAt: number, lastAccess: number, pinned: boolean, dirty: boolean }>,
     *   indexMaps: Map<string, Map<any, Set<number>>>
     * }>}
     */
    static _tables = new Map();

    /**
     * General Key-Value / Query Cache (used by Cache.remember & Cache.set)
     * @type {Map<string, { value: any, expiresAt: number | null, pinned: boolean, tags: Set<string> }>}
     */
    static _kv = new Map();

    static _stats = { hits: 0, misses: 0, evictions: 0, flushes: 0 };
    static _hookRegistered = false;

    /* =========================================================================
       INTERNAL INITIALIZATION & SYNC
    ========================================================================= */

    static _ensureHook() {
        if (this._hookRegistered || typeof Storage.onMutation !== "function") return;
        this._hookRegistered = true;

        Storage.onMutation(({ type, table, id, data }) => {
            // 1. Invalidate any general KV/query entries tagged with this table
            this.invalidateTag(`table:${table}`);

            // 2. Sync defined table store if autoSync is active
            const store = this._tables.get(table);
            if (!store || !store.config.autoSync) return;

            if (type === "clear") {
                this.clearTable(table);
                return;
            }

            if (type === "delete") {
                this._removeEntry(table, id);
                return;
            }

            if (type === "insert" || type === "update") {
                const matchesPolicy = store.config.where
                    ? Storage._matchWhere(data, id, store.config.where)
                    : true;

                if (matchesPolicy) {
                    const existing = store.records.get(id);
                    this._putEntry(table, id, data, {
                        pinned: existing ? existing.pinned : store.config.pinned,
                        dirty: false
                    });
                } else if (store.records.has(id)) {
                    // Record no longer matches the retention filter
                    this._removeEntry(table, id);
                }
            }
        });
    }

    static _getStore(table) {
        const store = this._tables.get(table);
        if (!store) {
            throw new Error(`[Cache] Table '${table}' is not registered. Call Cache.define('${table}', options) first.`);
        }
        return store;
    }

    static _isExpired(cachedAt, ttl) {
        return ttl > 0 && (Date.now() - cachedAt) >= ttl;
    }

    /* =========================================================================
       INDEX MANAGEMENT (O(1) LOOKUPS)
    ========================================================================= */

    static _indexAdd(store, id, data) {
        for (const field of store.config.indexes) {
            const val = field === "id" ? id : Storage._getNestedValue(data, field);
            if (val === undefined || val === null) continue;

            let fieldMap = store.indexMaps.get(field);
            if (!fieldMap) {
                fieldMap = new Map();
                store.indexMaps.set(field, fieldMap);
            }
            let idSet = fieldMap.get(val);
            if (!idSet) {
                idSet = new Set();
                fieldMap.set(val, idSet);
            }
            idSet.add(id);
        }
    }

    static _indexRemove(store, id, data) {
        for (const field of store.config.indexes) {
            const val = field === "id" ? id : Storage._getNestedValue(data, field);
            if (val === undefined || val === null) continue;

            const fieldMap = store.indexMaps.get(field);
            if (!fieldMap) continue;
            const idSet = fieldMap.get(val);
            if (idSet) {
                idSet.delete(id);
                if (idSet.size === 0) fieldMap.delete(val);
            }
        }
    }

    /* =========================================================================
       ENTRY LIFECYCLE & LRU EVICTION
    ========================================================================= */

    static _putEntry(table, id, data, { pinned, dirty = false } = {}) {
        const store = this._getStore(table);
        const now = Date.now();

        if (store.records.has(id)) {
            const prev = store.records.get(id);
            this._indexRemove(store, id, prev.data);
            store.records.delete(id);
        } else if (store.config.maxSize > 0 && store.records.size >= store.config.maxSize) {
            this._evictOneLRU(table);
        }

        const cloned = Storage._clone(data);
        const isPinned = pinned !== undefined ? Boolean(pinned) : store.config.pinned;

        // Map preserves insertion order -> deleting and re-inserting tracks LRU order
        store.records.set(id, {
            data: cloned,
            cachedAt: now,
            lastAccess: now,
            pinned: isPinned,
            dirty
        });

        this._indexAdd(store, id, cloned);
    }

    static _removeEntry(table, id) {
        const store = this._tables.get(table);
        if (!store || !store.records.has(id)) return false;

        const entry = store.records.get(id);
        this._indexRemove(store, id, entry.data);
        store.records.delete(id);
        this._stats.evictions++;
        return true;
    }

    static _touchEntry(store, id, entry) {
        entry.lastAccess = Date.now();
        store.records.delete(id);
        store.records.set(id, entry);
    }

    static _evictOneLRU(table) {
        const store = this._getStore(table);
        for (const [id, entry] of store.records.entries()) {
            // Never evict pinned or dirty (unflushed) entries automatically
            if (!entry.pinned && !entry.dirty) {
                this._removeEntry(table, id);
                return true;
            }
        }
        return false;
    }

    /* =========================================================================
       1. CONFIGURATION & PRELOADING (DECIDE WHAT ENTERS CACHE)
    ========================================================================= */

    /**
     * Define caching rules and indexes for a Storage table, optionally preloading immediately.
     *
     * @param {string} table - Storage table name.
     * @param {object} [options]
     * @param {object | function} [options.where] - Filter deciding which records belong in cache.
     * @param {string[]} [options.indexes=[]] - Fields to index for O(1) lookups (e.g. ["uuid", "name"]).
     * @param {number} [options.maxSize=0] - Max cached records (0 = unlimited). Uses LRU eviction.
     * @param {number} [options.ttl=0] - Entry lifetime in ms (0 = stays until evicted/invalidated).
     * @param {boolean} [options.pinned=false] - If true, entries are protected from LRU eviction.
     * @param {boolean} [options.writeBehind=false] - If true, Cache.mutate() buffers changes until flush().
     * @param {boolean} [options.autoSync=true] - Keep cache synced when Storage writes occur.
     * @param {boolean} [options.preload=true] - Immediately preload matching records from Storage.
     */
    static define(table, options = {}) {
        this._ensureHook();

        const config = {
            where: options.where,
            indexes: Array.isArray(options.indexes) ? [...options.indexes] : [],
            maxSize: typeof options.maxSize === "number" ? options.maxSize : 0,
            ttl: typeof options.ttl === "number" ? options.ttl : 0,
            pinned: Boolean(options.pinned),
            writeBehind: Boolean(options.writeBehind),
            autoSync: options.autoSync !== false
        };

        const indexMaps = new Map();
        for (const field of config.indexes) {
            indexMaps.set(field, new Map());
        }

        this._tables.set(table, {
            config,
            records: new Map(),
            indexMaps
        });

        if (options.preload !== false) {
            this.preload(table, config.where);
        }

        return this;
    }

    /**
     * Preload records from Storage into Cache (replaces or merges with current cached records).
     * @param {string} table
     * @param {object | function} [where] - Optional override filter; defaults to table's defined filter.
     * @param {object} [opts]
     * @param {boolean} [opts.clearFirst=true] - Clear existing entries before loading.
     * @param {boolean} [opts.pinned] - Pin all preloaded entries.
     * @returns {number} Number of preloaded records.
     */
    static preload(table, where, { clearFirst = true, pinned } = {}) {
        const store = this._getStore(table);
        if (clearFirst) {
            this.clearTable(table);
        }

        const filter = where !== undefined ? where : store.config.where;
        const rows = Storage.select(table, { where: filter });

        for (const row of rows) {
            this._putEntry(table, row.id, row.data, { pinned });
        }

        return rows.length;
    }

    /**
     * Load a single specific record from Storage into Cache on-demand (e.g. on player join).
     * @param {string} table
     * @param {number | object | function} where - Primary key ID or filter.
     * @param {object} [opts]
     * @param {boolean} [opts.pinned] - Lock this record in cache so LRU will not evict it.
     * @returns {{ id: number, data: any } | null}
     */
    static warmOne(table, where, { pinned } = {}) {
        this._getStore(table);
        const row = typeof where === "number"
            ? (() => {
                const d = Storage.findById(table, where);
                return d ? { id: where, data: d } : null;
            })()
            : Storage.selectOne(table, { where });

        if (!row) return null;

        this._putEntry(table, row.id, row.data, { pinned });
        return { id: row.id, data: Storage._clone(row.data) };
    }

    /* =========================================================================
       2. O(1) READS (NO STORAGE.SELECT NEEDED)
    ========================================================================= */

    /**
     * O(1) lookup by primary key ID from cache.
     * @param {string} table
     * @param {number} id
     * @param {object} [opts]
     * @param {boolean} [opts.fallbackToStorage=false] - If missed, load from Storage and cache it.
     * @returns {any | null}
     */
    static get(table, id, { fallbackToStorage = false } = {}) {
        const store = this._getStore(table);
        const entry = store.records.get(id);

        if (entry) {
            if (this._isExpired(entry.cachedAt, store.config.ttl)) {
                this._removeEntry(table, id);
            } else {
                this._stats.hits++;
                this._touchEntry(store, id, entry);
                return entry.data;
            }
        }

        this._stats.misses++;
        if (fallbackToStorage) {
            const loaded = this.warmOne(table, id);
            return loaded ? loaded.data : null;
        }
        return null;
    }

    /**
     * O(1) lookup using an indexed field (e.g. Cache.getBy("players", "uuid", player.id)).
     * @param {string} table
     * @param {string} indexField
     * @param {any} value
     * @param {object} [opts]
     * @param {boolean} [opts.fallbackToStorage=false] - Query Storage once if not cached, then cache it.
     * @returns {{ id: number, data: any } | null}
     */
    static getBy(table, indexField, value, { fallbackToStorage = false } = {}) {
        const store = this._getStore(table);
        const fieldMap = store.indexMaps.get(indexField);
        if (!fieldMap) {
            throw new Error(`[Cache] Field '${indexField}' is not indexed on table '${table}'. Add it to 'indexes' in define().`);
        }

        const idSet = fieldMap.get(value);
        if (idSet && idSet.size > 0) {
            for (const id of idSet) {
                const entry = store.records.get(id);
                if (!entry) continue;

                if (this._isExpired(entry.cachedAt, store.config.ttl)) {
                    this._removeEntry(table, id);
                    continue;
                }

                this._stats.hits++;
                this._touchEntry(store, id, entry);
                return { id, data: entry.data };
            }
        }

        this._stats.misses++;
        if (fallbackToStorage) {
            return this.warmOne(table, { [indexField]: value });
        }
        return null;
    }

    /**
     * O(1) lookup returning ALL cached records matching an indexed field value.
     * @param {string} table
     * @param {string} indexField
     * @param {any} value
     * @returns {Array<{ id: number, data: any }>}
     */
    static getAllBy(table, indexField, value) {
        const store = this._getStore(table);
        const fieldMap = store.indexMaps.get(indexField);
        if (!fieldMap) {
            throw new Error(`[Cache] Field '${indexField}' is not indexed on table '${table}'. Add it to 'indexes' in define().`);
        }

        const idSet = fieldMap.get(value);
        if (!idSet || idSet.size === 0) {
            this._stats.misses++;
            return [];
        }

        const results = [];
        for (const id of [...idSet]) {
            const entry = store.records.get(id);
            if (!entry) continue;
            if (this._isExpired(entry.cachedAt, store.config.ttl)) {
                this._removeEntry(table, id);
                continue;
            }
            this._stats.hits++;
            this._touchEntry(store, id, entry);
            results.push({ id, data: entry.data });
        }
        return results;
    }

    /**
     * Check if a record exists in cache by ID.
     * @param {string} table
     * @param {number} id
     * @returns {boolean}
     */
    static has(table, id) {
        const store = this._tables.get(table);
        if (!store || !store.records.has(id)) return false;
        const entry = store.records.get(id);
        if (this._isExpired(entry.cachedAt, store.config.ttl)) {
            this._removeEntry(table, id);
            return false;
        }
        return true;
    }

    /**
     * Return all currently cached records for a table without touching Storage.
     * @param {string} table
     * @param {function} [predicate] - Optional fast in-memory filter (data, id) => boolean.
     * @returns {Array<{ id: number, data: any }>}
     */
    static entries(table, predicate) {
        const store = this._getStore(table);
        const results = [];

        for (const [id, entry] of [...store.records.entries()]) {
            if (this._isExpired(entry.cachedAt, store.config.ttl)) {
                this._removeEntry(table, id);
                continue;
            }
            if (!predicate || predicate(entry.data, id)) {
                results.push({ id, data: entry.data });
            }
        }
        return results;
    }

    /* =========================================================================
       3. RETENTION CONTROL (DECIDE WHAT STAYS IN CACHE)
    ========================================================================= */

    /**
     * Pin a cached record so automatic LRU eviction will never remove it.
     * @param {string} table
     * @param {number} id
     * @returns {boolean}
     */
    static pin(table, id) {
        const store = this._getStore(table);
        const entry = store.records.get(id);
        if (!entry) return false;
        entry.pinned = true;
        return true;
    }

    /**
     * Unpin a cached record so it becomes eligible for LRU eviction again.
     * @param {string} table
     * @param {number} id
     * @returns {boolean}
     */
    static unpin(table, id) {
        const store = this._getStore(table);
        const entry = store.records.get(id);
        if (!entry) return false;
        entry.pinned = false;
        return true;
    }

    /**
     * Evict records from Cache ONLY (does NOT delete from Storage).
     * Automatically flushes dirty write-behind data before evicting if needed.
     * @param {string} table
     * @param {number | object | function} where - ID, query object, or predicate.
     * @param {boolean} [flushIfDirty=true]
     * @returns {number} Number of evicted records.
     */
    static evict(table, where, flushIfDirty = true) {
        const store = this._getStore(table);
        let evicted = 0;

        for (const [id, entry] of [...store.records.entries()]) {
            if (Storage._matchWhere(entry.data, id, where)) {
                if (flushIfDirty && entry.dirty) {
                    entry.dirty = false;
                    Storage.update(table, id, entry.data);
                }
                this._removeEntry(table, id);
                evicted++;
            }
        }
        return evicted;
    }

    /**
     * Keep ONLY records matching `where` in Cache and evict everything else.
     * Useful on world reload or phase changes to purge stale memory.
     * @param {string} table
     * @param {object | function} where
     * @returns {number} Number of evicted records.
     */
    static retain(table, where) {
        const store = this._getStore(table);
        let evicted = 0;

        for (const [id, entry] of [...store.records.entries()]) {
            if (!Storage._matchWhere(entry.data, id, where)) {
                if (entry.dirty) {
                    entry.dirty = false;
                    Storage.update(table, id, entry.data);
                }
                this._removeEntry(table, id);
                evicted++;
            }
        }
        return evicted;
    }

    /**
     * Remove all expired TTL entries across one or all tables and KV entries.
     * @param {string} [table]
     * @returns {number} Total expired items purged.
     */
    static sweep(table) {
        let purged = 0;
        const targets = table ? [[table, this._getStore(table)]] : [...this._tables.entries()];

        for (const [tblName, store] of targets) {
            if (store.config.ttl <= 0) continue;
            for (const [id, entry] of [...store.records.entries()]) {
                if (this._isExpired(entry.cachedAt, store.config.ttl)) {
                    if (entry.dirty) {
                        entry.dirty = false;
                        Storage.update(tblName, id, entry.data);
                    }
                    this._removeEntry(tblName, id);
                    purged++;
                }
            }
        }

        const now = Date.now();
        for (const [key, item] of [...this._kv.entries()]) {
            if (item.expiresAt !== null && now >= item.expiresAt) {
                this._kv.delete(key);
                purged++;
            }
        }

        return purged;
    }

    /**
     * Clear all cached entries for a table (without touching Storage).
     * @param {string} table
     */
    static clearTable(table) {
        const store = this._tables.get(table);
        if (!store) return;
        store.records.clear();
        for (const fieldMap of store.indexMaps.values()) {
            fieldMap.clear();
        }
    }

    /**
     * Re-synchronize a registered Cache table with Storage (used after transaction rollback).
     * @param {string} table
     */
    static syncFromStorage(table) {
        this.invalidateTag(`table:${table}`);
        const store = this._tables.get(table);
        if (!store) return;

        if (store.config.preload !== false && store.records.size > 0) {
            this.preload(table, store.config.where);
        } else {
            // Refresh any currently cached IDs from Storage and drop rolled-back IDs
            for (const [id, entry] of [...store.records.entries()]) {
                const fresh = Storage.findById(table, id);
                if (!fresh) {
                    this._removeEntry(table, id);
                } else {
                    this._putEntry(table, id, fresh, { pinned: entry.pinned, dirty: false });
                }
            }
        }
    }

    /* =========================================================================
       4. WRITE-BEHIND MUTATIONS & FLUSH (HIGH-FREQUENCY TICK UPDATES)
    ========================================================================= */

    /**
     * Mutate a cached record directly in RAM (supports $inc, $push, $pull, $unset).
     * - If table has `writeBehind: true`, marks the entry dirty without touching Storage until flush().
     * - If `writeBehind: false`, writes through immediately to Storage.
     *
     * @param {string} table
     * @param {number} id
     * @param {object | function} changes
     * @returns {any | null} Updated record data, or null if ID is not in cache.
     */
    static mutate(table, id, changes) {
        const store = this._getStore(table);
        const entry = store.records.get(id);
        if (!entry) return null;

        if (!store.config.writeBehind) {
            Storage.update(table, id, changes);
            if (!store.config.autoSync) {
                const nextData = Storage._applyChanges(entry.data, changes);
                this._putEntry(table, id, nextData, { pinned: entry.pinned, dirty: false });
            }
            return store.records.get(id)?.data ?? null;
        }

        const nextData = Storage._applyChanges(entry.data, changes);
        this._putEntry(table, id, nextData, {
            pinned: entry.pinned,
            dirty: true
        });
        return store.records.get(id).data;
    }

    /**
     * Persist all dirty write-behind records back to Storage (Scoreboard).
     * @param {string} [table] - Flush a specific table, or omit to flush all tables.
     * @returns {number} Number of records persisted to Storage.
     */
    static flush(table) {
        const targets = table ? [[table, this._getStore(table)]] : [...this._tables.entries()];
        let flushed = 0;

        for (const [tblName, store] of targets) {
            for (const [id, entry] of store.records.entries()) {
                if (entry.dirty) {
                    entry.dirty = false;
                    Storage.update(tblName, id, entry.data);
                    flushed++;
                }
            }
        }

        if (flushed > 0) this._stats.flushes++;
        return flushed;
    }

    /* =========================================================================
       5. GENERAL QUERY / COMPUTED CACHE (CACHE-ASIDE)
    ========================================================================= */

    /**
     * Store an arbitrary value or query result in the general KV cache.
     * @param {string} key
     * @param {any} value
     * @param {object} [opts]
     * @param {number} [opts.ttl=0] - Lifetime in ms (0 = permanent until invalidated).
     * @param {boolean} [opts.pinned=false]
     * @param {string[]} [opts.tags=[]] - Invalidation tags (use "table:players" to auto-invalidate on Storage writes!).
     */
    static set(key, value, { ttl = 0, pinned = false, tags = [] } = {}) {
        this._ensureHook();
        this._kv.set(key, {
            value,
            expiresAt: ttl > 0 ? Date.now() + ttl : null,
            pinned: Boolean(pinned),
            tags: new Set(tags)
        });
        return value;
    }

    /**
     * Retrieve a value from the general KV cache.
     * @param {string} key
     * @returns {any | undefined}
     */
    static read(key) {
        const item = this._kv.get(key);
        if (!item) {
            this._stats.misses++;
            return undefined;
        }
        if (item.expiresAt !== null && Date.now() >= item.expiresAt) {
            this._kv.delete(key);
            this._stats.misses++;
            return undefined;
        }
        this._stats.hits++;
        return item.value;
    }

    /**
     * Cache-aside helper: returns cached value if valid, otherwise runs `loaderFn()`, caches, and returns it.
     * @param {string} key
     * @param {function} loaderFn - Function that computes the value (e.g. () => Storage.select(...)).
     * @param {object} [opts]
     * @param {number} [opts.ttl=0]
     * @param {boolean} [opts.pinned=false]
     * @param {string[]} [opts.tags=[]]
     * @returns {any}
     */
    static remember(key, loaderFn, opts = {}) {
        const cached = this.read(key);
        if (cached !== undefined) return cached;

        const computed = loaderFn();
        this.set(key, computed, opts);
        return computed;
    }

    /**
     * Invalidate a specific key in the general KV cache.
     * @param {string} key
     * @returns {boolean}
     */
    static invalidate(key) {
        return this._kv.delete(key);
    }

    /**
     * Invalidate all KV entries matching a tag (e.g. "table:players" or "leaderboard").
     * @param {string} tag
     * @returns {number}
     */
    static invalidateTag(tag) {
        let count = 0;
        for (const [key, item] of [...this._kv.entries()]) {
            if (item.tags.has(tag)) {
                this._kv.delete(key);
                count++;
            }
        }
        return count;
    }

    /* =========================================================================
       6. DIAGNOSTICS
    ========================================================================= */

    /**
     * Return memory usage and hit/miss metrics.
     */
    static stats() {
        const total = this._stats.hits + this._stats.misses;
        const tables = {};

        for (const [name, store] of this._tables.entries()) {
            let dirty = 0;
            let pinned = 0;
            for (const entry of store.records.values()) {
                if (entry.dirty) dirty++;
                if (entry.pinned) pinned++;
            }
            tables[name] = {
                cached: store.records.size,
                pinned,
                dirty,
                indexes: [...store.config.indexes]
            };
        }

        return {
            hits: this._stats.hits,
            misses: this._stats.misses,
            hitRate: total > 0 ? `${((this._stats.hits / total) * 100).toFixed(1)}%` : "0.0%",
            evictions: this._stats.evictions,
            flushes: this._stats.flushes,
            kvEntries: this._kv.size,
            tables
        };
    }
}

Cache._ensureHook();
