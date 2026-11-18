import {
    world,
    system,
    CommandPermissionLevel,
    CustomCommandParamType,
    CustomCommandStatus
} from "@minecraft/server";
import { SQLInterpreter } from "../classes/SQLInterpreter.js";

/**
 * BedrockDBEnv - MariaDB-style Interactive Chat Console for BedrockDB
 *
 * Registers `/uc:bedrockdb connect` so authorized operators can turn their
 * Minecraft chat into a stateful SQL shell (`bedrockDB@<player>$ ...`):
 * - Intercepts chat messages privately (canceling public broadcast via beforeEvents.chatSend)
 * - Buffers multi-line SQL queries until terminated with `;`
 * - Supports `exit` to disconnect and `\c` / `clear` to reset the multiline buffer
 * - Includes automatic diagnostics & fallback commands (`/uc:bedrockdb exec`, `/uc:bedrockdb disconnect`)
 */
export class BedrockDBEnv {
    static _config = {
        commandName: "uc:bedrockdb",
        enumName: "uc:bedrockdb_op",
        permissionLevel: CommandPermissionLevel.GameDirectors,
        maxDisplayRows: 15,
        maxCellLength: 36,
        allowUnsafeWriteInConsole: true
    };

    /**
     * Active player terminal sessions keyed by player.id
     * @type {Map<string, {
     *   playerId: string,
     *   playerName: string,
     *   buffer: string[],
     *   connectedAt: number
     * }>}
     */
    static _sessions = new Map();

    static _registered = false;
    static _hooksAttached = false;

    /** @type {"beforeEvents" | "afterEvents" | "none"} */
    static _chatInterceptionMode = "none";

    /**
     * Configure BedrockDBEnv behavior before startup registration.
     * @param {object} [options]
     */
    static configure(options = {}) {
        Object.assign(this._config, options);
    }

    /**
     * Register `/uc:bedrockdb <connect|disconnect|exec>` on Minecraft's CustomCommandRegistry.
     * @param {import("@minecraft/server").CustomCommandRegistry | import("@minecraft/server").StartupEvent} startupOrRegistry
     */
    static register(startupOrRegistry) {
        const registry = startupOrRegistry?.customCommandRegistry ?? startupOrRegistry;
        if (!registry || typeof registry.registerCommand !== "function") {
            throw new TypeError("[BedrockDBEnv] Passa 'customCommandRegistry' ricevuto da system.beforeEvents.startup.");
        }

        this._attachHooks();

        try {
            if (typeof registry.registerEnum === "function") {
                registry.registerEnum(this._config.enumName, ["connect", "disconnect", "exec"]);
            }

            registry.registerCommand(
                {
                    name: this._config.commandName,
                    description: "Connette o gestisce la console interattiva stile MariaDB per BedrockDB.",
                    permissionLevel: this._config.permissionLevel,
                    mandatoryParameters: [
                        {
                            name: this._config.enumName,
                            type: CustomCommandParamType.Enum
                        }
                    ],
                    optionalParameters: [
                        {
                            name: "input",
                            type: CustomCommandParamType.String
                        }
                    ]
                },
                (origin, operation, optionalInput) => {
                    const sender = origin.sourceEntity ?? null;

                    if (!sender || sender.typeId !== "minecraft:player") {
                        return {
                            status: CustomCommandStatus.Failure,
                            message: "Il comando /uc:bedrockdb può essere eseguito solo da un giocatore."
                        };
                    }

                    const op = String(operation ?? "").toLowerCase();

                    if (op === "connect") {
                        system.run(() => {
                            this.connect(sender);
                        });
                        return { status: CustomCommandStatus.Success };
                    }

                    if (op === "disconnect") {
                        system.run(() => {
                            if (!this.disconnect(sender, false)) {
                                sender.sendMessage("§e[BedrockDB] Non sei connesso a nessuna sessione BedrockDB.");
                            }
                        });
                        return { status: CustomCommandStatus.Success };
                    }

                    if (op === "exec") {
                        const rawSql = String(optionalInput ?? "").trim();
                        if (!rawSql) {
                            return {
                                status: CustomCommandStatus.Failure,
                                message: "Specifica una query SQL: /uc:bedrockdb exec \"SHOW TABLES;\""
                            };
                        }
                        system.run(() => {
                            if (!this._sessions.has(sender.id)) {
                                this.connect(sender);
                            }
                            this._handleTerminalInput(sender, rawSql);
                        });
                        return { status: CustomCommandStatus.Success };
                    }

                    return {
                        status: CustomCommandStatus.Failure,
                        message: `Operazione sconosciuta '${operation}'. Usa: connect, disconnect oppure exec.`
                    };
                }
            );
        } catch (err) {
            console.warn(`[BedrockDBEnv] Avviso registrazione comando: ${err.message}`);
        }
    }

    /**
     * Optional self-subscribing initializer if not calling `register()` manually inside `startup`.
     */
    static init() {
        if (this._registered) return;
        this._registered = true;

        system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
            this.register(customCommandRegistry);
        });
    }

    /* =========================================================================
       SESSION LIFECYCLE (CONNECT / DISCONNECT / STATE)
    ========================================================================= */

    /**
     * Check whether a player currently has an active BedrockDB terminal session.
     * @param {import("@minecraft/server").Player | string} playerOrId
     * @returns {boolean}
     */
    static isConnected(playerOrId) {
        const id = typeof playerOrId === "string" ? playerOrId : playerOrId?.id;
        return Boolean(id && this._sessions.has(id));
    }

    /**
     * Connect a player to the BedrockDB interactive chat console.
     * @param {import("@minecraft/server").Player} player
     * @returns {boolean}
     */
    static connect(player) {
        if (!player || !player.id) return false;
        this._attachHooks();

        if (this._sessions.has(player.id)) {
            player.sendMessage(
                `§e[BedrockDB] Sei già connesso come §abedrockDB@${player.name}$§e. Digita §fexit §eper uscire.`
            );
            return false;
        }

        this._sessions.set(player.id, {
            playerId: player.id,
            playerName: player.name,
            buffer: [],
            connectedAt: Date.now()
        });

        const lines = [
            `§a§lWelcome to the BedrockDB monitor.§r §7Commands end with ;`,
            `§7Server version: §fBedrockDB 1.0.0 (Scoreboard SQL Engine)`,
            `§7Prompt attivo: §abedrockDB@${player.name}$`,
            `§7Digita §fhelp; §7per i comandi, §f\\c §7per svuotare il buffer o §fexit §7per disconnetterti.`
        ];

        if (this._chatInterceptionMode === "afterEvents") {
            lines.push(
                `§e[Avviso] Modalità compatibilità chat attiva: i comandi funzionano ma i messaggi restano visibili in chat pubblica (attiva '@minecraft/server' 2.0.0-beta + Beta APIs per renderli privati).`
            );
        } else if (this._chatInterceptionMode === "none") {
            lines.push(
                `§c[Attenzione] Intercettazione chat non attiva! Assicurati di avere '2.0.0-beta' nel manifest.json e l'esperimento 'Beta APIs' attivo nel mondo.`,
                `§7In alternativa puoi usare: §f/uc:bedrockdb exec "SHOW TABLES;" §7oppure §f/uc:bedrockdb disconnect`
            );
        }

        player.sendMessage(lines.join("\n"));
        return true;
    }

    /**
     * Disconnect a player from the BedrockDB interactive chat console.
     * @param {import("@minecraft/server").Player | string} playerOrId
     * @param {boolean} [silent=false]
     * @returns {boolean}
     */
    static disconnect(playerOrId, silent = false) {
        const id = typeof playerOrId === "string" ? playerOrId : playerOrId?.id;
        if (!id || !this._sessions.has(id)) return false;

        this._sessions.delete(id);

        if (!silent && typeof playerOrId === "object" && typeof playerOrId.sendMessage === "function") {
            playerOrId.sendMessage("§eBye");
        }
        return true;
    }

    /* =========================================================================
       CHAT INTERCEPTOR & MULTILINE SHELL PARSER
    ========================================================================= */

    static _isPlayerValid(player) {
        if (!player) return false;
        if (typeof player.isValid === "function") return player.isValid();
        if (typeof player.isValid === "boolean") return player.isValid;
        return true;
    }

    static _attachHooks() {
        if (this._hooksAttached) return;
        this._hooksAttached = true;

        // 1. Primary: Private chat interception via beforeEvents.chatSend (requires 2.0.0-beta / Beta APIs)
        if (world.beforeEvents?.chatSend && typeof world.beforeEvents.chatSend.subscribe === "function") {
            this._chatInterceptionMode = "beforeEvents";
            world.beforeEvents.chatSend.subscribe((ev) => {
                const player = ev.sender;
                if (!player || !this._sessions.has(player.id)) return;

                // Cancel public chat message while connected to the BedrockDB shell
                ev.cancel = true;
                const rawLine = ev.message;

                system.run(() => {
                    if (!this._isPlayerValid(player)) return;
                    this._handleTerminalInput(player, rawLine);
                });
            });
        } else if (world.afterEvents?.chatSend && typeof world.afterEvents.chatSend.subscribe === "function") {
            // 2. Fallback: Non-canceling chat listener if only afterEvents.chatSend is available
            this._chatInterceptionMode = "afterEvents";
            world.afterEvents.chatSend.subscribe((ev) => {
                const player = ev.sender;
                if (!player || !this._sessions.has(player.id)) return;

                const rawLine = ev.message;
                system.run(() => {
                    if (!this._isPlayerValid(player)) return;
                    this._handleTerminalInput(player, rawLine);
                });
            });
        } else {
            this._chatInterceptionMode = "none";
            console.warn(
                "[BedrockDBEnv] world.beforeEvents.chatSend non disponibile. Imposta '@minecraft/server' a '2.0.0-beta' nel manifest.json e attiva 'Beta APIs' nelle impostazioni del mondo."
            );
        }

        if (world.afterEvents?.playerLeave && typeof world.afterEvents.playerLeave.subscribe === "function") {
            world.afterEvents.playerLeave.subscribe((ev) => {
                if (ev.playerId) {
                    this._sessions.delete(ev.playerId);
                }
            });
        }
    }

    /**
     * Process a single chat line typed by a connected player.
     * @param {import("@minecraft/server").Player} player
     * @param {string} rawLine
     */
    static _handleTerminalInput(player, rawLine) {
        const session = this._sessions.get(player.id);
        if (!session) return;

        const trimmed = String(rawLine ?? "").trim();
        const isFirstLine = session.buffer.length === 0;
        const promptPrefix = isFirstLine
            ? `§abedrockDB@${player.name}$ §f`
            : `§8    -> §f`;

        // Echo user input with MariaDB-style prompt
        player.sendMessage(`${promptPrefix}${trimmed}`);

        if (!trimmed) return;

        // 1. Immediate exit command (works with or without semicolon)
        if (/^(?:exit|quit|\\q)\s*;?$/i.test(trimmed)) {
            this.disconnect(player, false);
            return;
        }

        // 2. Clear current multiline buffer (`\c` or `clear`)
        if (/^(?:\\c|clear)\s*;?$/i.test(trimmed)) {
            session.buffer = [];
            player.sendMessage("§7Query buffer svuotato.");
            return;
        }

        // 3. Built-in terminal help (`help` or `\h`)
        if (isFirstLine && /^(?:help|\\h)\s*;?$/i.test(trimmed)) {
            this._sendHelp(player);
            return;
        }

        // 4. Append line to session buffer and check if terminated by `;`
        session.buffer.push(trimmed);
        const combined = session.buffer.join("\n").trim();

        if (!this._endsWithSemicolon(combined)) {
            // Keep collecting subsequent chat lines until `;` is entered
            return;
        }

        // Statement is complete -> flush buffer and execute all `;`-delimited statements
        session.buffer = [];
        const statements = this._splitStatements(combined);

        for (const stmt of statements) {
            this._executeStatement(player, stmt);
        }
    }

    /**
     * Check whether the accumulated input ends with a `;` outside of string literals.
     * @param {string} text
     * @returns {boolean}
     */
    static _endsWithSemicolon(text) {
        let inSingle = false;
        let inDouble = false;
        let inBacktick = false;
        let lastNonSpace = "";

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inSingle) {
                if (ch === "'" && text[i + 1] === "'") { i++; continue; }
                if (ch === "\\") { i++; continue; }
                if (ch === "'") { inSingle = false; lastNonSpace = ch; }
                continue;
            }
            if (inDouble) {
                if (ch === '"') { inDouble = false; lastNonSpace = ch; }
                continue;
            }
            if (inBacktick) {
                if (ch === "`") { inBacktick = false; lastNonSpace = ch; }
                continue;
            }

            if (ch === "'") { inSingle = true; lastNonSpace = ch; }
            else if (ch === '"') { inDouble = true; lastNonSpace = ch; }
            else if (ch === "`") { inBacktick = true; lastNonSpace = ch; }
            else if (!/\s/.test(ch)) {
                lastNonSpace = ch;
            }
        }

        return !inSingle && !inDouble && !inBacktick && lastNonSpace === ";";
    }

    /**
     * Split one or more SQL statements separated by top-level `;` (ignoring `;` inside quotes).
     * @param {string} text
     * @returns {string[]}
     */
    static _splitStatements(text) {
        const statements = [];
        let current = "";
        let inSingle = false;
        let inDouble = false;
        let inBacktick = false;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];

            if (inSingle) {
                current += ch;
                if (ch === "'" && text[i + 1] === "'") {
                    current += text[++i];
                } else if (ch === "\\" && i + 1 < text.length) {
                    current += text[++i];
                } else if (ch === "'") {
                    inSingle = false;
                }
                continue;
            }

            if (inDouble) {
                current += ch;
                if (ch === '"') inDouble = false;
                continue;
            }

            if (inBacktick) {
                current += ch;
                if (ch === "`") inBacktick = false;
                continue;
            }

            if (ch === "'") {
                inSingle = true;
                current += ch;
            } else if (ch === '"') {
                inDouble = true;
                current += ch;
            } else if (ch === "`") {
                inBacktick = true;
                current += ch;
            } else if (ch === ";") {
                const stmt = current.trim();
                if (stmt) statements.push(stmt + ";");
                current = "";
            } else {
                current += ch;
            }
        }

        const trailing = current.trim();
        if (trailing) statements.push(trailing);

        return statements;
    }

    /**
     * Execute a complete SQL statement through SQLInterpreter and format MariaDB-style output.
     * @param {import("@minecraft/server").Player} player
     * @param {string} sql
     */
    static _executeStatement(player, sql) {
        const reply = (msg) => player.sendMessage(msg);
        const outcome = SQLInterpreter.interpret(sql, {
            allowUnsafeWrite: this._config.allowUnsafeWriteInConsole
        });

        if (!outcome.ok) {
            reply(`§cERROR: §f${outcome.error}`);
            if (outcome.hint) {
                reply(`§7Hint: ${outcome.hint}`);
            }
            return;
        }

        if (outcome.warnings && outcome.warnings.length > 0) {
            for (const warn of outcome.warnings) {
                reply(`§eWarning: §7${warn}`);
            }
        }

        const sec = (outcome.elapsedMs / 1000).toFixed(3);

        switch (outcome.kind) {
            case "meta":
                this._renderMeta(outcome.meta, sec, reply);
                break;

            case "validation":
                reply(`§aQuery OK, valid ${outcome.validation.statementType} on '${outcome.validation.table}' §8(${sec} sec)`);
                break;

            case "rows":
                this._renderRows(outcome.rows, sec, reply);
                break;

            case "mutation":
                this._renderMutation(outcome.mutation, sec, reply);
                break;
        }
    }

    /* =========================================================================
       MARIADB-STYLE TERMINAL OUTPUT RENDERERS
    ========================================================================= */

    static _sendHelp(player) {
        player.sendMessage(
            [
                `§6§lBedrockDB Monitor Commands:`,
                `§f  exit / quit / \\q   §7Disconnette il terminale e ripristina la chat normale.`,
                `§f  \\c / clear         §7Annulla la query multi-linea in corso nel buffer.`,
                `§f  SHOW TABLES;       §7Elenca tutte le tabelle nel mondo con PK/FK.`,
                `§f  DESCRIBE <tbl>;    §7Mostra colonne, tipi (incluso ENUM), PK e FK.`,
                `§f  SHOW FUNCTIONS;    §7Mostra tutte le funzioni MCSQLDataType.`,
                `§f  CACHE STATS;       §7Mostra hit/miss e record sporchi in RAM.`,
                `§f  BEGIN; / COMMIT;   §7Gestisce transazioni ACID e ROLLBACK;`
            ].join("\n")
        );
    }

    static _renderMeta(meta, sec, reply) {
        const lines = [`§6${meta.title}:`];
        for (const line of meta.lines) {
            lines.push(`§8| §f${line}`);
        }
        lines.push(`§8${meta.lines.length} item(s) (${sec} sec)`);
        reply(lines.join("\n"));
    }

    static _formatCell(value) {
        if (value === null || value === undefined) return "§8NULL§r";
        let str = typeof value === "object" ? JSON.stringify(value) : String(value);
        if (str.length > this._config.maxCellLength) {
            str = str.slice(0, this._config.maxCellLength - 3) + "...";
        }
        if (typeof value === "number") return `§b${str}§r`;
        if (typeof value === "boolean") return value ? "§aTRUE§r" : "§cFALSE§r";
        return `§f${str}§r`;
    }

    static _renderRows(rows, sec, reply) {
        if (rows.length === 0) {
            reply(`§7Empty set (${sec} sec)`);
            return;
        }

        const maxRows = this._config.maxDisplayRows;
        const visibleRows = rows.slice(0, maxRows);
        const columns = Object.keys(visibleRows[0]);

        const lines = [];
        const separator = `§8+${"-".repeat(Math.min(46, columns.join(" | ").length + 4))}+`;
        lines.push(separator);
        lines.push(`§8| §e${columns.join(" §8| §e")} §8|`);
        lines.push(separator);

        for (const row of visibleRows) {
            const formattedCols = columns.map(col => this._formatCell(row[col]));
            lines.push(`§8| ${formattedCols.join(" §8| ")} §8|`);
        }

        lines.push(separator);
        if (rows.length > maxRows) {
            lines.push(`§7... ${rows.length - maxRows} righe nascoste (usa LIMIT per paginare).`);
        }
        lines.push(`§a${rows.length} row${rows.length === 1 ? "" : "s"} in set §8(${sec} sec)`);
        reply(lines.join("\n"));
    }

    static _renderMutation(res, sec, reply) {
        if (res.insertId !== undefined) {
            const idsInfo = res.insertIds.length > 1
                ? `IDs: ${res.insertIds.join(", ")}`
                : `Last insert ID: ${res.insertId}`;
            reply(`§aQuery OK, ${res.affectedRows} row${res.affectedRows === 1 ? "" : "s"} affected §7(${idsInfo}) §8(${sec} sec)`);
            return;
        }

        if (res.affectedRows !== undefined) {
            reply(`§aQuery OK, ${res.affectedRows} row${res.affectedRows === 1 ? "" : "s"} affected §8(${sec} sec)`);
            return;
        }

        if (res.action === "created") {
            const extras = [];
            if (res.primaryKey) extras.push(`PK: ${res.primaryKey}`);
            if (res.foreignKeys?.length) extras.push(`FK: ${res.foreignKeys.length}`);
            const extraStr = extras.length > 0 ? ` [${extras.join(", ")}]` : "";
            reply(`§aQuery OK, table '${res.table}' created${extraStr} §8(${sec} sec)`);
            return;
        }

        if (res.action === "altered") {
            reply(`§aQuery OK, table '${res.table}' altered §8(${sec} sec)`);
            return;
        }

        if (res.action === "BEGIN") {
            reply(`§aQuery OK, transaction started §8(${sec} sec)`);
            return;
        }

        if (res.action === "COMMIT") {
            reply(`§aQuery OK, transaction committed §8(${sec} sec)`);
            return;
        }

        if (res.action === "ROLLBACK") {
            reply(`§eQuery OK, transaction rolled back §8(${sec} sec)`);
            return;
        }

        if (res.action === "SAVEPOINT") {
            reply(`§aQuery OK, savepoint '${res.name}' created §8(${sec} sec)`);
            return;
        }

        if (res.action === "ROLLBACK_TO") {
            reply(`§eQuery OK, rolled back to savepoint '${res.name}' §8(${sec} sec)`);
            return;
        }

        if (res.action === "RELEASE_SAVEPOINT") {
            reply(`§aQuery OK, savepoint '${res.name}' released §8(${sec} sec)`);
            return;
        }

        if (res.action === "exists") {
            reply(`§eQuery OK, table '${res.table}' already exists §8(${sec} sec)`);
            return;
        }

        if (res.truncated) {
            reply(`§aQuery OK, table '${res.table}' truncated §8(${sec} sec)`);
            return;
        }

        if (res.dropped !== undefined) {
            reply(
                res.dropped
                    ? `§aQuery OK, table '${res.table}' dropped §8(${sec} sec)`
                    : `§eQuery OK, table '${res.table}' did not exist §8(${sec} sec)`
            );
            return;
        }

        reply(`§aQuery OK §8(${sec} sec)`);
    }
}
