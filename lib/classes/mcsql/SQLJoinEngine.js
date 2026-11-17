import { Storage } from "../Storage.js";
import { MCSQLDataType } from "../MCSQLDataType.js";

/**
 * SQLJoinEngine - Multi-Table Hash Join & Projection Executor for MCSQL
 *
 * Handles INNER JOIN and LEFT [OUTER] JOIN across two or more scoreboard tables
 * in O(N + M) time using in-memory hash indexes.
 */
export class SQLJoinEngine {
    /**
     * Resolve a value node (literal, parameter, columnRef, or MCSQLDataType fnCall)
     * within a multi-table joined scope.
     */
    static resolveScopeValue(node, scope, activeAliases, params) {
        if (node === null || node === undefined || typeof node !== "object" || !node.kind) {
            return node;
        }

        switch (node.kind) {
            case "literal":
                return node.value;

            case "columnRef":
                return this.resolveScopeField(scope, node.name, activeAliases);

            case "fnCall": {
                const resolvedArgs = node.args.map(arg =>
                    this.resolveScopeValue(arg, scope, activeAliases, params)
                );
                return MCSQLDataType.evaluate(node.fn, resolvedArgs, { row: scope, params });
            }

            case "negParam": {
                const v = this.resolveScopeValue(node.param, scope, activeAliases, params);
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
                return node.items.map(item => this.resolveScopeValue(item, scope, activeAliases, params));

            default:
                return node;
        }
    }

    /**
     * Resolve a qualified (`p.name`, `h.x`, `p.stats.kills`) or unqualified (`coins`) column
     * against a joined row scope `{ [alias]: rowObject | null }`.
     */
    static resolveScopeField(scope, colRef, activeAliases) {
        const dotIdx = colRef.indexOf(".");
        if (dotIdx !== -1) {
            const prefix = colRef.slice(0, dotIdx);
            if (activeAliases.includes(prefix)) {
                const tableRow = scope[prefix];
                if (!tableRow) return undefined; // LEFT JOIN unmatched side -> NULL
                const fieldPath = colRef.slice(dotIdx + 1);
                return fieldPath === "id" ? tableRow.id : Storage._getNestedValue(tableRow, fieldPath);
            }
        }

        let foundVal = undefined;
        let matchCount = 0;

        for (const alias of activeAliases) {
            const tableRow = scope[alias];
            if (!tableRow) continue;
            const val = colRef === "id" ? tableRow.id : Storage._getNestedValue(tableRow, colRef);
            if (val !== undefined) {
                foundVal = val;
                matchCount++;
            }
        }

        if (matchCount > 1) {
            throw new Error(`[MCSQL] Ambiguous column '${colRef}' exists in multiple joined tables. Prefix it with a table alias (e.g. '${activeAliases[0]}.${colRef}').`);
        }

        return foundVal;
    }

    /**
     * Evaluate a WHERE or ON boolean AST against a joined row scope.
     */
    static evalScopeExpr(node, scope, activeAliases, params) {
        if (!node || node.kind === "all") return true;

        switch (node.kind) {
            case "or":
                return node.terms.some(t => this.evalScopeExpr(t, scope, activeAliases, params));

            case "and":
                return node.terms.every(t => this.evalScopeExpr(t, scope, activeAliases, params));

            case "not":
                return !this.evalScopeExpr(node.expr, scope, activeAliases, params);

            case "isNull": {
                const val = this.resolveScopeField(scope, node.col, activeAliases);
                const isNull = val === undefined || val === null;
                return node.isNot ? !isNull : isNull;
            }

            case "in": {
                const actual = this.resolveScopeField(scope, node.col, activeAliases);
                let items = node.items.map(i => this.resolveScopeValue(i, scope, activeAliases, params));
                if (items.length === 1 && Array.isArray(items[0])) items = items[0];
                const hit = items.includes(actual);
                return node.negated ? !hit : hit;
            }

            case "between": {
                const actual = this.resolveScopeField(scope, node.col, activeAliases);
                const min = this.resolveScopeValue(node.min, scope, activeAliases, params);
                const max = this.resolveScopeValue(node.max, scope, activeAliases, params);
                const hit = actual !== undefined && actual !== null && actual >= min && actual <= max;
                return node.negated ? !hit : hit;
            }

            case "like": {
                const actual = this.resolveScopeField(scope, node.col, activeAliases);
                const pattern = this.resolveScopeValue(node.pattern, scope, activeAliases, params);
                if (typeof actual !== "string" || typeof pattern !== "string") return Boolean(node.negated);
                const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const regexStr = "^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$";
                const hit = new RegExp(regexStr, "i").test(actual);
                return node.negated ? !hit : hit;
            }

            case "contains": {
                const actual = this.resolveScopeField(scope, node.col, activeAliases);
                const target = this.resolveScopeValue(node.target, scope, activeAliases, params);
                const hit = (Array.isArray(actual) || typeof actual === "string") && actual.includes(target);
                return node.negated ? !hit : hit;
            }

            case "regexp": {
                const actual = this.resolveScopeField(scope, node.col, activeAliases);
                const pattern = this.resolveScopeValue(node.pattern, scope, activeAliases, params);
                const rx = pattern instanceof RegExp ? pattern : new RegExp(pattern);
                const hit = typeof actual === "string" && rx.test(actual);
                return node.negated ? !hit : hit;
            }

            case "cmp": {
                const leftVal = this.resolveScopeField(scope, node.col, activeAliases);
                const rightVal = this.resolveScopeValue(node.val, scope, activeAliases, params);

                switch (node.op) {
                    case "=": return leftVal === rightVal;
                    case "!=": return leftVal !== rightVal;
                    case ">": return leftVal !== null && rightVal !== null && leftVal > rightVal;
                    case ">=": return leftVal !== null && rightVal !== null && leftVal >= rightVal;
                    case "<": return leftVal !== null && rightVal !== null && leftVal < rightVal;
                    case "<=": return leftVal !== null && rightVal !== null && leftVal <= rightVal;
                    default: return false;
                }
            }

            default:
                throw new Error(`[MCSQL] Unsupported expression node '${node.kind}' in JOIN query.`);
        }
    }

    /**
     * Extract an equi-join key pair from the top-level ON clause to build an O(1) Hash Index.
     */
    static extractEquiJoinPair(onNode, joinAlias, previousAliases) {
        if (!onNode) return null;
        const candidates = onNode.kind === "and" ? onNode.terms : [onNode];

        for (const term of candidates) {
            if (term.kind === "cmp" && term.op === "=" && term.val && term.val.kind === "columnRef") {
                const leftCol = term.col;
                const rightCol = term.val.name;
                const leftPrefix = leftCol.split(".")[0];
                const rightPrefix = rightCol.split(".")[0];

                if (leftPrefix === joinAlias && previousAliases.includes(rightPrefix)) {
                    return { leftKey: rightCol, rightKey: leftCol };
                }
                if (rightPrefix === joinAlias && previousAliases.includes(leftPrefix)) {
                    return { leftKey: leftCol, rightKey: rightCol };
                }
            }
        }
        return null;
    }

    /**
     * Execute a multi-table SELECT with INNER JOIN / LEFT JOIN, WHERE, GROUP BY, ORDER BY, LIMIT.
     */
    static execute(plan) {
        const activeAliases = [plan.tableAlias];
        const baseRows = Storage.select(plan.table, { flat: true });

        let scopes = baseRows.map(row => ({ [plan.tableAlias]: row }));

        for (const join of plan.joins) {
            if (activeAliases.includes(join.alias)) {
                throw new Error(`[MCSQL] Duplicate table alias '${join.alias}' in JOIN query.`);
            }

            const rightRows = Storage.select(join.table, { flat: true });
            const nextAliases = [...activeAliases, join.alias];
            const equiPair = this.extractEquiJoinPair(join.on, join.alias, activeAliases);

            const nextScopes = [];

            if (equiPair) {
                const hashIndex = new Map();
                for (const rRow of rightRows) {
                    const rKey = this.resolveScopeField({ [join.alias]: rRow }, equiPair.rightKey, [join.alias]);
                    if (rKey === undefined || rKey === null) continue;
                    if (!hashIndex.has(rKey)) hashIndex.set(rKey, []);
                    hashIndex.get(rKey).push(rRow);
                }

                for (const scope of scopes) {
                    const lKey = this.resolveScopeField(scope, equiPair.leftKey, activeAliases);
                    const bucket = (lKey !== undefined && lKey !== null) ? hashIndex.get(lKey) : null;
                    let matchedCount = 0;

                    if (bucket) {
                        for (const rRow of bucket) {
                            const candidateScope = { ...scope, [join.alias]: rRow };
                            if (this.evalScopeExpr(join.on, candidateScope, nextAliases, plan.params)) {
                                nextScopes.push(candidateScope);
                                matchedCount++;
                            }
                        }
                    }

                    if (matchedCount === 0 && join.joinType === "LEFT") {
                        nextScopes.push({ ...scope, [join.alias]: null });
                    }
                }
            } else {
                for (const scope of scopes) {
                    let matchedCount = 0;
                    for (const rRow of rightRows) {
                        const candidateScope = { ...scope, [join.alias]: rRow };
                        if (this.evalScopeExpr(join.on, candidateScope, nextAliases, plan.params)) {
                            nextScopes.push(candidateScope);
                            matchedCount++;
                        }
                    }
                    if (matchedCount === 0 && join.joinType === "LEFT") {
                        nextScopes.push({ ...scope, [join.alias]: null });
                    }
                }
            }

            scopes = nextScopes;
            activeAliases.push(join.alias);
        }

        if (plan.whereAst) {
            scopes = scopes.filter(scope => this.evalScopeExpr(plan.whereAst, scope, activeAliases, plan.params));
        }

        const hasAggregates = plan.selectItems.some(i => i.kind === "aggregate");
        const hasRegularCols = plan.selectItems.some(i => i.kind !== "aggregate");

        if (hasAggregates && hasRegularCols && !plan.groupBy) {
            throw new SyntaxError("[MCSQL] Mixing aggregate functions with regular columns requires a GROUP BY clause.");
        }

        if (hasAggregates) {
            const aggItems = plan.selectItems.filter(i => i.kind === "aggregate");
            const groupColItem = plan.selectItems.find(i => i.kind === "column");

            const computeAggRow = (groupScopes, groupKeyVal) => {
                const out = {};
                if (groupColItem) {
                    out[groupColItem.alias] = groupKeyVal;
                } else if (plan.groupBy) {
                    const cleanKey = plan.groupBy.includes(".") ? plan.groupBy.split(".").pop() : plan.groupBy;
                    out[cleanKey] = groupKeyVal;
                }

                for (const agg of aggItems) {
                    if (agg.fn === "COUNT") {
                        if (agg.field === "*") {
                            out[agg.alias] = groupScopes.length;
                        } else {
                            out[agg.alias] = groupScopes.reduce((acc, sc) => {
                                const v = this.resolveScopeField(sc, agg.field, activeAliases);
                                return v !== undefined && v !== null ? acc + 1 : acc;
                            }, 0);
                        }
                        continue;
                    }

                    const nums = groupScopes
                        .map(sc => this.resolveScopeField(sc, agg.field, activeAliases))
                        .filter(v => typeof v === "number" && !isNaN(v));

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
                aggRows = [computeAggRow(scopes, null)];
            } else {
                const groups = new Map();
                for (const sc of scopes) {
                    const gVal = this.resolveScopeField(sc, plan.groupBy, activeAliases) ?? null;
                    const mapKey = JSON.stringify(gVal);
                    if (!groups.has(mapKey)) groups.set(mapKey, { val: gVal, list: [] });
                    groups.get(mapKey).list.push(sc);
                }
                aggRows = [...groups.values()].map(g => computeAggRow(g.list, g.val));
            }

            return this.applyOrderAndPagination(aggRows, plan.orderBy, plan.offset, plan.limit);
        }

        // Standard multi-table projection
        if (plan.orderBy && plan.orderBy.length > 0) {
            scopes.sort((a, b) => {
                for (const { field, dir } of plan.orderBy) {
                    const mult = dir === "DESC" ? -1 : 1;
                    const valA = this.resolveScopeField(a, field, activeAliases);
                    const valB = this.resolveScopeField(b, field, activeAliases);
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

        for (const scope of scopes) {
            const outRow = {};

            for (const item of plan.selectItems) {
                if (item.kind === "wildcard") {
                    for (const alias of activeAliases) {
                        if (scope[alias]) {
                            Object.assign(outRow, Storage._clone(scope[alias]));
                        }
                    }
                } else if (item.kind === "tableWildcard") {
                    if (!activeAliases.includes(item.alias)) {
                        throw new ReferenceError(`[MCSQL] Unknown table alias '${item.alias}'.`);
                    }
                    if (scope[item.alias]) {
                        Object.assign(outRow, Storage._clone(scope[item.alias]));
                    }
                } else if (item.kind === "scalarFn") {
                    const resolvedArgs = item.args.map(arg =>
                        this.resolveScopeValue(arg, scope, activeAliases, plan.params)
                    );
                    outRow[item.alias] = MCSQLDataType.evaluate(item.fn, resolvedArgs, {
                        row: scope,
                        params: plan.params
                    });
                } else {
                    const val = this.resolveScopeField(scope, item.col, activeAliases);
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

    static applyOrderAndPagination(rows, orderBy, offset, limit) {
        let out = rows;
        if (orderBy && orderBy.length > 0) {
            out.sort((a, b) => {
                for (const { field, dir } of orderBy) {
                    const cleanField = field.includes(".") ? field.split(".").pop() : field;
                    const mult = dir === "DESC" ? -1 : 1;
                    if (a[cleanField] === b[cleanField]) continue;
                    if (a[cleanField] === undefined || a[cleanField] === null) return 1;
                    if (b[cleanField] === undefined || b[cleanField] === null) return -1;
                    return a[cleanField] < b[cleanField] ? -1 * mult : 1 * mult;
                }
                return 0;
            });
        }

        if (offset > 0 || typeof limit === "number") {
            const end = typeof limit === "number" ? offset + limit : undefined;
            out = out.slice(offset, end);
        }

        return out;
    }
}
