import { SQLTokenizer } from "./SQLTokenizer.js";

const AGGREGATE_FUNCTIONS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

/**
 * SQLParser - Recursive Descent Parser for MCSQL
 *
 * Builds validated Abstract Syntax Trees (ASTs) for:
 * - SELECT (with optional FROM, INNER/LEFT JOIN, scalar/aggregate functions, WHERE, GROUP BY, ORDER BY, LIMIT, OFFSET)
 * - INSERT INTO (columns + VALUES or JSON payload, supporting function calls like UUID() and NOW())
 * - UPDATE (SET assignments, atomic increments, UNSET, and WHERE)
 * - DELETE FROM
 * - CREATE TABLE / DROP TABLE / TRUNCATE TABLE
 */
export class SQLParser {
    constructor(tokens, rawSql = "") {
        this.tokens = tokens;
        this.rawSql = rawSql;
        this.pos = 0;
        this.positionalParamCounter = 0;
    }

    /**
     * Convenience helper to tokenize and parse a SQL string in one call.
     * @param {string} sql
     * @returns {object} AST root node
     */
    static parse(sql) {
        const tokens = SQLTokenizer.tokenize(sql);
        const parser = new SQLParser(tokens, sql);
        return parser.parseStatement();
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
            throw new SyntaxError(`[MCSQL] Unexpected trailing token '${this.peek().value}' at pos ${this.peek().pos}.`);
        }
        return ast;
    }

    /* =========================================================================
       DDL PARSERS (CREATE, DROP, TRUNCATE)
    ========================================================================= */

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

        // Optional SQL column schema block (...) for standard SQL compatibility
        if (this.matchPunct("(")) {
            let depth = 1;
            while (depth > 0 && this.peek().type !== "EOF") {
                const t = this.consume();
                if (t.value === "(") depth++;
                else if (t.value === ")") depth--;
            }
            if (depth !== 0) {
                throw new SyntaxError("[MCSQL] Unclosed '(' in CREATE TABLE column definition.");
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

    /* =========================================================================
       INSERT PARSER
    ========================================================================= */

    parseInsert() {
        this.expectKeyword("INSERT");
        this.expectKeyword("INTO");
        const table = this.parseIdentifier();

        if (this.matchKeyword("JSON")) {
            const payload = this.parseValueNode(false);
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
                values.push(this.parseValueNode(false));
            } while (this.matchPunct(","));
            this.expectPunct(")");

            if (values.length !== columns.length) {
                throw new SyntaxError(`[MCSQL] Column count (${columns.length}) does not match value count (${values.length}).`);
            }
            rows.push(values);
        } while (this.matchPunct(","));

        return { type: "INSERT", table, mode: "columns", columns, rows };
    }

    /* =========================================================================
       UPDATE PARSER
    ========================================================================= */

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
                const deltaNode = this.parseValueNode(false);
                assignments.push({ col, kind: "inc", op, delta: deltaNode });
            } else {
                const valueNode = this.parseValueNode(true);
                assignments.push({ col, kind: "set", value: valueNode });
            }
        } while (this.matchPunct(","));

        let where = null;
        if (this.matchKeyword("WHERE")) {
            where = this.parseWhere(false);
        }

        return { type: "UPDATE", table, assignments, where };
    }

    /* =========================================================================
       DELETE PARSER
    ========================================================================= */

    parseDelete() {
        this.expectKeyword("DELETE");
        this.expectKeyword("FROM");
        const table = this.parseIdentifier();

        let where = null;
        if (this.matchKeyword("WHERE")) {
            where = this.parseWhere(false);
        }

        return { type: "DELETE", table, where };
    }

    /* =========================================================================
       SELECT PARSER
    ========================================================================= */

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

        // Optional FROM clause (allows dual-less queries like `SELECT UUID(), NOW()`)
        if (!this.matchKeyword("FROM")) {
            return {
                type: "SELECT",
                table: null,
                tableAlias: null,
                joins: [],
                distinct,
                selectItems,
                where: null,
                groupBy: null,
                orderBy: [],
                limit: null,
                offset: 0
            };
        }

        const table = this.parseIdentifier();
        const tableAlias = this.parseTableAlias(table);

        // Optional INNER JOIN / LEFT [OUTER] JOIN clauses
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
            const firstNum = this.parseValueNode(false);
            if (this.matchPunct(",")) {
                offset = firstNum;
                limit = this.parseValueNode(false);
            } else {
                limit = firstNum;
                if (this.matchKeyword("OFFSET")) {
                    offset = this.parseValueNode(false);
                }
            }
        } else if (this.matchKeyword("OFFSET")) {
            offset = this.parseValueNode(false);
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

        // Function call in SELECT list: either Aggregate (COUNT, SUM, ...) or Scalar MCSQLDataType (UUID(), UPPER(name), ...)
        if ((tok.type === "IDENT" || tok.type === "KEYWORD") && next.value === "(") {
            const fnName = tok.value.toUpperCase();

            if (AGGREGATE_FUNCTIONS.has(fnName)) {
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

            // Scalar function from MCSQLDataType (e.g., UUID(), NOW(), UPPER(name), CONCAT(a, b))
            const fnNode = this.parseFunctionCall(true);
            const alias = this.parseOptionalAlias(fnName.toLowerCase());
            return { kind: "scalarFn", fn: fnNode.fn, args: fnNode.args, alias };
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

    /* =========================================================================
       WHERE EXPRESSION PARSER
    ========================================================================= */

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

        throw new SyntaxError(`[MCSQL] Expected comparison operator after '${col}', got '${opTok.value}' at pos ${opTok.pos}.`);
    }

    /* =========================================================================
       LITERALS, PARAMETERS & FUNCTION CALLS
    ========================================================================= */

    parseFunctionCall(allowColumnRef = false) {
        const nameTok = this.consume();
        const fnName = String(nameTok.type === "IDENT" ? nameTok.value : nameTok.raw).toUpperCase();
        this.expectPunct("(");

        const args = [];
        if (!this.matchPunct(")")) {
            do {
                args.push(this.parseValueNode(allowColumnRef));
            } while (this.matchPunct(","));
            this.expectPunct(")");
        }

        return { kind: "fnCall", fn: fnName, args };
    }

    parseValueNode(allowColumnRef = false) {
        const tok = this.peek();
        const next = this.peek(1);

        // Function invocation: UUID(), NOW(), UPPER(name), RAND_INT(1, 10), etc.
        if ((tok.type === "IDENT" || tok.type === "KEYWORD") && next.value === "(") {
            return this.parseFunctionCall(allowColumnRef);
        }

        // Unary minus for negative numbers: -50
        if (tok.type === "PUNCT" && tok.value === "-") {
            this.consume();
            const afterMinus = this.peek();
            if (afterMinus.type === "NUMBER") {
                this.consume();
                return { kind: "literal", value: -afterMinus.value };
            }
            if (afterMinus.type === "PARAM") {
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

        // Column reference (used in JOIN ON, SELECT scalarFn(col), or UPDATE SET a = b)
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

        throw new SyntaxError(`[MCSQL] Expected literal value, function call, or parameter placeholder, got '${tok.value}' at pos ${tok.pos}.`);
    }
}
