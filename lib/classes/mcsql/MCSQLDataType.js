/**
 * MCSQLDataType - Custom SQL Functions & Dynamic Data Types Registry
 *
 * Allows built-in and developer-defined functions (e.g., UUID(), NOW(), UPPER(col),
 * CONCAT(...), RAND_INT(min, max)) to be invoked directly inside MCSQL queries
 * (SELECT, INSERT VALUES, UPDATE SET, and WHERE clauses).
 */
export class MCSQLDataType {
    /**
     * Registry of available SQL scalar functions / dynamic data types.
     * @type {Map<string, {
     *   handler: (args: any[], context: { row?: any, params?: any }) => any,
     *   minArgs: number,
     *   maxArgs: number,
     *   description: string,
     *   signature: string
     * }>}
     */
    static _registry = new Map();

    /**
     * Register a custom SQL function or dynamic data type.
     *
     * @param {string} name - Case-insensitive SQL function name (e.g., "UUID", "PLAYER_TAG").
     * @param {(args: any[], context: { row?: any, params?: any }) => any} handler - Evaluation callback.
     * @param {object} [meta]
     * @param {number} [meta.minArgs=0] - Minimum required arguments.
     * @param {number} [meta.maxArgs=Infinity] - Maximum allowed arguments.
     * @param {string} [meta.signature] - Display signature for SHOW FUNCTIONS.
     * @param {string} [meta.description="Custom SQL data function"] - Human-readable description.
     */
    static register(name, handler, meta = {}) {
        if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim())) {
            throw new TypeError(`[MCSQLDataType] Invalid function name '${name}'.`);
        }
        if (typeof handler !== "function") {
            throw new TypeError(`[MCSQLDataType] Handler for '${name}' must be a function.`);
        }

        const upperName = name.trim().toUpperCase();
        const minArgs = typeof meta.minArgs === "number" ? meta.minArgs : 0;
        const maxArgs = typeof meta.maxArgs === "number" ? meta.maxArgs : Infinity;

        this._registry.set(upperName, {
            handler,
            minArgs,
            maxArgs,
            signature: meta.signature || `${upperName}()`,
            description: meta.description || "Custom SQL data function."
        });

        return this;
    }

    /**
     * Unregister a custom SQL function.
     * @param {string} name
     * @returns {boolean}
     */
    static unregister(name) {
        return this._registry.delete(String(name).trim().toUpperCase());
    }

    /**
     * Check whether a SQL function is registered.
     * @param {string} name
     * @returns {boolean}
     */
    static has(name) {
        return this._registry.has(String(name).trim().toUpperCase());
    }

    /**
     * Retrieve metadata for a registered function.
     * @param {string} name
     */
    static getMeta(name) {
        return this._registry.get(String(name).trim().toUpperCase()) ?? null;
    }

    /**
     * Evaluate a registered SQL function with resolved arguments.
     *
     * @param {string} name
     * @param {any[]} [args=[]]
     * @param {{ row?: any, params?: any }} [context={}]
     * @returns {any}
     */
    static evaluate(name, args = [], context = {}) {
        const upperName = String(name).trim().toUpperCase();
        const entry = this._registry.get(upperName);

        if (!entry) {
            throw new ReferenceError(`[MCSQLDataType] Unknown SQL function '${name}()'. Use 'SHOW FUNCTIONS' to list available functions.`);
        }

        if (args.length < entry.minArgs || args.length > entry.maxArgs) {
            const expected = entry.minArgs === entry.maxArgs
                ? `${entry.minArgs}`
                : `${entry.minArgs}..${entry.maxArgs === Infinity ? "*" : entry.maxArgs}`;
            throw new RangeError(`[MCSQLDataType] Function ${upperName}() expects ${expected} argument(s), got ${args.length}.`);
        }

        return entry.handler(args, context);
    }

    /**
     * Return all registered functions sorted alphabetically.
     * @returns {Array<{ name: string, signature: string, description: string, minArgs: number, maxArgs: number }>}
     */
    static list() {
        return [...this._registry.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, meta]) => ({
                name,
                signature: meta.signature,
                description: meta.description,
                minArgs: meta.minArgs,
                maxArgs: meta.maxArgs
            }));
    }

    /**
     * Generate an RFC 4122 version 4 UUID safe for Bedrock's QuickJS runtime.
     * @returns {string}
     */
    static generateUUID() {
        let d = Date.now();
        let d2 = typeof performance !== "undefined" && typeof performance.now === "function"
            ? Math.floor(performance.now() * 1000)
            : Math.floor(Math.random() * 0xffffffff);

        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            let r = Math.random() * 16;
            if (d > 0) {
                r = (d + r) % 16 | 0;
                d = Math.floor(d / 16);
            } else {
                r = (d2 + r) % 16 | 0;
                d2 = Math.floor(d2 / 16);
            }
            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
    }
}

/* =============================================================================
   BUILT-IN SQL FUNCTIONS & DYNAMIC DATA TYPES
============================================================================= */

MCSQLDataType.register("UUID", () => MCSQLDataType.generateUUID(), {
    minArgs: 0,
    maxArgs: 0,
    signature: "UUID()",
    description: "Genera un identificatore univoco RFC 4122 v4."
});

MCSQLDataType.register("SHORT_UUID", ([len = 8]) => {
    const size = Math.max(4, Math.min(32, Number(len) || 8));
    return MCSQLDataType.generateUUID().replace(/-/g, "").slice(0, size);
}, {
    minArgs: 0,
    maxArgs: 1,
    signature: "SHORT_UUID([length=8])",
    description: "Genera un ID alfanumerico compatto."
});

MCSQLDataType.register("NOW", () => Date.now(), {
    minArgs: 0,
    maxArgs: 0,
    signature: "NOW()",
    description: "Restituisce il timestamp Unix corrente in millisecondi."
});

MCSQLDataType.register("ISO_DATE", ([ts]) => {
    const date = ts !== undefined && ts !== null ? new Date(Number(ts)) : new Date();
    return date.toISOString();
}, {
    minArgs: 0,
    maxArgs: 1,
    signature: "ISO_DATE([timestampMs])",
    description: "Formatta una data in stringa ISO-8601."
});

MCSQLDataType.register("RAND", () => Math.random(), {
    minArgs: 0,
    maxArgs: 0,
    signature: "RAND()",
    description: "Restituisce un numero casuale in virgola mobile tra 0 e 1."
});

MCSQLDataType.register("RAND_INT", ([min = 0, max = 100]) => {
    const low = Math.ceil(Number(min));
    const high = Math.floor(Number(max));
    return Math.floor(Math.random() * (high - low + 1)) + low;
}, {
    minArgs: 0,
    maxArgs: 2,
    signature: "RAND_INT([min=0, max=100])",
    description: "Restituisce un intero casuale compreso tra min e max."
});

MCSQLDataType.register("UPPER", ([val]) => (val == null ? null : String(val).toUpperCase()), {
    minArgs: 1,
    maxArgs: 1,
    signature: "UPPER(text)",
    description: "Converte una stringa in maiuscolo."
});

MCSQLDataType.register("LOWER", ([val]) => (val == null ? null : String(val).toLowerCase()), {
    minArgs: 1,
    maxArgs: 1,
    signature: "LOWER(text)",
    description: "Converte una stringa in minuscolo."
});

MCSQLDataType.register("TRIM", ([val]) => (val == null ? null : String(val).trim()), {
    minArgs: 1,
    maxArgs: 1,
    signature: "TRIM(text)",
    description: "Rimuove gli spazi iniziali e finali da una stringa."
});

MCSQLDataType.register("CONCAT", (args) => args.map(v => (v == null ? "" : String(v))).join(""), {
    minArgs: 1,
    maxArgs: Infinity,
    signature: "CONCAT(val1, val2, ...)",
    description: "Concatena due o più valori in una singola stringa."
});

MCSQLDataType.register("COALESCE", (args) => {
    for (const item of args) {
        if (item !== null && item !== undefined) return item;
    }
    return null;
}, {
    minArgs: 1,
    maxArgs: Infinity,
    signature: "COALESCE(val1, val2, ...)",
    description: "Restituisce il primo valore non NULL."
});

MCSQLDataType.register("ROUND", ([num, decimals = 0]) => {
    if (num == null) return null;
    const factor = Math.pow(10, Number(decimals) || 0);
    return Math.round(Number(num) * factor) / factor;
}, {
    minArgs: 1,
    maxArgs: 2,
    signature: "ROUND(number, [decimals=0])",
    description: "Arrotonda un numero ai decimali specificati."
});

MCSQLDataType.register("FLOOR", ([num]) => (num == null ? null : Math.floor(Number(num))), {
    minArgs: 1,
    maxArgs: 1,
    signature: "FLOOR(number)",
    description: "Arrotonda per difetto all'intero inferiore."
});

MCSQLDataType.register("CEIL", ([num]) => (num == null ? null : Math.ceil(Number(num))), {
    minArgs: 1,
    maxArgs: 1,
    signature: "CEIL(number)",
    description: "Arrotonda per eccesso all'intero superiore."
});

MCSQLDataType.register("ABS", ([num]) => (num == null ? null : Math.abs(Number(num))), {
    minArgs: 1,
    maxArgs: 1,
    signature: "ABS(number)",
    description: "Restituisce il valore assoluto di un numero."
});

MCSQLDataType.register("JSON_ARRAY", (args) => [...args], {
    minArgs: 0,
    maxArgs: Infinity,
    signature: "JSON_ARRAY(item1, item2, ...)",
    description: "Crea un array JSON da una lista di argomenti."
});

MCSQLDataType.register("JSON_OBJECT", (args) => {
    if (args.length % 2 !== 0) {
        throw new SyntaxError("[MCSQLDataType] JSON_OBJECT() requires an even number of key-value arguments.");
    }
    const obj = {};
    for (let i = 0; i < args.length; i += 2) {
        obj[String(args[i])] = args[i + 1];
    }
    return obj;
}, {
    minArgs: 0,
    maxArgs: Infinity,
    signature: "JSON_OBJECT(key1, val1, ...)",
    description: "Crea un oggetto JSON da coppie chiave-valore."
});
