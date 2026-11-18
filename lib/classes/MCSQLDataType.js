import { world } from "@minecraft/server";

/**
 * MCSQLDataType - Custom SQL Functions & Dynamic Data Types Registry
 *
 * Allows built-in, Minecraft-aware, and developer-defined functions (e.g., UUID(),
 * NOW(), PLAYER_POS(), DISTANCE(), HAS_TAG(), SCORE(), ENUM(...), UPPER(col))
 * to be invoked directly inside MCSQL queries (SELECT, INSERT, UPDATE, and WHERE).
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

    /**
     * Find an online player by exact ID or case-insensitive name.
     * @param {string} nameOrId
     * @returns {import("@minecraft/server").Player | null}
     */
    static findOnlinePlayer(nameOrId) {
        if (nameOrId === null || nameOrId === undefined) return null;
        const target = String(nameOrId).trim();
        if (!target) return null;
        const lower = target.toLowerCase();

        for (const player of world.getAllPlayers()) {
            if (player.id === target || player.name.toLowerCase() === lower) {
                return player;
            }
        }
        return null;
    }

    /**
     * Normalize coordinate objects ({ x, y, z, dimension? }) or [x, y, z] arrays.
     * @param {any} input
     * @returns {{ x: number, y: number, z: number, dimension: string | null } | null}
     */
    static extractCoords(input) {
        if (input === null || input === undefined) return null;
        if (Array.isArray(input) && input.length >= 3) {
            const x = Number(input[0]);
            const y = Number(input[1]);
            const z = Number(input[2]);
            if ([x, y, z].some(n => Number.isNaN(n))) return null;
            return { x, y, z, dimension: null };
        }
        if (typeof input === "object") {
            const x = Number(input.x);
            const y = Number(input.y);
            const z = Number(input.z);
            if ([x, y, z].some(n => Number.isNaN(n))) return null;
            return {
                x,
                y,
                z,
                dimension: typeof input.dimension === "string" ? input.dimension : null
            };
        }
        return null;
    }
}

/* =============================================================================
   BUILT-IN SQL FUNCTIONS & DYNAMIC DATA TYPES
============================================================================= */

MCSQLDataType.register("ENUM", ([val, ...allowed]) => {
    if (val === null || val === undefined) return val;
    if (!allowed.includes(val)) {
        const formatted = allowed
            .map(v => (typeof v === "string" ? `'${v}'` : String(v)))
            .join(", ");
        throw new TypeError(`[MCSQLDataType] Valore ENUM '${val}' non valido. Valori consentiti: (${formatted}).`);
    }
    return val;
}, {
    minArgs: 2,
    maxArgs: Infinity,
    signature: "ENUM(value, opt1, opt2, ...)",
    description: "Valida che un valore appartenga a un insieme finito di opzioni consentite."
});

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

/* =============================================================================
   MINECRAFT-AWARE SQL FUNCTIONS (WORLD, PLAYERS, SPATIAL & SCOREBOARD)
============================================================================= */

MCSQLDataType.register("PLAYER_POS", ([playerNameOrId]) => {
    const player = MCSQLDataType.findOnlinePlayer(playerNameOrId);
    if (!player) return null;

    const loc = player.location;
    return {
        x: Math.round(loc.x * 100) / 100,
        y: Math.round(loc.y * 100) / 100,
        z: Math.round(loc.z * 100) / 100,
        dimension: player.dimension.id
    };
}, {
    minArgs: 1,
    maxArgs: 1,
    signature: "PLAYER_POS(playerNameOrId)",
    description: "Restituisce { x, y, z, dimension } di un giocatore online (o NULL se offline)."
});

MCSQLDataType.register("PLAYER_ID", ([playerName]) => {
    const player = MCSQLDataType.findOnlinePlayer(playerName);
    return player ? player.id : null;
}, {
    minArgs: 1,
    maxArgs: 1,
    signature: "PLAYER_ID(playerName)",
    description: "Restituisce l'ID univoco di un giocatore online dal suo nome."
});

MCSQLDataType.register("ONLINE_COUNT", () => world.getAllPlayers().length, {
    minArgs: 0,
    maxArgs: 0,
    signature: "ONLINE_COUNT()",
    description: "Restituisce il numero di giocatori attualmente online nel mondo."
});

MCSQLDataType.register("DISTANCE", (args) => {
    if (args.length === 2) {
        const a = MCSQLDataType.extractCoords(args[0]);
        const b = MCSQLDataType.extractCoords(args[1]);
        if (!a || !b) return null;
        if (a.dimension && b.dimension && a.dimension !== b.dimension) {
            return Infinity;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    if (args.length === 6) {
        const nums = args.map(Number);
        if (nums.some(n => Number.isNaN(n))) return null;
        const [x1, y1, z1, x2, y2, z2] = nums;
        return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2 + (z2 - z1) ** 2);
    }

    throw new TypeError("[MCSQLDataType] DISTANCE() accetta 2 oggetti/array coordinate (posA, posB) oppure 6 numeri (x1, y1, z1, x2, y2, z2).");
}, {
    minArgs: 2,
    maxArgs: 6,
    signature: "DISTANCE(posA, posB | x1, y1, z1, x2, y2, z2)",
    description: "Calcola la distanza 3D euclidea tra due punti o coordinate giocatori."
});

MCSQLDataType.register("DISTANCE_2D", ([posA, posB]) => {
    const a = MCSQLDataType.extractCoords(posA);
    const b = MCSQLDataType.extractCoords(posB);
    if (!a || !b) return null;
    if (a.dimension && b.dimension && a.dimension !== b.dimension) {
        return Infinity;
    }
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    return Math.sqrt(dx * dx + dz * dz);
}, {
    minArgs: 2,
    maxArgs: 2,
    signature: "DISTANCE_2D(posA, posB)",
    description: "Calcola la distanza orizzontale (X, Z) tra due coordinate."
});

MCSQLDataType.register("HAS_TAG", ([playerNameOrId, tag]) => {
    if (tag === null || tag === undefined) return false;
    const player = MCSQLDataType.findOnlinePlayer(playerNameOrId);
    if (!player) return false;
    return Boolean(player.hasTag(String(tag)));
}, {
    minArgs: 2,
    maxArgs: 2,
    signature: "HAS_TAG(playerNameOrId, tag)",
    description: "Verifica se un giocatore online possiede uno specifico tag Minecraft."
});

MCSQLDataType.register("SCORE", ([targetNameOrId, objectiveId]) => {
    if (targetNameOrId === null || targetNameOrId === undefined || !objectiveId) return null;
    const objective = world.scoreboard.getObjective(String(objectiveId));
    if (!objective) return null;

    const player = MCSQLDataType.findOnlinePlayer(targetNameOrId);
    if (player) {
        try {
            const val = objective.getScore(player);
            return typeof val === "number" ? val : null;
        } catch {
            return null;
        }
    }

    const targetStr = String(targetNameOrId);
    for (const participant of objective.getParticipants()) {
        if (participant.displayName === targetStr) {
            const val = objective.getScore(participant);
            return typeof val === "number" ? val : null;
        }
    }
    return null;
}, {
    minArgs: 2,
    maxArgs: 2,
    signature: "SCORE(playerOrParticipant, objectiveId)",
    description: "Legge il punteggio da una scoreboard vanilla di Minecraft."
});
