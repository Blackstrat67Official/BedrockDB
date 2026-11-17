import { Storage } from "./classes/Storage.js";
import { Cache } from "./classes/Cache.js";
import { MCSQL } from "./classes/MCSQL.js";
import { MCSQLDataType } from "./classes/MCSQLDataType.js";
import { SQLTransaction } from "./classes/SQLTransaction.js";
import { SQLInterpreter } from "./classes/SQLInterpreter.js";
import { SQLCommand } from "./commands/SQLCommand.js";
import { BedrockDBEnv } from "./commands/BedrockDBEnv.js";

const BedrockDB = Object.freeze({
    Storage,
    Cache,
    MCSQL,
    MCSQLDataType,
    SQLTransaction,
    SQLInterpreter,
    SQLCommand,
    BedrockDBEnv
});

export {
    Storage,
    Cache,
    MCSQL,
    MCSQLDataType,
    SQLTransaction,
    SQLInterpreter,
    SQLCommand,
    BedrockDBEnv
};

export default BedrockDB;
