import { Storage } from "./Storage.js";

/**
 * MCSQL - SQL Interpreter & Compiler for Minecraft Bedrock Storage
 *
 * Parses real SQL statements into ASTs and translates them directly into
 * optimized calls on the Storage class.
 *
 * Supported SQL Statements:
 * - SELECT [DISTINCT] cols / alias.* / aggregates
 *     FROM table [alias]
 *     [INNER | LEFT [OUTER]] JOIN table2 [alias2] ON ...
 *     [WHERE ...] [GROUP BY ...] [ORDER BY ...] [LIMIT ...] [OFFSET ...]
 * - INSERT INTO table (cols) VALUES (...), (...)
 * - UPDATE table SET col = val, col = col + 1 WHERE ...
 * - DELETE FROM table WHERE ...
 * - CREATE TABLE [IF NOT EXISTS] table
 * - TRUNCATE [TABLE] table [RESTART IDENTITY]
 * - DROP TABLE [IF EXISTS] table
 * - Prepared Statements with positional (?, $1) and named (:param) placeholders
 */
export class MCSQL {
    /** @type {Map<string, CompiledQuery>} */
    static _planCache = new Map();
    static _maxPlanCache = 100;

    /* =========================================================================
       PUBLIC API
    ========================================================================= */

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
     * Pre-compile a SQL statement into a reusable executable object (avoids re-parsing in hot loops).
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

        const tokens = _Tokenizer.tokenize(sql);
        const parser = new _Parser(tokens, sql);
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
class CompiledQuery {
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
        const plan = _Compiler.buildPlan(this.ast, params, options);

        switch (plan.type) {
            case "CREATE_TABLE": {
                Storage._getObjective(plan.table, true);
                return { ok: true, table: plan.table, action: "created" };
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
                return _Compiler.executeSelect(plan);
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
        const plan = _Compiler.buildPlan(this.ast, params, { allowUnsafeWrite: true });
        return {
            statement: plan.type,
            table: plan.table,
            storageCalls: plan.previewCalls
        };
    }
}

/* =============================================================================
   TOKENIZER (LEXER)
============================================================================= */

const KEYWORDS = new Set([
    "SELECT", "DISTINCT", "FROM", "WHERE", "AND", "OR", "NOT",
    "JOIN", "INNER", "LEFT", "OUTER", "ON",
    "IN", "BETWEEN", "LIKE", "CONTAINS", "REGEXP", "IS", "NULL",
    "ORDER", "BY", "ASC", "DESC", "LIMIT", "OFFSET", "GROUP",
    "AS", "INSERT", "INTO", "VALUES", "JSON", "UPDATE", "SET",
    "DELETE", "CREATE", "TABLE", "IF", "EXISTS", "DROP", "TRUNCATE",
    "RESTART", "IDENTITY", "TRUE", "FALSE", "ALL", "UNSET"
]);

class _Tokenizer {
    static tokenize(input) {
        const tokens = [];
        let i = 0;
        const len = input.length;

        while (i < len) {
            const ch = input[i];

            // Skip whitespace
            if (/\s/.test(ch)) {
                i++;
                continue;
            }

            // Skip -- single-line comments
            if (ch === "-" && input[i + 1] === "-") {
                while (i < len && input[i] !== "\n") i++;
                continue;
            }

            // Skip /* */ multi-line comments
            if (ch === "/" && input[i + 1] === "*") {
                i += 2;
                while (i < len && !(input[i] === "*" && input[i + 1] === "/")) i++;
                i += 2;
                continue;
            }

            // Single-quoted string literal ('...')
            if (ch === "'") {
                let str = "";
                i++;
                while (i < len) {
                    if (input[i] === "'" && input[i + 1] === "'") {
                        str += "'";
                        i += 2;
                    } else if (input[i] === "\\" && i + 1 < len) {
                        str += input[i + 1];
                        i += 2;
                    } else if (input[i] === "'") {
                        i++;
                        break;
                    } else {
                        str += input[i++];
                    }
                }
                tokens.push({ type: "STRING", value: str, pos: i });
                continue;
            }

            // Backtick or double-quoted identifier (`col` or "col")
            if (ch === "`" || ch === '"') {
                const quote = ch;
                let ident = "";
                i++;
                while (i < len && input[i] !== quote) {
                    ident += input[i++];
                }
                if (input[i] === quote) i++;
                tokens.push({ type: "IDENT", value: ident, pos: i });
                continue;
            }

            // Positional placeholder: ? or $1, $2...
            if (ch === "?") {
                tokens.push({ type: "PARAM", mode: "positional", value: null, pos: i });
                i++;
                continue;
            }
            if (ch === "$" && /[0-9]/.test(input[i + 1] || "")) {
                let num = "";
                i++;
                while (i < len && /[0-9]/.test(input[i])) num += input[i++];
                tokens.push({ type: "PARAM", mode: "indexed", value: parseInt(num, 10) - 1, pos: i });
                continue;
            }

            // Named placeholder: :paramName
            if (ch === ":" && /[a-zA-Z_]/.test(input[i + 1] || "")) {
                let name = "";
                i++;
                while (i < len && /[a-zA-Z0-9_]/.test(input[i])) name += input[i++];
                tokens.push({ type: "PARAM", mode: "named", value: name, pos: i });
                continue;
            }

            // Numbers (integers & floats)
            if (/[0-9]/.test(ch)) {
                let numStr = "";
                while (i < len && /[0-9.]/.test(input[i])) numStr += input[i++];
                tokens.push({ type: "NUMBER", value: Number(numStr), pos: i });
                continue;
            }

            // Two-character operators
            const two = input.slice(i, i + 2);
            if (two === "!=" || two === "<>" || two === ">=" || two === "<=") {
                tokens.push({ type: "OP", value: two === "<>" ? "!=" : two, pos: i });
                i += 2;
                continue;
            }

            // Single-character operators & punctuation
            if ("=><+-*/(),;[]{}".includes(ch)) {
                tokens.push({ type: "PUNCT", value: ch, pos: i });
                i++;
                continue;
            }

            // Identifiers & Keywords (supports dot-notation and alias.* like p.name or p.*)
            if (/[a-zA-Z_]/.test(ch)) {
                let word = "";
                while (i < len && /[a-zA-Z0-9_.]/.test(input[i])) {
                    word += input[i++];
                }
                // Support table-scoped wildcard: alias.* (e.g., p.*)
                if (word.endsWith(".") && input[i] === "*") {
                    word += "*";
                    i++;
                }
                const upper = word.toUpperCase();
                if (!word.includes(".") && KEYWORDS.has(upper)) {
                    tokens.push({ type: "KEYWORD", value: upper, raw: word, pos: i });
                } else {
                    tokens.push({ type: "IDENT", value: word, pos: i });
                }
                continue;
            }

            throw new SyntaxError(`[MCSQL] Unexpected character '${ch}' at position ${i}.`);
        }

        tokens.push({ type: "EOF", value: "EOF", pos: len });
        return tokens;
    }
}

/* =============================================================================
   RECURSIVE DESCENT SQL PARSER
============================================================================= */

class _Parser {
    constructor(tokens, rawSql) {
        this.tokens = tokens;
        this.rawSql = rawSql;
        this.pos = 0;
        this.positionalParamCounter = 0;
    }

    peek(offset = 0) {
        return this.tokens[this.pos + offset] || this.tokens[this.tokens.length - 1];
    }

    consume() {
        return this.tokens[this.pos++];
    }

    matchKeyword(kw) {
        const tok = this.peek();
        if (tok.type === "KEYWORD" && tok.value === kw) {
            this.consume();
            return true;
        }
        return false;
    }

    expectKeyword(kw) {
        if (!this.matchKeyword(kw)) {
            const tok = this.peek();
            throw new SyntaxError(`[MCSQL] Expected keyword '${kw}', got '${tok.value}' at pos ${tok.pos}.`);
        }
    }

    matchPunct(ch) {
        const tok = this.peek();
        if ((tok.type === "PUNCT" || tok.type === "OP") && tok.value === ch) {
            this.consume();
            return true;
        }
        return false;
    }

    expectPunct(ch) {
        if (!this.matchPunct(ch)) {
            const tok = this.peek();
            throw new SyntaxError(`[MCSQL] Expected '${ch}', got '${tok.value}' at pos ${tok.pos}.`);
        }
    }

    parseIdentifier() {
        const tok = this.peek();
        if (tok.type === "IDENT" || tok.type === "KEYWORD") {
            this.consume();
            return tok.type === "IDENT" ? tok.value : tok.raw;
        }
        throw new SyntaxError(`[MCSQL] Expected identifier, got '${tok.value}' at pos ${tok.pos}.`);
    }

    parseTableAlias(defaultAlias) {
        if (this.matchKeyword("AS")) {
            return this.parseIdentifier();
        }
        const tok = this.peek();
        if (tok.type === "IDENT") {
            return this.parseIdentifier();
        }
        return defaultAlias;
    }

    parseStatement() {
        const tok = this.peek();
        if (tok.type !== "KEYWORD") {
            throw new SyntaxError(`[MCSQL] Unexpected token '${tok.value}' at start of SQL statement.`);
        }

        let ast;
        switch (tok.value) {
            case "SELECT":
                ast = this.parseSelect();
                break;
            case "INSERT":
                ast = this.parseInsert();
                break;
            case "UPDATE":
                ast = this.parseUpdate();
                break;
            case "DELETE":
                ast = this.parseDelete();
                break;
            case "CREATE":
                ast = this.parseCreateTable();
                break;
            case "DROP":
                ast = this.parseDropTable();
                break;
            case "TRUNCATE":
                ast = this.parseTruncate();
                break;
            default:
                throw new SyntaxError(`[MCSQL] Unsupported SQL command '${tok.value}'.`);
        }

        this.matchPunct(";");
        if (this.peek().type !== "EOF") {
            throw new SyntaxError(`[MCSQL] Unexpected trailing token '${this.peek().value}'.`);
        }
        return ast;
    }

    /* ----------------------------- DDL PARSERS ----------------------------- */

    parseCreateTable() {
        this.expectKeyword("CREATE");
        this.expectKeyword("TABLE");
        let ifNotExists = false;
        if (this.matchKeyword("IF")) {
            this.expectKeyword("NOT");
            this.expectKeyword("EXISTS");
            ifNotExists = true;
        }
        const table = this.parseIdentifier();
        if (this.matchPunct("(")) {
            let depth = 1;
            while (depth > 0 && this.peek().type !== "EOF") {
                const t = this.consume();
                if (t.value === "(") depth++;
                else if (t.value === ")") depth--;
            }
        }
        return { type: "CREATE_TABLE", table, ifNotExists };
    }

    parseDropTable() {
        this.expectKeyword("DROP");
        this.expectKeyword("TABLE");
        let ifExists = false;
        if (this.matchKeyword("IF")) {
            this.expectKeyword("EXISTS");
            ifExists = true;
        }
        const table = this.parseIdentifier();
        return { type: "DROP_TABLE", table, ifExists };
    }

    parseTruncate() {
        this.expectKeyword("TRUNCATE");
        this.matchKeyword("TABLE");
        const table = this.parseIdentifier();
        let restartIdentity = false;
        if (this.matchKeyword("RESTART")) {
            this.expectKeyword("IDENTITY");
            restartIdentity = true;
        }
        return { type: "TRUNCATE", table, restartIdentity };
    }

    /* ---------------------------- INSERT PARSER ---------------------------- */

    parseInsert() {
        this.expectKeyword("INSERT");
        this.expectKeyword("INTO");
        const table = this.parseIdentifier();

        if (this.matchKeyword("JSON")) {
            const payload = this.parseValueNode();
            return { type: "INSERT", table, mode: "json", payloads: [payload] };
        }

        const columns = [];
        if (this.matchPunct("(")) {
            do {
                columns.push(this.parseIdentifier());
            } while (this.matchPunct(","));
            this.expectPunct(")");
        } else {
            throw new SyntaxError("[MCSQL] INSERT INTO requires a column list '(col1, col2, ...)' or JSON keyword.");
        }

        this.expectKeyword("VALUES");

        const rows = [];
        do {
            this.expectPunct("(");
            const values = [];
            do {
                values.push(this.parseValueNode());
            } while (this.matchPunct(","));
            this.expectPunct(")");

            if (values.length !== columns.length) {
                throw new SyntaxError(`[MCSQL] Column count (${columns.length}) does not match value count (${values.length}).`);
            }
            rows.push(values);
        } while (this.matchPunct(","));

        return { type: "INSERT", table, mode: "columns", columns, rows };
    }

    /* ---------------------------- UPDATE PARSER ---------------------------- */

    parseUpdate() {
        this.expectKeyword("UPDATE");
        const table = this.parseIdentifier();
        this.expectKeyword("SET");

        const assignments = [];
        do {
            if (this.matchKeyword("UNSET")) {
                const col = this.parseIdentifier();
                assignments.push({ col, kind: "unset" });
                continue;
            }

            const col = this.parseIdentifier();
            this.expectPunct("=");

            const nextTok = this.peek();
            const afterTok = this.peek(1);
            if (
                (nextTok.type === "IDENT" && nextTok.value === col) &&
                (afterTok.type === "PUNCT" && (afterTok.value === "+" || afterTok.value === "-"))
            ) {
                this.consume();
                const op = this.consume().value;
                const deltaNode = this.parseValueNode();
                assignments.push({ col, kind: "inc", op, delta: deltaNode });
            } else {
                const valueNode = this.parseValueNode();
                assignments.push({ col, kind: "set", value: valueNode });
            }
        } while (this.matchPunct(","));

        let where = null;
        if (this.matchKeyword("WHERE")) {
            where = this.parseWhere();
        }

        return { type: "UPDATE", table, assignments, where };
    }

    /* ---------------------------- DELETE PARSER ---------------------------- */

    parseDelete() {
        this.expectKeyword("DELETE");
        this.expectKeyword("FROM");
        const table = this.parseIdentifier();

        let where = null;
        if (this.matchKeyword("WHERE")) {
            where = this.parseWhere();
        }

        return { type: "DELETE", table, where };
    }

    /* ---------------------------- SELECT PARSER ---------------------------- */

    parseSelect() {
        this.expectKeyword("SELECT");
        const distinct = this.matchKeyword("DISTINCT");

        const selectItems = [];
        if (this.matchPunct("*")) {
            selectItems.push({ kind: "wildcard" });
        } else {
            do {
                selectItems.push(this.parseSelectItem());
            } while (this.matchPunct(","));
        }

        this.expectKeyword("FROM");
        const table = this.parseIdentifier();
        const tableAlias = this.parseTableAlias(table);

        // Parse optional INNER JOIN / LEFT [OUTER] JOIN clauses
        const joins = [];
        while (true) {
            let joinType = null;
            if (this.matchKeyword("INNER")) {
                this.expectKeyword("JOIN");
                joinType = "INNER";
            } else if (this.matchKeyword("LEFT")) {
                this.matchKeyword("OUTER");
                this.expectKeyword("JOIN");
                joinType = "LEFT";
            } else if (this.matchKeyword("JOIN")) {
                joinType = "INNER";
            } else {
                break;
            }

            const joinTable = this.parseIdentifier();
            const joinAlias = this.parseTableAlias(joinTable);
            this.expectKeyword("ON");
            const on = this.parseOr(true);

            joins.push({
                joinType,
                table: joinTable,
                alias: joinAlias,
                on
            });
        }

        let where = null;
        if (this.matchKeyword("WHERE")) {
            where = this.parseWhere(joins.length > 0);
        }

        let groupBy = null;
        if (this.matchKeyword("GROUP")) {
            this.expectKeyword("BY");
            groupBy = this.parseIdentifier();
        }

        const orderBy = [];
        if (this.matchKeyword("ORDER")) {
            this.expectKeyword("BY");
            do {
                const field = this.parseIdentifier();
                let dir = "ASC";
                if (this.matchKeyword("ASC")) dir = "ASC";
                else if (this.matchKeyword("DESC")) dir = "DESC";
                orderBy.push({ field, dir });
            } while (this.matchPunct(","));
        }

        let limit = null;
        let offset = 0;
        if (this.matchKeyword("LIMIT")) {
            const firstNum = this.parseValueNode();
            if (this.matchPunct(",")) {
                offset = firstNum;
                limit = this.parseValueNode();
            } else {
                limit = firstNum;
                if (this.matchKeyword("OFFSET")) {
                    offset = this.parseValueNode();
                }
            }
        } else if (this.matchKeyword("OFFSET")) {
            offset = this.parseValueNode();
        }

        return {
            type: "SELECT",
            table,
            tableAlias,
            joins,
            distinct,
            selectItems,
            where,
            groupBy,
            orderBy,
            limit,
            offset
        };
    }

    parseSelectItem() {
        const tok = this.peek();
        const next = this.peek(1);

        // Table-scoped wildcard: e.g. SELECT p.*, h.name AS homeName
        if (tok.type === "IDENT" && tok.value.endsWith(".*")) {
            this.consume();
            const alias = tok.value.slice(0, -2);
            return { kind: "tableWildcard", alias };
        }

        // SQL Aggregate Function: COUNT(*), COUNT(h.id), SUM(coins), AVG(level), MIN(x), MAX(x)
        if ((tok.type === "IDENT" || tok.type === "KEYWORD") && next.value === "(") {
            const fnName = tok.value.toUpperCase();
            if (["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(fnName)) {
                this.consume();
                this.expectPunct("(");
                let field = "*";
                if (!this.matchPunct("*")) {
                    field = this.parseIdentifier();
                }
                this.expectPunct(")");

                const cleanField = field === "*" ? "all" : (field.includes(".") ? field.split(".").pop() : field);
                const alias = this.parseOptionalAlias(`${fnName.toLowerCase()}_${cleanField}`);
                return { kind: "aggregate", fn: fnName, field, alias };
            }
        }

        // Standard column or qualified/nested field (e.g. name, p.name, p.stats.kills)
        const col = this.parseIdentifier();
        const defaultAlias = col.includes(".") ? col.split(".").pop() : col;
        const alias = this.parseOptionalAlias(defaultAlias);
        return { kind: "column", col, alias };
    }

    parseOptionalAlias(fallback) {
        if (this.matchKeyword("AS")) {
            return this.parseIdentifier();
        }
        const tok = this.peek();
        if (tok.type === "IDENT") {
            return this.parseIdentifier();
        }
        return fallback;
    }

    /* ----------------------- WHERE EXPRESSION PARSER ----------------------- */

    parseWhere(allowColumnRhs = false) {
        if (this.matchKeyword("ALL")) {
            return { kind: "all" };
        }
        return this.parseOr(allowColumnRhs);
    }

    parseOr(allowColumnRhs = false) {
        const terms = [this.parseAnd(allowColumnRhs)];
        while (this.matchKeyword("OR")) {
            terms.push(this.parseAnd(allowColumnRhs));
        }
        return terms.length === 1 ? terms[0] : { kind: "or", terms };
    }

    parseAnd(allowColumnRhs = false) {
        const terms = [this.parseNot(allowColumnRhs)];
        while (this.matchKeyword("AND")) {
            terms.push(this.parseNot(allowColumnRhs));
        }
        return terms.length === 1 ? terms[0] : { kind: "and", terms };
    }

    parseNot(allowColumnRhs = false) {
        if (this.matchKeyword("NOT")) {
            return { kind: "not", expr: this.parseNot(allowColumnRhs) };
        }
        return this.parsePrimaryCondition(allowColumnRhs);
    }

    parsePrimaryCondition(allowColumnRhs = false) {
        if (this.matchPunct("(")) {
            const expr = this.parseOr(allowColumnRhs);
            this.expectPunct(")");
            return expr;
        }

        const col = this.parseIdentifier();

        // IS [NOT] NULL
        if (this.matchKeyword("IS")) {
            const isNot = this.matchKeyword("NOT");
            this.expectKeyword("NULL");
            return { kind: "isNull", col, isNot };
        }

        const negated = this.matchKeyword("NOT");

        if (this.matchKeyword("IN")) {
            this.expectPunct("(");
            const items = [];
            do {
                items.push(this.parseValueNode(false));
            } while (this.matchPunct(","));
            this.expectPunct(")");
            return { kind: "in", col, items, negated };
        }

        if (this.matchKeyword("BETWEEN")) {
            const min = this.parseValueNode(allowColumnRhs);
            this.expectKeyword("AND");
            const max = this.parseValueNode(allowColumnRhs);
            return { kind: "between", col, min, max, negated };
        }

        if (this.matchKeyword("LIKE")) {
            const pattern = this.parseValueNode(false);
            return { kind: "like", col, pattern, negated };
        }

        if (this.matchKeyword("CONTAINS")) {
            const target = this.parseValueNode(false);
            return { kind: "contains", col, target, negated };
        }

        if (this.matchKeyword("REGEXP")) {
            const pattern = this.parseValueNode(false);
            return { kind: "regexp", col, pattern, negated };
        }

        if (negated) {
            throw new SyntaxError(`[MCSQL] Unexpected 'NOT' before operator on column '${col}'.`);
        }

        const opTok = this.peek();
        if ((opTok.type === "OP" || opTok.type === "PUNCT") && ["=", "!=", ">", ">=", "<", "<="].includes(opTok.value)) {
            this.consume();
            const val = this.parseValueNode(allowColumnRhs);
            return { kind: "cmp", col, op: opTok.value, val };
        }

        throw new SyntaxError(`[MCSQL] Expected comparison operator after '${col}', got '${opTok.value}'.`);
    }

    /* ------------------------- LITERALS & PARAMS --------------------------- */

    parseValueNode(allowColumnRef = false) {
        const tok = this.peek();

        // Unary minus for negative numbers: -50
        if (tok.type === "PUNCT" && tok.value === "-") {
            this.consume();
            const next = this.peek();
            if (next.type === "NUMBER") {
                this.consume();
                return { kind: "literal", value: -next.value };
            }
            if (next.type === "PARAM") {
                const paramNode = this.parseValueNode(false);
                return { kind: "negParam", param: paramNode };
            }
            throw new SyntaxError(`[MCSQL] Expected number after '-' at pos ${tok.pos}.`);
        }

        if (tok.type === "STRING" || tok.type === "NUMBER") {
            this.consume();
            return { kind: "literal", value: tok.value };
        }

        if (tok.type === "KEYWORD") {
            if (tok.value === "TRUE") {
                this.consume();
                return { kind: "literal", value: true };
            }
            if (tok.value === "FALSE") {
                this.consume();
                return { kind: "literal", value: false };
            }
            if (tok.value === "NULL") {
                this.consume();
                return { kind: "literal", value: null };
            }
        }

        if (tok.type === "PARAM") {
            this.consume();
            if (tok.mode === "positional") {
                return { kind: "param", mode: "indexed", index: this.positionalParamCounter++ };
            }
            if (tok.mode === "indexed") {
                return { kind: "param", mode: "indexed", index: tok.value };
            }
            return { kind: "param", mode: "named", name: tok.value };
        }

        // Column reference on RHS of ON / JOIN WHERE (e.g., ON p.uuid = h.ownerUuid)
        if (allowColumnRef && tok.type === "IDENT") {
            this.consume();
            return { kind: "columnRef", name: tok.value };
        }

        // Inline JSON array literal: ['a', 'b']
        if (tok.type === "PUNCT" && tok.value === "[") {
            this.consume();
            const arr = [];
            if (!this.matchPunct("]")) {
                do {
                    arr.push(this.parseValueNode(false));
                } while (this.matchPunct(","));
                this.expectPunct("]");
            }
            return { kind: "arrayLiteral", items: arr };
        }

        throw new SyntaxError(`[MCSQL] Expected literal value or parameter placeholder, got '${tok.value}' at pos ${tok.pos}.`);
    }
}

/* =============================================================================
   AST TO STORAGE COMPILER & EXECUTOR
============================================================================= */

class _Compiler {
    static resolveValue(node, params) {
        if (node === null || node === undefined || typeof node !== "object" || !node.kind) {
            return node;
        }
        switch (node.kind) {
            case "literal":
                return node.value;
            case "negParam": {
                const v = this.resolveValue(node.param, params);
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
                return node.items.map(item => this.resolveValue(item, params));
            default:
                return node;
        }
    }

    /**
     * Compile SQL WHERE AST into a native Storage `where` object (for single-table queries).
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

    static buildPlan(ast, params, options) {
        switch (ast.type) {
            case "CREATE_TABLE":
                return {
                    type: "CREATE_TABLE",
                    table: ast.table,
                    previewCalls: [{ method: "Storage._getObjective", args: [ast.table, true] }]
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
                const hasNestedPaths = ast.assignments.some(a => a.col.includes("."));

                let changes;
                if (!hasNestedPaths) {
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
                    const resolvedOps = ast.assignments.map(item => ({
                        col: item.col,
                        kind: item.kind,
                        op: item.op,
                        val: item.kind === "inc"
                            ? this.resolveValue(item.delta, params)
                            : item.kind === "set"
                                ? this.resolveValue(item.value, params)
                                : undefined
                    }));

                    changes = (oldData) => {
                        const copy = Storage._clone(oldData);
                        for (const opItem of resolvedOps) {
                            if (opItem.kind === "unset") {
                                const parts = opItem.col.split(".");
                                const last = parts.pop();
                                const target = parts.reduce((acc, k) => acc?.[k], copy);
                                if (target && typeof target === "object") delete target[last];
                            } else if (opItem.kind === "inc") {
                                const curr = Storage._getNestedValue(copy, opItem.col) || 0;
                                const delta = opItem.op === "-" ? -opItem.val : opItem.val;
                                this.setNestedProperty(copy, opItem.col, curr + delta);
                            } else {
                                this.setNestedProperty(copy, opItem.col, opItem.val);
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
                const limit = ast.limit !== null ? this.resolveValue(ast.limit, params) : undefined;
                const offset = ast.offset ? this.resolveValue(ast.offset, params) : 0;

                // If JOIN clauses are present, route to the multi-table Hash Join planner
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

                // Single-table fast path
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

                let columns = "*";
                let requestedKeys = null;

                if (ast.selectItems[0].kind !== "wildcard") {
                    columns = {};
                    requestedKeys = [];
                    for (const item of ast.selectItems) {
                        if (item.kind === "wildcard") {
                            throw new SyntaxError("[MCSQL] Cannot combine '*' with explicit column names.");
                        }
                        if (item.kind === "tableWildcard") {
                            if (item.alias !== ast.tableAlias) {
                                throw new ReferenceError(`[MCSQL] Unknown table alias '${item.alias}'.`);
                            }
                            columns = "*";
                            requestedKeys = null;
                            break;
                        }
                        columns[item.alias] = stripAlias(item.col);
                        requestedKeys.push(item.alias);
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

    static executeSelect(plan) {
        if (plan.mode === "join") {
            return this.executeJoinedSelect(plan);
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
        rows = this._applyOrderAndPagination(rows, plan.orderBy, plan.offset, plan.limit);
        return rows;
    }

    /* =========================================================================
       MULTI-TABLE HASH JOIN ENGINE (INNER JOIN & LEFT JOIN)
    ========================================================================= */

    /**
     * Resolve a qualified (`p.name`, `h.x`, `p.stats.kills`) or unqualified (`coins`) column
     * against a joined row scope `{ [alias]: rowObject | null }`.
     */
    static _resolveScopeField(scope, colRef, activeAliases) {
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

        // Unqualified column: search across active table scopes in order
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
    static _evalScopeExpr(node, scope, activeAliases, params) {
        if (!node || node.kind === "all") return true;

        switch (node.kind) {
            case "or":
                return node.terms.some(t => this._evalScopeExpr(t, scope, activeAliases, params));

            case "and":
                return node.terms.every(t => this._evalScopeExpr(t, scope, activeAliases, params));

            case "not":
                return !this._evalScopeExpr(node.expr, scope, activeAliases, params);

            case "isNull": {
                const val = this._resolveScopeField(scope, node.col, activeAliases);
                const isNull = val === undefined || val === null;
                return node.isNot ? !isNull : isNull;
            }

            case "in": {
                const actual = this._resolveScopeField(scope, node.col, activeAliases);
                let items = node.items.map(i => this.resolveValue(i, params));
                if (items.length === 1 && Array.isArray(items[0])) items = items[0];
                const hit = items.includes(actual);
                return node.negated ? !hit : hit;
            }

            case "between": {
                const actual = this._resolveScopeField(scope, node.col, activeAliases);
                const min = this.resolveValue(node.min, params);
                const max = this.resolveValue(node.max, params);
                const hit = actual !== undefined && actual !== null && actual >= min && actual <= max;
                return node.negated ? !hit : hit;
            }

            case "like": {
                const actual = this._resolveScopeField(scope, node.col, activeAliases);
                const pattern = this.resolveValue(node.pattern, params);
                if (typeof actual !== "string" || typeof pattern !== "string") return Boolean(node.negated);
                const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const regexStr = "^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$";
                const hit = new RegExp(regexStr, "i").test(actual);
                return node.negated ? !hit : hit;
            }

            case "contains": {
                const actual = this._resolveScopeField(scope, node.col, activeAliases);
                const target = this.resolveValue(node.target, params);
                const hit = (Array.isArray(actual) || typeof actual === "string") && actual.includes(target);
                return node.negated ? !hit : hit;
            }

            case "regexp": {
                const actual = this._resolveScopeField(scope, node.col, activeAliases);
                const pattern = this.resolveValue(node.pattern, params);
                const rx = pattern instanceof RegExp ? pattern : new RegExp(pattern);
                const hit = typeof actual === "string" && rx.test(actual);
                return node.negated ? !hit : hit;
            }

            case "cmp": {
                const leftVal = this._resolveScopeField(scope, node.col, activeAliases);
                const rightVal = node.val && node.val.kind === "columnRef"
                    ? this._resolveScopeField(scope, node.val.name, activeAliases)
                    : this.resolveValue(node.val, params);

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
     * Extract an equi-join key pair from the top-level ON clause so we can build an O(1) Hash Index.
     */
    static _extractEquiJoinPair(onNode, joinAlias, previousAliases) {
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
    static executeJoinedSelect(plan) {
        const activeAliases = [plan.tableAlias];
        const baseRows = Storage.select(plan.table, { flat: true });

        // Initialize tuple scopes: [{ [tableAlias]: row }]
        let scopes = baseRows.map(row => ({ [plan.tableAlias]: row }));

        // Sequentially execute each JOIN using Hash Join when an equality ON key is available
        for (const join of plan.joins) {
            if (activeAliases.includes(join.alias)) {
                throw new Error(`[MCSQL] Duplicate table alias '${join.alias}' in JOIN query.`);
            }

            const rightRows = Storage.select(join.table, { flat: true });
            const nextAliases = [...activeAliases, join.alias];
            const equiPair = this._extractEquiJoinPair(join.on, join.alias, activeAliases);

            const nextScopes = [];

            if (equiPair) {
                // Build O(1) hash map on right table
                const hashIndex = new Map();
                for (const rRow of rightRows) {
                    const rKey = this._resolveScopeField({ [join.alias]: rRow }, equiPair.rightKey, [join.alias]);
                    if (rKey === undefined || rKey === null) continue;
                    if (!hashIndex.has(rKey)) hashIndex.set(rKey, []);
                    hashIndex.get(rKey).push(rRow);
                }

                for (const scope of scopes) {
                    const lKey = this._resolveScopeField(scope, equiPair.leftKey, activeAliases);
                    const bucket = (lKey !== undefined && lKey !== null) ? hashIndex.get(lKey) : null;
                    let matchedCount = 0;

                    if (bucket) {
                        for (const rRow of bucket) {
                            const candidateScope = { ...scope, [join.alias]: rRow };
                            if (this._evalScopeExpr(join.on, candidateScope, nextAliases, plan.params)) {
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
                // General nested-loop join for non-equi ON conditions
                for (const scope of scopes) {
                    let matchedCount = 0;
                    for (const rRow of rightRows) {
                        const candidateScope = { ...scope, [join.alias]: rRow };
                        if (this._evalScopeExpr(join.on, candidateScope, nextAliases, plan.params)) {
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

        // Apply post-join WHERE filter
        if (plan.whereAst) {
            scopes = scopes.filter(scope => this._evalScopeExpr(plan.whereAst, scope, activeAliases, plan.params));
        }

        // Handle Aggregate + GROUP BY on joined scopes
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
                            // SQL standard: COUNT(col) ignores NULL values (essential for LEFT JOIN!)
                            out[agg.alias] = groupScopes.reduce((acc, sc) => {
                                const v = this._resolveScopeField(sc, agg.field, activeAliases);
                                return v !== undefined && v !== null ? acc + 1 : acc;
                            }, 0);
                        }
                        continue;
                    }

                    const nums = groupScopes
                        .map(sc => this._resolveScopeField(sc, agg.field, activeAliases))
                        .filter(v => typeof v === "number" && !isNaN(v));

                    if (nums.length === 0) {
                        out[agg.alias] = 0;
                    } else if (agg.fn === "SUM") {
                        out[agg.alias] = nums.reduce((a, b) => a + b, 0);
                    } else if (agg.fn === "AVG") {
                        out[agg.alias] = nums.reduce((a, b) => a + b, 0) / nums.length;
                    } else if (agg.fn === "MIN") {
                        out[agg.alias] = Math.min(...nums);
                    } else if (agg.fn === "MAX") {
                        out[agg.alias] = Math.max(...nums);
                    }
                }
                return out;
            };

            let aggRows;
            if (!plan.groupBy) {
                aggRows = [computeAggRow(scopes, null)];
            } else {
                const groups = new Map();
                for (const sc of scopes) {
                    const gVal = this._resolveScopeField(sc, plan.groupBy, activeAliases) ?? null;
                    const mapKey = JSON.stringify(gVal);
                    if (!groups.has(mapKey)) groups.set(mapKey, { val: gVal, list: [] });
                    groups.get(mapKey).list.push(sc);
                }
                aggRows = [...groups.values()].map(g => computeAggRow(g.list, g.val));
            }

            return this._applyOrderAndPagination(aggRows, plan.orderBy, plan.offset, plan.limit);
        }

        // Standard multi-table projection + ORDER BY + DISTINCT + LIMIT/OFFSET
        // Sort before projection so ORDER BY can reference unprojected columns
        if (plan.orderBy && plan.orderBy.length > 0) {
            scopes.sort((a, b) => {
                for (const { field, dir } of plan.orderBy) {
                    const mult = dir === "DESC" ? -1 : 1;
                    const valA = this._resolveScopeField(a, field, activeAliases);
                    const valB = this._resolveScopeField(b, field, activeAliases);
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
                } else {
                    const val = this._resolveScopeField(scope, item.col, activeAliases);
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

    static _applyOrderAndPagination(rows, orderBy, offset, limit) {
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
