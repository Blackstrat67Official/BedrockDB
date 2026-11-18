import { Storage } from "../Storage.js";
import { MCSQLDataType } from "../MCSQLDataType.js";
import { SQLJoinEngine } from "./SQLJoinEngine.js";
import { SQLParser } from "./SQLParser.js";

/**
 * SQLCompiler - AST-to-Storage Plan Builder & Execution Engine
 *
 * Resolves bound parameters, subqueries, virtual views, and MCSQLDataType function calls
 * (UUID(), NOW(), PLAYER_POS(), DISTANCE(), HAS_TAG(), SCORE(), UPPER(), etc.)
 * and compiles SQL ASTs into optimized Storage operations.
 */
export class SQLCompiler {
    /**
     * Evaluate a subquery AST for `IN (SELECT ...)`, `EXISTS (SELECT ...)`, or scalar `(SELECT ...)`.
     * @param {"list" | "exists" | "scalar"} mode
     * @param {object} subqueryAst
     * @param {any[] | Record<string, any>} params
     * @param {Set<string>} [visitedViews=new Set()]
     */
    static evaluateSubquery(mode, subqueryAst, params, visitedViews = new Set()) {
        const subPlan = this.buildPlan(subqueryAst, params, {}, visitedViews);
        const subRows = this.executeSelect(subPlan);

        if (mode === "exists") {
            return subRows.length > 0;
        }

        if (mode === "scalar") {
            if (subRows.length === 0) return null;
            if (subRows.length > 1) {
                throw new Error("[MCSQL] Scalar subquery returned more than 1 row.");
            }
            const keys = Object.keys(subRows[0]);
            if (keys.length !== 1) {
                throw new SyntaxError("[MCSQL] Scalar subquery must project exactly 1 column.");
            }
            return subRows[0][keys[0]];
        }

        // mode === "list" for IN (SELECT ...)
        if (subRows.length === 0) return [];
        const keys = Object.keys(subRows[0]);
        if (keys.length !== 1) {
            throw new SyntaxError("[MCSQL] Subquery inside IN (...) must project exactly 1 column.");
        }
        const colKey = keys[0];
        return subRows.map(r => r[colKey]);
    }

    /**
     * Materialize a Virtual SQL View into an array of row objects.
     * Detects circular view definitions automatically.
     * @param {string} viewName
     * @param {Set<string>} [visitedViews=new Set()]
     * @returns {any[] | null} Materialized rows if `viewName` is a view, or `null` if it's a physical table.
     */
    static resolveViewRows(viewName, visitedViews = new Set()) {
        const viewDef = Storage.getView(viewName);
        if (!viewDef) return null;

        if (visitedViews.has(viewName)) {
            throw new Error(`[MCSQL] Circular view dependency detected while resolving view '${viewName}'.`);
        }

        const nextVisited = new Set(visitedViews);
        nextVisited.add(viewName);

        const viewAst = SQLParser.parse(viewDef.sql);
        const viewPlan = this.buildPlan(viewAst, [], {}, nextVisited);
        return this.executeSelect(viewPlan);
    }

    /**
     * Resolve a value AST node into a concrete JavaScript value.
     * Supports literals, bound parameters, scalar subqueries, MCSQLDataType function calls, and row column references.
     */
    static resolveValue(node, params, rowContext = null, tableAlias = null, visitedViews = new Set()) {
        if (node === null || node === undefined || typeof node !== "object" || !node.kind) {
            return node;
        }

        switch (node.kind) {
            case "literal":
                return node.value;

            case "scalarSubquery":
                return this.evaluateSubquery("scalar", node.subquery, params, visitedViews);

            case "columnRef": {
                if (!rowContext) {
                    throw new SyntaxError(`[MCSQL] Column reference '${node.name}' cannot be used without a table row context.`);
                }
                const col = tableAlias && node.name.startsWith(`${tableAlias}.`)
                    ? node.name.slice(tableAlias.length + 1)
                    : node.name;
                return col === "id" ? rowContext.id : Storage._getNestedValue(rowContext, col);
            }

            case "fnCall": {
                const resolvedArgs = node.args.map(arg =>
                    this.resolveValue(arg, params, rowContext, tableAlias, visitedViews)
                );
                return MCSQLDataType.evaluate(node.fn, resolvedArgs, { row: rowContext, params });
            }

            case "negParam": {
                const v = this.resolveValue(node.param, params, rowContext, tableAlias, visitedViews);
                if (typeof v !== "number") throw new TypeError("[MCSQL] Unary '-' requires a numeric parameter.");
                return -v;
            }

            case "param": {
                if (node.mode === "indexed") {
                    if (!Array.isArray(params) || node.index >= params.length) {
                        throw new RangeError(`[MCSQL] Missing positional parameter #${node.index + 1}.`);
                    }
                    return params[node.index];
                }
                if (typeof params !== "object" || params === null || !(node.name in params)) {
                    throw new RangeError(`[MCSQL] Missing named parameter ':${node.name}'.`);
                }
                return params[node.name];
            }

            case "arrayLiteral":
                return node.items.map(item => this.resolveValue(item, params, rowContext, tableAlias, visitedViews));

            default:
                return node;
        }
    }

    /**
     * Evaluate a WHERE AST expression directly against a single row object `{ id, ...data }`.
     * Used for functional predicates (e.g. `WHERE DISTANCE(coords, PLAYER_POS('Steve')) <= 30`)
     * and for filtering rows returned by Virtual SQL Views.
     */
    static evalRowCondition(node, row, tableAlias, params, visitedViews = new Set()) {
        if (!node || node.kind === "all") return true;

        const cleanCol = (col) =>
            tableAlias && col && col.startsWith(`${tableAlias}.`) ? col.slice(tableAlias.length + 1) : col;

        const getColVal = (col) => {
            const c = cleanCol(col);
            return c === "id" ? row.id : Storage._getNestedValue(row, c);
        };

        switch (node.kind) {
            case "or":
                return node.terms.some(t => this.evalRowCondition(t, row, tableAlias, params, visitedViews));

            case "and":
                return node.terms.every(t => this.evalRowCondition(t, row, tableAlias, params, visitedViews));

            case "not":
                return !this.evalRowCondition(node.expr, row, tableAlias, params, visitedViews);

            case "existsSubquery": {
                const exists = this.evaluateSubquery("exists", node.subquery, params, visitedViews);
                return node.negated ? !exists : exists;
            }

            case "inSubquery": {
                const actual = node.lhs
                    ? this.resolveValue(node.lhs, params, row, tableAlias, visitedViews)
                    : getColVal(node.col);
                const values = this.evaluateSubquery("list", node.subquery, params, visitedViews);
                const hit = values.includes(actual);
                return node.negated ? !hit : hit;
            }

            case "isNull":
            case "exprIsNull": {
                const val = node.lhs
                    ? this.resolveValue(node.lhs, params, row, tableAlias, visitedViews)
                    : getColVal(node.col);
                const isNull = val === undefined || val === null;
                return node.isNot ? !isNull : isNull;
            }

            case "in":
            case "exprIn": {
                const actual = node.lhs
                    ? this.resolveValue(node.lhs, params, row, tableAlias, visitedViews)
                    : getColVal(node.col);
                let items = node.items.map(i => this.resolveValue(i, params, row, tableAlias, visitedViews));
                if (items.length === 1 && Array.isArray(items[0])) items = items[0];
                const hit = items.includes(actual);
                return node.negated ? !hit : hit;
            }

            case "between":
            case "exprBetween": {
                const actual = node.lhs
                    ? this.resolveValue(node.lhs, params, row, tableAlias, visitedViews)
                    : getColVal(node.col);
                const min = this.resolveValue(node.min, params, row, tableAlias, visitedViews);
                const max = this.resolveValue(node.max, params, row, tableAlias, visitedViews);
                const hit = actual !== undefined && actual !== null && min !== null && max !== null && actual >= min && actual <= max;
                return node.negated ? !hit : hit;
            }

            case "like":
            case "exprLike": {
                const actual = node.lhs
                    ? this.resolveValue(node.lhs, params, row, tableAlias, visitedViews)
                    : getColVal(node.col);
                const pattern = this.resolveValue(node.pattern, params, row, tableAlias, visitedViews);
                if (typeof actual !== "string" || typeof pattern !== "string") return Boolean(node.negated);
                const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const regexStr = "^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$";
                const hit = new RegExp(regexStr, "i").test(actual);
                return node.negated ? !hit : hit;
            }

            case "contains":
            case "exprContains": {
                const actual = node.lhs
                    ? this.resolveValue(node.lhs, params, row, tableAlias, visitedViews)
                    : getColVal(node.col);
                const target = this.resolveValue(node.target, params, row, tableAlias, visitedViews);
                const hit = (Array.isArray(actual) || typeof actual === "string") && actual.includes(target);
                return node.negated ? !hit : hit;
            }

            case "regexp":
            case "exprRegexp": {
                const actual = node.lhs
                    ? this.resolveValue(node.lhs, params, row, tableAlias, visitedViews)
                    : getColVal(node.col);
                const pattern = this.resolveValue(node.pattern, params, row, tableAlias, visitedViews);
                const rx = pattern instanceof RegExp ? pattern : new RegExp(pattern);
                const hit = typeof actual === "string" && rx.test(actual);
                return node.negated ? !hit : hit;
            }

            case "cmp":
            case "exprCmp": {
                const leftVal = node.lhs
                    ? this.resolveValue(node.lhs, params, row, tableAlias, visitedViews)
                    : getColVal(node.col);
                const rightVal = this.resolveValue(node.val, params, row, tableAlias, visitedViews);

                switch (node.op) {
                    case "=": return leftVal === rightVal;
                    case "!=": return leftVal !== rightVal;
                    case ">": return leftVal !== undefined && leftVal !== null && rightVal !== undefined && rightVal !== null && leftVal > rightVal;
                    case ">=": return leftVal !== undefined && leftVal !== null && rightVal !== undefined && rightVal !== null && leftVal >= rightVal;
                    case "<": return leftVal !== undefined && leftVal !== null && rightVal !== undefined && rightVal !== null && leftVal < rightVal;
                    case "<=": return leftVal !== undefined && leftVal !== null && rightVal !== undefined && rightVal !== null && leftVal <= rightVal;
                    default: return false;
                }
            }

            default:
                throw new Error(`[MCSQL] Unknown WHERE AST node '${node.kind}'.`);
        }
    }

    /**
     * Check whether a WHERE AST node requires per-row functional evaluation
     * (e.g., function call on LHS or row-dependent columnRef inside a function on RHS).
     */
    static _needsFunctionalWhere(node) {
        if (!node || typeof node !== "object") return false;
        if (
            node.kind === "exprCmp" ||
            node.kind === "exprIsNull" ||
            node.kind === "exprIn" ||
            node.kind === "exprBetween" ||
            node.kind === "exprLike" ||
            node.kind === "exprContains" ||
            node.kind === "exprRegexp"
        ) {
            return true;
        }
        if (node.kind === "cmp" && this._isDynamicRowExpr(node.val)) {
            return true;
        }
        if (Array.isArray(node.terms)) {
            return node.terms.some(t => this._needsFunctionalWhere(t));
        }
        if (node.expr) {
            return this._needsFunctionalWhere(node.expr);
        }
        return false;
    }

    /**
     * Compile SQL WHERE AST into a native Storage `where` object (or functional predicate / numeric ID).
     */
    static compileWhere(node, params, stripAlias = null, visitedViews = new Set()) {
        if (!node || node.kind === "all") return undefined;

        if (this._needsFunctionalWhere(node)) {
            return (data, id) => this.evalRowCondition(node, { id, ...data }, stripAlias, params, visitedViews);
        }

        const cleanCol = (col) => {
            if (stripAlias && col.startsWith(`${stripAlias}.`)) {
                return col.slice(stripAlias.length + 1);
            }
            return col;
        };

        switch (node.kind) {
            case "or":
                return { $or: node.terms.map(t => this.compileWhere(t, params, stripAlias, visitedViews)) };

            case "and":
                return { $and: node.terms.map(t => this.compileWhere(t, params, stripAlias, visitedViews)) };

            case "not":
                return { $not: this.compileWhere(node.expr, params, stripAlias, visitedViews) };

            case "existsSubquery": {
                const exists = this.evaluateSubquery("exists", node.subquery, params, visitedViews);
                const passes = node.negated ? !exists : exists;
                return passes ? {} : { id: -1 };
            }

            case "inSubquery": {
                const values = this.evaluateSubquery("list", node.subquery, params, visitedViews);
                return { [cleanCol(node.col)]: { [node.negated ? "$nin" : "$in"]: values } };
            }

            case "isNull":
                return { [cleanCol(node.col)]: { $exists: node.isNot } };

            case "in": {
                let resolved = node.items.map(item => this.resolveValue(item, params, null, null, visitedViews));
                if (resolved.length === 1 && Array.isArray(resolved[0])) {
                    resolved = resolved[0];
                }
                return { [cleanCol(node.col)]: { [node.negated ? "$nin" : "$in"]: resolved } };
            }

            case "between": {
                const min = this.resolveValue(node.min, params, null, null, visitedViews);
                const max = this.resolveValue(node.max, params, null, null, visitedViews);
                const expr = { [cleanCol(node.col)]: { $between: [min, max] } };
                return node.negated ? { $not: expr } : expr;
            }

            case "like": {
                const pattern = this.resolveValue(node.pattern, params, null, null, visitedViews);
                const expr = { [cleanCol(node.col)]: { $like: pattern } };
                return node.negated ? { $not: expr } : expr;
            }

            case "contains": {
                const target = this.resolveValue(node.target, params, null, null, visitedViews);
                const expr = { [cleanCol(node.col)]: { $contains: target } };
                return node.negated ? { $not: expr } : expr;
            }

            case "regexp": {
                const pattern = this.resolveValue(node.pattern, params, null, null, visitedViews);
                const expr = { [cleanCol(node.col)]: { $regex: pattern } };
                return node.negated ? { $not: expr } : expr;
            }

            case "cmp": {
                const col = cleanCol(node.col);
                const val = this.resolveValue(node.val, params, null, null, visitedViews);
                if (col === "id" && node.op === "=" && typeof val === "number") {
                    return val;
                }
                const opMap = {
                    "=": val,
                    "!=": { $ne: val },
                    ">": { $gt: val },
                    ">=": { $gte: val },
                    "<": { $lt: val },
                    "<=": { $lte: val }
                };
                return { [col]: opMap[node.op] };
            }

            default:
                throw new Error(`[MCSQL] Unknown WHERE AST node '${node.kind}'.`);
        }
    }

    /**
     * Set a value inside an object supporting dot-notation (e.g. "stats.kills").
     */
    static setNestedProperty(obj, path, value) {
        if (!path.includes(".")) {
            obj[path] = value;
            return;
        }
        const parts = path.split(".");
        let curr = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            if (typeof curr[key] !== "object" || curr[key] === null) {
                curr[key] = {};
            }
            curr = curr[key];
        }
        curr[parts[parts.length - 1]] = value;
    }

    /**
     * Check whether an AST node contains dynamic row-dependent references or functions.
     */
    static _isDynamicRowExpr(node) {
        if (!node || typeof node !== "object") return false;
        if (node.kind === "columnRef" || node.kind === "fnCall") return true;
        if (Array.isArray(node.args)) return node.args.some(a => this._isDynamicRowExpr(a));
        return false;
    }

    /**
     * Build a complete execution plan from an AST and bound parameters.
     */
    static buildPlan(ast, params, options = {}, visitedViews = new Set()) {
        switch (ast.type) {
            case "BEGIN":
            case "COMMIT":
            case "ROLLBACK":
                return {
                    type: ast.type,
                    table: "(transaction)",
                    previewCalls: [{ method: `SQLTransaction.${ast.type.toLowerCase()}`, args: [] }]
                };

            case "SAVEPOINT":
                return {
                    type: "SAVEPOINT",
                    name: ast.name,
                    table: "(transaction)",
                    previewCalls: [{ method: "SQLTransaction.savepoint", args: [ast.name] }]
                };

            case "ROLLBACK_TO":
                return {
                    type: "ROLLBACK_TO",
                    name: ast.name,
                    table: "(transaction)",
                    previewCalls: [{ method: "SQLTransaction.rollbackTo", args: [ast.name] }]
                };

            case "RELEASE_SAVEPOINT":
                return {
                    type: "RELEASE_SAVEPOINT",
                    name: ast.name,
                    table: "(transaction)",
                    previewCalls: [{ method: "SQLTransaction.releaseSavepoint", args: [ast.name] }]
                };

            case "CREATE_VIEW":
                return {
                    type: "CREATE_VIEW",
                    table: ast.viewName,
                    viewName: ast.viewName,
                    orReplace: ast.orReplace,
                    ifNotExists: ast.ifNotExists,
                    selectAst: ast.selectAst,
                    selectSql: ast.selectSql,
                    previewCalls: [{ method: "Storage.defineView", args: [ast.viewName, ast.selectSql] }]
                };

            case "DROP_VIEW":
                return {
                    type: "DROP_VIEW",
                    table: ast.viewName,
                    viewName: ast.viewName,
                    ifExists: ast.ifExists,
                    previewCalls: [{ method: "Storage.dropView", args: [ast.viewName] }]
                };

            case "CREATE_TABLE": {
                if (Storage.getView(ast.table)) {
                    throw new Error(`[MCSQL] Cannot create table '${ast.table}': a virtual VIEW with that name already exists.`);
                }
                let compiledSchema = null;
                if (ast.schema) {
                    const columns = {};
                    for (const [colName, colDef] of Object.entries(ast.schema.columns || {})) {
                        const resolvedCol = { ...colDef };
                        if (resolvedCol.hasDefault && resolvedCol.defaultNode) {
                            const node = resolvedCol.defaultNode;
                            delete resolvedCol.defaultNode;
                            if (node.kind === "fnCall") {
                                resolvedCol.defaultFn = node.fn;
                                resolvedCol.defaultArgs = node.args.map(a => this.resolveValue(a, params));
                            } else {
                                resolvedCol.default = this.resolveValue(node, params);
                            }
                        }
                        columns[colName] = resolvedCol;
                    }
                    compiledSchema = {
                        primaryKey: ast.schema.primaryKey,
                        columns,
                        unique: ast.schema.unique,
                        foreignKeys: ast.schema.foreignKeys
                    };
                }

                const previewCalls = [{ method: "Storage._getObjective", args: [ast.table, true] }];
                if (compiledSchema) {
                    previewCalls.push({ method: "Storage.defineSchema", args: [ast.table, compiledSchema] });
                }

                return {
                    type: "CREATE_TABLE",
                    table: ast.table,
                    ifNotExists: ast.ifNotExists,
                    schema: compiledSchema,
                    previewCalls
                };
            }

            case "ALTER_TABLE":
                if (Storage.getView(ast.table)) {
                    throw new Error(`[MCSQL] '${ast.table}' is a virtual VIEW and cannot be altered with ALTER TABLE.`);
                }
                return {
                    type: "ALTER_TABLE",
                    table: ast.table,
                    action: ast.action,
                    column: ast.column,
                    fk: ast.fk,
                    previewCalls: [{ method: "Storage.defineSchema", args: [ast.table, { action: ast.action }] }]
                };

            case "DROP_TABLE":
                if (Storage.getView(ast.table)) {
                    throw new Error(`[MCSQL] '${ast.table}' is a virtual VIEW. Use 'DROP VIEW ${ast.table}' instead.`);
                }
                return {
                    type: "DROP_TABLE",
                    table: ast.table,
                    ifExists: ast.ifExists,
                    previewCalls: [{ method: "Storage.drop", args: [ast.table] }]
                };

            case "TRUNCATE":
                if (Storage.getView(ast.table)) {
                    throw new Error(`[MCSQL] '${ast.table}' is a virtual VIEW and cannot be truncated.`);
                }
                return {
                    type: "TRUNCATE",
                    table: ast.table,
                    restartIdentity: ast.restartIdentity,
                    previewCalls: [{ method: "Storage.truncate", args: [ast.table, ast.restartIdentity] }]
                };

            case "INSERT": {
                if (Storage.getView(ast.table)) {
                    throw new Error(`[MCSQL] '${ast.table}' is a virtual VIEW and is read-only. Insert into its underlying table(s) instead.`);
                }
                let rows = [];
                if (ast.mode === "json") {
                    const parsed = this.resolveValue(ast.payloads[0], params, null, null, visitedViews);
                    const obj = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
                    rows = Array.isArray(obj) ? obj : [obj];
                } else {
                    for (const valNodes of ast.rows) {
                        const record = {};
                        for (let i = 0; i < ast.columns.length; i++) {
                            const val = this.resolveValue(valNodes[i], params, null, null, visitedViews);
                            this.setNestedProperty(record, ast.columns[i], val);
                        }
                        rows.push(record);
                    }
                }
                const method = rows.length === 1 ? "Storage.insert" : "Storage.insertMany";
                const args = rows.length === 1 ? [ast.table, rows[0]] : [ast.table, rows];
                return {
                    type: "INSERT",
                    table: ast.table,
                    rows,
                    previewCalls: [{ method, args }]
                };
            }

            case "UPDATE": {
                if (Storage.getView(ast.table)) {
                    throw new Error(`[MCSQL] '${ast.table}' is a virtual VIEW and is read-only. Update its underlying table(s) instead.`);
                }
                if (!ast.where && !options.allowUnsafeWrite) {
                    throw new Error("[MCSQL] Unsafe UPDATE blocked: missing WHERE clause. Add 'WHERE ALL' or pass { allowUnsafeWrite: true }.");
                }
                const where = this.compileWhere(ast.where, params, null, visitedViews);
                const needsFunctionalUpdater = ast.assignments.some(
                    a => a.col.includes(".") || (a.kind === "set" && this._isDynamicRowExpr(a.value))
                );

                let changes;
                if (!needsFunctionalUpdater) {
                    changes = {};
                    for (const item of ast.assignments) {
                        if (item.kind === "unset") {
                            if (!changes.$unset) changes.$unset = [];
                            changes.$unset.push(item.col);
                        } else if (item.kind === "inc") {
                            const rawDelta = this.resolveValue(item.delta, params);
                            if (typeof rawDelta !== "number") {
                                throw new TypeError(`[MCSQL] Increment on '${item.col}' requires a number.`);
                            }
                            if (!changes.$inc) changes.$inc = {};
                            changes.$inc[item.col] = item.op === "-" ? -rawDelta : rawDelta;
                        } else {
                            changes[item.col] = this.resolveValue(item.value, params);
                        }
                    }
                } else {
                    changes = (oldData) => {
                        const copy = Storage._clone(oldData);
                        for (const item of ast.assignments) {
                            if (item.kind === "unset") {
                                const parts = item.col.split(".");
                                const last = parts.pop();
                                const target = parts.reduce((acc, k) => acc?.[k], copy);
                                if (target && typeof target === "object") delete target[last];
                            } else if (item.kind === "inc") {
                                const rawDelta = this.resolveValue(item.delta, params, copy);
                                if (typeof rawDelta !== "number") {
                                    throw new TypeError(`[MCSQL] Increment on '${item.col}' requires a number.`);
                                }
                                const curr = Storage._getNestedValue(copy, item.col) || 0;
                                const delta = item.op === "-" ? -rawDelta : rawDelta;
                                this.setNestedProperty(copy, item.col, curr + delta);
                            } else {
                                const val = this.resolveValue(item.value, params, copy);
                                this.setNestedProperty(copy, item.col, val);
                            }
                        }
                        return copy;
                    };
                }

                return {
                    type: "UPDATE",
                    table: ast.table,
                    where,
                    changes,
                    previewCalls: [{ method: "Storage.update", args: [ast.table, where, changes] }]
                };
            }

            case "DELETE": {
                if (Storage.getView(ast.table)) {
                    throw new Error(`[MCSQL] '${ast.table}' is a virtual VIEW and is read-only. Delete from its underlying table(s) instead.`);
                }
                if (!ast.where && !options.allowUnsafeWrite) {
                    throw new Error("[MCSQL] Unsafe DELETE blocked: missing WHERE clause. Use 'TRUNCATE TABLE' or 'WHERE ALL'.");
                }
                const where = this.compileWhere(ast.where, params, null, visitedViews);
                return {
                    type: "DELETE",
                    table: ast.table,
                    where,
                    previewCalls: [{ method: "Storage.delete", args: [ast.table, where] }]
                };
            }

            case "SELECT": {
                // Dual-less SELECT (e.g., `SELECT UUID() AS id, NOW() AS ts, PLAYER_POS('Steve') AS pos`)
                if (!ast.table) {
                    const hasCols = ast.selectItems.some(i => i.kind === "column" || i.kind === "wildcard" || i.kind === "tableWildcard");
                    if (hasCols) {
                        throw new SyntaxError("[MCSQL] Selecting table columns requires a FROM <table> clause.");
                    }
                    return {
                        type: "SELECT",
                        mode: "dualless",
                        table: "(none)",
                        selectItems: ast.selectItems,
                        params,
                        visitedViews,
                        previewCalls: [{ method: "MCSQLDataType.evaluate", args: ast.selectItems.map(i => i.fn) }]
                    };
                }

                const limit = ast.limit !== null ? this.resolveValue(ast.limit, params, null, null, visitedViews) : undefined;
                const offset = ast.offset ? this.resolveValue(ast.offset, params, null, null, visitedViews) : 0;

                // Multi-table JOIN path (supports physical tables and virtual views seamlessly)
                if (ast.joins && ast.joins.length > 0) {
                    const baseViewRows = this.resolveViewRows(ast.table, visitedViews);
                    const resolvedJoins = ast.joins.map(j => ({
                        ...j,
                        preloadedRows: this.resolveViewRows(j.table, visitedViews)
                    }));

                    const previewCalls = [
                        {
                            method: baseViewRows ? "VIEW.materialize" : "Storage.select",
                            args: [ast.table, { flat: true }]
                        },
                        ...resolvedJoins.map(j => ({
                            method: `HASH_${j.joinType}_JOIN`,
                            args: [j.table, { alias: j.alias, isView: Boolean(j.preloadedRows) }]
                        }))
                    ];

                    return {
                        type: "SELECT",
                        mode: "join",
                        table: ast.table,
                        tableAlias: ast.tableAlias,
                        preloadedBaseRows: baseViewRows,
                        joins: resolvedJoins,
                        distinct: ast.distinct,
                        selectItems: ast.selectItems,
                        whereAst: ast.where,
                        groupBy: ast.groupBy,
                        orderBy: ast.orderBy,
                        limit,
                        offset,
                        params,
                        visitedViews,
                        previewCalls
                    };
                }

                // Check if target FROM source is a Virtual SQL View
                const viewRows = this.resolveViewRows(ast.table, visitedViews);
                if (viewRows !== null) {
                    return {
                        type: "SELECT",
                        mode: "view",
                        table: ast.table,
                        tableAlias: ast.tableAlias,
                        viewRows,
                        distinct: ast.distinct,
                        selectItems: ast.selectItems,
                        whereAst: ast.where,
                        groupBy: ast.groupBy,
                        orderBy: ast.orderBy,
                        limit,
                        offset,
                        params,
                        visitedViews,
                        previewCalls: [{ method: "VIEW.select", args: [ast.table] }]
                    };
                }

                // Single-table physical path
                const where = this.compileWhere(ast.where, params, ast.tableAlias, visitedViews);
                const stripAlias = (col) =>
                    col && col.startsWith(`${ast.tableAlias}.`) ? col.slice(ast.tableAlias.length + 1) : col;

                const hasAggregates = ast.selectItems.some(i => i.kind === "aggregate");
                const hasRegularCols = ast.selectItems.some(i => i.kind !== "aggregate");

                if (hasAggregates && hasRegularCols && !ast.groupBy) {
                    throw new SyntaxError("[MCSQL] Mixing aggregate functions with regular columns requires a GROUP BY clause.");
                }

                if (hasAggregates) {
                    const aggItems = ast.selectItems.filter(i => i.kind === "aggregate");
                    const groupColItem = ast.selectItems.find(i => i.kind === "column");
                    const cleanGroupBy = stripAlias(ast.groupBy);

                    const previewCalls = aggItems.map(agg => ({
                        method: "Storage.aggregate",
                        args: [
                            ast.table,
                            {
                                fn: agg.fn,
                                field: agg.field === "*" ? undefined : stripAlias(agg.field),
                                where,
                                groupBy: cleanGroupBy || undefined
                            }
                        ]
                    }));

                    return {
                        type: "SELECT",
                        mode: "aggregate",
                        table: ast.table,
                        aggItems: aggItems.map(a => ({ ...a, field: a.field === "*" ? "*" : stripAlias(a.field) })),
                        groupColAlias: groupColItem ? groupColItem.alias : cleanGroupBy,
                        groupBy: cleanGroupBy,
                        where,
                        orderBy: ast.orderBy.map(o => ({ field: stripAlias(o.field), dir: o.dir })),
                        limit,
                        offset,
                        previewCalls
                    };
                }

                const hasScalarFns = ast.selectItems.some(i => i.kind === "scalarFn");
                const hasWildcard = ast.selectItems.some(i => i.kind === "wildcard" || i.kind === "tableWildcard");

                if (hasWildcard && ast.selectItems.length > 1) {
                    throw new SyntaxError("[MCSQL] Cannot combine '*' with explicit column names on a single table.");
                }

                // If scalar functions (e.g., UPPER(name), UUID()) are present, fetch full rows and project per row
                if (hasScalarFns) {
                    const selectOptions = {
                        columns: "*",
                        where,
                        orderBy: ast.orderBy.length > 0
                            ? ast.orderBy.map(o => ({ field: stripAlias(o.field), dir: o.dir }))
                            : undefined,
                        limit,
                        offset,
                        distinct: false,
                        flat: true
                    };

                    return {
                        type: "SELECT",
                        mode: "standardWithFns",
                        table: ast.table,
                        tableAlias: ast.tableAlias,
                        selectItems: ast.selectItems,
                        selectOptions,
                        distinct: ast.distinct,
                        params,
                        previewCalls: [
                            { method: "Storage.select", args: [ast.table, selectOptions] },
                            { method: "MCSQLDataType.evaluate", args: ast.selectItems.filter(i => i.kind === "scalarFn").map(i => i.fn) }
                        ]
                    };
                }

                // Pure column / wildcard fast path
                let columns = "*";
                let requestedKeys = null;

                if (ast.selectItems[0].kind !== "wildcard") {
                    if (ast.selectItems[0].kind === "tableWildcard") {
                        if (ast.selectItems[0].alias !== ast.tableAlias) {
                            throw new ReferenceError(`[MCSQL] Unknown table alias '${ast.selectItems[0].alias}'.`);
                        }
                    } else {
                        columns = {};
                        requestedKeys = [];
                        for (const item of ast.selectItems) {
                            columns[item.alias] = stripAlias(item.col);
                            requestedKeys.push(item.alias);
                        }
                    }
                }

                const selectOptions = {
                    columns,
                    where,
                    orderBy: ast.orderBy.length > 0
                        ? ast.orderBy.map(o => ({ field: stripAlias(o.field), dir: o.dir }))
                        : undefined,
                    limit,
                    offset,
                    distinct: ast.distinct,
                    flat: true
                };

                return {
                    type: "SELECT",
                    mode: "standard",
                    table: ast.table,
                    selectOptions,
                    requestedKeys,
                    previewCalls: [{ method: "Storage.select", args: [ast.table, selectOptions] }]
                };
            }

            default:
                throw new Error(`[MCSQL] Unknown AST node '${ast.type}'.`);
        }
    }

    /**
     * Execute a compiled SELECT plan.
     */
    static executeSelect(plan) {
        if (plan.mode === "dualless") {
            const singleRow = {};
            for (const item of plan.selectItems) {
                const resolvedArgs = item.args.map(arg => this.resolveValue(arg, plan.params, null, null, plan.visitedViews));
                singleRow[item.alias] = MCSQLDataType.evaluate(item.fn, resolvedArgs, { params: plan.params });
            }
            return [singleRow];
        }

        if (plan.mode === "join") {
            return SQLJoinEngine.execute(plan);
        }

        if (plan.mode === "view") {
            return this._executeVirtualViewSelect(plan);
        }

        if (plan.mode === "standardWithFns") {
            const rawRows = Storage.select(plan.table, plan.selectOptions);
            const stripAlias = (col) =>
                col && col.startsWith(`${plan.tableAlias}.`) ? col.slice(plan.tableAlias.length + 1) : col;

            let rows = [];
            const seen = plan.distinct ? new Set() : null;

            for (const row of rawRows) {
                const projected = {};
                for (const item of plan.selectItems) {
                    if (item.kind === "scalarFn") {
                        const resolvedArgs = item.args.map(arg =>
                            this.resolveValue(arg, plan.params, row, plan.tableAlias)
                        );
                        projected[item.alias] = MCSQLDataType.evaluate(item.fn, resolvedArgs, {
                            row,
                            params: plan.params
                        });
                    } else {
                        const field = stripAlias(item.col);
                        projected[item.alias] = field === "id" ? row.id : Storage._getNestedValue(row, field);
                    }
                }

                if (plan.distinct) {
                    const sig = JSON.stringify(projected);
                    if (seen.has(sig)) continue;
                    seen.add(sig);
                }
                rows.push(projected);
            }
            return rows;
        }

        if (plan.mode === "standard") {
            const rawRows = Storage.select(plan.table, plan.selectOptions);

            if (plan.requestedKeys && !plan.requestedKeys.includes("id")) {
                return rawRows.map(row => {
                    const clean = {};
                    for (const key of plan.requestedKeys) {
                        clean[key] = row[key];
                    }
                    return clean;
                });
            }
            return rawRows;
        }

        // Single-table Aggregate execution
        if (!plan.groupBy) {
            const singleRow = {};
            for (const agg of plan.aggItems) {
                singleRow[agg.alias] = Storage.aggregate(plan.table, {
                    fn: agg.fn,
                    field: agg.field === "*" ? undefined : agg.field,
                    where: plan.where
                });
            }
            return [singleRow];
        }

        const groupMap = new Map();
        for (const agg of plan.aggItems) {
            const res = Storage.aggregate(plan.table, {
                fn: agg.fn,
                field: agg.field === "*" ? undefined : agg.field,
                where: plan.where,
                groupBy: plan.groupBy
            });

            for (const [groupKey, val] of Object.entries(res)) {
                if (!groupMap.has(groupKey)) {
                    groupMap.set(groupKey, { [plan.groupColAlias]: groupKey });
                }
                groupMap.get(groupKey)[agg.alias] = val;
            }
        }

        let rows = [...groupMap.values()];
        rows = SQLJoinEngine.applyOrderAndPagination(rows, plan.orderBy, plan.offset, plan.limit);
        return rows;
    }

    /**
     * Execute full SQL SELECT semantics (WHERE, GROUP BY, aggregates, scalar functions,
     * ORDER BY, DISTINCT, LIMIT, OFFSET) over rows materialized from a Virtual SQL View.
     */
    static _executeVirtualViewSelect(plan) {
        let rows = plan.viewRows.map(r => Storage._clone(r));
        const stripAlias = (col) =>
            col && col.startsWith(`${plan.tableAlias}.`) ? col.slice(plan.tableAlias.length + 1) : col;

        const getField = (row, col) => {
            const clean = stripAlias(col);
            return clean === "id" ? row.id : Storage._getNestedValue(row, clean);
        };

        if (plan.whereAst) {
            rows = rows.filter(row =>
                this.evalRowCondition(plan.whereAst, row, plan.tableAlias, plan.params, plan.visitedViews)
            );
        }

        const hasAggregates = plan.selectItems.some(i => i.kind === "aggregate");
        const hasRegularCols = plan.selectItems.some(i => i.kind !== "aggregate");

        if (hasAggregates && hasRegularCols && !plan.groupBy) {
            throw new SyntaxError("[MCSQL] Mixing aggregate functions with regular columns requires a GROUP BY clause.");
        }

        if (hasAggregates) {
            const aggItems = plan.selectItems.filter(i => i.kind === "aggregate");
            const groupColItem = plan.selectItems.find(i => i.kind === "column");

            const computeAggRow = (groupRows, groupKeyVal) => {
                const out = {};
                if (groupColItem) {
                    out[groupColItem.alias] = groupKeyVal;
                } else if (plan.groupBy) {
                    const cleanGroup = stripAlias(plan.groupBy);
                    out[cleanGroup] = groupKeyVal;
                }

                for (const agg of aggItems) {
                    if (agg.fn === "COUNT") {
                        if (agg.field === "*") {
                            out[agg.alias] = groupRows.length;
                        } else {
                            out[agg.alias] = groupRows.reduce((acc, r) => {
                                const v = getField(r, agg.field);
                                return v !== undefined && v !== null ? acc + 1 : acc;
                            }, 0);
                        }
                        continue;
                    }

                    const nums = groupRows
                        .map(r => getField(r, agg.field))
                        .filter(v => typeof v === "number" && !Number.isNaN(v));

                    if (nums.length === 0) out[agg.alias] = 0;
                    else if (agg.fn === "SUM") out[agg.alias] = nums.reduce((a, b) => a + b, 0);
                    else if (agg.fn === "AVG") out[agg.alias] = nums.reduce((a, b) => a + b, 0) / nums.length;
                    else if (agg.fn === "MIN") out[agg.alias] = Math.min(...nums);
                    else if (agg.fn === "MAX") out[agg.alias] = Math.max(...nums);
                }
                return out;
            };

            let aggRows;
            if (!plan.groupBy) {
                aggRows = [computeAggRow(rows, null)];
            } else {
                const groups = new Map();
                for (const r of rows) {
                    const gVal = getField(r, plan.groupBy) ?? null;
                    const key = JSON.stringify(gVal);
                    if (!groups.has(key)) groups.set(key, { val: gVal, list: [] });
                    groups.get(key).list.push(r);
                }
                aggRows = [...groups.values()].map(g => computeAggRow(g.list, g.val));
            }

            return SQLJoinEngine.applyOrderAndPagination(aggRows, plan.orderBy, plan.offset, plan.limit);
        }

        if (plan.orderBy && plan.orderBy.length > 0) {
            rows.sort((a, b) => {
                for (const { field, dir } of plan.orderBy) {
                    const mult = dir === "DESC" ? -1 : 1;
                    const valA = getField(a, field);
                    const valB = getField(b, field);
                    if (valA === valB) continue;
                    if (valA === undefined || valA === null) return 1;
                    if (valB === undefined || valB === null) return -1;
                    return valA < valB ? -1 * mult : 1 * mult;
                }
                return 0;
            });
        }

        let projectedRows = [];
        const seen = plan.distinct ? new Set() : null;

        for (const row of rows) {
            const outRow = {};
            for (const item of plan.selectItems) {
                if (item.kind === "wildcard") {
                    Object.assign(outRow, Storage._clone(row));
                } else if (item.kind === "tableWildcard") {
                    if (item.alias !== plan.tableAlias) {
                        throw new ReferenceError(`[MCSQL] Unknown table/view alias '${item.alias}'.`);
                    }
                    Object.assign(outRow, Storage._clone(row));
                } else if (item.kind === "scalarFn") {
                    const resolvedArgs = item.args.map(arg =>
                        this.resolveValue(arg, plan.params, row, plan.tableAlias, plan.visitedViews)
                    );
                    outRow[item.alias] = MCSQLDataType.evaluate(item.fn, resolvedArgs, {
                        row,
                        params: plan.params
                    });
                } else {
                    const val = getField(row, item.col);
                    outRow[item.alias] = val === undefined ? null : val;
                }
            }

            if (plan.distinct) {
                const sig = JSON.stringify(outRow);
                if (seen.has(sig)) continue;
                seen.add(sig);
            }
            projectedRows.push(outRow);
        }

        if (plan.offset > 0 || typeof plan.limit === "number") {
            const end = typeof plan.limit === "number" ? plan.offset + plan.limit : undefined;
            projectedRows = projectedRows.slice(plan.offset, end);
        }

        return projectedRows;
    }
}

// Wire subquery evaluator into SQLJoinEngine without circular imports
SQLJoinEngine.setSubqueryResolver((mode, subqueryAst, params) =>
    SQLCompiler.evaluateSubquery(mode, subqueryAst, params)
);
