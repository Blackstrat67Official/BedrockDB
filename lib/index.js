import { Storage } from "./classes/Storage.js";
import { Cache } from "./classes/Cache.js";
import { MCSQL } from "./classes/MCSQL.js";
import { MCSQLDataType } from "./classes/MCSQLDataType.js";
import { SQLTransaction } from "./classes/SQLTransaction.js";
import { SQLTrigger } from "./classes/SQLTrigger.js";
import { SQLScheduler } from "./classes/SQLScheduler.js";
import { SQLInterpreter } from "./classes/SQLInterpreter.js";
import { SQLCommand } from "./commands/SQLCommand.js";
import { BedrockDBEnv } from "./commands/BedrockDBEnv.js";

/**
 * Costrutto unico che raccoglie l'intera libreria database per Minecraft Bedrock.
 */
const BedrockDB = Object.freeze({
    Storage,
    Cache,
    MCSQL,
    MCSQLDataType,
    SQLTransaction,
    SQLTrigger,
    SQLScheduler,
    SQLInterpreter,
    SQLCommand,
    BedrockDBEnv
});

// Esportazioni nominate
export {
    Storage,
    Cache,
    MCSQL,
    MCSQLDataType,
    SQLTransaction,
    SQLTrigger,
    SQLScheduler,
    SQLInterpreter,
    SQLCommand,
    BedrockDBEnv
};

// Esportazione predefinita come singolo oggetto unificato
export default BedrockDB;
