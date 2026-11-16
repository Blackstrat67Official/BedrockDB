import { Storage } from "./classes/Storage.js";
import { Cache } from "./classes/Cache.js";
import { MCSQL } from "./classes/MCSQL.js";
import { SqlCommand } from "./commands/SQLCommand.js";

/**
 * Costrutto unico che raccoglie l'intera libreria database per Minecraft Bedrock.
 * L'importazione di questo file registra automaticamente anche il comando `/uc:sql`.
 */
const BedrockDB = Object.freeze({
    Storage,
    Cache,
    MCSQL,
    SQLCommand,
});

// Esportazioni nominate (es. import { Storage, Cache, MCSQL, SQLCommand } from "./lib/index.js")
export {
    Storage,
    Cache,
    MCSQL,
    SQLCommand,
};

// Esportazione predefinita come singolo oggetto unificato (es. import DB from "./lib/index.js")
export default BedrockDB;
