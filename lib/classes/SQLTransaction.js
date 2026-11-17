import { world } from "@minecraft/server";
import { Storage } from "./Storage.js";
import { Cache } from "./Cache.js";
import { MCSQL } from "./MCSQL.js";

const SCHEMA_TABLE = "_db_schemas";

/**
 * SQLTransaction - Atomic Transaction & Savepoint Manager for BedrockDB
 *
 * Guarantees ACID-style atomicity across multiple scoreboard tables:
 * - Captures Copy-On-Write snapshots of every scoreboard objective before modification
 * - Automatically rolls back scoreboard participants, Storage internal maps,
 *   defined schemas, and Cache entries if any statement or constraint fails
 * - Supports nested transactions via automatic Savepoints
 * - Works programmatically (SQLTransaction.run / new SQLTransaction) and via SQL (BEGIN / COMMIT / ROLLBACK)
 */
export class SQLTransaction {
    /** @type {SQLTransaction | null} */
    static _active = null;

    constructor() {
        this._id = `tx_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        this._state = "idle"; // "idle" | "active" | "committed" | "rolled_back"
        /** @type {Map<string, { existed: boolean, entries: Array<{ raw: string, score: number }> }>} */
        this._baseSnapshots = new Map();
        /** @type {Array<{ name: string, snapshots: Map<string, { existed: boolean, entries: Array<{ raw: string, score: number }> }> }>} */
        this._savepoints = [];
        /** @type {Array<{ sql: string, params: any[] | Record<string, any> }>} */
        this._queue = [];
        this._logs = [];
    }

    /* =========================================================================
       STATIC API (SCOPED ATOMIC EXECUTION & GLOBAL SQL SESSION)
    ========================================================================= */

    /**
     * Check whether an atomic transaction is currently in progress.
     * @returns {boolean}
     */
    static isActive() {
        return this._active !== null && this._active._state === "active";
    }

    /**
     * Return the currently active transaction instance, if any.
     * @returns {SQLTransaction | null}
     */
    static current() {
        return this.isActive() ? this._active : null;
    }

    /**
     * Execute a function inside an atomic transaction.
     * - Automatically commits if the callback succeeds.
     * - Automatically rolls back ALL changes if any error or constraint violation occurs.
     * - Supports nesting via automatic savepoints if a transaction is already active.
     *
     * @template T
     * @param {(tx: SQLTransaction) => T} callback
     * @returns {T}
     */
    static run(callback) {
        if (typeof callback !== "function") {
            throw new TypeError("[SQLTransaction] run() requires a callback function.");
        }

        // Nested transaction -> isolate with an automatic savepoint
        if (this.isActive()) {
            const parentTx = this._active;
            const spName = `__nested_${parentTx._savepoints.length + 1}_${Date.now()}`;
            parentTx.savepoint(spName);
            try {
                const res = callback(parentTx);
                parentTx.releaseSavepoint(spName);
                return res;
            } catch (err) {
                parentTx.rollbackTo(spName);
                throw err;
            }
        }

        const tx = new SQLTransaction();
        tx.begin();
        try {
            const result = callback(tx);
            tx.commit();
            return result;
        } catch (err) {
            if (tx._state === "active") {
                tx.rollback();
            }
            throw err;
        }
    }

    /**
     * Start a global transaction (used by SQL `BEGIN` / `START TRANSACTION`).
     * @returns {SQLTransaction}
     */
    static begin() {
        if (this.isActive()) {
            throw new Error("[SQLTransaction] A transaction is already active. Use SAVEPOINT for nested checkpoints or COMMIT/ROLLBACK first.");
        }
        const tx = new SQLTransaction();
        return tx.begin();
    }

    /**
     * Commit the active global transaction (used by SQL `COMMIT`).
     */
    static commit() {
        if (!this.isActive()) {
            throw new Error("[SQLTransaction] No active transaction to COMMIT.");
        }
        return this._active.commit();
    }

    /**
     * Roll back the active global transaction (used by SQL `ROLLBACK`).
     */
    static rollback() {
        if (!this.isActive()) {
            throw new Error("[SQLTransaction] No active transaction to ROLLBACK.");
        }
        return this._active.rollback();
    }

    /**
     * Create a named savepoint inside the active transaction.
     * @param {string} name
     */
    static savepoint(name) {
        if (!this.isActive()) {
            throw new Error("[SQLTransaction] Cannot create SAVEPOINT outside of an active transaction.");
        }
        return this._active.savepoint(name);
    }

    /**
     * Roll back to a named savepoint inside the active transaction.
     * @param {string} name
     */
    static rollbackTo(name) {
        if (!this.isActive()) {
            throw new Error("[SQLTransaction] Cannot ROLLBACK TO SAVEPOINT outside of an active transaction.");
        }
        return this._active.rollbackTo(name);
    }

    /**
     * Release a named savepoint without rolling back.
     * @param {string} name
     */
    static releaseSavepoint(name) {
        if (!this.isActive()) {
            throw new Error("[SQLTransaction] Cannot RELEASE SAVEPOINT outside of an active transaction.");
        }
        return this._active.releaseSavepoint(name);
    }

    /* =========================================================================
       INSTANCE LIFECYCLE (BEGIN, SAVEPOINT, COMMIT, ROLLBACK, BATCH QUEUE)
    ========================================================================= */

    /**
     * Activate this transaction and start tracking all Storage mutations.
     * @returns {this}
     */
    begin() {
        if (this._state === "active") {
            throw new Error("[SQLTransaction] This transaction is already active.");
        }
        if (SQLTransaction.isActive() && SQLTransaction._active !== this) {
            throw new Error("[SQLTransaction] Another transaction is already active.");
        }
        this._state = "active";
        SQLTransaction._active = this;
        return this;
    }

    /**
     * Queue a SQL statement for batch atomic execution via `.execute()`.
     * @param {string} sql
     * @param {any[] | Record<string, any>} [params=[]]
     * @returns {this}
     */
    add(sql, params = []) {
        if (typeof sql !== "string" || sql.trim() === "") {
            throw new TypeError("[SQLTransaction] SQL statement must be a non-empty string.");
        }
        this._queue.push({ sql, params });
        return this;
    }

    /**
     * Execute a SQL statement immediately within this active transaction.
     * @param {string} sql
     * @param {any[] | Record<string, any>} [params=[]]
     * @returns {any}
     */
    query(sql, params = []) {
        if (this._state !== "active") {
            throw new Error("[SQLTransaction] Cannot call tx.query() on an inactive transaction. Call begin() or use add().execute().");
        }
        this._logs.push(sql);
        return MCSQL.query(sql, params);
    }

    /**
     * Execute a SELECT query inside this transaction and return the first row or null.
     * @param {string} sql
     * @param {any[] | Record<string, any>} [params=[]]
     */
    queryOne(sql, params = []) {
        if (this._state !== "active") {
            throw new Error("[SQLTransaction] Transaction is not active.");
        }
        return MCSQL.queryOne(sql, params);
    }

    /**
     * Execute a SELECT query inside this transaction and return a single scalar value.
     * @param {string} sql
     * @param {any[] | Record<string, any>} [params=[]]
     */
    scalar(sql, params = []) {
        if (this._state !== "active") {
            throw new Error("[SQLTransaction] Transaction is not active.");
        }
        return MCSQL.scalar(sql, params);
    }

    /**
     * Execute all queued SQL statements added with `.add()` atomically.
     * @returns {{ ok: true, executed: number, results: any[], tablesTouched: string[] }}
     */
    execute() {
        if (this._queue.length === 0) {
            return { ok: true, executed: 0, results: [], tablesTouched: [] };
        }

        const statements = [...this._queue];
        this._queue = [];

        return SQLTransaction.run((tx) => {
            const results = [];
            for (const item of statements) {
                results.push(tx.query(item.sql, item.params));
            }
            return {
                ok: true,
                executed: results.length,
                results,
                tablesTouched: [...tx._baseSnapshots.keys()].filter(t => t !== SCHEMA_TABLE)
            };
        });
    }

    /**
     * Create a savepoint checkpoint inside the active transaction.
     * @param {string} name
     * @returns {this}
     */
    savepoint(name) {
        if (this._state !== "active") {
            throw new Error("[SQLTransaction] Cannot create savepoint on an inactive transaction.");
        }
        const cleanName = String(name || "").trim();
        if (!cleanName) {
            throw new TypeError("[SQLTransaction] Savepoint name cannot be empty.");
        }

        // Remove existing savepoint with same name if re-declared (SQL standard)
        const existingIdx = this._savepoints.findIndex(sp => sp.name === cleanName);
        if (existingIdx !== -1) {
            this._savepoints.splice(existingIdx);
        }

        this._savepoints.push({
            name: cleanName,
            snapshots: new Map()
        });
        return this;
    }

    /**
     * Roll back all changes made after the named savepoint, keeping the transaction active.
     * @param {string} name
     * @returns {this}
     */
    rollbackTo(name) {
        if (this._state !== "active") {
            throw new Error("[SQLTransaction] Cannot rollback to savepoint on an inactive transaction.");
        }
        const idx = this._savepoints.findIndex(sp => sp.name === name);
        if (idx === -1) {
            throw new ReferenceError(`[SQLTransaction] Savepoint '${name}' does not exist.`);
        }

        // Restore snapshots from newest savepoint back down to target savepoint
        for (let i = this._savepoints.length - 1; i >= idx; i--) {
            const sp = this._savepoints[i];
            this._restoreSnapshots(sp.snapshots);
        }

        // Keep the target savepoint empty so future changes after rollbackTo are tracked cleanly
        this._savepoints.splice(idx + 1);
        this._savepoints[idx].snapshots.clear();
        return this;
    }

    /**
     * Release a savepoint (and any nested savepoints created after it).
     * @param {string} name
     * @returns {this}
     */
    releaseSavepoint(name) {
        if (this._state !== "active") {
            throw new Error("[SQLTransaction] Cannot release savepoint on an inactive transaction.");
        }
        const idx = this._savepoints.findIndex(sp => sp.name === name);
        if (idx === -1) {
            throw new ReferenceError(`[SQLTransaction] Savepoint '${name}' does not exist.`);
        }
        this._savepoints.splice(idx);
        return this;
    }

    /**
     * Commit all changes permanently and end the transaction.
     * @returns {{ ok: true, action: "COMMIT", tablesTouched: string[] }}
     */
    commit() {
        if (this._state !== "active") {
            throw new Error("[SQLTransaction] Cannot commit an inactive transaction.");
        }

        const tablesTouched = [...this._baseSnapshots.keys()].filter(t => t !== SCHEMA_TABLE);
        this._baseSnapshots.clear();
        this._savepoints = [];
        this._state = "committed";

        if (SQLTransaction._active === this) {
            SQLTransaction._active = null;
        }

        return { ok: true, action: "COMMIT", tablesTouched };
    }

    /**
     * Roll back all modifications made during this transaction and restore exact prior state.
     * @returns {{ ok: true, action: "ROLLBACK", tablesRestored: string[] }}
     */
    rollback() {
        if (this._state !== "active") {
            throw new Error("[SQLTransaction] Cannot rollback an inactive transaction.");
        }

        const tablesRestored = [...this._baseSnapshots.keys()].filter(t => t !== SCHEMA_TABLE);
        this._restoreSnapshots(this._baseSnapshots);

        this._baseSnapshots.clear();
        this._savepoints = [];
        this._state = "rolled_back";

        if (SQLTransaction._active === this) {
            SQLTransaction._active = null;
        }

        return { ok: true, action: "ROLLBACK", tablesRestored };
    }

    /* =========================================================================
       INTERNAL COPY-ON-WRITE SNAPSHOT & RESTORE ENGINE
    ========================================================================= */

    /**
     * Capture the pre-mutation state of a scoreboard objective (called by Storage._beforeWrite).
     * @param {string} table
     */
    static _captureTableSnapshot(table) {
        const tx = this._active;
        if (!tx || tx._state !== "active") return;

        // Capture in base transaction snapshot if not yet captured
        if (!tx._baseSnapshots.has(table)) {
            tx._baseSnapshots.set(table, this._readRawObjectiveSnapshot(table));
        }

        // Also capture in every active savepoint that hasn't snapshotted this table yet
        for (const sp of tx._savepoints) {
            if (!sp.snapshots.has(table)) {
                sp.snapshots.set(table, this._readRawObjectiveSnapshot(table));
            }
        }
    }

    /**
     * Read raw scoreboard participants & scores for a table.
     * @param {string} table
     * @returns {{ existed: boolean, entries: Array<{ raw: string, score: number }> }}
     */
    static _readRawObjectiveSnapshot(table) {
        const objective = world.scoreboard.getObjective(table);
        if (!objective) {
            return { existed: false, entries: [] };
        }

        const entries = [];
        for (const p of objective.getParticipants()) {
            const score = objective.getScore(p);
            if (typeof score === "number") {
                entries.push({ raw: p.displayName, score });
            }
        }

        return { existed: true, entries };
    }

    /**
     * Restore a set of table snapshots back to Minecraft's scoreboard, Storage, and Cache.
     * @param {Map<string, { existed: boolean, entries: Array<{ raw: string, score: number }> }>} snapshotMap
     */
    _restoreSnapshots(snapshotMap) {
        let schemaTouched = false;

        for (const [table, snap] of snapshotMap.entries()) {
            if (table === SCHEMA_TABLE) schemaTouched = true;

            const existingObj = world.scoreboard.getObjective(table);

            if (!snap.existed) {
                if (existingObj) {
                    try {
                        world.scoreboard.removeObjective(table);
                    } catch {
                        // Fallback: strip all participants if objective removal fails
                        for (const p of existingObj.getParticipants()) {
                            existingObj.removeParticipant(p);
                        }
                    }
                }
                Storage._cache.delete(table);
                if (typeof Cache.clearTable === "function") {
                    Cache.clearTable(table);
                }
                continue;
            }

            const obj = existingObj ?? world.scoreboard.addObjective(table, table);
            for (const p of obj.getParticipants()) {
                obj.removeParticipant(p);
            }
            for (const entry of snap.entries) {
                obj.setScore(entry.raw, entry.score);
            }

            // Re-sync Storage's internal map and Cache layer
            Storage.sync(table);
            if (typeof Cache.syncFromStorage === "function") {
                Cache.syncFromStorage(table);
            }
        }

        if (schemaTouched && typeof Storage._reloadSchemas === "function") {
            Storage._reloadSchemas();
        }
    }
}

// Register Copy-On-Write hook on Storage without circular imports
if (typeof Storage.setBeforeWriteHook === "function") {
    Storage.setBeforeWriteHook((table) => {
        SQLTransaction._captureTableSnapshot(table);
    });
}
