import { world, system } from "@minecraft/server";
import { Storage } from "./Storage.js";
import { Cache } from "./Cache.js";

const SCHEDULE_TABLE = "_db_schedules";

/**
 * SQLScheduler - Persistent Database Timers & Tick-Budgeted Cache Auto-Flush
 *
 * Features:
 * - Persistent Timers (`_db_schedules`): stores delayed & recurring jobs on scoreboard
 *   so jail sentences, shop rents, licenses, and bans survive `/reload` and server restarts
 * - Startup Race-Condition Protection: if a persisted timer is already due before its
 *   handler is registered, it executes immediately upon `registerHandler()`
 * - Tick-Budgeted Execution: processes at most `maxJobsPerTick` due timers per tick to
 *   prevent lag spikes when many timers expire offline
 * - Tick-Budgeted Cache Auto-Flush: spreads dirty `writeBehind` Cache writes across
 *   multiple ticks (`maxWritesPerTick`) and automatically flushes/evicts on `playerLeave`
 */
export class SQLScheduler {
    /**
     * Registered persistent job handlers keyed by handler name.
     * @type {Map<string, (payload: any, job: any) => any>}
     */
    static _handlers = new Map();

    /** @type {Set<string>} Guards against concurrent double-execution of the same jobId */
    static _inFlight = new Set();

    static _loopId = null;
    static _pollIntervalTicks = 20; // Check due schedules every 20 ticks (1 second)
    static _maxJobsPerTick = 5;

    /**
     * Tick-budgeted Cache auto-flush configuration
     */
    static _cacheFlushConfig = {
        enabled: false,
        intervalTicks: 40,
        maxWritesPerTick: 5,
        tables: null, // null = all tables registered in Cache
        sweepTtl: true,
        _tickCounter: 0
    };

    /** @type {Map<string, { keyField: string, flush: boolean, evict: boolean }>} */
    static _playerBindings = new Map();
    static _playerLeaveHooked = false;

    static _stats = {
        jobsExecuted: 0,
        jobsFailed: 0,
        cacheRowsFlushed: 0
    };

    /* =========================================================================
       1. PERSISTENT HANDLER REGISTRATION
    ========================================================================= */

    /**
     * Register a named handler for persistent scheduled jobs.
     * Automatically starts the scheduler loop and processes any overdue jobs for this handler.
     *
     * @param {string} handlerName - Unique handler identifier (e.g. "release_prisoner").
     * @param {(payload: any, job: { jobId: string, handler: string, runAt: number, intervalMs: number | null, attempts: number }) => any} handlerFn
     */
    static registerHandler(handlerName, handlerFn) {
        if (typeof handlerName !== "string" || handlerName.trim() === "") {
            throw new TypeError("[SQLScheduler] 'handlerName' must be a non-empty string.");
        }
        if (typeof handlerFn !== "function") {
            throw new TypeError(`[SQLScheduler] Handler for '${handlerName}' must be a function.`);
        }

        const cleanName = handlerName.trim();
        this._handlers.set(cleanName, handlerFn);
        this.start();

        // Process any persisted jobs for this handler that became due before registration
        system.run(() => {
            this._processDueJobs(cleanName);
        });

        return this;
    }

    /**
     * Unregister a persistent job handler.
     * @param {string} handlerName
     * @returns {boolean}
     */
    static unregisterHandler(handlerName) {
        return this._handlers.delete(String(handlerName || "").trim());
    }

    /* =========================================================================
       2. PERSISTENT TIMER SCHEDULING API
    ========================================================================= */

    /**
     * Schedule a persistent one-shot job to run after `delayMs` milliseconds.
     * Survives `/reload`, world save/exit, and server restarts.
     *
     * @param {string} handlerName - Name registered via `SQLScheduler.registerHandler()`.
     * @param {number} delayMs - Delay in milliseconds from now (e.g. `600_000` for 10 minutes).
     * @param {any} [payload={}] - JSON-serializable payload passed to the handler.
     * @param {object} [options]
     * @param {string} [options.key] - Optional deduplication key (e.g. `"jail:player123"`). Replaces any existing job with the same key.
     * @param {number} [options.maxRetries=0] - Number of retry attempts if the handler throws an error.
     * @returns {string} The persistent `jobId`.
     */
    static schedule(handlerName, delayMs, payload = {}, options = {}) {
        const delay = Math.max(0, Number(delayMs) || 0);
        return this.scheduleAt(handlerName, Date.now() + delay, payload, options);
    }

    /**
     * Schedule a persistent one-shot job at an exact Unix timestamp (`timestampMs`).
     *
     * @param {string} handlerName
     * @param {number} timestampMs
     * @param {any} [payload={}]
     * @param {object} [options]
     * @param {string} [options.key]
     * @param {number} [options.maxRetries=0]
     * @returns {string} The persistent `jobId`.
     */
    static scheduleAt(handlerName, timestampMs, payload = {}, options = {}) {
        return this._upsertSchedule({
            handlerName,
            runAt: Number(timestampMs) || Date.now(),
            intervalMs: null,
            payload,
            key: options.key,
            maxRetries: options.maxRetries
        });
    }

    /**
     * Schedule a persistent recurring job that executes every `intervalMs` milliseconds.
     *
     * @param {string} handlerName
     * @param {number} intervalMs - Interval in milliseconds (minimum 50ms).
     * @param {any} [payload={}]
     * @param {object} [options]
     * @param {string} [options.key] - Optional unique key so re-calling on startup doesn't duplicate the recurring job.
     * @param {number} [options.initialDelayMs] - Optional custom delay before the very first run (defaults to `intervalMs`).
     * @param {number} [options.maxRetries=0]
     * @returns {string} The persistent `jobId`.
     */
    static scheduleInterval(handlerName, intervalMs, payload = {}, options = {}) {
        const interval = Math.max(50, Number(intervalMs) || 1000);
        const firstDelay = options.initialDelayMs !== undefined
            ? Math.max(0, Number(options.initialDelayMs))
            : interval;

        return this._upsertSchedule({
            handlerName,
            runAt: Date.now() + firstDelay,
            intervalMs: interval,
            payload,
            key: options.key,
            maxRetries: options.maxRetries
        });
    }

    static _upsertSchedule({ handlerName, runAt, intervalMs, payload, key, maxRetries }) {
        if (typeof handlerName !== "string" || handlerName.trim() === "") {
            throw new TypeError("[SQLScheduler] 'handlerName' must be a non-empty string.");
        }

        const cleanHandler = handlerName.trim();
        const jobId = key ? String(key).trim() : this._generateJobId();

        // Remove existing schedule with same jobId if deduplication key was provided
        if (key) {
            Storage.delete(SCHEDULE_TABLE, { jobId });
        }

        Storage.insert(SCHEDULE_TABLE, {
            jobId,
            handler: cleanHandler,
            payload: payload ?? {},
            runAt,
            intervalMs,
            createdAt: Date.now(),
            attempts: 0,
            maxRetries: Math.max(0, Number(maxRetries) || 0)
        });

        this.start();
        return jobId;
    }

    /**
     * Cancel and remove a scheduled job by its `jobId` (or custom `key`).
     * @param {string} jobId
     * @returns {boolean} True if a job was found and canceled.
     */
    static cancel(jobId) {
        if (!jobId) return false;
        this._inFlight.delete(jobId);
        return Storage.delete(SCHEDULE_TABLE, { jobId: String(jobId) }) > 0;
    }

    /**
     * Cancel all scheduled jobs matching a handler name and optional payload predicate.
     * @param {string} handlerName
     * @param {(payload: any, job: any) => boolean} [predicate]
     * @returns {number} Number of canceled jobs.
     */
    static cancelByHandler(handlerName, predicate) {
        const rows = Storage.select(SCHEDULE_TABLE, {
            where: { handler: String(handlerName) },
            flat: true
        });

        let canceled = 0;
        for (const row of rows) {
            if (!predicate || predicate(row.payload, row)) {
                this._inFlight.delete(row.jobId);
                canceled += Storage.delete(SCHEDULE_TABLE, row.id);
            }
        }
        return canceled;
    }

    /**
     * Retrieve details and remaining time (`remainingMs`) for a scheduled job.
     * @param {string} jobId
     * @returns {(object & { remainingMs: number }) | null}
     */
    static getJob(jobId) {
        const row = Storage.selectOne(SCHEDULE_TABLE, {
            where: { jobId: String(jobId) },
            flat: true
        });
        if (!row) return null;
        return {
            ...row,
            remainingMs: Math.max(0, row.runAt - Date.now())
        };
    }

    /**
     * List all active scheduled jobs sorted by next execution time (`runAt ASC`).
     * @param {string} [handlerName]
     * @returns {Array<object & { remainingMs: number }>}
     */
    static listJobs(handlerName) {
        const now = Date.now();
        const rows = Storage.select(SCHEDULE_TABLE, {
            where: handlerName ? { handler: String(handlerName) } : undefined,
            orderBy: { runAt: "ASC" },
            flat: true
        });

        return rows.map(r => ({
            ...r,
            remainingMs: Math.max(0, r.runAt - now)
        }));
    }

    /* =========================================================================
       3. TICK-BUDGETED CACHE AUTO-FLUSH & PLAYER LIFECYCLE SYNC
    ========================================================================= */

    /**
     * Enable periodic, tick-budgeted flushing of dirty `writeBehind` Cache entries.
     * Spreads scoreboard writes across ticks (`maxWritesPerTick`) to keep TPS smooth.
     *
     * @param {object} [options]
     * @param {number} [options.intervalTicks=40] - How often to run a flush pass (40 ticks = 2s).
     * @param {number} [options.maxWritesPerTick=5] - Maximum scoreboard writes per flush pass.
     * @param {string[] | null} [options.tables=null] - Specific Cache tables to flush, or null for all.
     * @param {boolean} [options.sweepTtl=true] - Also purge expired TTL cache entries during passes.
     */
    static enableCacheAutoFlush({
        intervalTicks = 40,
        maxWritesPerTick = 5,
        tables = null,
        sweepTtl = true
    } = {}) {
        this._cacheFlushConfig.enabled = true;
        this._cacheFlushConfig.intervalTicks = Math.max(1, Number(intervalTicks) || 40);
        this._cacheFlushConfig.maxWritesPerTick = Math.max(1, Number(maxWritesPerTick) || 5);
        this._cacheFlushConfig.tables = Array.isArray(tables) ? [...tables] : null;
        this._cacheFlushConfig.sweepTtl = sweepTtl !== false;
        this._cacheFlushConfig._tickCounter = 0;

        this.start();
        return this;
    }

    /**
     * Disable automatic background Cache flushing.
     */
    static disableCacheAutoFlush() {
        this._cacheFlushConfig.enabled = false;
    }

    /**
     * Automatically flush (and optionally evict) a player's cached record when they leave the server.
     * Prevents losing un-flushed `writeBehind` data on disconnect while freeing RAM.
     *
     * @param {string} table - Registered Cache table name (e.g. "players").
     * @param {string} [keyField="uuid"] - Indexed field matching `player.id` (e.g. "uuid").
     * @param {object} [options]
     * @param {boolean} [options.flush=true] - Persist dirty changes to Storage immediately on leave.
     * @param {boolean} [options.evict=true] - Remove player record from RAM cache on leave.
     */
    static bindPlayerLeave(table, keyField = "uuid", { flush = true, evict = true } = {}) {
        this._playerBindings.set(table, {
            keyField,
            flush: flush !== false,
            evict: evict !== false
        });

        if (!this._playerLeaveHooked && world.afterEvents?.playerLeave) {
            this._playerLeaveHooked = true;
            world.afterEvents.playerLeave.subscribe((ev) => {
                if (!ev.playerId) return;
                this._handlePlayerLeave(ev.playerId);
            });
        }

        return this;
    }

    static _handlePlayerLeave(playerId) {
        for (const [table, cfg] of this._playerBindings.entries()) {
            const store = Cache._tables.get(table);
            if (!store) continue;

            // Locate matching record in cache (uses O(1) index if available, else scans cache)
            let matchedId = null;
            const fieldMap = store.indexMaps.get(cfg.keyField);
            if (fieldMap && fieldMap.has(playerId)) {
                const first = fieldMap.get(playerId).values().next();
                if (!first.done) matchedId = first.value;
            } else {
                for (const [id, entry] of store.records.entries()) {
                    const val = cfg.keyField === "id" ? id : Storage._getNestedValue(entry.data, cfg.keyField);
                    if (val === playerId) {
                        matchedId = id;
                        break;
                    }
                }
            }

            if (matchedId === null) continue;

            const entry = store.records.get(matchedId);
            if (!entry) continue;

            if (cfg.flush && entry.dirty) {
                entry.dirty = false;
                Storage.update(table, matchedId, entry.data);
                Cache._stats.flushes++;
                this._stats.cacheRowsFlushed++;
            }

            if (cfg.evict) {
                Cache.evict(table, matchedId, false);
            }
        }
    }

    /* =========================================================================
       4. SCHEDULER LOOP & EXECUTION ENGINE
    ========================================================================= */

    /**
     * Start (or configure) the background scheduler tick loop.
     * @param {object} [options]
     * @param {number} [options.pollIntervalTicks=20] - Tick interval for checking due schedules.
     * @param {number} [options.maxJobsPerTick=5] - Max persistent jobs executed per poll pass.
     */
    static start({ pollIntervalTicks, maxJobsPerTick } = {}) {
        if (typeof pollIntervalTicks === "number") {
            this._pollIntervalTicks = Math.max(1, pollIntervalTicks);
        }
        if (typeof maxJobsPerTick === "number") {
            this._maxJobsPerTick = Math.max(1, maxJobsPerTick);
        }

        if (this._loopId !== null) return this;

        let scheduleTickCounter = 0;

        this._loopId = system.runInterval(() => {
            // 1. Poll due persistent timers
            scheduleTickCounter++;
            if (scheduleTickCounter >= this._pollIntervalTicks) {
                scheduleTickCounter = 0;
                this._processDueJobs();
            }

            // 2. Tick-budgeted Cache auto-flush
            if (this._cacheFlushConfig.enabled) {
                this._cacheFlushConfig._tickCounter++;
                if (this._cacheFlushConfig._tickCounter >= this._cacheFlushConfig.intervalTicks) {
                    this._cacheFlushConfig._tickCounter = 0;
                    this._flushCacheBudgeted();
                }
            }
        }, 1);

        return this;
    }

    /**
     * Stop the background scheduler loop.
     */
    static stop() {
        if (this._loopId !== null) {
            system.clearRun(this._loopId);
            this._loopId = null;
        }
    }

    /**
     * Manually trigger an immediate scheduler & cache-flush pass (useful in tests or shutdown).
     */
    static tickNow() {
        this._processDueJobs();
        if (this._cacheFlushConfig.enabled) {
            this._flushCacheBudgeted();
        }
    }

    /**
     * Execute due persistent jobs up to `_maxJobsPerTick`.
     * @param {string} [onlyHandler] - Optionally filter by a single handler name.
     */
    static _processDueJobs(onlyHandler) {
        const now = Date.now();
        const dueJobs = Storage.select(SCHEDULE_TABLE, {
            where: (row) => {
                if (row.runAt > now) return false;
                if (onlyHandler && row.handler !== onlyHandler) return false;
                if (!this._handlers.has(row.handler)) return false;
                if (this._inFlight.has(row.jobId)) return false;
                return true;
            },
            orderBy: { runAt: "ASC" },
            limit: this._maxJobsPerTick,
            flat: true
        });

        for (const job of dueJobs) {
            const handlerFn = this._handlers.get(job.handler);
            if (!handlerFn) continue;

            this._inFlight.add(job.jobId);
            try {
                handlerFn(Storage._clone(job.payload), {
                    jobId: job.jobId,
                    handler: job.handler,
                    runAt: job.runAt,
                    intervalMs: job.intervalMs ?? null,
                    attempts: job.attempts ?? 0
                });

                this._stats.jobsExecuted++;

                if (typeof job.intervalMs === "number" && job.intervalMs > 0) {
                    // Reschedule recurring timer cleanly
                    Storage.update(SCHEDULE_TABLE, job.id, {
                        runAt: Date.now() + job.intervalMs,
                        attempts: 0
                    });
                } else {
                    // One-shot job completed -> delete from persistent store
                    Storage.delete(SCHEDULE_TABLE, job.id);
                }
            } catch (err) {
                this._stats.jobsFailed++;
                const nextAttempts = (job.attempts ?? 0) + 1;
                const maxRetries = job.maxRetries ?? 0;

                if (nextAttempts <= maxRetries) {
                    // Exponential backoff retry (1s, 2s, 4s...)
                    const backoffMs = Math.min(30_000, 1000 * Math.pow(2, nextAttempts - 1));
                    Storage.update(SCHEDULE_TABLE, job.id, {
                        attempts: nextAttempts,
                        runAt: Date.now() + backoffMs
                    });
                } else {
                    console.warn(`[SQLScheduler] Job '${job.jobId}' (${job.handler}) failed: ${err.message}`);
                    Storage.delete(SCHEDULE_TABLE, job.id);
                }
            } finally {
                this._inFlight.delete(job.jobId);
            }
        }
    }

    /**
     * Flush at most `maxWritesPerTick` dirty Cache entries across registered tables.
     */
    static _flushCacheBudgeted() {
        const budget = this._cacheFlushConfig.maxWritesPerTick;
        const allowedTables = this._cacheFlushConfig.tables
            ? new Set(this._cacheFlushConfig.tables)
            : null;

        let written = 0;

        for (const [tableName, store] of Cache._tables.entries()) {
            if (allowedTables && !allowedTables.has(tableName)) continue;

            for (const [id, entry] of store.records.entries()) {
                if (written >= budget) break;
                if (entry.dirty) {
                    entry.dirty = false;
                    Storage.update(tableName, id, entry.data);
                    written++;
                    this._stats.cacheRowsFlushed++;
                }
            }
            if (written >= budget) break;
        }

        if (written > 0) {
            Cache._stats.flushes++;
        }

        if (this._cacheFlushConfig.sweepTtl) {
            Cache.sweep();
        }
    }

    /**
     * Return scheduler metrics and queue depth.
     */
    static stats() {
        return {
            running: this._loopId !== null,
            registeredHandlers: [...this._handlers.keys()],
            pendingJobs: Storage.count(SCHEDULE_TABLE),
            jobsExecuted: this._stats.jobsExecuted,
            jobsFailed: this._stats.jobsFailed,
            cacheAutoFlush: this._cacheFlushConfig.enabled,
            cacheRowsFlushed: this._stats.cacheRowsFlushed
        };
    }

    static _generateJobId() {
        return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
}
