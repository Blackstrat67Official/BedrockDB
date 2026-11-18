/**
 * SQLTokenizer - Lexical Analyzer for MCSQL
 *
 * Converts raw SQL strings into structured tokens with exact source positions
 * and strict validation of unclosed strings or identifiers.
 */

export const SQL_KEYWORDS = new Set([
    "SELECT", "DISTINCT", "FROM", "WHERE", "AND", "OR", "NOT",
    "JOIN", "INNER", "LEFT", "OUTER", "ON",
    "IN", "BETWEEN", "LIKE", "CONTAINS", "REGEXP", "IS", "NULL",
    "ORDER", "BY", "ASC", "DESC", "LIMIT", "OFFSET", "GROUP",
    "AS", "INSERT", "INTO", "VALUES", "JSON", "UPDATE", "SET",
    "DELETE", "CREATE", "TABLE", "IF", "EXISTS", "DROP", "TRUNCATE",
    "RESTART", "IDENTITY", "TRUE", "FALSE", "ALL", "UNSET",
    "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "DEFAULT",
    "CASCADE", "RESTRICT", "ACTION", "NO", "ALTER", "ADD", "CONSTRAINT",
    "BEGIN", "START", "TRANSACTION", "COMMIT", "ROLLBACK", "SAVEPOINT",
    "TO", "RELEASE", "VIEW", "VIEWS", "REPLACE"
]);

export class SQLTokenizer {
    /**
     * Tokenize a SQL query string into an array of lexical tokens.
     * @param {string} input
     * @returns {Array<{ type: string, value: any, raw?: string, mode?: string, pos: number }>}
     */
    static tokenize(input) {
        if (typeof input !== "string") {
            throw new TypeError("[MCSQL] SQL input must be a string.");
        }

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
                const startPos = i;
                i += 2;
                let closed = false;
                while (i < len) {
                    if (input[i] === "*" && input[i + 1] === "/") {
                        i += 2;
                        closed = true;
                        break;
                    }
                    i++;
                }
                if (!closed) {
                    throw new SyntaxError(`[MCSQL] Unclosed multi-line comment '/*' starting at position ${startPos}.`);
                }
                continue;
            }

            // Single-quoted string literal ('...')
            if (ch === "'") {
                const startPos = i;
                let str = "";
                let closed = false;
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
                        closed = true;
                        break;
                    } else {
                        str += input[i++];
                    }
                }
                if (!closed) {
                    throw new SyntaxError(`[MCSQL] Unclosed string literal starting at position ${startPos}.`);
                }
                tokens.push({ type: "STRING", value: str, pos: startPos });
                continue;
            }

            // Backtick or double-quoted identifier (`col` or "col")
            if (ch === "`" || ch === '"') {
                const startPos = i;
                const quote = ch;
                let ident = "";
                let closed = false;
                i++;
                while (i < len) {
                    if (input[i] === quote) {
                        i++;
                        closed = true;
                        break;
                    }
                    ident += input[i++];
                }
                if (!closed) {
                    throw new SyntaxError(`[MCSQL] Unclosed quoted identifier (${quote}) starting at position ${startPos}.`);
                }
                if (ident.length === 0) {
                    throw new SyntaxError(`[MCSQL] Empty quoted identifier at position ${startPos}.`);
                }
                tokens.push({ type: "IDENT", value: ident, pos: startPos });
                continue;
            }

            // Positional placeholder: ? or $1, $2...
            if (ch === "?") {
                tokens.push({ type: "PARAM", mode: "positional", value: null, pos: i });
                i++;
                continue;
            }
            if (ch === "$" && /[0-9]/.test(input[i + 1] || "")) {
                const startPos = i;
                let num = "";
                i++;
                while (i < len && /[0-9]/.test(input[i])) num += input[i++];
                const idx = parseInt(num, 10) - 1;
                if (idx < 0) {
                    throw new SyntaxError(`[MCSQL] Positional parameter index must start at $1 (got $0 at pos ${startPos}).`);
                }
                tokens.push({ type: "PARAM", mode: "indexed", value: idx, pos: startPos });
                continue;
            }

            // Named placeholder: :paramName
            if (ch === ":" && /[a-zA-Z_]/.test(input[i + 1] || "")) {
                const startPos = i;
                let name = "";
                i++;
                while (i < len && /[a-zA-Z0-9_]/.test(input[i])) name += input[i++];
                tokens.push({ type: "PARAM", mode: "named", value: name, pos: startPos });
                continue;
            }

            // Numbers (integers & floats)
            if (/[0-9]/.test(ch)) {
                const startPos = i;
                let numStr = "";
                let dotCount = 0;
                while (i < len && /[0-9.]/.test(input[i])) {
                    if (input[i] === ".") dotCount++;
                    numStr += input[i++];
                }
                if (dotCount > 1 || numStr.endsWith(".")) {
                    throw new SyntaxError(`[MCSQL] Malformed number '${numStr}' at position ${startPos}.`);
                }
                tokens.push({ type: "NUMBER", value: Number(numStr), pos: startPos });
                continue;
            }

            // Two-character comparison operators
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

            // Identifiers & Keywords (supports dot-notation like stats.kills and alias.* like p.*)
            if (/[a-zA-Z_]/.test(ch)) {
                const startPos = i;
                let word = "";
                while (i < len && /[a-zA-Z0-9_.]/.test(input[i])) {
                    word += input[i++];
                }
                if (word.endsWith(".") && input[i] === "*") {
                    word += "*";
                    i++;
                } else if (word.endsWith(".") || word.includes("..")) {
                    throw new SyntaxError(`[MCSQL] Invalid identifier '${word}' at position ${startPos}.`);
                }

                const upper = word.toUpperCase();
                if (!word.includes(".") && SQL_KEYWORDS.has(upper)) {
                    tokens.push({ type: "KEYWORD", value: upper, raw: word, pos: startPos });
                } else {
                    tokens.push({ type: "IDENT", value: word, pos: startPos });
                }
                continue;
            }

            throw new SyntaxError(`[MCSQL] Unexpected character '${ch}' at position ${i}.`);
        }

        tokens.push({ type: "EOF", value: "EOF", pos: len });
        return tokens;
    }
}
