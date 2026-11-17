import { world } from "@minecraft/server";
import { MCSQL } from "./MCSQL.js";
import { MCSQLDataType } from "./MCSQLDataType.js";
import { SQLTransaction } from "./SQLTransaction.js";
import { Storage } from "./Storage.js";
import { Cache } from "./Cache.js";
import { SQLTokenizer } from "./mcsql/SQLTokenizer.js";
import { SQLParser } from "./mcsql/SQLParser.js";
import { SQLCompiler } from "./mcsql/SQLCompiler.js";

/**
 * SQLInterpreter - Syntax/Semantic Validator, Diagnostic Engine & Query Runner
 *
 * Decouples SQL validation, meta-commands (SHOW TABLES, SHOW FUNCTIONS, DESCRIBE,
 * EXPLAIN, VALIDATE, CACHE STATS), and safe query execution from chat/UI layers.
 */
export class SQLInterpreter {
    /**
     * Perform deep lexical, syntactic, and semantic validation on a SQL query
     * WITHOUT modifying any data in Storage.
     *
     * @param {string} sql
     * @param {any[] | Record<string, any>} [params=[]]
     * @param {object} [options]
     * @param {boolean} [options.allowUnsafeWrite=false]
     * @param {boolean} [options.strictTableCheck=false] - Fail if target table does not exist yet on SELECT/UPDATE/DELETE.
     * @returns {{
     *   valid: boolean,
     *   statementType?: string,
     *   table?: string | null,
     *   warnings: string[],
     *   previewCalls?: Array<{ method: string, args: any[] }>,
     *   error?: string,
     *   errorType?: string,
     *   hint?: string
     * }}
     */
    static validate(sql, params = [], options = {}) {
        const warnings = [];

        if (typeof sql !== "string" || sql.trim() === "") {
            return {
                valid: false,
                warnings,
                errorType: "EmptyQueryError",
                error: "La query SQL è vuota.",
                hint: "Scrivi un comando valido, ad esempio: SELECT * FROM players LIMIT 5"
            };
        }

        const trimmed = sql.trim();

        try {
            // 1. Structural pre-check (balanced parentheses outside string literals)
            this._checkBalancedDelimiters(trimmed);

            // 2. Lexical tokenization & recursive-descent AST parsing
            const tokens = SQLTokenizer.tokenize(trimmed);
            const parser = new SQLParser(tokens, trimmed);
            const ast = parser.parseStatement();

            // 3. Validate all MCSQLDataType function calls & argument counts in AST
            this._validateFunctionsInAst(ast);

            // 4. Dry-run compilation (checks WHERE safety, parameter bindings, GROUP BY rules)
            const plan = SQLCompiler.buildPlan(ast, params, {
                allowUnsafeWrite: Boolean(options.allowUnsafeWrite)
            });

            // 5. Semantic table existence checks against Minecraft scoreboard objectives
            if (plan.table && plan.table !== "(none)" && plan.table !== "(transaction)") {
                if (plan.table.length > 16) {
                    throw new RangeError(`Il nome tabella '${plan.table}' supera il limite di 16 caratteri di Minecraft Bedrock.`);
                }

                const tableExists = Boolean(world.scoreboard.getObjective(plan.table));

                if (plan.type === "CREATE_TABLE" && tableExists && !plan.ifNotExists) {
                    throw new Error(`La tabella '${plan.table}' esiste già. Usa 'CREATE TABLE IF NOT EXISTS ${plan.table}'.`);
                }

                if (plan.type === "CREATE_TABLE" && plan.schema?.foreignKeys) {
                    for (const fk of plan.schema.foreignKeys) {
                        if (fk.refTable !== plan.table && !world.scoreboard.getObjective(fk.refTable)) {
                            warnings.push(`La tabella referenziata '${fk.refTable}' nella FOREIGN KEY (${fk.column}) non esiste ancora.`);
                        }
                    }
                }

                if (plan.type === "ALTER_TABLE" && plan.fk) {
                    if (!world.scoreboard.getObjective(plan.fk.refTable)) {
                        warnings.push(`La tabella referenziata '${plan.fk.refTable}' nella FOREIGN KEY (${plan.fk.column}) non esiste ancora.`);
                    }
                }

                if (plan.type === "DROP_TABLE" && !tableExists && !plan.ifExists) {
                    throw new Error(`La tabella '${plan.table}' non esiste. Usa 'DROP TABLE IF EXISTS ${plan.table}'.`);
                }

                if (["SELECT", "UPDATE", "DELETE", "TRUNCATE"].includes(plan.type) && !tableExists) {
                    const msg = `La tabella '${plan.table}' non esiste ancora nel mondo.`;
                    if (options.strictTableCheck) {
                        throw new Error(msg);
                    }
                    warnings.push(msg);
                }

                // Check joined tables as well
                if (ast.joins && ast.joins.length > 0) {
                    for (const j of ast.joins) {
                        if (!world.scoreboard.getObjective(j.table)) {
                            const jMsg = `La tabella in JOIN '${j.table}' non esiste ancora nel mondo.`;
                            if (options.strictTableCheck) throw new Error(jMsg);
                            warnings.push(jMsg);
                        }
                    }
                }
            }

            return {
                valid: true,
                statementType: plan.type,
                table: plan.table,
                warnings,
                previewCalls: plan.previewCalls
            };
        } catch (err) {
            return {
                valid: false,
                warnings,
                errorType: err.name || "SQLError",
                error: String(err.message || err).replace(/^\[MCSQL(?:DataType)?\]\s*/i, ""),
                hint: this._buildHelpfulHint(err, trimmed)
            };
        }
    }

    /**
     * Interpret and execute any SQL query or diagnostic meta-command.
     *
     * Supported Meta-Commands:
     * - SHOW TABLES
     * - SHOW FUNCTIONS
     * - DESCRIBE <table> / DESC <table>
     * - EXPLAIN <sql>
     * - VALIDATE <sql> / CHECK <sql>
     * - CACHE STATS
     *
     * @param {string} rawInput
     * @param {object} [context]
     * @param {any[] | Record<string, any>} [context.params=[]]
     * @param {boolean} [context.allowUnsafeWrite=false]
     * @returns {{
     *   ok: boolean,
     *   kind: "rows" | "mutation" | "meta" | "validation" | "error",
     *   elapsedMs: number,
     *   warnings: string[],
     *   rows?: any[],
     *   mutation?: any,
     *   meta?: { subtype: string, title: string, lines: string[], payload?: any },
     *   validation?: any,
     *   error?: string,
     *   hint?: string
     * }}
     */
    static interpret(rawInput, context = {}) {
        const startTime = Date.now();
        const trimmed = String(rawInput ?? "").trim();
        const params = context.params ?? [];
        const allowUnsafeWrite = Boolean(context.allowUnsafeWrite);

        if (!trimmed) {
            return {
                ok: false,
                kind: "error",
                elapsedMs: 0,
                warnings: [],
                error: "Inserisci una query SQL valida.",
                hint: "Esempio: SELECT * FROM players LIMIT 5"
            };
        }

        try {
            // 1. SHOW TABLES (excludes internal _db_ system objectives)
            if (/^SHOW\s+TABLES\s*;?$/i.test(trimmed)) {
                const objectives = world.scoreboard.getObjectives()
                    .filter(obj => !obj.id.startsWith("_db_"));
                const tables = objectives.map(obj => {
                    const schema = Storage.getSchema(obj.id);
                    return {
                        name: obj.id,
                        count: Storage.count(obj.id),
                        primaryKey: schema?.primaryKey ?? null,
                        fkCount: schema?.foreignKeys?.length ?? 0
                    };
                });
                return {
                    ok: true,
                    kind: "meta",
                    elapsedMs: Date.now() - startTime,
                    warnings: [],
                    meta: {
                        subtype: "SHOW_TABLES",
                        title: `Tabelle nel mondo (${tables.length})`,
                        lines: tables.length === 0
                            ? ["Nessuna tabella (scoreboard objective) presente nel mondo."]
                            : tables.map(t => {
                                const badges = [];
                                if (t.primaryKey) badges.push(`PK: ${t.primaryKey}`);
                                if (t.fkCount > 0) badges.push(`FK: ${t.fkCount}`);
                                const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
                                return `${t.name} (${t.count} record)${badgeStr}`;
                            }),
                        payload: tables
                    }
                };
            }

            // 1b. TRANSACTION STATUS
            if (/^TRANSACTION\s+STATUS\s*;?$/i.test(trimmed)) {
                const activeTx = SQLTransaction.current();
                return {
                    ok: true,
                    kind: "meta",
                    elapsedMs: Date.now() - startTime,
                    warnings: [],
                    meta: {
                        subtype: "TX_STATUS",
                        title: "Stato Transazione",
                        lines: activeTx
                            ? [
                                `Transazione attiva: ${activeTx._id}`,
                                `Tabelle tracciate (snapshot): ${[...activeTx._baseSnapshots.keys()].filter(t => !t.startsWith("_db_")).join(", ") || "nessuna"}`,
                                `Savepoint attivi: ${activeTx._savepoints.map(s => s.name).join(", ") || "nessuno"}`
                            ]
                            : ["Nessuna transazione attiva al momento."],
                        payload: { active: Boolean(activeTx) }
                    }
                };
            }

            // 2. SHOW FUNCTIONS
            if (/^SHOW\s+FUNCTIONS\s*;?$/i.test(trimmed)) {
                const fns = MCSQLDataType.list();
                return {
                    ok: true,
                    kind: "meta",
                    elapsedMs: Date.now() - startTime,
                    warnings: [],
                    meta: {
                        subtype: "SHOW_FUNCTIONS",
                        title: `Funzioni MCSQLDataType registrate (${fns.length})`,
                        lines: fns.map(f => `${f.signature} -> ${f.description}`),
                        payload: fns
                    }
                };
            }

            // 3. CACHE STATS
            if (/^CACHE\s+STATS\s*;?$/i.test(trimmed)) {
            // 4. DESCRIBE / DESC <table> (shows declared PK/FK schema + inferred fields)
            const descMatch = trimmed.match(/^(?:DESCRIBE|DESC)\s+([a-zA-Z0-9_]+)\s*;?$/i);
            if (descMatch) {
                const tableName = descMatch[1];
                const schema = Storage.getSchema(tableName);
                const rows = Storage.select(tableName, { limit: 25, flat: true });

                if (!schema && rows.length === 0) {
                    return {
                        ok: true,
                        kind: "meta",
                        elapsedMs: Date.now() - startTime,
                        warnings: [],
                        meta: {
                            subtype: "DESCRIBE",
                            title: `Struttura tabella ${tableName}`,
                            lines: [`La tabella '${tableName}' è vuota o non esiste.`],
                            payload: []
                        }
                    };
                }

                const lines = [];
                if (schema) {
                    lines.push(`Primary Key: ${schema.primaryKey || "nessuna (usa score id)"}`);
                    for (const [col, def] of Object.entries(schema.columns)) {
                        const tags = [];
                        if (def.type) tags.push(def.type);
                        if (def.primaryKey) tags.push("PRIMARY KEY");
                        if (def.notNull && !def.primaryKey) tags.push("NOT NULL");
                        if (def.unique && !def.primaryKey) tags.push("UNIQUE");
                        if (def.hasDefault) {
                            tags.push(`DEFAULT ${def.defaultFn ? `${def.defaultFn}()` : JSON.stringify(def.default)}`);
                        }
                        lines.push(`${col}: ${tags.join(" | ") || "ANY"}`);
                    }
                    for (const fk of schema.foreignKeys) {
                        lines.push(`FOREIGN KEY (${fk.column}) -> ${fk.refTable}(${fk.refColumn}) [ON DELETE ${fk.onDelete}, ON UPDATE ${fk.onUpdate}]`);
                    }
                }

                if (rows.length > 0) {
                    const fieldTypes = new Map();
                    for (const row of rows) {
                        for (const [key, val] of Object.entries(row)) {
                            if (schema && schema.columns[key]) continue;
                            if (!fieldTypes.has(key)) fieldTypes.set(key, new Set());
                            const typeLabel = val === null ? "null" : Array.isArray(val) ? "array" : typeof val;
                            fieldTypes.get(key).add(typeLabel);
                        }
                    }
                    for (const [field, types] of fieldTypes.entries()) {
                        lines.push(`${field} (inferred): ${[...types].join(" | ")}`);
                    }
                }

                return {
                    ok: true,
                    kind: "meta",
                    elapsedMs: Date.now() - startTime,
                    warnings: [],
                    meta: {
                        subtype: "DESCRIBE",
                        title: `Struttura tabella ${tableName}`,
                        lines,
                        payload: { schema, sampleCount: rows.length }
                    }
                };
            }

            // 5. VALIDATE / CHECK <sql>
            const validateMatch = trimmed.match(/^(?:VALIDATE|CHECK)\s+(.+)$/i);
            if (validateMatch) {
                const check = this.validate(validateMatch[1], params, { allowUnsafeWrite });
                return {
                    ok: check.valid,
                    kind: "validation",
                    elapsedMs: Date.now() - startTime,
                    warnings: check.warnings,
                    validation: check,
                    error: check.error,
                    hint: check.hint
                };
            }

            // 6. EXPLAIN <sql>
            const explainMatch = trimmed.match(/^EXPLAIN\s+(.+)$/i);
            if (explainMatch) {
                const plan = MCSQL.explain(explainMatch[1], params);
                return {
                    ok: true,
                    kind: "meta",
                    elapsedMs: Date.now() - startTime,
                    warnings: [],
                    meta: {
                        subtype: "EXPLAIN",
                        title: `EXPLAIN ${plan.statement} on ${plan.table}`,
                        lines: plan.storageCalls.map(c => `${c.method}(${JSON.stringify(c.args)})`),
                        payload: plan
                    }
                };
            }

            // 7. Standard SQL Query -> Validate first, then execute
            const check = this.validate(trimmed, params, { allowUnsafeWrite });
            if (!check.valid) {
                return {
                    ok: false,
                    kind: "error",
                    elapsedMs: Date.now() - startTime,
                    warnings: check.warnings,
                    error: check.error,
                    hint: check.hint
                };
            }

            const execResult = MCSQL.query(trimmed, params, { allowUnsafeWrite });
            const elapsedMs = Date.now() - startTime;

            if (Array.isArray(execResult)) {
                return {
                    ok: true,
                    kind: "rows",
                    elapsedMs,
                    warnings: check.warnings,
                    rows: execResult
                };
            }

            return {
                ok: true,
                kind: "mutation",
                elapsedMs,
                warnings: check.warnings,
                mutation: execResult
            };
        } catch (err) {
            return {
                ok: false,
                kind: "error",
                elapsedMs: Date.now() - startTime,
                warnings: [],
                error: String(err.message || err).replace(/^\[MCSQL(?:DataType)?\]\s*/i, ""),
                hint: this._buildHelpfulHint(err, trimmed)
            };
        }
    }

    /* =========================================================================
       INTERNAL SYNTAX & SEMANTIC HELPERS
    ========================================================================= */

    /**
     * Check balanced parentheses while respecting string literals.
     */
    static _checkBalancedDelimiters(sql) {
        let depth = 0;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inBacktick = false;

        for (let i = 0; i < sql.length; i++) {
            const ch = sql[i];
            if (inSingleQuote) {
                if (ch === "'" && sql[i + 1] === "'") { i++; continue; }
                if (ch === "\\") { i++; continue; }
                if (ch === "'") inSingleQuote = false;
                continue;
            }
            if (inDoubleQuote) {
                if (ch === '"') inDoubleQuote = false;
                continue;
            }
            if (inBacktick) {
                if (ch === "`") inBacktick = false;
                continue;
            }

            if (ch === "'") inSingleQuote = true;
            else if (ch === '"') inDoubleQuote = true;
            else if (ch === "`") inBacktick = true;
            else if (ch === "(") depth++;
            else if (ch === ")") {
                depth--;
                if (depth < 0) {
                    throw new SyntaxError(`Parentesi chiusa ')' in eccesso alla posizione ${i}.`);
                }
            }
        }

        if (depth > 0) {
            throw new SyntaxError(`Mancano ${depth} parentesi di chiusura ')'.`);
        }
    }

    /**
     * Recursively inspect AST nodes to verify all MCSQLDataType function calls before execution.
     */
    static _validateFunctionsInAst(node) {
        if (!node || typeof node !== "object") return;

        if (node.kind === "fnCall" || node.kind === "scalarFn") {
            const meta = MCSQLDataType.getMeta(node.fn);
            if (!meta) {
                throw new ReferenceError(`Funzione SQL sconosciuta '${node.fn}()'. Usa 'SHOW FUNCTIONS' per l'elenco.`);
            }
            const argCount = Array.isArray(node.args) ? node.args.length : 0;
            if (argCount < meta.minArgs || argCount > meta.maxArgs) {
                throw new RangeError(`La funzione ${meta.signature} ha ricevuto ${argCount} argomenti non validi.`);
            }
        }

        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const item of value) this._validateFunctionsInAst(item);
            } else if (value && typeof value === "object") {
                this._validateFunctionsInAst(value);
            }
        }
    }

    /**
     * Generate user-friendly diagnostic hints for common SQL mistakes.
     */
    static _buildHelpfulHint(err, sql) {
        const msg = String(err?.message || err);

        if (msg.includes("allowUnsafeWrite")) {
            return "Aggiungi una clausola WHERE (oppure 'WHERE ALL') o passa 'true' come secondo parametro in chat.";
        }
        if (msg.includes("Unclosed string literal")) {
            return "Controlla che tutte le stringhe siano racchiuse tra apici singoli 'testo'.";
        }
        if (msg.includes("16-character limit") || msg.includes("16 caratteri")) {
            return "In Minecraft Bedrock i nomi delle scoreboard (tabelle) possono avere al massimo 16 caratteri.";
        }
        if (/^SELECT\s+/i.test(sql) && !/\bFROM\b/i.test(sql)) {
            return "Se stai selezionando colonne di una tabella, assicurati di aver scritto 'FROM nome_tabella'.";
        }
        return undefined;
    }
}
