import { Storage } from "./Storage.js";

const VALID_EVENTS = new Set([
    "BEFORE_INSERT",
    "AFTER_INSERT",
    "BEFORE_UPDATE",
    "AFTER_UPDATE",
    "BEFORE_DELETE",
    "AFTER_DELETE",
    "BEFORE_CLEAR",
    "AFTER_CLEAR"
]);

/**
 * SQLTrigger - Reactive Database Triggers & Field Watchers for BedrockDB
 *
 * Features:
 * - Granular BEFORE / AFTER lifecycle hooks (INSERT, UPDATE, DELETE, CLEAR)
 * - Automatic field-level diff calculation (`changedFields` and `diff` map)
 * - Ability in BEFORE_* triggers to enrich/normalize `newRow` or cancel/abort writes
 *   (automatically rolling back active SQLTransactions when aborted)
 * - Wildcard (`"*"`) listeners and built-in persistent Audit Log (`enableAuditLog`)
 * - Recursion depth protection to prevent infinite trigger loops
 */
export class SQLTrigger {
    /**
     * Registered triggers keyed by internal trigger ID.
     * @type {Map<string, {
     *   id: string,
     *   name: string | null,
     *   table: string,
     *   events: Set<string>,
     *   handler: (ctx: any) => any,
     *   priority: number,
     *   when?: (ctx: any) => boolean,
     *   fields?: Set<string>,
     *   includeSystem: boolean,
     *   once: boolean
     * }>}
     */
    static _triggers = new Map();

    /** @type {Map<string, string>} Maps unique trigger name -> trigger ID */
    static _namedIndex = new Map();

    static _enabled = true;
    static _seq = 0;

    /** @type {Map<string, number>} Tracks active call depth per (table:event) to prevent infinite loops */
    static _activeDepth = new Map();
    static _maxRecursionDepth = 8;

    /* =========================================================================
       REGISTRATION & SHORTHAND API
    ========================================================================= */

    /**
     * Register a reactive trigger on one or all (`"*"`) tables.
     *
     * @param {string} table - Target table name or `"*"` for all user tables.
     * @param {string | string[]} events - Event name(s): BEFORE_INSERT, AFTER_INSERT, BEFORE_UPDATE, AFTER_UPDATE, BEFORE_DELETE, AFTER_DELETE, BEFORE_CLEAR, AFTER_CLEAR.
     * @param {(ctx: {
     *   event: string,
     *   table: string,
     *   id?: number,
     *   oldRow?: any,
     *   newRow?: any,
     *   changedFields?: string[],
     *   diff?: Record<string, { old: any, new: any }>,
     *   cancel: (reason?: string) => never
     * }) => any} handler
     * @param {object} [options]
     * @param {string} [options.name] - Optional unique name (replaces any existing trigger with the same name).
     * @param {number} [options.priority=0] - Higher priority triggers execute first.
     * @param {(ctx: any) => boolean} [options.when] - Optional predicate; handler runs only if truthy.
     * @param {string[]} [options.fields] - For UPDATE events, fire only if at least one listed field changed.
     * @param {boolean} [options.includeSystem=false] - Whether `"*"` triggers also observe `_db_*` system tables.
     * @param {boolean} [options.once=false] - Automatically remove trigger after first execution.
     * @returns {() => boolean} Unsubscribe function.
     */
    static on(table, events, handler, options = {}) {
        if (typeof table !== "string" || table.trim() === "") {
            throw new TypeError("[SQLTrigger] 'table' must be a non-empty string or '*'.");
        }
        if (typeof handler !== "function") {
            throw new TypeError("[SQLTrigger] 'handler' must be a function.");
        }

        const eventList = Array.isArray(events) ? events : [events];
        if (eventList.length === 0) {
            throw new TypeError("[SQLTrigger] At least one trigger event must be specified.");
        }

        const normalizedEvents = new Set();
        for (const ev of eventList) {
            const upper = String(ev || "").trim().toUpperCase();
            if (!VALID_EVENTS.has(upper)) {
                throw new TypeError(`[SQLTrigger] Invalid trigger event '${ev}'. Allowed: ${[...VALID_EVENTS].join(", ")}.`);
            }
            normalizedEvents.add(upper);
        }

        const cleanTable = table.trim();
        const name = options.name ? String(options.name).trim() : null;

        // Replace existing trigger if registered with the same unique name (safe across /reload)
        if (name && this._namedIndex.has(name)) {
            this.off(name);
        }

        const id = `trg_${++this._seq}`;
        const entry = {
            id,
            name,
            table: cleanTable,
            events: normalizedEvents,
            handler,
            priority: typeof options.priority === "number" ? options.priority : 0,
            when: typeof options.when === "function" ? options.when : undefined,
            fields: Array.isArray(options.fields) && options.fields.length > 0
                ? new Set(options.fields)
                : undefined,
            includeSystem: Boolean(options.includeSystem),
            once: Boolean(options.once)
        };

        this._triggers.set(id, entry);
        if (name) {
            this._namedIndex.set(name, id);
        }

        return () => this.off(id);
    }

    static beforeInsert(table, handler, options = {}) {
        return this.on(table, "BEFORE_INSERT", handler, options);
    }

    static afterInsert(table, handler, options = {}) {
        return this.on(table, "AFTER_INSERT", handler, options);
    }

    static beforeUpdate(table, handler, options = {}) {
        return this.on(table, "BEFORE_UPDATE", handler, options);
    }

    static afterUpdate(table, handler, options = {}) {
        return this.on(table, "AFTER_UPDATE", handler, options);
    }

    static beforeDelete(table, handler, options = {}) {
        return this.on(table, "BEFORE_DELETE", handler, options);
    }

    static afterDelete(table, handler, options = {}) {
        return this.on(table, "AFTER_DELETE", handler, options);
    }

    /**
     * Convenience helper to react whenever a specific field on a table changes value.
     *
     * @param {string} table
     * @param {string} field - Field name or dot-notation path (e.g. "coins" or "stats.kills").
     * @param {(ctx: {
     *   id: number,
     *   table: string,
     *   field: string,
     *   oldValue: any,
     *   newValue: any,
     *   oldRow: any,
     *   newRow: any
     * }) => void} handler
     * @param {object} [options]
     * @returns {() => boolean}
     */
    static watchField(table, field, handler, options = {}) {
        if (typeof field !== "string" || field.trim() === "") {
            throw new TypeError("[SQLTrigger] 'field' must be a non-empty string.");
        }
        const cleanField = field.trim();
        const topLevelKey = cleanField.split(".")[0];

        return this.on(
            table,
            "AFTER_UPDATE",
            (ctx) => {
                const oldValue = Storage._getNestedValue(ctx.oldRow, cleanField);
                const newValue = Storage._getNestedValue(ctx.newRow, cleanField);
                if (this._areEqual(oldValue, newValue)) return;

                handler({
                    id: ctx.id,
                    table: ctx.table,
                    field: cleanField,
                    oldValue,
                    newValue,
                    oldRow: ctx.oldRow,
                    newRow: ctx.newRow
                });
            },
            {
                ...options,
                fields: [topLevelKey]
            }
        );
    }

    /* =========================================================================
       BUILT-IN PERSISTENT AUDIT LOG
    ========================================================================= */

    /**
     * Automatically log INSERT, UPDATE, and DELETE mutations into a persistent scoreboard table (`_db_audit`).
     *
     * @param {object} [options]
     * @param {string | string[]} [options.tables="*"] - Specific table(s) to audit, or `"*"` for all user tables.
     * @param {string} [options.auditTable="_db_audit"] - Target audit table name (max 16 chars).
     * @param {number} [options.maxEntries=500] - Maximum retained audit entries before pruning oldest rows (0 = unlimited).
     * @param {(ctx: any) => Record<string, any>} [options.metaBuilder] - Optional callback to attach extra metadata (e.g. actor/staff name).
     * @returns {() => boolean} Unsubscribe function to disable audit logging.
     */
    static enableAuditLog({
        tables = "*",
        auditTable = "_db_audit",
        maxEntries = 500,
        metaBuilder
    } = {}) {
        const targetSet = Array.isArray(tables) ? new Set(tables) : null;

        return this.on(
            "*",
            ["AFTER_INSERT", "AFTER_UPDATE", "AFTER_DELETE"],
            (ctx) => {
                if (ctx.table === auditTable) return;
                if (targetSet && !targetSet.has(ctx.table)) return;

                const action = ctx.event.replace("AFTER_", "");
                const extra = typeof metaBuilder === "function" ? (metaBuilder(ctx) || {}) : {};

                const logRecord = {
                    ts: Date.now(),
                    action,
                    table: ctx.table,
                    rowId: ctx.id ?? null,
                    changedFields: ctx.changedFields ?? null,
                    oldRow: ctx.oldRow ?? null,
                    newRow: ctx.newRow ?? null,
                    ...extra
                };

                Storage.insert(auditTable, logRecord);

                if (maxEntries > 0) {
                    const total = Storage.count(auditTable);
                    if (total > maxEntries) {
                        const oldest = Storage.select(auditTable, {
                            columns: ["id"],
                            orderBy: { id: "ASC" },
                            limit: total - maxEntries,
                            flat: true
                        });
                        for (const row of oldest) {
                            Storage.delete(auditTable, row.id);
                        }
                    }
                }
            },
            {
                name: `__builtin_audit_${auditTable}`,
                priority: -100,
                includeSystem: false
            }
        );
    }

    /**
     * Disable the built-in audit log trigger.
     * @param {string} [auditTable="_db_audit"]
     */
    static disableAuditLog(auditTable = "_db_audit") {
        return this.off(`__builtin_audit_${auditTable}`);
    }

    /* =========================================================================
       TRIGGER MANAGEMENT & INSPECTION
    ========================================================================= */

    /**
     * Unregister a trigger by its unique name or internal ID (`trg_...`).
     * @param {string} nameOrId
     * @returns {boolean}
     */
    static off(nameOrId) {
        if (!nameOrId) return false;

        let targetId = nameOrId;
        if (this._namedIndex.has(nameOrId)) {
            targetId = this._namedIndex.get(nameOrId);
        }

        const entry = this._triggers.get(targetId);
        if (!entry) return false;

        if (entry.name) {
            this._namedIndex.delete(entry.name);
        }
        this._triggers.delete(targetId);
        return true;
    }

    /**
     * Remove all triggers for a specific table, or clear all triggers globally.
     * @param {string} [table]
     * @returns {number} Number of removed triggers.
     */
    static clear(table) {
        if (!table) {
            const count = this._triggers.size;
            this._triggers.clear();
            this._namedIndex.clear();
            return count;
        }

        let removed = 0;
        for (const [id, entry] of [...this._triggers.entries()]) {
            if (entry.table === table) {
                this.off(id);
                removed++;
            }
        }
        return removed;
    }

    /**
     * Enable or pause all trigger execution globally.
     * @param {boolean} enabled
     */
    static setEnabled(enabled) {
        this._enabled = Boolean(enabled);
    }

    /**
     * Check whether trigger execution is currently active.
     * @returns {boolean}
     */
    static isEnabled() {
        return this._enabled;
    }

    /**
     * List registered triggers for inspection or diagnostics (`SHOW TRIGGERS`).
     * @param {string} [table]
     * @returns {Array<{ id: string, name: string | null, table: string, events: string[], priority: number, fields: string[] | null }>}
     */
    static list(table) {
        const out = [];
        for (const entry of this._triggers.values()) {
            if (table && entry.table !== table && entry.table !== "*") continue;
            out.push({
                id: entry.id,
                name: entry.name,
                table: entry.table,
                events: [...entry.events],
                priority: entry.priority,
                fields: entry.fields ? [...entry.fields] : null
            });
        }
        return out.sort((a, b) => b.priority - a.priority);
    }

    /* =========================================================================
       INTERNAL DISPATCH ENGINE (INVOKED BY STORAGE)
    ========================================================================= */

    /**
     * Dispatch matching triggers for a Storage lifecycle event.
     * @param {string} event
     * @param {any} payload
     * @returns {any} Possibly transformed `newRow` for BEFORE_INSERT / BEFORE_UPDATE.
     */
    static _dispatch(event, payload) {
        if (!this._enabled || this._triggers.size === 0) {
            return payload?.newRow;
        }

        const table = payload.table;
        const isSystemTable = typeof table === "string" && table.startsWith("_db_");

        // Collect matching triggers sorted by descending priority
        const matching = [];
        for (const entry of this._triggers.values()) {
            if (!entry.events.has(event)) continue;
            if (entry.table === "*") {
                if (isSystemTable && !entry.includeSystem) continue;
            } else if (entry.table !== table) {
                continue;
            }
            matching.push(entry);
        }

        if (matching.length === 0) {
            return payload?.newRow;
        }

        matching.sort((a, b) => b.priority - a.priority);

        // Guard against infinite recursive trigger loops
        const depthKey = `${table}:${event}`;
        const currentDepth = this._activeDepth.get(depthKey) || 0;
        if (currentDepth >= this._maxRecursionDepth) {
            throw new Error(
                `[SQLTrigger] Maximum trigger recursion depth (${this._maxRecursionDepth}) exceeded on '${table}' (${event}).`
            );
        }

        this._activeDepth.set(depthKey, currentDepth + 1);

        try {
            let currentNewRow = payload.newRow;

            // Compute field-level diff once for UPDATE events
            let changedFields;
            let diff;
            if ((event === "BEFORE_UPDATE" || event === "AFTER_UPDATE") && payload.oldRow && currentNewRow) {
                const computed = this._computeDiff(payload.oldRow, currentNewRow);
                changedFields = computed.changedFields;
                diff = computed.diff;
            }

            const cancel = (reason = `Operation blocked by ${event} trigger on '${table}'.`) => {
                throw new Error(`[SQLTrigger] ${reason}`);
            };

            for (const entry of matching) {
                // Skip if trigger watches specific fields and none of them changed
                if (entry.fields && changedFields) {
                    const hasRelevantChange = changedFields.some(f => entry.fields.has(f));
                    if (!hasRelevantChange) continue;
                }

                const ctx = {
                    event,
                    table,
                    id: payload.id,
                    oldRow: payload.oldRow,
                    newRow: currentNewRow,
                    changedFields,
                    diff,
                    cancel
                };

                if (entry.when && !entry.when(ctx)) {
                    continue;
                }

                if (entry.once) {
                    this.off(entry.id);
                }

                const result = entry.handler(ctx);

                // Allow BEFORE_INSERT and BEFORE_UPDATE handlers to return a modified row object
                if (
                    (event === "BEFORE_INSERT" || event === "BEFORE_UPDATE") &&
                    result !== undefined &&
                    result !== null &&
                    typeof result === "object" &&
                    !Array.isArray(result)
                ) {
                    currentNewRow = result;
                    if (event === "BEFORE_UPDATE" && payload.oldRow) {
                        const recomputed = this._computeDiff(payload.oldRow, currentNewRow);
                        changedFields = recomputed.changedFields;
                        diff = recomputed.diff;
                    }
                }
            }

            return currentNewRow;
        } finally {
            if (currentDepth === 0) {
                this._activeDepth.delete(depthKey);
            } else {
                this._activeDepth.set(depthKey, currentDepth);
            }
        }
    }

    static _areEqual(a, b) {
        if (a === b) return true;
        if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
            return false;
        }
        return JSON.stringify(a) === JSON.stringify(b);
    }

    static _computeDiff(oldRow, newRow) {
        const keys = new Set([...Object.keys(oldRow || {}), ...Object.keys(newRow || {})]);
        const changedFields = [];
        const diff = {};

        for (const key of keys) {
            const oldVal = oldRow ? oldRow[key] : undefined;
            const newVal = newRow ? newRow[key] : undefined;
            if (!this._areEqual(oldVal, newVal)) {
                changedFields.push(key);
                diff[key] = { old: oldVal, new: newVal };
            }
        }

        return { changedFields, diff };
    }
}

// Wire SQLTrigger into Storage automatically without circular module imports
if (typeof Storage.setTriggerHook === "function") {
    Storage.setTriggerHook((event, payload) => SQLTrigger._dispatch(event, payload));
}
