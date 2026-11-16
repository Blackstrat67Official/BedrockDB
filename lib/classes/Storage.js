import { world } from "@minecraft/server";

const SEQ_KEY = "__seq__";

/**
 * Storage - SQL-like JSON Database Engine for Minecraft Bedrock Scoreboards
 *
 * Objective   -> Table
 * Participant -> JSON string (Serialized Row)
 * Score       -> Primary Key ID (Auto-Increment Integer >= 1)
 */
export class Storage {
    /** @type {Map<string, Map<number, { participant: import("@minecraft/server").ScoreboardIdentity | string, data: any }>>} */
    static _cache = new Map();

    /* =========================================================================
       INTERNAL UTILITIES & CACHE ENGINE
    ========================================================================= */

    /**
     * Validate table (objective) name and return or create the objective.
     * @param {string} table
     * @param {boolean} [createIfMissing=true]
     * @returns {import("@minecraft/server").ScoreboardObjective | null}
     */
    static _getObjective(table, createIfMissing = true) {
        if (typeof table !== "string" || table.trim() === "") {
            throw new TypeError(`[Storage] Invalid table name: '${table}'. Must be a non-empty string.`);
        }
        if (table.length > 16) {
            throw new RangeError(`[Storage] Table name '${table}' exceeds Minecraft's 16-character limit.`);
        }

        let objective = world.scoreboard.getObjective(table);
        if (!objective && createIfMissing) {
            try {
                objective = world.scoreboard.addObjective(table, table);
            } catch (err) {
                throw new Error(`[Storage] Failed to create table '${table}': ${err.message}`);
            }
        }
        return objective ?? null;
    }

    /**
     * Load or retrieve the in-memory table cache for fast zero-parse reads.
     * @param {string} table
     * @returns {Map<number, { participant: any, data: any }> | null}
     */
    static _getTableMap(table) {
        if (this._cache.has(table)) {
            return this._cache.get(table);
        }

        const objective = this._getObjective(table, false);
        if (!objective) return null;

        const map = new Map();
        for (const p of objective.getParticipants()) {
            const raw = p.displayName;
            if (raw === SEQ_KEY) continue;

            const parsed = this._parse(raw);
            if (parsed !== null) {
                const id = objective.getScore(p);
                if (typeof id === "number" && id >= 1) {
                    map.set(id, { participant: p, data: parsed });
                }
            }
        }

        this._cache.set(table, map);
        return map;
    }

    /**
     * Force cache synchronization with the world scoreboard (useful if /scoreboard commands were run).
     * @param {string} [table] - Specific table to sync, or omit to clear all caches.
     */
    static sync(table) {
        if (table) {
            this._cache.delete(table);
            this._getTableMap(table);
        } else {
            this._cache.clear();
        }
    }

    /**
     * Generate a strictly monotonic auto-increment ID persisted via __seq__.
     * @param {import("@minecraft/server").ScoreboardObjective} objective
     * @returns {number}
     */
    static _getNextId(objective) {
        let currentSeq = objective.getScore(SEQ_KEY);

        if (typeof currentSeq !== "number" || isNaN(currentSeq)) {
            let max = 0;
            for (const p of objective.getParticipants()) {
                if (p.displayName === SEQ_KEY) continue;
                const score = objective.getScore(p);
                if (typeof score === "number" && score > max) max = score;
            }
            currentSeq = max;
        }

        const nextId = currentSeq + 1;
        objective.setScore(SEQ_KEY, nextId);
        return nextId;
    }

    /**
     * Serialize data into JSON checking Minecraft's 32,767 char participant limit.
     * @param {any} data
     * @returns {string}
     */
    static _stringify(data) {
        if (data === undefined) {
            throw new TypeError("[Storage] Cannot store 'undefined' data.");
        }
        const json = JSON.stringify(data);
        if (json.length > 32767) {
            throw new RangeError(`[Storage] Record size (${json.length} chars) exceeds Minecraft's 32,767 char limit.`);
        }
        return json;
    }

    /**
     * Safely parse JSON string.
     * @param {string} json
     * @returns {any | null}
     */
    static _parse(json) {
        try {
            return JSON.parse(json);
        } catch {
            return null;
        }
    }

    /**
     * Resolve nested object paths using dot-notation (e.g., "stats.kills").
     * @param {any} obj
     * @param {string} path
     * @returns {any}
     */
    static _getNestedValue(obj, path) {
        if (obj === null || typeof obj !== "object") return undefined;
        if (path in obj) return obj[path];
        return path.split(".").reduce((acc, part) => (acc != null ? acc[part] : undefined), obj);
    }

    /* =========================================================================
       SQL QUERY ENGINE (WHERE, PROJECTION, ORDER BY)
    ========================================================================= */

    /**
     * Evaluate SQL-like WHERE conditions against a record.
     * Supports: ID number, callback (data, id) => boolean, or condition object with operators.
     * @param {any} data
     * @param {number} id
     * @param {number | function | object} [where]
     * @returns {boolean}
     */
    static _matchWhere(data, id, where) {
        if (where === undefined || where === null) return true;
        if (typeof where === "number") return id === where;
        if (typeof where === "function") return Boolean(where(data, id));
        if (typeof where !== "object") {
            throw new TypeError("[Storage] 'where' clause must be an object, function, number (ID), or omitted.");
        }

        for (const [key, condition] of Object.entries(where)) {
            if (key === "$and") {
                if (!Array.isArray(condition) || !condition.every(sub => this._matchWhere(data, id, sub))) {
                    return false;
                }
                continue;
            }
            if (key === "$or") {
                if (!Array.isArray(condition) || !condition.some(sub => this._matchWhere(data, id, sub))) {
                    return false;
                }
                continue;
            }
            if (key === "$not") {
                if (this._matchWhere(data, id, condition)) {
                    return false;
                }
                continue;
            }

            const actualValue = key === "id" ? id : this._getNestedValue(data, key);

            // Operator object (e.g., { $gte: 10, $lt: 50 })
            if (condition !== null && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof RegExp)) {
                const ops = Object.keys(condition);
                const isOperatorObj = ops.some(op => op.startsWith("$"));

                if (isOperatorObj) {
                    for (const [op, target] of Object.entries(condition)) {
                        switch (op) {
                            case "$eq":
                                if (actualValue !== target) return false;
                                break;
                            case "$ne":
                                if (actualValue === target) return false;
                                break;
                            case "$gt":
                                if (!(actualValue > target)) return false;
                                break;
                            case "$gte":
                                if (!(actualValue >= target)) return false;
                                break;
                            case "$lt":
                                if (!(actualValue < target)) return false;
                                break;
                            case "$lte":
                                if (!(actualValue <= target)) return false;
                                break;
                            case "$between":
                                if (!Array.isArray(target) || actualValue < target[0] || actualValue > target[1]) return false;
                                break;
                            case "$in":
                                if (!Array.isArray(target) || !target.includes(actualValue)) return false;
                                break;
                            case "$nin":
                                if (Array.isArray(target) && target.includes(actualValue)) return false;
                                break;
                            case "$contains":
                                if (Array.isArray(actualValue) || typeof actualValue === "string") {
                                    if (!actualValue.includes(target)) return false;
                                } else {
                                    return false;
                                }
                                break;
                            case "$like": {
                                if (typeof actualValue !== "string" || typeof target !== "string") return false;
                                const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                                const regexStr = "^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$";
                                if (!new RegExp(regexStr, "i").test(actualValue)) return false;
                                break;
                            }
                            case "$regex": {
                                const rx = target instanceof RegExp ? target : new RegExp(target);
                                if (typeof actualValue !== "string" || !rx.test(actualValue)) return false;
                                break;
                            }
                            case "$exists": {
                                const exists = actualValue !== undefined && actualValue !== null;
                                if (Boolean(target) !== exists) return false;
                                break;
                            }
                            default:
                                throw new Error(`[Storage] Unknown WHERE operator '${op}'.`);
                        }
                    }
                    continue;
                }
            }

            // Direct equality check
            if (actualValue !== condition) return false;
        }

        return true;
    }

    /**
     * Apply SQL SELECT column projection and aliasing.
     * @param {any} data
     * @param {number} id
     * @param {string | string[] | Record<string, string>} [columns]
     * @returns {any}
     */
    static _projectColumns(data, id, columns) {
        if (!columns || columns === "*") {
            return structuredClone ? structuredClone(data) : JSON.parse(JSON.stringify(data));
        }

        const projected = {};
        if (Array.isArray(columns)) {
            for (const col of columns) {
                if (col === "id") {
                    projected.id = id;
                } else {
                    const outKey = col.includes(".") ? col.split(".").pop() : col;
                    projected[outKey] = this._getNestedValue(data, col);
                }
            }
            return projected;
        }

        if (typeof columns === "object") {
            for (const [alias, sourcePath] of Object.entries(columns)) {
                projected[alias] = sourcePath === "id" ? id : this._getNestedValue(data, sourcePath);
            }
            return projected;
        }

        throw new TypeError("[Storage] 'columns' must be '*', an array of field names, or an alias map object.");
    }

    /**
     * Normalize orderBy parameter into an array of { field, dir } rules.
     * @param {string | Record<string, "ASC"|"DESC"> | Array<{field: string, dir?: "ASC"|"DESC"}>} orderBy
     * @returns {Array<{ field: string, dir: 1 | -1 }>}
     */
    static _normalizeOrderBy(orderBy) {
        if (!orderBy) return [];
        if (typeof orderBy === "string") {
            const [field, rawDir] = orderBy.trim().split(/\s+/);
            const dir = rawDir && rawDir.toUpperCase() === "DESC" ? -1 : 1;
            return [{ field, dir }];
        }
        if (Array.isArray(orderBy)) {
            return orderBy.map(item => ({
                field: item.field,
                dir: String(item.dir || "ASC").toUpperCase() === "DESC" ? -1 : 1
            }));
        }
        if (typeof orderBy === "object") {
            return Object.entries(orderBy).map(([field, rawDir]) => ({
                field,
                dir: String(rawDir).toUpperCase() === "DESC" ? -1 : 1
            }));
        }
        throw new TypeError("[Storage] Invalid 'orderBy' format.");
    }

    /* =========================================================================
       CREATE (INSERT)
    ========================================================================= */

    /**
     * Insert a single record into a table.
     * @param {string} table
     * @param {object} data
     * @returns {number} The assigned primary key ID.
     */
    static insert(table, data) {
        const objective = this._getObjective(table, true);
        const json = this._stringify(data);
        const id = this._getNextId(objective);

        objective.setScore(json, id);

        const map = this._getTableMap(table);
        if (map) {
            map.set(id, { participant: json, data: JSON.parse(json) });
        }

        return id;
    }

    /**
     * Insert multiple records in a single batch.
     * @param {string} table
     * @param {object[]} records
     * @returns {number[]} Array of assigned IDs.
     */
    static insertMany(table, records) {
        if (!Array.isArray(records)) {
            throw new TypeError("[Storage] 'records' must be an array.");
        }
        const objective = this._getObjective(table, true);
        const map = this._getTableMap(table);
        const ids = [];

        for (const item of records) {
            const json = this._stringify(item);
            const id = this._getNextId(objective);
            objective.setScore(json, id);
            if (map) {
                map.set(id, { participant: json, data: JSON.parse(json) });
            }
            ids.push(id);
        }

        return ids;
    }

    /* =========================================================================
       READ (SQL SELECT & AGGREGATIONS)
    ========================================================================= */

    /**
     * Fast O(1) lookup by primary key ID.
     * @param {string} table
     * @param {number} id
     * @returns {object | null}
     */
    static findById(table, id) {
        if (typeof id !== "number" || isNaN(id)) {
            throw new TypeError(`[Storage] ID must be a valid number, got ${typeof id}.`);
        }
        const map = this._getTableMap(table);
        if (!map || !map.has(id)) return null;
        return JSON.parse(JSON.stringify(map.get(id).data));
    }

    /**
     * SQL-like SELECT query across a table.
     *
     * @param {string} table - Table (objective) name.
     * @param {object | function} [options] - Query options or filter callback.
     * @param {string | string[] | Record<string, string>} [options.columns="*"] - Columns to return or alias map.
     * @param {object | function | number} [options.where] - Filter conditions, ID, or callback.
     * @param {string | object | Array} [options.orderBy] - Sort specification (e.g. { coins: "DESC" } or "level ASC").
     * @param {number} [options.limit] - Max records to return.
     * @param {number} [options.offset=0] - Number of records to skip.
     * @param {boolean} [options.distinct=false] - Deduplicate projected rows.
     * @param {boolean} [options.flat=false] - If true, returns `{ id, ...fields }` instead of `{ id, data }`.
     * @returns {Array<any>}
     */
    static select(table, options = {}) {
        const opts = typeof options === "function" ? { where: options } : (options ?? {});
        const {
            columns = "*",
            where,
            orderBy,
            limit,
            offset = 0,
            distinct = false,
            flat = false
        } = opts;

        const map = this._getTableMap(table);
        if (!map || map.size === 0) return [];

        // Fast-path when querying strictly by exact numeric ID
        let candidates = [];
        if (typeof where === "number") {
            const entry = map.get(where);
            if (entry) candidates.push({ id: where, data: entry.data });
        } else {
            for (const [id, entry] of map.entries()) {
                if (this._matchWhere(entry.data, id, where)) {
                    candidates.push({ id, data: entry.data });
                }
            }
        }

        // ORDER BY (applied before projection so you can sort by unprojected columns, just like real SQL)
        const sortRules = this._normalizeOrderBy(orderBy);
        if (sortRules.length > 0) {
            candidates.sort((a, b) => {
                for (const { field, dir } of sortRules) {
                    const valA = field === "id" ? a.id : this._getNestedValue(a.data, field);
                    const valB = field === "id" ? b.id : this._getNestedValue(b.data, field);
                    if (valA === valB) continue;
                    if (valA === undefined || valA === null) return 1;
                    if (valB === undefined || valB === null) return -1;
                    return valA < valB ? -1 * dir : 1 * dir;
                }
                return 0;
            });
        }

        // PROJECTION + DISTINCT
        let rows = [];
        const seen = distinct ? new Set() : null;

        for (const item of candidates) {
            const projected = this._projectColumns(item.data, item.id, columns);
            if (distinct) {
                const sig = JSON.stringify(projected);
                if (seen.has(sig)) continue;
                seen.add(sig);
            }
            rows.push(flat ? { id: item.id, ...projected } : { id: item.id, data: projected });
        }

        // OFFSET & LIMIT
        if (offset > 0 || typeof limit === "number") {
            const end = typeof limit === "number" ? offset + limit : undefined;
            rows = rows.slice(offset, end);
        }

        return rows;
    }

    /**
     * Retrieve the first matching record (SQL `SELECT ... LIMIT 1`).
     * @param {string} table
     * @param {object | function} [options]
     * @returns {any | null}
     */
    static selectOne(table, options = {}) {
        const opts = typeof options === "function" ? { where: options } : { ...options };
        opts.limit = 1;
        const res = this.select(table, opts);
        return res.length > 0 ? res[0] : null;
    }

    /**
     * Execute SQL aggregations (COUNT, SUM, AVG, MIN, MAX) with optional GROUP BY.
     * @param {string} table
     * @param {object} options
     * @param {"COUNT" | "SUM" | "AVG" | "MIN" | "MAX"} options.fn
     * @param {string} [options.field] - Field to aggregate (required for SUM, AVG, MIN, MAX).
     * @param {object | function} [options.where] - Filter before aggregation.
     * @param {string} [options.groupBy] - Optional field path to group results by.
     * @returns {number | Record<string, number>}
     */
    static aggregate(table, { fn, field, where, groupBy } = {}) {
        const operation = String(fn || "").toUpperCase();
        if (!["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(operation)) {
            throw new TypeError(`[Storage] Invalid aggregate function '${fn}'.`);
        }
        if (operation !== "COUNT" && !field) {
            throw new TypeError(`[Storage] 'field' is required for ${operation} aggregation.`);
        }

        const rows = this.select(table, { where });

        const compute = (groupRows) => {
            if (operation === "COUNT") return groupRows.length;
            const values = groupRows
                .map(r => (field === "id" ? r.id : this._getNestedValue(r.data, field)))
                .filter(v => typeof v === "number" && !isNaN(v));

            if (values.length === 0) return 0;
            if (operation === "SUM") return values.reduce((a, b) => a + b, 0);
            if (operation === "AVG") return values.reduce((a, b) => a + b, 0) / values.length;
            if (operation === "MIN") return Math.min(...values);
            if (operation === "MAX") return Math.max(...values);
            return 0;
        };

        if (!groupBy) {
            return compute(rows);
        }

        const groups = new Map();
        for (const row of rows) {
            const key = String(this._getNestedValue(row.data, groupBy) ?? "null");
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }

        const result = {};
        for (const [key, groupRows] of groups.entries()) {
            result[key] = compute(groupRows);
        }
        return result;
    }

    /* =========================================================================
       UPDATE & UPSERT
    ========================================================================= */

    /**
     * Apply partial fields, atomic modifiers ($inc, $push, $pull, $unset), or a transform callback.
     * @param {any} currentData
     * @param {object | function} changes
     * @returns {any}
     */
    static _applyChanges(currentData, changes) {
        if (typeof changes === "function") {
            return changes(JSON.parse(JSON.stringify(currentData)));
        }

        const updated = { ...currentData };
        for (const [key, val] of Object.entries(changes)) {
            if (key === "$inc" && typeof val === "object") {
                for (const [k, delta] of Object.entries(val)) {
                    updated[k] = (typeof updated[k] === "number" ? updated[k] : 0) + delta;
                }
            } else if (key === "$push" && typeof val === "object") {
                for (const [k, item] of Object.entries(val)) {
                    if (!Array.isArray(updated[k])) updated[k] = [];
                    updated[k].push(item);
                }
            } else if (key === "$pull" && typeof val === "object") {
                for (const [k, item] of Object.entries(val)) {
                    if (Array.isArray(updated[k])) {
                        updated[k] = updated[k].filter(el => el !== item);
                    }
                }
            } else if (key === "$unset" && Array.isArray(val)) {
                for (const k of val) {
                    delete updated[k];
                }
            } else {
                updated[key] = val;
            }
        }
        return updated;
    }

    /**
     * Update records matching `where` while preserving their primary key IDs.
     * @param {string} table
     * @param {number | object | function} where - ID, SQL query object, or callback.
     * @param {object | function} changes - Fields to merge, atomic modifiers ($inc, $push...), or callback.
     * @returns {number} Number of updated records.
     */
    static update(table, where, changes) {
        if (where === undefined) {
            throw new TypeError("[Storage] 'where' condition is required for update.");
        }
        if (changes === undefined) {
            throw new TypeError("[Storage] 'changes' must be provided for update.");
        }

        const objective = this._getObjective(table, false);
        const map = this._getTableMap(table);
        if (!objective || !map || map.size === 0) return 0;

        let updatedCount = 0;

        for (const [id, entry] of map.entries()) {
            if (this._matchWhere(entry.data, id, where)) {
                const nextData = this._applyChanges(entry.data, changes);
                const nextJson = this._stringify(nextData);

                objective.removeParticipant(entry.participant);
                objective.setScore(nextJson, id);

                map.set(id, { participant: nextJson, data: JSON.parse(nextJson) });
                updatedCount++;
            }
        }

        return updatedCount;
    }

    /**
     * Update matching record(s) if found, otherwise insert a new record.
     * @param {string} table
     * @param {object} where - Exact match criteria (also merged into inserted data if created).
     * @param {object} data - Data to update or insert.
     * @returns {{ action: "updated" | "inserted", count: number, id?: number }}
     */
    static upsert(table, where, data) {
        const updated = this.update(table, where, data);
        if (updated > 0) {
            return { action: "updated", count: updated };
        }
        const base = typeof where === "object" && where !== null ? where : {};
        const payload = typeof data === "function" ? data(base) : { ...base, ...data };
        const id = this.insert(table, payload);
        return { action: "inserted", count: 1, id };
    }

    /* =========================================================================
       DELETE & MAINTENANCE
    ========================================================================= */

    /**
     * Delete records matching `where` (ID, query object, or callback).
     * @param {string} table
     * @param {number | object | function} where
     * @returns {number} Number of deleted records.
     */
    static delete(table, where) {
        if (where === undefined) {
            throw new TypeError("[Storage] 'where' is required for delete. Use truncate() to clear all records.");
        }

        const objective = this._getObjective(table, false);
        const map = this._getTableMap(table);
        if (!objective || !map || map.size === 0) return 0;

        let deletedCount = 0;

        for (const [id, entry] of [...map.entries()]) {
            if (this._matchWhere(entry.data, id, where)) {
                objective.removeParticipant(entry.participant);
                map.delete(id);
                deletedCount++;
            }
        }

        return deletedCount;
    }

    /**
     * Remove all records from a table.
     * @param {string} table
     * @param {boolean} [resetAutoIncrement=false] - If true, resets the primary key sequence back to 1.
     */
    static truncate(table, resetAutoIncrement = false) {
        const objective = this._getObjective(table, false);
        if (!objective) return;

        for (const p of objective.getParticipants()) {
            if (!resetAutoIncrement && p.displayName === SEQ_KEY) continue;
            objective.removeParticipant(p);
        }

        this._cache.set(table, new Map());
    }

    /**
     * Completely remove the scoreboard objective (table) from the world.
     * @param {string} table
     * @returns {boolean}
     */
    static drop(table) {
        this._cache.delete(table);
        const objective = this._getObjective(table, false);
        if (!objective) return false;
        world.scoreboard.removeObjective(table);
        return true;
    }

    /* =========================================================================
       UTILITIES & FLUENT QUERY BUILDER
    ========================================================================= */

    /**
     * Check if at least one record matches `where` (or if the table has any records).
     * @param {string} table
     * @param {number | object | function} [where]
     * @returns {boolean}
     */
    static exists(table, where) {
        const map = this._getTableMap(table);
        if (!map || map.size === 0) return false;
        if (where === undefined) return true;
        if (typeof where === "number") return map.has(where);

        for (const [id, entry] of map.entries()) {
            if (this._matchWhere(entry.data, id, where)) return true;
        }
        return false;
    }

    /**
     * Count records matching `where` (or total records in the table).
     * @param {string} table
     * @param {number | object | function} [where]
     * @returns {number}
     */
    static count(table, where) {
        const map = this._getTableMap(table);
        if (!map || map.size === 0) return 0;
        if (where === undefined) return map.size;

        let total = 0;
        for (const [id, entry] of map.entries()) {
            if (this._matchWhere(entry.data, id, where)) total++;
        }
        return total;
    }

    /**
     * Start a fluent SQL-like query builder on a table.
     * @param {string} table
     * @returns {QueryBuilder}
     */
    static from(table) {
        return new QueryBuilder(table);
    }
}

/**
 * Chainable SQL Query Builder for Storage.
 */
class QueryBuilder {
    constructor(table) {
        this._table = table;
        this._options = {};
    }

    select(columns = "*") {
        this._options.columns = columns;
        return this;
    }

    where(condition) {
        this._options.where = condition;
        return this;
    }

    orderBy(field, dir = "ASC") {
        if (!this._options.orderBy) this._options.orderBy = [];
        this._options.orderBy.push({ field, dir });
        return this;
    }

    limit(count) {
        this._options.limit = count;
        return this;
    }

    offset(count) {
        this._options.offset = count;
        return this;
    }

    distinct(enabled = true) {
        this._options.distinct = enabled;
        return this;
    }

    flat(enabled = true) {
        this._options.flat = enabled;
        return this;
    }

    exec() {
        return Storage.select(this._table, this._options);
    }

    first() {
        return Storage.selectOne(this._table, this._options);
    }

    count() {
        return Storage.count(this._table, this._options.where);
    }

    exists() {
        return Storage.exists(this._table, this._options.where);
    }

    update(changes) {
        return Storage.update(this._table, this._options.where, changes);
    }

    delete() {
        return Storage.delete(this._table, this._options.where);
    }
}
