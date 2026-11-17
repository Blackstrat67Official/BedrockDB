import { Storage } from "./Storage.js";
import { SQLTokenizer } from "./mcsql/SQLTokenizer.js";
import { SQLParser } from "./mcsql/SQLParser.js";
import { SQLCompiler } from "./mcsql/SQLCompiler.js";

/**
 * MCSQL - Modular SQL Facade & Plan Cache for Minecraft Bedrock Storage
 *
 * Orchestrates SQLTokenizer, SQLParser, SQLCompiler, SQLJoinEngine,
 * and MCSQLDataType to execute SQL queries on scoreboard tables.
 */
export class MCSQL {
    /** @type {Map<string, CompiledQuery>} */
    static _planCache = new Map();
    static _maxPlanCache = 100;

    /**
     * Execute a SQL query against Storage.
     *
     * @param {string} sql - The SQL statement to execute.
     * @param {any[] | Record<string, any>} [params=[]] - Positional (?, $1) or named (:key) parameters.
     * @param {object} [options]
     * @param {boolean} [options.allowUnsafeWrite=false] - Allow UPDATE/DELETE without a WHERE clause.
     * @param {boolean} [options.cachePlan=true] - Cache the parsed AST for repeated queries.
     * @returns {any} Rows array for SELECT, metadata object for INSERT/UPDATE/DELETE/DDL.
     */
    static query(sql, params = [], options = {}) {
        const compiled = this.compile(sql, options.cachePlan !== false);
        return compiled.execute(params, options);
    }

    /**
     * Execute a SELECT query and return only the first row, or null if none matched.
     *
     * @param {string} sql
     * @param {any[] | Record<string, any>} [params=[]]
     * @returns {Record<string, any> | null}
     */
    static queryOne(sql, params = []) {
        const rows = this.query(sql, params);
        if (!Array.isArray(rows)) {
            throw new TypeError("[MCSQL] queryOne() can only be used with SELECT statements.");
        }
        return rows.length > 0 ? rows[0] : null;
    }

    /**
     * Execute a SELECT query and return a single scalar value (e.g. SELECT COUNT(*) FROM players).
     *
     * @param {string} sql
     * @param {any[] | Record<string, any>} [params=[]]
     * @returns {any}
     */
    static scalar(sql, params = []) {
        const row = this.queryOne(sql, params);
        if (!row) return null;
        const keys = Object.keys(row);
        return keys.length > 0 ? row[keys[0]] : null;
    }

    /**
     * Pre-compile a SQL statement into a reusable executable object.
     *
     * @param {string} sql
     * @param {boolean} [useCache=true]
     * @returns {CompiledQuery}
     */
    static compile(sql, useCache = true) {
        if (typeof sql !== "string" || sql.trim() === "") {
            throw new TypeError("[MCSQL] SQL query must be a non-empty string.");
        }

        if (useCache && this._planCache.has(sql)) {
            return this._planCache.get(sql);
        }

        const tokens = SQLTokenizer.tokenize(sql);
        const parser = new SQLParser(tokens, sql);
        const ast = parser.parseStatement();
        const compiled = new CompiledQuery(sql, ast);

        if (useCache) {
            if (this._planCache.size >= this._maxPlanCache) {
                const oldestKey = this._planCache.keys().next().value;
                this._planCache.delete(oldestKey);
            }
            this._planCache.set(sql, compiled);
        }

        return compiled;
    }

    /**
     * Inspect how MCSQL translates a SQL query into Storage calls without executing it.
     *
     * @param {string} sql
     * @param {any[] | Record<string, any>} [params=[]]
     * @returns {{ statement: string, table: string, storageCalls: Array<{ method: string, args: any[] }> }}
     */
    static explain(sql, params = []) {
        const compiled = this.compile(sql, false);
        return compiled.explain(params);
    }

    /**
     * Clear the internal compiled SQL plan cache.
     */
    static clearPlanCache() {
        this._planCache.clear();
    }
}

/**
 * Represents a pre-parsed SQL statement ready to bind parameters and execute against Storage.
 */
export class CompiledQuery {
    constructor(sql, ast) {
        this.sql = sql;
        this.ast = ast;
    }

    /**
     * Execute the compiled statement with bound parameters.
     * @param {any[] | Record<string, any>} [params=[]]
     * @param {object} [options={}]
     */
    execute(params = [], options = {}) {
        const plan = SQLCompiler.buildPlan(this.ast, params, options);

        switch (plan.type) {
            case "CREATE_TABLE": {
                const alreadyExists = Boolean(worldObjectiveExists(plan.table));
                if (alreadyExists && !plan.ifNotExists) {
                    throw new Error(`[MCSQL] Table '${plan.table}' already exists.`);
                }
                Storage._getObjective(plan.table, true);
                return { ok: true, table: plan.table, action: alreadyExists ? "exists" : "created" };
            }

            case "DROP_TABLE": {
                const dropped = Storage.drop(plan.table);
                if (!dropped && !plan.ifExists) {
                    throw new Error(`[MCSQL] Table '${plan.table}' does not exist.`);
                }
                return { ok: true, table: plan.table, dropped };
            }

            case "TRUNCATE": {
                Storage.truncate(plan.table, plan.restartIdentity);
                return { ok: true, table: plan.table, truncated: true };
            }

            case "INSERT": {
                if (plan.rows.length === 1) {
                    const id = Storage.insert(plan.table, plan.rows[0]);
                    return { affectedRows: 1, insertId: id, insertIds: [id] };
                }
                const ids = Storage.insertMany(plan.table, plan.rows);
                return { affectedRows: ids.length, insertId: ids[0] ?? null, insertIds: ids };
            }

            case "UPDATE": {
                const affectedRows = Storage.update(plan.table, plan.where, plan.changes);
                return { affectedRows };
            }

            case "DELETE": {
                const affectedRows = Storage.delete(plan.table, plan.where);
                return { affectedRows };
            }

            case "SELECT": {
                return SQLCompiler.executeSelect(plan);
            }

            default:
                throw new Error(`[MCSQL] Unsupported statement type '${plan.type}'.`);
        }
    }

    /**
     * Preview the Storage method calls generated for this SQL query.
     * @param {any[] | Record<string, any>} [params=[]]
     */
    explain(params = []) {
        const plan = SQLCompiler.buildPlan(this.ast, params, { allowUnsafeWrite: true });
        return {
            statement: plan.type,
            table: plan.table,
            storageCalls: plan.previewCalls
        };
    }
}

function worldObjectiveExists(table) {
    return Storage._getObjective(table, false) !== null;
}
