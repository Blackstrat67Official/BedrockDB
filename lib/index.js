import { Storage } from "./classes/Storage.js";
import { Cache } from "./classes/Cache.js";
import { MCSQL } from "./classes/MCSQL.js";
import { MCSQLDataType } from "./classes/MCSQLDataType.js";
import { SQLTransaction } from "./classes/SQLTransaction.js";
import { SQLInterpreter } from "./classes/SQLInterpreter.js";
import { SQLCommand } from "./commands/SQLCommand.js";

/**
 * Costrutto unico che raccoglie l'intera libreria database per Minecraft Bedrock.
 */
const BedrockDB = Object.freeze({
    Storage,
    Cache,
    MCSQL,
    MCSQLDataType,
    SQLTransaction,
    SQLInterpreter,
    SQLCommand
});

// Esportazioni nominate
export {
    Storage,
    Cache,
    MCSQL,
    MCSQLDataType,
    SQLTransaction,
    SQLInterpreter,
    SQLCommand
};

// Esportazione predefinita come singolo oggetto unificato
export default BedrockDB;
