import {
    world,
    system,
    CommandPermissionLevel,
    CustomCommandParamType,
    CustomCommandStatus
} from "@minecraft/server";
import { SQLInterpreter } from "../classes/SQLInterpreter.js";

/**
 * SQLCommand - Minecraft Bedrock Chat Command Interface (/uc:sql)
 *
 * Thin presentation & command registration layer that delegates all parsing,
 * syntax validation, meta-commands, and execution to SQLInterpreter.
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
    static _chatHooked = false;

    /**
     * Optional configuration before world startup completes.
     * @param {object} [options]
     */
    static configure(options = {}) {
        Object.assign(this._config, options);
    }

    /**
     * Register the `/uc:sql` slash command inside `system.beforeEvents.startup`.
     * @param {import("@minecraft/server").CustomCommandRegistry | import("@minecraft/server").StartupEvent} startupOrRegistry
     */
    static register(startupOrRegistry) {
        const registry = startupOrRegistry?.customCommandRegistry ?? startupOrRegistry;
        if (!registry || typeof registry.registerCommand !== "function") {
            throw new TypeError("[SQLCommand] Passa 'customCommandRegistry' ricevuto da system.beforeEvents.startup.");
        }

        try {
            registry.registerCommand(
                {
                    name: this._config.commandName,
                    description: "Esegue o valida una query MCSQL sulle tabelle scoreboard.",
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

                    system.run(() => {
                        this.executeFromChat(rawQuery, sender, Boolean(force));
                    });

                    return {
                        status: CustomCommandStatus.Success
                    };
                }
            );
        } catch (err) {
            console.warn(`[SQLCommand] Avviso registrazione comando: ${err.message}`);
        }

        this._registerChatShortcut();
    }

    /**
     * Optional helper that self-subscribes to `system.beforeEvents.startup`.
     */
    static init() {
        if (this._registered) return;
        this._registered = true;

        system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
            this.register(customCommandRegistry);
        });
    }

    /**
     * Attach optional `!sql` chat shortcut once.
     */
    static _registerChatShortcut() {
        if (this._chatHooked || !world.beforeEvents?.chatSend) return;
        this._chatHooked = true;

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

    /**
     * Pass chat input to SQLInterpreter and render formatted output in Minecraft chat.
     * @param {string} rawInput
     * @param {import("@minecraft/server").Entity | null} [sender=null]
     * @param {boolean} [force=false]
     */
    static executeFromChat(rawInput, sender = null, force = false) {
        const reply = (msg) => {
            if (sender && typeof sender.sendMessage === "function") {
                sender.sendMessage(msg);
            } else {
                console.warn(msg.replace(/§[0-9a-fk-or]/g, ""));
            }
        };

        const outcome = SQLInterpreter.interpret(rawInput, { allowUnsafeWrite: force });

        if (!outcome.ok) {
            reply(`§c§l[MCSQL Errore]§r §c${outcome.error}`);
            if (outcome.hint) {
                reply(`§7Suggerimento: ${outcome.hint}`);
            }
            return;
        }

        if (outcome.warnings && outcome.warnings.length > 0) {
            for (const warn of outcome.warnings) {
                reply(`§e[MCSQL Avviso] §7${warn}`);
            }
        }

        switch (outcome.kind) {
            case "meta":
                this._renderMetaResult(outcome.meta, outcome.elapsedMs, reply);
                break;

            case "validation":
                reply(`§a§l[MCSQL Validazione OK]§r §fTipo: §b${outcome.validation.statementType} §7| Tabella: §b${outcome.validation.table} §8(${outcome.elapsedMs}ms)`);
                break;

            case "rows":
                this._renderRowsResult(outcome.rows, outcome.elapsedMs, reply);
                break;

            case "mutation":
                this._renderMutationResult(outcome.mutation, outcome.elapsedMs, reply);
                break;
        }
    }

    /* =========================================================================
       CHAT RENDERERS
    ========================================================================= */

    static _renderMetaResult(meta, elapsedMs, reply) {
        const lines = [`§6§l[MCSQL] ${meta.title}:`];
        for (const line of meta.lines) {
            lines.push(`§8 - §f${line}`);
        }
        lines.push(`§8Completato in ${elapsedMs}ms.`);
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

    static _renderRowsResult(rows, elapsedMs, reply) {
        if (rows.length === 0) {
            reply(`§e[MCSQL] Nessun record trovato. §8(${elapsedMs}ms)`);
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

        lines.push(`§8Query eseguita in ${elapsedMs}ms.`);
        reply(lines.join("\n"));
    }

    static _renderMutationResult(res, elapsedMs, reply) {
        if (res.insertId !== undefined) {
            const idsInfo = res.insertIds.length > 1
                ? `IDs: §b${res.insertIds.join(", ")}`
                : `ID: §b${res.insertId}`;
            reply(`§a[MCSQL] INSERT completato: §f${res.affectedRows} §arecord inseriti (${idsInfo}§a). §8(${elapsedMs}ms)`);
            return;
        }

        if (res.affectedRows !== undefined) {
            reply(`§a[MCSQL] Query eseguita: §f${res.affectedRows} §arecord interessati. §8(${elapsedMs}ms)`);
            return;
        }

        if (res.action === "created") {
            reply(`§a[MCSQL] Tabella §b${res.table} §acreata con successo. §8(${elapsedMs}ms)`);
            return;
        }

        if (res.action === "exists") {
            reply(`§e[MCSQL] La tabella §b${res.table} §eesiste già. §8(${elapsedMs}ms)`);
            return;
        }

        if (res.truncated) {
            reply(`§a[MCSQL] Tabella §b${res.table} §asvuotata con successo. §8(${elapsedMs}ms)`);
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

        reply(`§a[MCSQL] Operazione completata. §8(${elapsedMs}ms)`);
    }
}
