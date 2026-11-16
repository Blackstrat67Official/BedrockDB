import {
    world,
    system,
    CommandPermissionLevel,
    CustomCommandParamType,
    CustomCommandStatus
} from "@minecraft/server";
import { MCSQL } from "../classes/MCSQL.js";
import { Storage } from "../classes/Storage.js";
import { Cache } from "../classes/Cache.js";

/**
 * SqlCommand - In-Game Chat Slash Command (/uc:sql) for MCSQL
 *
 * Registers the native Minecraft Bedrock slash command `/uc:sql`
 * (also accessible as `/sql` in chat) allowing operators to run
 * SQL queries, JOINs, EXPLAIN plans, and table inspections in-game.
 */
export class SQLCommand {
    static _config = {
        commandName: "uc:sql",
        permissionLevel: CommandPermissionLevel.GameDirectors,
        maxDisplayRows: 15,
        maxCellLength: 36,
        enableChatPrefix: false, // Optional '!sql <query>' without outer quotes
        chatPrefix: "!sql"
    };

    static _registered = false;

    /**
     * Optional configuration before world startup completes.
     * @param {object} [options]
     * @param {string} [options.commandName="uc:sql"]
     * @param {CommandPermissionLevel} [options.permissionLevel]
     * @param {number} [options.maxDisplayRows=15]
     * @param {number} [options.maxCellLength=36]
     * @param {boolean} [options.enableChatPrefix=false]
     * @param {string} [options.chatPrefix="!sql"]
     */
    static configure(options = {}) {
        Object.assign(this._config, options);
    }

    /**
     * Register the `/uc:sql` slash command on Bedrock's startup event.
     */
    static init() {
        if (this._registered) return;
        this._registered = true;

        system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
            customCommandRegistry.registerCommand(
                {
                    name: this._config.commandName,
                    description: "Esegue una query MCSQL sulle tabelle scoreboard.",
                    permissionLevel: this._config.permissionLevel,
                    mandatoryParameters: [
                        {
                            name: "query",
                            type: CustomCommandParamType.String
                        }
                    ],
                    optionalParameters: [
                        {
                            name: "force",
                            type: CustomCommandParamType.Boolean
                        }
                    ]
                },
                (origin, rawQuery, force = false) => {
                    const sender = origin.sourceEntity ?? null;

                    // Defer execution to the next tick via system.run() so scoreboard
                    // write operations (INSERT, UPDATE, DELETE, CREATE, DROP) have full privileges.
                    system.run(() => {
                        this.executeFromChat(rawQuery, sender, Boolean(force));
                    });

                    return {
                        status: CustomCommandStatus.Success
                    };
                }
            );
        });

        // Optional chat shortcut (!sql SELECT * FROM players) without needing outer double-quotes
        if (world.beforeEvents?.chatSend) {
            world.beforeEvents.chatSend.subscribe((ev) => {
                if (!this._config.enableChatPrefix) return;
                const prefix = this._config.chatPrefix;
                if (!ev.message.startsWith(prefix + " ")) return;

                ev.cancel = true;
                const rawSql = ev.message.slice(prefix.length).trim();
                const player = ev.sender;

                if (player.commandPermissionLevel < this._config.permissionLevel) {
                    player.sendMessage("§c[MCSQL] Permessi insufficienti per eseguire query SQL.");
                    return;
                }

                system.run(() => {
                    this.executeFromChat(rawSql, player, false);
                });
            });
        }
    }

    /**
     * Parse, execute, and send formatted feedback for a SQL string entered in chat.
     * @param {string} rawInput
     * @param {import("@minecraft/server").Entity | null} [sender=null]
     * @param {boolean} [force=false]
     */
    static executeFromChat(rawInput, sender = null, force = false) {
        const reply = (msg) => {
            if (sender && typeof sender.sendMessage === "function") {
                sender.sendMessage(msg);
            } else {
                // Dedicated server console or command block fallback
                console.warn(msg.replace(/§[0-9a-fk-or]/g, ""));
            }
        };

        const trimmed = String(rawInput ?? "").trim();
        if (!trimmed) {
            reply("§c[MCSQL] Inserisci una query SQL valida. Esempio: §f/uc:sql \"SELECT * FROM players LIMIT 5\"");
            return;
        }

        const startTime = Date.now();

        try {
            // 1. Built-in diagnostic & schema helper commands
            if (/^SHOW\s+TABLES\s*;?$/i.test(trimmed)) {
                this._handleShowTables(reply, startTime);
                return;
            }

            if (/^CACHE\s+STATS\s*;?$/i.test(trimmed)) {
                this._handleCacheStats(reply, startTime);
                return;
            }

            const descMatch = trimmed.match(/^(?:DESCRIBE|DESC)\s+([a-zA-Z0-9_]+)\s*;?$/i);
            if (descMatch) {
                this._handleDescribeTable(descMatch[1], reply, startTime);
                return;
            }

            const explainMatch = trimmed.match(/^EXPLAIN\s+(.+)$/i);
            if (explainMatch) {
                const plan = MCSQL.explain(explainMatch[1]);
                const elapsed = Date.now() - startTime;
                reply(`§6§l[MCSQL EXPLAIN]§r §e${plan.statement} §7on §b${plan.table}`);
                for (const call of plan.storageCalls) {
                    reply(`§8 > §f${call.method}§7(${JSON.stringify(call.args)})`);
                }
                reply(`§8Piano generato in ${elapsed}ms.`);
                return;
            }

            // 2. Standard MCSQL execution
            const result = MCSQL.query(trimmed, [], { allowUnsafeWrite: force });
            const elapsed = Date.now() - startTime;

            // SELECT returns an array of row objects
            if (Array.isArray(result)) {
                this._sendSelectResult(result, reply, elapsed);
                return;
            }

            // INSERT / UPDATE / DELETE / DDL return metadata objects
            this._sendMutationResult(result, reply, elapsed);
        } catch (err) {
            reply(`§c§l[MCSQL Errore]§r §c${err.message}`);
            if (String(err.message).includes("allowUnsafeWrite")) {
                reply("§7Suggerimento: aggiungi §ftrue §7come secondo parametro per forzare: §e/uc:sql \"...\" true");
            }
        }
    }

    /* =========================================================================
       META COMMAND HANDLERS
    ========================================================================= */

    static _handleShowTables(reply, startTime) {
        const objectives = world.scoreboard.getObjectives();
        const elapsed = Date.now() - startTime;

        if (objectives.length === 0) {
            reply("§e[MCSQL] Nessuna tabella (scoreboard objective) presente nel mondo.");
            return;
        }

        const lines = [`§6§l[MCSQL] Tabelle nel mondo (${objectives.length}):`];
        for (const obj of objectives) {
            const count = Storage.count(obj.id);
            lines.push(`§8 - §b${obj.id} §7(${count} record)`);
        }
        lines.push(`§8Completato in ${elapsed}ms.`);
        reply(lines.join("\n"));
    }

    static _handleDescribeTable(tableName, reply, startTime) {
        const rows = Storage.select(tableName, { limit: 25, flat: true });
        const elapsed = Date.now() - startTime;

        if (rows.length === 0) {
            reply(`§e[MCSQL] La tabella §b${tableName} §eè vuota o non esiste.`);
            return;
        }

        /** @type {Map<string, Set<string>>} */
        const fieldTypes = new Map();
        for (const row of rows) {
            for (const [key, val] of Object.entries(row)) {
                if (!fieldTypes.has(key)) fieldTypes.set(key, new Set());
                const typeLabel = val === null ? "null" : Array.isArray(val) ? "array" : typeof val;
                fieldTypes.get(key).add(typeLabel);
            }
        }

        const lines = [`§6§l[MCSQL] Struttura tabella §b${tableName}§6 (campione di ${rows.length} record):`];
        for (const [field, types] of fieldTypes.entries()) {
            lines.push(`§8 - §f${field}§7: §a${[...types].join(" | ")}`);
        }
        lines.push(`§8Completato in ${elapsed}ms.`);
        reply(lines.join("\n"));
    }

    static _handleCacheStats(reply, startTime) {
        const stats = Cache.stats();
        const elapsed = Date.now() - startTime;

        const lines = [
            `§6§l[MCSQL Cache Stats]`,
            `§7Hits: §a${stats.hits} §8| §7Misses: §c${stats.misses} §8| §7Hit Rate: §b${stats.hitRate}`,
            `§7Evictions: §e${stats.evictions} §8| §7Flushes: §e${stats.flushes} §8| §7KV Keys: §f${stats.kvEntries}`
        ];

        for (const [tbl, info] of Object.entries(stats.tables)) {
            lines.push(`§8 - §b${tbl}§7: cached=§f${info.cached}§7, pinned=§e${info.pinned}§7, dirty=§c${info.dirty} §7[idx: ${info.indexes.join(", ") || "none"}]`);
        }

        lines.push(`§8Completato in ${elapsed}ms.`);
        reply(lines.join("\n"));
    }

    /* =========================================================================
       CHAT OUTPUT FORMATTERS
    ========================================================================= */

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

    static _sendSelectResult(rows, reply, elapsed) {
        if (rows.length === 0) {
            reply(`§e[MCSQL] Nessun record trovato. §8(${elapsed}ms)`);
            return;
        }

        const maxRows = this._config.maxDisplayRows;
        const visibleRows = rows.slice(0, maxRows);
        const columns = Object.keys(visibleRows[0]);

        const lines = [];
        lines.push(`§6§l[MCSQL] Risultati (${rows.length} rig${rows.length === 1 ? "a" : "he"}):`);
        lines.push(`§e${columns.join(" §8| §e")}`);
        lines.push(`§8${"-".repeat(Math.min(48, columns.join(" | ").length + 4))}`);

        for (const row of visibleRows) {
            const formattedCols = columns.map((col) => this._formatCell(row[col]));
            lines.push(formattedCols.join(" §8| "));
        }

        if (rows.length > maxRows) {
            lines.push(`§7... altri §f${rows.length - maxRows} §7record nascosti (usa §fLIMIT§7 per paginare).`);
        }

        lines.push(`§8Query eseguita in ${elapsed}ms.`);
        reply(lines.join("\n"));
    }

    static _sendMutationResult(res, reply, elapsed) {
        if (res.insertId !== undefined) {
            const idsInfo = res.insertIds.length > 1
                ? `IDs: §b${res.insertIds.join(", ")}`
                : `ID: §b${res.insertId}`;
            reply(`§a[MCSQL] INSERT completato: §f${res.affectedRows} §arecord inseriti (${idsInfo}§a). §8(${elapsed}ms)`);
            return;
        }

        if (res.affectedRows !== undefined) {
            reply(`§a[MCSQL] Query eseguita: §f${res.affectedRows} §arecord interessati. §8(${elapsed}ms)`);
            return;
        }

        if (res.action === "created") {
            reply(`§a[MCSQL] Tabella §b${res.table} §apronta. §8(${elapsed}ms)`);
            return;
        }

        if (res.truncated) {
            reply(`§a[MCSQL] Tabella §b${res.table} §asvuotata con successo. §8(${elapsed}ms)`);
            return;
        }

        if (res.dropped !== undefined) {
            reply(
                res.dropped
                    ? `§a[MCSQL] Tabella §b${res.table} §aeliminata.`
                    : `§e[MCSQL] La tabella §b${res.table} §enon esisteva.`
            );
            return;
        }

        reply(`§a[MCSQL] Operazione completata. §8(${elapsed}ms)`);
    }
}

// Auto-register /uc:sql when this module is imported
SqlCommand.init();
