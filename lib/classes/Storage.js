import { world } from "@minecraft/server";

const SEQ_KEY = "__seq__";
const SCHEMA_TABLE = "_db_schemas";
const VIEW_TABLE = "_db_views";

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

    /** @type {Set<function({ type: "insert"|"update"|"delete"|"clear", table: string, id?: number, data?: any }): void>} */
    static _listeners = new Set();

    /** @type {((table: string) => void) | null} */
    static _beforeWriteHook = null;

    /** @type {((event: string, payload: any) => any) | null} */
    static _triggerHook = null;

    /**
     * In-memory cache of table schemas (PRIMARY KEY, FOREIGN KEYs, ENUM, UNIQUE, NOT NULL, DEFAULT).
     * @type {Map<string, {
     *   table: string,
     *   primaryKey: string | null,
     *   columns: Record<string, {
     *     type?: string,
     *     enumValues?: Array<string | number | boolean>,
     *     primaryKey?: boolean,
     *     notNull?: boolean,
     *     unique?: boolean,
     *     hasDefault?: boolean,
     *     default?: any,
     *     defaultFn?: string,
     *     defaultArgs?: any[]
     *   }>,
     *   unique: string[],
     *   foreignKeys: Array<{
     *     column: string,
     *     refTable: string,
     *     refColumn: string,
     *     onDelete: "RESTRICT" | "CASCADE" | "SET NULL",
     *     onUpdate: "RESTRICT" | "CASCADE" | "SET NULL"
     *   }>
     * }>}
     */
    static _schemas = new Map();
    static _schemasLoaded = false;

    /**
     * In-memory cache of persistent Virtual SQL Views (`_db_views`).
     * @type {Map<string, { name: string, sql: string, createdAt: number }>}
     */
    static _views = new Map();
    static _viewsLoaded = false;

    /** @type {((fnName: string, args: any[]) => any) | null} */
    static _defaultFnEvaluator = null;

    /* =========================================================================
       INTERNAL HOOKS & EVENTS (FOR TRANSACTIONS & CACHE SYNCHRONIZATION)
    ========================================================================= */

    /**
     * Register a Copy-On-Write hook invoked before any scoreboard table is modified.
     * Used by SQLTransaction to capture pre-mutation snapshots.
     * @param {(table: string) => void} hookFn
     */
    static setBeforeWriteHook(hookFn) {
        this._beforeWriteHook = hookFn;
    }

    /**
     * Register a reactive trigger dispatcher invoked before and after row mutations.
     * Used by SQLTrigger without circular imports.
     * @param {(event: string, payload: any) => any} hookFn
     */
    static setTriggerHook(hookFn) {
        this._triggerHook = hookFn;
    }

    /**
     * Dispatch a trigger phase event if a trigger hook is registered.
     * @param {string} event
     * @param {any} payload
     * @returns {any}
     */
    static _fireTrigger(event, payload) {
        if (typeof this._triggerHook === "function") {
            return this._triggerHook(event, payload);
        }
        return undefined;
    }

    /**
     * Register a resolver for SQL default functions (e.g. UUID(), NOW()).
     * @param {(fnName: string, args: any[]) => any} evaluatorFn
     */
    static setDefaultFunctionEvaluator(evaluatorFn) {
        this._defaultFnEvaluator = evaluatorFn;
    }

    static _beforeWrite(table) {
        if (typeof this._beforeWriteHook === "function") {
            this._beforeWriteHook(table);
        }
    }

    /**
     * Subscribe to database write mutations (insert, update, delete, clear).
     * @param {function} listener
     * @returns {function} Unsubscribe function.
     */
    static onMutation(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /**
     * Broadcast a mutation event to all registered listeners.
     * @param {{ type: "insert"|"update"|"delete"|"clear", table: string, id?: number, data?: any }} event
     */
    static _emit(event) {
        for (const listener of this._listeners) {
            try {
                listener(event);
            } catch {
                // Prevent listener errors from breaking storage operations
            }
        }
    }

    /* =========================================================================
       TABLE SCHEMA, PRIMARY KEY, ENUM & FOREIGN KEY MANAGEMENT
    ========================================================================= */

    /**
     * Load persisted table schemas from the `_db_schemas` system scoreboard objective.
     */
    static _ensureSchemasLoaded() {
        if (this._schemasLoaded) return;
        this._schemasLoaded = true;
        this._schemas.clear();

        const obj = world.scoreboard.getObjective(SCHEMA_TABLE);
        if (!obj) return;

        for (const p of obj.getParticipants()) {
            if (p.displayName === SEQ_KEY) continue;
            const parsed = this._parse(p.displayName);
            if (parsed && typeof parsed.table === "string") {
                this._schemas.set(parsed.table, this._normalizeSchema(parsed.table, parsed));
            }
        }
    }

    /**
     * Force reload of schemas from scoreboard (called after transaction rollback).
     */
    static _reloadSchemas() {
        this._schemasLoaded = false;
        this._ensureSchemasLoaded();
    }

    static _formatEnumList(values) {
        return values
            .map(v => (typeof v === "string" ? `'${v}'` : String(v)))
            .join(", ");
    }

    static _normalizeSchema(table, raw = {}) {
        const columns = {};
        const uniqueSet = new Set(Array.isArray(raw.unique) ? raw.unique : []);
        let primaryKey = raw.primaryKey ?? null;

        if (raw.columns && typeof raw.columns === "object") {
            for (const [colName, colDef] of Object.entries(raw.columns)) {
                const def = { ...(colDef || {}) };

                if (def.type && String(def.type).toUpperCase() === "ENUM") {
                    def.type = "ENUM";
                    if (!Array.isArray(def.enumValues) || def.enumValues.length === 0) {
                        throw new TypeError(`[Storage] Column '${table}.${colName}' of type ENUM requires a non-empty 'enumValues' array.`);
                    }
                    const normalizedValues = [];
                    for (const item of def.enumValues) {
                        if (item === null || !["string", "number", "boolean"].includes(typeof item)) {
                            throw new TypeError(`[Storage] ENUM values for '${table}.${colName}' must be primitive literals (string, number, or boolean).`);
                        }
                        if (!normalizedValues.includes(item)) {
                            normalizedValues.push(item);
                        }
                    }
                    def.enumValues = normalizedValues;

                    if (def.hasDefault && def.default !== undefined && def.default !== null && !def.defaultFn) {
                        if (!def.enumValues.includes(def.default)) {
                            throw new Error(
                                `[Storage] Enum Constraint Error: Default value '${def.default}' for '${table}.${colName}' is not valid. Allowed values: ${this._formatEnumList(def.enumValues)}.`
                            );
                        }
                    }
                }

                if (def.primaryKey) {
                    if (primaryKey && primaryKey !== colName) {
                        throw new Error(`[Storage] Table '${table}' cannot declare multiple PRIMARY KEYs ('${primaryKey}' and '${colName}').`);
                    }
                    primaryKey = colName;
                    def.notNull = true;
                    def.unique = true;
                }
                if (def.unique) {
                    uniqueSet.add(colName);
                }
                columns[colName] = def;
            }
        }

        if (primaryKey) {
            uniqueSet.add(primaryKey);
            if (!columns[primaryKey]) {
                columns[primaryKey] = { primaryKey: true, notNull: true, unique: true };
            } else {
                columns[primaryKey].primaryKey = true;
                columns[primaryKey].notNull = true;
                columns[primaryKey].unique = true;
            }
        }

        const validActions = new Set(["RESTRICT", "CASCADE", "SET NULL"]);
        const foreignKeys = [];

        if (Array.isArray(raw.foreignKeys)) {
            for (const fk of raw.foreignKeys) {
                if (!fk.column || !fk.refTable || !fk.refColumn) {
                    throw new TypeError(`[Storage] Invalid FOREIGN KEY definition on table '${table}'.`);
                }
                const onDelete = String(fk.onDelete || "RESTRICT").toUpperCase();
                const onUpdate = String(fk.onUpdate || "RESTRICT").toUpperCase();
                if (!validActions.has(onDelete) || !validActions.has(onUpdate)) {
                    throw new TypeError(`[Storage] Invalid FK referential action. Allowed: RESTRICT, CASCADE, SET NULL.`);
                }
                foreignKeys.push({
                    column: fk.column,
                    refTable: fk.refTable,
                    refColumn: fk.refColumn,
                    onDelete,
                    onUpdate
                });
            }
        }

        return {
            table,
            primaryKey,
            columns,
            unique: [...uniqueSet],
            foreignKeys
        };
    }

    /**
     * Define or update a table schema with PRIMARY KEY, FOREIGN KEYs, ENUM, UNIQUE, NOT NULL, and DEFAULTs.
     * Persists automatically in the `_db_schemas` system scoreboard objective.
     *
     * @param {string} table
     * @param {object} schemaDef
     * @param {string | null} [schemaDef.primaryKey]
     * @param {Record<string, object>} [schemaDef.columns]
     * @param {string[]} [schemaDef.unique]
     * @param {Array<{ column: string, refTable: string, refColumn: string, onDelete?: string, onUpdate?: string }>} [schemaDef.foreignKeys]
     * @param {boolean} [validateExisting=true] - Verify existing records satisfy the new constraints.
     */
    static defineSchema(table, schemaDef = {}, validateExisting = true) {
        if (table === SCHEMA_TABLE) {
            throw new Error(`[Storage] Cannot define schema on system table '${SCHEMA_TABLE}'.`);
        }
        this._ensureSchemasLoaded();

        const normalized = this._normalizeSchema(table, schemaDef);

        // Validate existing rows against the new schema before saving
        if (validateExisting) {
            const existingMap = this._getTableMap(table);
            if (existingMap && existingMap.size > 0) {
                const seenUnique = new Map();
                for (const uCol of normalized.unique) {
                    seenUnique.set(uCol, new Set());
                }

                for (const [id, entry] of existingMap.entries()) {
                    const row = entry.data;
                    for (const [colName, colDef] of Object.entries(normalized.columns)) {
                        const val = colName === "id" ? id : this._getNestedValue(row, colName);
                        if (colDef.notNull && (val === undefined || val === null)) {
                            throw new Error(`[Storage] Cannot apply schema to '${table}': existing row #${id} has NULL '${colName}'.`);
                        }
                        if (colDef.type === "ENUM" && Array.isArray(colDef.enumValues) && val !== undefined && val !== null) {
                            if (!colDef.enumValues.includes(val)) {
                                throw new Error(
                                    `[Storage] Cannot apply schema to '${table}': existing row #${id} has invalid ENUM value '${val}' for '${colName}'. Allowed: ${this._formatEnumList(colDef.enumValues)}.`
                                );
                            }
                        }
                    }
                    for (const uCol of normalized.unique) {
                        const val = uCol === "id" ? id : this._getNestedValue(row, uCol);
                        if (val !== undefined && val !== null) {
                            if (seenUnique.get(uCol).has(val)) {
                                throw new Error(`[Storage] Cannot apply schema to '${table}': duplicate value '${val}' in '${uCol}'.`);
                            }
                            seenUnique.get(uCol).add(val);
                        }
                    }
                    this._validateForeignKeysOnRow(table, normalized, row, id);
                }
            }
        }

        // Persist schema into `_db_schemas` scoreboard objective
        this._beforeWrite(SCHEMA_TABLE);
        const schemaObj = this._getObjective(SCHEMA_TABLE, true);
        for (const p of schemaObj.getParticipants()) {
            if (p.displayName === SEQ_KEY) continue;
            const parsed = this._parse(p.displayName);
            if (parsed && parsed.table === table) {
                schemaObj.removeParticipant(p);
            }
        }

        const serialized = this._stringify(normalized);
        const schemaId = this._getNextId(schemaObj);
        schemaObj.setScore(serialized, schemaId);

        this._schemas.set(table, normalized);
        return this._clone(normalized);
    }

    /**
     * Retrieve the declared schema (PRIMARY KEY, FOREIGN KEYs, ENUM, columns) for a table, or null.
     * @param {string} table
     */
    static getSchema(table) {
        this._ensureSchemasLoaded();
        const schema = this._schemas.get(table);
        return schema ? this._clone(schema) : null;
    }

    /**
     * Return all declared table schemas.
     */
    static getAllSchemas() {
        this._ensureSchemasLoaded();
        const out = {};
        for (const [tbl, schema] of this._schemas.entries()) {
            out[tbl] = this._clone(schema);
        }
        return out;
    }

    /**
     * Remove a table's schema metadata.
     * @param {string} table
     */
    static dropSchema(table) {
        this._ensureSchemasLoaded();
        if (!this._schemas.has(table)) return false;

        const schemaObj = world.scoreboard.getObjective(SCHEMA_TABLE);
        if (schemaObj) {
            this._beforeWrite(SCHEMA_TABLE);
            for (const p of schemaObj.getParticipants()) {
                if (p.displayName === SEQ_KEY) continue;
                const parsed = this._parse(p.displayName);
                if (parsed && parsed.table === table) {
                    schemaObj.removeParticipant(p);
                }
            }
        }

        this._schemas.delete(table);
        return true;
    }

    /* =========================================================================
       VIRTUAL SQL VIEWS MANAGEMENT (_db_views)
    ========================================================================= */

    /**
     * Load persisted virtual SQL views from the `_db_views` system scoreboard objective.
     */
    static _ensureViewsLoaded() {
        if (this._viewsLoaded) return;
        this._viewsLoaded = true;
        this._views.clear();

        const obj = world.scoreboard.getObjective(VIEW_TABLE);
        if (!obj) return;

        for (const p of obj.getParticipants()) {
            if (p.displayName === SEQ_KEY) continue;
            const parsed = this._parse(p.displayName);
            if (parsed && typeof parsed.name === "string" && typeof parsed.sql === "string") {
                this._views.set(parsed.name, {
                    name: parsed.name,
                    sql: parsed.sql,
                    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0
                });
            }
        }
    }

    /**
     * Force reload of virtual views from scoreboard (called after transaction rollback).
     */
    static _reloadViews() {
        this._viewsLoaded = false;
        this._ensureViewsLoaded();
    }

    /**
     * Create or replace a persistent Virtual SQL View in `_db_views`.
     *
     * @param {string} name
     * @param {string} selectSql
     * @param {object} [options]
     * @param {boolean} [options.orReplace=false]
     * @param {boolean} [options.ifNotExists=false]
     * @returns {{ action: "created" | "replaced" | "exists", view: { name: string, sql: string, createdAt: number } }}
     */
    static defineView(name, selectSql, { orReplace = false, ifNotExists = false } = {}) {
        if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim())) {
            throw new TypeError(`[Storage] Invalid view name '${name}'.`);
        }
        const cleanName = name.trim();
        if (cleanName.startsWith("_db_")) {
            throw new Error(`[Storage] View name '${cleanName}' cannot use reserved prefix '_db_'.`);
        }

        if (world.scoreboard.getObjective(cleanName)) {
            throw new Error(`[Storage] Cannot create view '${cleanName}': a physical table with that name already exists.`);
        }

        this._ensureViewsLoaded();
        const existing = this._views.get(cleanName);

        if (existing) {
            if (ifNotExists && !orReplace) {
                return { action: "exists", view: this._clone(existing) };
            }
            if (!orReplace) {
                throw new Error(`[Storage] View '${cleanName}' already exists. Use 'CREATE OR REPLACE VIEW' or 'DROP VIEW' first.`);
            }
        }

        const viewRecord = {
            name: cleanName,
            sql: String(selectSql).trim(),
            createdAt: Date.now()
        };

        this._beforeWrite(VIEW_TABLE);
        const viewObj = this._getObjective(VIEW_TABLE, true);
        for (const p of viewObj.getParticipants()) {
            if (p.displayName === SEQ_KEY) continue;
            const parsed = this._parse(p.displayName);
            if (parsed && parsed.name === cleanName) {
                viewObj.removeParticipant(p);
            }
        }

        const serialized = this._stringify(viewRecord);
        const id = this._getNextId(viewObj);
        viewObj.setScore(serialized, id);

        this._views.set(cleanName, viewRecord);
        return {
            action: existing ? "replaced" : "created",
            view: this._clone(viewRecord)
        };
    }

    /**
     * Retrieve a declared Virtual SQL View by name, or null if not found.
     * @param {string} name
     * @returns {{ name: string, sql: string, createdAt: number } | null}
     */
    static getView(name) {
        this._ensureViewsLoaded();
        const v = this._views.get(name);
        return v ? this._clone(v) : null;
    }

    /**
     * Return all declared Virtual SQL Views.
     * @returns {Record<string, { name: string, sql: string, createdAt: number }>}
     */
    static getAllViews() {
        this._ensureViewsLoaded();
        const out = {};
        for (const [k, v] of this._views.entries()) {
            out[k] = this._clone(v);
        }
        return out;
    }

    /**
     * Drop a Virtual SQL View from `_db_views`.
     * @param {string} name
     * @returns {boolean}
     */
    static dropView(name) {
        this._ensureViewsLoaded();
        if (!this._views.has(name)) return false;

        const viewObj = world.scoreboard.getObjective(VIEW_TABLE);
        if (viewObj) {
            this._beforeWrite(VIEW_TABLE);
            for (const p of viewObj.getParticipants()) {
                if (p.displayName === SEQ_KEY) continue;
                const parsed = this._parse(p.displayName);
                if (parsed && parsed.name === name) {
                    viewObj.removeParticipant(p);
                }
            }
        }

        this._views.delete(name);
        return true;
    }

    /**
     * Apply schema DEFAULT values to a new record before validation.
     */
    static _applySchemaDefaults(table, data) {
        const schema = this.getSchema(table);
        if (!schema) return data;

        const copy = this._clone(data);
        for (const [colName, colDef] of Object.entries(schema.columns)) {
            if (colName === "id") continue;
            const currentVal = this._getNestedValue(copy, colName);
            if (currentVal === undefined && colDef.hasDefault) {
                let defaultVal;
                if (colDef.defaultFn) {
                    if (typeof this._defaultFnEvaluator === "function") {
                        defaultVal = this._defaultFnEvaluator(colDef.defaultFn, colDef.defaultArgs || []);
                    } else if (colDef.defaultFn === "NOW") {
                        defaultVal = Date.now();
                    } else {
                        throw new Error(`[Storage] Default function '${colDef.defaultFn}()' requires MCSQLDataType to be loaded.`);
                    }
                } else {
                    defaultVal = this._clone(colDef.default);
                }
                this._setNestedValue(copy, colName, defaultVal);
            }
        }
        return copy;
    }

    /**
     * Validate NOT NULL, ENUM, PRIMARY KEY, UNIQUE, and FOREIGN KEY constraints for a row.
     * @param {string} table
     * @param {object} rowData
     * @param {number | null} [ignoreRowId=null] - Exclude this internal row ID (used during UPDATE).
     * @param {Map<string, Set<any>> | null} [batchSeenKeys=null] - Optional per-column Set for multi-row insertMany batches.
     */
    static _validateRowConstraints(table, rowData, ignoreRowId = null, batchSeenKeys = null) {
        const schema = this.getSchema(table);
        if (!schema) return;

        // 1. NOT NULL, PRIMARY KEY presence & ENUM domain checks
        for (const [colName, colDef] of Object.entries(schema.columns)) {
            if (colName === "id") continue; // Internal auto-increment score
            const val = this._getNestedValue(rowData, colName);
            if (colDef.primaryKey && (val === undefined || val === null)) {
                throw new Error(`[Storage] Primary Key Error: '${colName}' in table '${table}' cannot be NULL.`);
            }
            if (colDef.notNull && (val === undefined || val === null)) {
                throw new Error(`[Storage] Not-Null Constraint Error: Column '${colName}' in table '${table}' cannot be NULL.`);
            }
            if (colDef.type === "ENUM" && Array.isArray(colDef.enumValues) && val !== undefined && val !== null) {
                if (!colDef.enumValues.includes(val)) {
                    throw new Error(
                        `[Storage] Enum Constraint Error: Value '${val}' is not valid for '${table}.${colName}'. Allowed values: ${this._formatEnumList(colDef.enumValues)}.`
                    );
                }
            }
        }

        // 2. PRIMARY KEY & UNIQUE uniqueness checks
        if (schema.unique.length > 0) {
            const map = this._getTableMap(table);
            for (const uCol of schema.unique) {
                if (uCol === "id") continue;
                const val = this._getNestedValue(rowData, uCol);
                if (val === undefined || val === null) continue;

                const isPk = schema.primaryKey === uCol;
                const label = isPk ? `Primary Key Violation` : `Unique Constraint Violation`;

                if (batchSeenKeys) {
                    const seenSet = batchSeenKeys.get(uCol);
                    if (seenSet && seenSet.has(val)) {
                        throw new Error(`[Storage] ${label}: Duplicate value '${val}' for '${table}.${uCol}'.`);
                    }
                }

                if (map) {
                    for (const [existingId, entry] of map.entries()) {
                        if (ignoreRowId !== null && existingId === ignoreRowId) continue;
                        const existingVal = this._getNestedValue(entry.data, uCol);
                        if (existingVal === val) {
                            throw new Error(`[Storage] ${label}: Duplicate value '${val}' for '${table}.${uCol}'.`);
                        }
                    }
                }
            }
        }

        // 3. FOREIGN KEY referential integrity checks
        this._validateForeignKeysOnRow(table, schema, rowData, ignoreRowId);
    }

    static _validateForeignKeysOnRow(table, schema, rowData, rowId = null) {
        if (!schema.foreignKeys || schema.foreignKeys.length === 0) return;

        for (const fk of schema.foreignKeys) {
            const fkVal = fk.column === "id" ? rowId : this._getNestedValue(rowData, fk.column);
            if (fkVal === undefined || fkVal === null) continue; // NULL foreign keys are valid in SQL

            const parentMap = this._getTableMap(fk.refTable);
            let parentExists = false;

            if (parentMap) {
                if (fk.refColumn === "id") {
                    parentExists = parentMap.has(fkVal);
                } else {
                    for (const entry of parentMap.values()) {
                        if (this._getNestedValue(entry.data, fk.refColumn) === fkVal) {
                            parentExists = true;
                            break;
                        }
                    }
                }
            }

            if (!parentExists) {
                throw new Error(
                    `[Storage] Foreign Key Violation: Value '${fkVal}' in '${table}.${fk.column}' references non-existent '${fk.refTable}.${fk.refColumn}'.`
                );
            }
        }
    }

    /**
     * Find all child table foreign keys that reference `parentTable`.
     */
    static _getReferencingForeignKeys(parentTable) {
        this._ensureSchemasLoaded();
        const refs = [];
        for (const [childTable, schema] of this._schemas.entries()) {
            for (const fk of schema.foreignKeys) {
                if (fk.refTable === parentTable) {
                    refs.push({ childTable, ...fk });
                }
            }
        }
        return refs;
    }

    /**
     * Enforce ON DELETE referential actions (RESTRICT, CASCADE, SET NULL) when parent rows are deleted.
     */
    static _handleReferentialOnDelete(parentTable, deletedRows) {
        const refs = this._getReferencingForeignKeys(parentTable);
        if (refs.length === 0) return;

        for (const ref of refs) {
            for (const parentRow of deletedRows) {
                const parentKeyVal = ref.refColumn === "id"
                    ? parentRow.id
                    : this._getNestedValue(parentRow.data, ref.refColumn);

                if (parentKeyVal === undefined || parentKeyVal === null) continue;

                const matchingChildren = this.select(ref.childTable, {
                    where: { [ref.column]: parentKeyVal }
                });

                if (matchingChildren.length === 0) continue;

                if (ref.onDelete === "RESTRICT") {
                    throw new Error(
                        `[Storage] Foreign Key Violation (ON DELETE RESTRICT): Cannot delete from '${parentTable}' because ${matchingChildren.length} record(s) in '${ref.childTable}.${ref.column}' reference '${parentKeyVal}'.`
                    );
                }

                if (ref.onDelete === "CASCADE") {
                    this.delete(ref.childTable, { [ref.column]: parentKeyVal });
                } else if (ref.onDelete === "SET NULL") {
                    this.update(ref.childTable, { [ref.column]: parentKeyVal }, { [ref.column]: null });
                }
            }
        }
    }

    /**
     * Enforce ON UPDATE referential actions (RESTRICT, CASCADE, SET NULL) when parent key values change.
     */
    static _handleReferentialOnUpdate(parentTable, oldData, nextData, rowId) {
        const refs = this._getReferencingForeignKeys(parentTable);
        if (refs.length === 0) return;

        for (const ref of refs) {
            if (ref.refColumn === "id") continue; // Internal row ID never changes on update
            const oldVal = this._getNestedValue(oldData, ref.refColumn);
            const newVal = this._getNestedValue(nextData, ref.refColumn);

            if (oldVal === newVal || oldVal === undefined || oldVal === null) continue;

            const matchingChildren = this.select(ref.childTable, {
                where: { [ref.column]: oldVal }
            });

            if (matchingChildren.length === 0) continue;

            if (ref.onUpdate === "RESTRICT") {
                throw new Error(
                    `[Storage] Foreign Key Violation (ON UPDATE RESTRICT): Cannot change '${parentTable}.${ref.refColumn}' from '${oldVal}' to '${newVal}' because ${matchingChildren.length} record(s) in '${ref.childTable}.${ref.column}' reference it.`
                );
            }

            if (ref.onUpdate === "CASCADE") {
                this.update(ref.childTable, { [ref.column]: oldVal }, { [ref.column]: newVal });
            } else if (ref.onUpdate === "SET NULL") {
                this.update(ref.childTable, { [ref.column]: oldVal }, { [ref.column]: null });
            }
        }
    }

    /* =========================================================================
       INTERNAL UTILITIES & ENGINE
    ========================================================================= */

    /**
     * Deep-clone helper safe for Minecraft Bedrock's QuickJS runtime.
     * @param {any} value
     * @returns {any}
     */
    static _clone(value) {
        if (value === null || typeof value !== "object") return value;
        if (typeof structuredClone === "function") {
            return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    }

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
            this._beforeWrite(table);
            try {
                objective = world.scoreboard.addObjective(table, table);
            } catch (err) {
                throw new Error(`[Storage] Failed to create table '${table}': ${err.message}`);
            }
        }
        return objective ?? null;
    }

    /**
     * Load or retrieve the internal table map for fast zero-parse reads.
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
     * Force synchronization with the world scoreboard (useful if /scoreboard commands were run).
     * @param {string} [table] - Specific table to sync, or omit to clear all internal maps.
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
        let currentSeq;
        try {
            currentSeq = objective.getScore(SEQ_KEY);
        } catch {
            currentSeq = undefined;
        }

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

    static _setNestedValue(obj, path, value) {
        if (!path.includes(".")) {
            obj[path] = value;
            return;
        }
        const parts = path.split(".");
        let curr = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const k = parts[i];
            if (typeof curr[k] !== "object" || curr[k] === null) curr[k] = {};
            curr = curr[k];
        }
        curr[parts[parts.length - 1]] = value;
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
            return this._clone(data);
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
       CREATE (INSERT WITH SCHEMA & CONSTRAINT ENFORCEMENT)
    ========================================================================= */

    /**
     * Insert a single record into a table (validates PRIMARY KEY, FOREIGN KEY, ENUM, UNIQUE, NOT NULL).
     * @param {string} table
     * @param {object} data
     * @returns {number} The assigned primary key ID.
     */
    static insert(table, data) {
        let prepared = this._applySchemaDefaults(table, data);
        const beforeRes = this._fireTrigger("BEFORE_INSERT", { table, newRow: prepared });
        if (beforeRes !== undefined) prepared = beforeRes;
        this._validateRowConstraints(table, prepared, null, null);

        this._beforeWrite(table);
        const objective = this._getObjective(table, true);
        const json = this._stringify(prepared);
        const id = this._getNextId(objective);
        const parsedCopy = JSON.parse(json);

        objective.setScore(json, id);

        const map = this._getTableMap(table);
        if (map) {
            map.set(id, { participant: json, data: parsedCopy });
        }

        const clonedAfter = this._clone(parsedCopy);
        this._emit({ type: "insert", table, id, data: clonedAfter });
        this._fireTrigger("AFTER_INSERT", { table, id, newRow: this._clone(parsedCopy) });
        return id;
    }

    /**
     * Insert multiple records in an all-or-nothing validated batch.
     * @param {string} table
     * @param {object[]} records
     * @returns {number[]} Array of assigned IDs.
     */
    static insertMany(table, records) {
        if (!Array.isArray(records)) {
            throw new TypeError("[Storage] 'records' must be an array.");
        }
        if (records.length === 0) return [];

        const schema = this.getSchema(table);
        const batchSeenKeys = schema && schema.unique.length > 0
            ? new Map(schema.unique.map(col => [col, new Set()]))
            : null;

        // Pre-validate all rows in the batch before mutating scoreboard
        const preparedRows = [];
        for (const item of records) {
            let prepared = this._applySchemaDefaults(table, item);
            const beforeRes = this._fireTrigger("BEFORE_INSERT", { table, newRow: prepared });
            if (beforeRes !== undefined) prepared = beforeRes;
            this._validateRowConstraints(table, prepared, null, batchSeenKeys);

            if (batchSeenKeys) {
                for (const [uCol, seenSet] of batchSeenKeys.entries()) {
                    if (uCol === "id") continue;
                    const val = this._getNestedValue(prepared, uCol);
                    if (val !== undefined && val !== null) seenSet.add(val);
                }
            }
            preparedRows.push(prepared);
        }

        this._beforeWrite(table);
        const objective = this._getObjective(table, true);
        const map = this._getTableMap(table);
        const ids = [];

        for (const prepared of preparedRows) {
            const json = this._stringify(prepared);
            const id = this._getNextId(objective);
            const parsedCopy = JSON.parse(json);

            objective.setScore(json, id);
            if (map) {
                map.set(id, { participant: json, data: parsedCopy });
            }

            const clonedAfter = this._clone(parsedCopy);
            this._emit({ type: "insert", table, id, data: clonedAfter });
            this._fireTrigger("AFTER_INSERT", { table, id, newRow: this._clone(parsedCopy) });
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
        return this._clone(map.get(id).data);
    }

    /**
     * SQL-like SELECT query across a table.
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

        if (offset > 0 || typeof limit === "number") {
            const end = typeof limit === "number" ? offset + limit : undefined;
            rows = rows.slice(offset, end);
        }

        return rows;
    }

    /**
     * Retrieve the first matching record (SQL `SELECT ... LIMIT 1`).
     */
    static selectOne(table, options = {}) {
        const opts = typeof options === "function" ? { where: options } : { ...options };
        opts.limit = 1;
        const res = this.select(table, opts);
        return res.length > 0 ? res[0] : null;
    }

    /**
     * Execute SQL aggregations (COUNT, SUM, AVG, MIN, MAX) with optional GROUP BY.
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
       UPDATE & UPSERT (WITH CONSTRAINT & CASCADE ENFORCEMENT)
    ========================================================================= */

    /**
     * Apply partial fields, atomic modifiers ($inc, $push, $pull, $unset), or a transform callback.
     */
    static _applyChanges(currentData, changes) {
        if (typeof changes === "function") {
            return changes(this._clone(currentData));
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

        // Collect all target updates and validate constraints first
        const plannedUpdates = [];
        for (const [id, entry] of [...map.entries()]) {
            if (this._matchWhere(entry.data, id, where)) {
                const oldData = this._clone(entry.data);
                let nextData = this._applyChanges(entry.data, changes);
                const beforeRes = this._fireTrigger("BEFORE_UPDATE", {
                    table,
                    id,
                    oldRow: this._clone(oldData),
                    newRow: nextData
                });
                if (beforeRes !== undefined) nextData = beforeRes;
                this._validateRowConstraints(table, nextData, id, null);
                plannedUpdates.push({ id, entry, oldData, nextData });
            }
        }

        if (plannedUpdates.length === 0) return 0;

        // Enforce ON UPDATE referential integrity (RESTRICT / CASCADE / SET NULL)
        for (const item of plannedUpdates) {
            this._handleReferentialOnUpdate(table, item.oldData, item.nextData, item.id);
        }

        this._beforeWrite(table);
        for (const item of plannedUpdates) {
            const nextJson = this._stringify(item.nextData);
            const parsedCopy = JSON.parse(nextJson);

            objective.removeParticipant(item.entry.participant);
            objective.setScore(nextJson, item.id);

            map.set(item.id, { participant: nextJson, data: parsedCopy });
            const clonedAfter = this._clone(parsedCopy);
            this._emit({ type: "update", table, id: item.id, data: clonedAfter });
            this._fireTrigger("AFTER_UPDATE", {
                table,
                id: item.id,
                oldRow: this._clone(item.oldData),
                newRow: this._clone(parsedCopy)
            });
        }

        return plannedUpdates.length;
    }

    /**
     * Update matching record(s) if found, otherwise insert a new record.
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
       DELETE & MAINTENANCE (WITH ON DELETE CASCADE / RESTRICT / SET NULL)
    ========================================================================= */

    /**
     * Delete records matching `where` (ID, query object, or callback).
     */
    static delete(table, where) {
        if (where === undefined) {
            throw new TypeError("[Storage] 'where' is required for delete. Use truncate() to clear all records.");
        }

        const objective = this._getObjective(table, false);
        const map = this._getTableMap(table);
        if (!objective || !map || map.size === 0) return 0;

        const toDelete = [];
        for (const [id, entry] of [...map.entries()]) {
            if (this._matchWhere(entry.data, id, where)) {
                const oldData = this._clone(entry.data);
                this._fireTrigger("BEFORE_DELETE", { table, id, oldRow: this._clone(oldData) });
                toDelete.push({ id, entry, data: oldData });
            }
        }

        if (toDelete.length === 0) return 0;

        // Enforce ON DELETE referential integrity (RESTRICT / CASCADE / SET NULL)
        this._handleReferentialOnDelete(table, toDelete);

        this._beforeWrite(table);
        for (const item of toDelete) {
            // Re-check in case recursive cascade already deleted this entry
            if (!map.has(item.id)) continue;
            const currentEntry = map.get(item.id);
            objective.removeParticipant(currentEntry.participant);
            map.delete(item.id);
            this._emit({ type: "delete", table, id: item.id });
            this._fireTrigger("AFTER_DELETE", {
                table,
                id: item.id,
                oldRow: this._clone(item.data)
            });
        }

        return toDelete.length;
    }

    /**
     * Remove all records from a table.
     * @param {string} table
     * @param {boolean} [resetAutoIncrement=false]
     */
    static truncate(table, resetAutoIncrement = false) {
        this._fireTrigger("BEFORE_CLEAR", { table, mode: "TRUNCATE" });
        const map = this._getTableMap(table);
        if (map && map.size > 0) {
            const allRows = [...map.entries()].map(([id, entry]) => ({ id, data: this._clone(entry.data) }));
            this._handleReferentialOnDelete(table, allRows);
        }

        const objective = this._getObjective(table, false);
        if (!objective) return;

        this._beforeWrite(table);
        for (const p of objective.getParticipants()) {
            if (!resetAutoIncrement && p.displayName === SEQ_KEY) continue;
            objective.removeParticipant(p);
        }

        this._cache.set(table, new Map());
        this._emit({ type: "clear", table });
        this._fireTrigger("AFTER_CLEAR", { table, mode: "TRUNCATE" });
    }
        }

        if (toDelete.length === 0) return 0;

        // Enforce ON DELETE referential integrity (RESTRICT / CASCADE / SET NULL)
        this._handleReferentialOnDelete(table, toDelete);

        this._beforeWrite(table);
        for (const item of toDelete) {
            // Re-check in case recursive cascade already deleted this entry
            if (!map.has(item.id)) continue;
            const currentEntry = map.get(item.id);
            objective.removeParticipant(currentEntry.participant);
            map.delete(item.id);
            this._emit({ type: "delete", table, id: item.id });
        }

        return toDelete.length;
    }

    /**
     * Remove all records from a table.
     * @param {string} table
     * @param {boolean} [resetAutoIncrement=false]
     */
    static truncate(table, resetAutoIncrement = false) {
        const map = this._getTableMap(table);
        if (map && map.size > 0) {
            const allRows = [...map.entries()].map(([id, entry]) => ({ id, data: this._clone(entry.data) }));
            this._handleReferentialOnDelete(table, allRows);
        }

        const objective = this._getObjective(table, false);
        if (!objective) return;

        this._beforeWrite(table);
        for (const p of objective.getParticipants()) {
            if (!resetAutoIncrement && p.displayName === SEQ_KEY) continue;
            objective.removeParticipant(p);
        }

        this._cache.set(table, new Map());
        this._emit({ type: "clear", table });
    }

    /**
     * Completely remove the scoreboard objective (table) and its schema from the world.
     * @param {string} table
     * @returns {boolean}
     */
    static drop(table) {
        const refs = this._getReferencingForeignKeys(table);
        if (refs.length > 0) {
            const childNames = refs.map(r => `${r.childTable}(${r.column})`).join(", ");
            throw new Error(`[Storage] Cannot DROP table '${table}' because it is referenced by FOREIGN KEY on: ${childNames}.`);
        }

        const objective = this._getObjective(table, false);
        this.dropSchema(table);
        this._cache.delete(table);

        if (!objective) return false;
        this._beforeWrite(table);
        world.scoreboard.removeObjective(table);
        this._emit({ type: "clear", table });
        return true;
    }

    /* =========================================================================
       UTILITIES & FLUENT QUERY BUILDER
    ========================================================================= */

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

    static from(table) {
        return new QueryBuilder(table);
    }
}

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
