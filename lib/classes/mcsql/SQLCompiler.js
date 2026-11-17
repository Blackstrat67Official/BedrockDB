import { Storage } from "../Storage.js";
import { MCSQLDataType } from "../MCSQLDataType.js";
import { SQLJoinEngine } from "./SQLJoinEngine.js";

/**
 * SQLCompiler - AST-to-Storage Plan Builder & Execution Engine
 *
 * Resolves bound parameters and MCSQLDataType function calls (UUID(), NOW(), UPPER(), etc.)
 * and compiles SQL ASTs into optimized Storage operations.
 */
export class SQLCompiler {
    /**
     * Resolve a value AST node into a concrete JavaScript value.
     * Supports literals, bound parameters, MCSQLDataType function calls, and row column references.
     */
    static resolveValue(node, params, rowContext = null, tableAlias = null) {
        if (node === null || node === undefined || typeof node !== "object" || !node.kind) {
            return node;
        }

        switch (node.kind) {
            case "literal":
                return node.value;

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
                    this.resolveValue(arg, params, rowContext, tableAlias)
                );
                return MCSQLDataType.evaluate(node.fn, resolvedArgs, { row: rowContext, params });
            }

            case "negParam": {
                const v = this.resolveValue(node.param, params, rowContext, tableAlias);
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
                return node.items.map(item => this.resolveValue(item, params, rowContext, tableAlias));

            default:
                return node;
        }
    }

    /**
     * Compile SQL WHERE AST into a native Storage `where` object (or numeric ID fast-path).
     */
    static compileWhere(node, params, stripAlias = null) {
        if (!node || node.kind === "all") return undefined;

        const cleanCol = (col) => {
            if (stripAlias && col.startsWith(`${stripAlias}.`)) {
                return col.slice(stripAlias.length + 1);
            }
            return col;
        };

        switch (node.kind) {
            case "or":
                return { $or: node.terms.map(t => this.compileWhere(t, params, stripAlias)) };

            case "and":
                return { $and: node.terms.map(t => this.compileWhere(t, params, stripAlias)) };

            case "not":
                return { $not: this.compileWhere(node.expr, params, stripAlias) };

            case "isNull":
                return { [cleanCol(node.col)]: { $exists: node.isNot } };

            case "in": {
                let resolved = node.items.map(item => this.resolveValue(item, params));
                if (resolved.length === 1 && Array.isArray(resolved[0])) {
                    resolved = resolved[0];
                }
                return { [cleanCol(node.col)]: { [node.negated ? "$nin" : "$in"]: resolved } };
            }

            case "between": {
                const min = this.resolveValue(node.min, params);
                const max = this.resolveValue(node.max, params);
                const expr = { [cleanCol(node.col)]: { $between: [min, max] } };
                return node.negated ? { $not: expr } : expr;
            }

            case "like": {
                const pattern = this.resolveValue(node.pattern, params);
                const expr = { [cleanCol(node.col)]: { $like: pattern } };
                return node.negated ? { $not: expr } : expr;
            }

            case "contains": {
                const target = this.resolveValue(node.target, params);
                const expr = { [cleanCol(node.col)]: { $contains: target } };
                return node.negated ? { $not: expr } : expr;
            }

            case "regexp": {
                const pattern = this.resolveValue(node.pattern, params);
                const expr = { [cleanCol(node.col)]: { $regex: pattern } };
                return node.negated ? { $not: expr } : expr;
            }

            case "cmp": {
                const col = cleanCol(node.col);
                const val = this.resolveValue(node.val, params);
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
    static buildPlan(ast, params, options = {}) {
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

            case "CREATE_TABLE": {
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
                return {
                    type: "ALTER_TABLE",
                    table: ast.table,
                    action: ast.action,
                    column: ast.column,
                    fk: ast.fk,
                    previewCalls: [{ method: "Storage.defineSchema", args: [ast.table, { action: ast.action }] }]
                };

            case "DROP_TABLE":
                return {
                    type: "DROP_TABLE",
                    table: ast.table,
                    ifExists: ast.ifExists,
                    previewCalls: [{ method: "Storage.drop", args: [ast.table] }]
                };

            case "TRUNCATE":
                return {
                    type: "TRUNCATE",
                    table: ast.table,
                    restartIdentity: ast.restartIdentity,
                    previewCalls: [{ method: "Storage.truncate", args: [ast.table, ast.restartIdentity] }]
                };

            case "INSERT": {
                let rows = [];
                if (ast.mode === "json") {
                    const parsed = this.resolveValue(ast.payloads[0], params);
                    const obj = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
                    rows = Array.isArray(obj) ? obj : [obj];
                } else {
                    for (const valNodes of ast.rows) {
                        const record = {};
                        for (let i = 0; i < ast.columns.length; i++) {
                            const val = this.resolveValue(valNodes[i], params);
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
                if (!ast.where && !options.allowUnsafeWrite) {
                    throw new Error("[MCSQL] Unsafe UPDATE blocked: missing WHERE clause. Add 'WHERE ALL' or pass { allowUnsafeWrite: true }.");
                }
                const where = this.compileWhere(ast.where, params);
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
                if (!ast.where && !options.allowUnsafeWrite) {
                    throw new Error("[MCSQL] Unsafe DELETE blocked: missing WHERE clause. Use 'TRUNCATE TABLE' or 'WHERE ALL'.");
                }
                const where = this.compileWhere(ast.where, params);
                return {
                    type: "DELETE",
                    table: ast.table,
                    where,
                    previewCalls: [{ method: "Storage.delete", args: [ast.table, where] }]
                };
            }

            case "SELECT": {
                // Dual-less SELECT (e.g., `SELECT UUID() AS id, NOW() AS ts`)
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
                        previewCalls: [{ method: "MCSQLDataType.evaluate", args: ast.selectItems.map(i => i.fn) }]
                    };
                }

                const limit = ast.limit !== null ? this.resolveValue(ast.limit, params) : undefined;
                const offset = ast.offset ? this.resolveValue(ast.offset, params) : 0;

                // Multi-table JOIN path
                if (ast.joins && ast.joins.length > 0) {
                    const previewCalls = [
                        { method: "Storage.select", args: [ast.table, { flat: true }] },
                        ...ast.joins.map(j => ({
                            method: `HASH_${j.joinType}_JOIN`,
                            args: [j.table, { alias: j.alias }]
                        }))
                    ];

                    return {
                        type: "SELECT",
                        mode: "join",
                        table: ast.table,
                        tableAlias: ast.tableAlias,
                        joins: ast.joins,
                        distinct: ast.distinct,
                        selectItems: ast.selectItems,
                        whereAst: ast.where,
                        groupBy: ast.groupBy,
                        orderBy: ast.orderBy,
                        limit,
                        offset,
                        params,
                        previewCalls
                    };
                }

                // Single-table path
                const where = this.compileWhere(ast.where, params, ast.tableAlias);
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
                const resolvedArgs = item.args.map(arg => this.resolveValue(arg, plan.params));
                singleRow[item.alias] = MCSQLDataType.evaluate(item.fn, resolvedArgs, { params: plan.params });
            }
            return [singleRow];
        }

        if (plan.mode === "join") {
            return SQLJoinEngine.execute(plan);
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
}
