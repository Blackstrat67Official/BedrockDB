# BedrockDB & MCSQL — Official Guide (v1.0.0)

**BedrockDB** is a relational and document-oriented (JSON) database engine designed for **Minecraft Bedrock Script API (`@minecraft/server`)**.
It uses Minecraft's native scoreboards as a zero-dependency persistence layer, adding a full SQL interpreter (**MCSQL**), primary and foreign keys, virtual views, an indexed $O(1)$ in-memory cache, ACID transactions, reactive triggers, persistent timers, and a MariaDB-style interactive console directly in chat.

---

## Table of Contents

1. [Architecture & Minecraft Limitations](#1-architettura--limiti-di-minecraft)
2. [Installation & Configuration](#2-installazione--configurazione)
3. [SQL Engine (`MCSQL`)](#3-motore-sql-mcsql)
4. [SQL Functions & Dynamic Types (`MCSQLDataType`)](#4-funzioni-sql--tipi-dinamici-mcsqldatatype)
5. [Direct API (`Storage` & `QueryBuilder`)](#5-api-diretta-storage--querybuilder)
6. [Indexed In-Memory Cache (`Cache`)](#6-cache-indicizzata-in-ram-cache)
7. [ACID Atomic Transactions (`SQLTransaction`)](#7-transazioni-atomiche-acid-sqltransaction)
8. [Reactive Triggers & Audit Log (`SQLTrigger`)](#8-trigger-reattivi--audit-log-sqltrigger)
9. [Persistent Timers & Auto-Flush (`SQLScheduler`)](#9-timer-persistenti--auto-flush-sqlscheduler)
10. [Interactive Console & Chat Commands (`BedrockDBEnv` / `SQLCommand`)](#10-console-interattiva--comandi-chat-bedrockdbenv--sqlcommand)

---

## 1. Architecture & Minecraft Limitations

BedrockDB maps relational database concepts directly onto Minecraft world's native data structures:

| Database Concept | Minecraft Bedrock Implementation |
| :--- | :--- |
| **Table** | `ScoreboardObjective` (es. `players`, `vehicles`) |
| **Row (Record)** | Fake participant (`ScoreboardIdentity`) serializzato in JSON |
| **Internal Primary Key (`id`)** | Numeric score (`score >= 1`) gestito da un contatore monotonico `__seq__` |
| **System Metadata** | Reserved tables with the prefix `_db_` (`_db_schemas`, `_db_views`, `_db_schedules`, `_db_audit`) |

### Minecraft Technical Limitations to Keep in Mind
* **Nome tabella:** up to **16 characters** (a Bedrock-imposed limit for scoreboard objective IDs).
* **Dimensione singolo record:** up to **32,767 JSON characters** per row.
* **Runtime:** QuickJS (ES2023) with no access to an external filesystem; all data is stored natively in the world file.

---

## 2. Installation & Configuration

### 2.1 `manifest.json`
Make sure the Behavior Pack declares the `@minecraft/server` dependency version `2.0.0-beta` (required for custom command registration and private chat interception), and enable the **Beta APIs** experiment in the world settings.

```json
{
  "format_version": 2,
  "header": {
    "name": "MyServer Core [BP]",
    "description": "Behavior Pack with BedrockDB",
    "uuid": "a4f82e1c-7b39-4d62-9e15-3c8a70f14b29",
    "version": [1, 0, 0],
    "min_engine_version": [1, 21, 90]
  },
  "modules": [
    {
      "type": "script",
      "language": "javascript",
      "uuid": "5c3b9a84-6f12-4e78-a290-1f7d84e36c52",
      "version": [1, 0, 0],
      "entry": "scripts/main.js"
    }
  ],
  "dependencies": [
    {
      "module_name": "@minecraft/server",
      "version": "2.0.0-beta"
    }
  ]
}
```

### 2.2 Entry Point (`scripts/main.js`)

```javascript
import { system } from "@minecraft/server";
import BedrockDB, {
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
} from "./libs/BedrockDB/index.js";

// Registers the /uc:sql and /uc:bedrockdb commands when the server starts
system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
    SQLCommand.register(customCommandRegistry);
    BedrockDBEnv.register(customCommandRegistry);
});
```

---

## 3. SQL Engine (`MCSQL`)

`MCSQL` compiles actual SQL queries into execution plans optimized for `Storage`, while maintaining an internal **Plan Cache** to avoid reparsing repeated queries in gameplay loops.

### 3.1 Parameterized Queries (Security & Performance)
It supports three placeholder styles to prevent syntax errors or injection:
* **Posizionali (`?`):** `MCSQL.query("SELECT * FROM players WHERE coins >= ? AND job = ?", [500, "Polizia"])`
* **Indicizzati (`$1, $2`):** `MCSQL.query("SELECT * FROM players WHERE job = $1 OR rank = $1", ["Admin"])`
* **Nominativi (`:param`):** `MCSQL.query("SELECT * FROM players WHERE uuid = :id", { id: player.id })`

### 3.2 DDL: Tables, Constraints, ENUMs & Virtual Views

```javascript
// Create a table with PRIMARY KEY, ENUM, UNIQUE, NOT NULL, and dynamic DEFAULT constraints
MCSQL.query(`
    CREATE TABLE IF NOT EXISTS players (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role ENUM('cittadino', 'polizia', 'medico', 'staff') DEFAULT 'cittadino',
        coins INT DEFAULT 100,
        createdAt INT DEFAULT NOW()
    )
`);

// Create a child table with a FOREIGN KEY and referential actions (CASCADE / RESTRICT / SET NULL)
MCSQL.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
        plate TEXT PRIMARY KEY,
        ownerUuid TEXT REFERENCES players(uuid) ON DELETE CASCADE ON UPDATE CASCADE,
        model TEXT NOT NULL,
        impounded BOOLEAN DEFAULT FALSE
    )
`);

// Modify constraints on an existing table
MCSQL.query("ALTER TABLE players ADD UNIQUE (name)");

// Create a persistent virtual view (stored in _db_views)
MCSQL.query(`
    CREATE OR REPLACE VIEW police_roster AS
    SELECT uuid, name, coins
    FROM players
    WHERE role = 'polizia'
`);

// Cleanup and removal
MCSQL.query("TRUNCATE TABLE vehicles RESTART IDENTITY");
MCSQL.query("DROP VIEW IF EXISTS police_roster");
MCSQL.query("DROP TABLE IF EXISTS vehicles");
```

### 3.3 DML: `INSERT`, `UPDATE`, `DELETE`

```javascript
// Single-row or multi-row INSERT
const res = MCSQL.query(
    "INSERT INTO players (uuid, name, role, coins) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    ["p-1", "Alex", "polizia", 1500, "p-2", "Marco", "cittadino", 300]
);
// res -> { affectedRows: 2, insertId: 1, insertIds: [1, 2] }

// Direct INSERT from a JSON object
MCSQL.query("INSERT INTO players JSON ?", [{ uuid: "p-3", name: "Sara", coins: 800 }]);

// UPDATE with an atomic increment and property removal (UNSET)
MCSQL.query("UPDATE players SET coins = coins + 250, UNSET tempFlag WHERE uuid = ?", ["p-1"]);

// DELETE (always requires WHERE or WHERE ALL for safety)
MCSQL.query("DELETE FROM vehicles WHERE impounded = TRUE");
MCSQL.query("DELETE FROM vehicles WHERE ALL");
```

### 3.4 `SELECT`, `JOIN`, Subqueries and Aggregations

```javascript
// INNER JOIN & LEFT JOIN using Hash Join O(N + M)
const fleet = MCSQL.query(`
    SELECT p.name AS proprietario, v.plate AS targa, v.model
    FROM players p
    INNER JOIN vehicles v ON p.uuid = v.ownerUuid
    WHERE v.impounded = FALSE
    ORDER BY p.name ASC
    LIMIT 10 OFFSET 0
`);

// Nested subqueries (IN, EXISTS, and scalar subqueries)
const richCitizens = MCSQL.query(`
    SELECT name, coins
    FROM players
    WHERE coins > (SELECT AVG(coins) FROM players)
      AND uuid IN (SELECT ownerUuid FROM vehicles)
`);

// Aggregations and GROUP BY
const statsByRole = MCSQL.query(`
    SELECT role, COUNT(*) AS totale, SUM(coins) AS patrimonioTotale, AVG(coins) AS media
    FROM players
    GROUP BY role
    ORDER BY patrimonioTotale DESC
`);

// Quick methods for a single row or scalar value
const singlePlayer = MCSQL.queryOne("SELECT * FROM players WHERE uuid = ?", ["p-1"]);
const totalCoins = MCSQL.scalar("SELECT SUM(coins) FROM players");

// Inspect the execution plan without modifying data
const plan = MCSQL.explain("SELECT * FROM players WHERE coins >= ?", [1000]);
```

---

## 4. SQL Functions & Dynamic Types (`MCSQLDataType`)

Functions registered in `MCSQLDataType` can be called directly inside `SELECT`, `INSERT`, `UPDATE`, `WHERE` and in `DEFAULT`.

### 4.1 General Built-in Functions
* **Identifiers & Time:** `UUID()`, `SHORT_UUID([len=8])`, `NOW()`, `ISO_DATE([timestampMs])`
* **Validation:** `ENUM(valore, 'opt1', 'opt2', ...)`
* **Strings:** `UPPER(txt)`, `LOWER(txt)`, `TRIM(txt)`, `CONCAT(a, b, ...)`, `COALESCE(a, b, ...)`
* **Math & Random:** `RAND()`, `RAND_INT(min, max)`, `ROUND(num, [dec])`, `FLOOR(num)`, `CEIL(num)`, `ABS(num)`
* **JSON:** `JSON_ARRAY(v1, v2, ...)`, `JSON_OBJECT('k1', v1, 'k2', v2)`

### 4.2 Spatial & Minecraft-Aware Functions

| Function | Description |
| :--- | :--- |
| `PLAYER_POS(nameOrId)` | Returns `{ x, y, z, dimension }` for the online player, or `NULL`. |
| `PLAYER_ID(playerName)` | Returns l'ID univoco del giocatore online dal nome. |
| `ONLINE_COUNT()` | Returns il numero di giocatori attualmente connessi. |
| `DISTANCE(posA, posB)` | 3D Euclidean distance between two points (or 6 numbers `x1,y1,z1,x2,y2,z2`). |
| `DISTANCE_2D(posA, posB)` | Horizontal distance on the `(X, Z)`. |
| `HAS_TAG(nameOrId, tag)` | Checks whether an online player has a specific Minecraft tag. |
| `SCORE(target, objective)` | Reads a score from a vanilla Minecraft scoreboard. |

```javascript
// Example: Save Steve's current position in the homes table
MCSQL.query(
    "INSERT INTO homes (id, owner, name, coords) VALUES (UUID(), ?, ?, PLAYER_POS(?))",
    ["Steve", "Villa", "Steve"]
);

// Example: Spatial query — find all shops within 30 blocks of Steve
const nearbyShops = MCSQL.query(`
    SELECT name, owner
    FROM shops
    WHERE DISTANCE(coords, PLAYER_POS('Steve')) <= 30
`);

// Example: SELECT without FROM
const serverInfo = MCSQL.queryOne("SELECT UUID() AS sessionId, NOW() AS serverTime, ONLINE_COUNT() AS online");
```

### 4.3 Registering Custom Functions

```javascript
MCSQLDataType.register("TAX", ([amount, rate = 0.22]) => {
    return Math.round(Number(amount) * Number(rate));
}, {
    minArgs: 1,
    maxArgs: 2,
    signature: "TAX(amount, [rate=0.22])",
    description: "Calculates the tax on an amount."
});

// Immediate use in SQL:
// SELECT name, coins, TAX(coins) AS tax FROM players;
```

---

## 5. Direct API (`Storage` & `QueryBuilder`)

For very high-frequency operations or complex JavaScript logic, you can use `Storage` without going through the SQL parser.

```javascript
// Direct CRUD operations
const rowId = Storage.insert("players", { uuid: "p-10", name: "Luca", coins: 500, stats: { kills: 2 } });
const byId = Storage.findById("players", rowId);

// Advanced WHERE operators ($gt, $gte, $lt, $lte, $ne, $between, $in, $nin, $contains, $like, $regex, $exists, $and, $or, $not)
const results = Storage.select("players", {
    columns: ["uuid", "name", "coins"],
    where: {
        coins: { $between: [200, 2000] },
        name: { $like: "L%" },
        "stats.kills": { $gte: 1 }
    },
    orderBy: { coins: "DESC" },
    limit: 10
});

// Atomic modifiers ($inc, $push, $pull, $unset)
Storage.update("players", { uuid: "p-10" }, {
    $inc: { coins: 150 },
    $push: { badges: "veterano" }
});

// Upsert (updates if it exists; otherwise inserts)
Storage.upsert("players", { uuid: "p-10" }, { name: "Luca", coins: 650 });

// Fluent QueryBuilder
const top3 = Storage.from("players")
    .select(["name", "coins"])
    .where({ role: "cittadino" })
    .orderBy("coins", "DESC")
    .limit(3)
    .flat()
    .exec();
```

---

## 6. Indexed In-Memory Cache (`Cache`)

`Cache` keeps frequently accessed records in memory with **indici secondari $O(1)$**, eviction **LRU**, expiration **TTL** e modalità **Write-Behind** (changes are made in RAM at 20 TPS and saved to the scoreboard only on `flush()`).

```javascript
// 1. Configure the cache for the players table
Cache.define("players", {
    indexes: ["uuid", "name"], // Lookup istantanei O(1) per uuid e name
    maxSize: 200,              // Massimo 200 record in RAM (LRU)
    ttl: 0,                    // Nessuna expiration automatica
    writeBehind: true,         // Le mutate() restano in RAM fino al flush()
    autoSync: true,            // Si sincronizza se Storage viene modificato esternamente
    preload: true              // Precarica subito i record all'avvio
});

// 2. O(1) lookup without accessing Storage
const entry = Cache.getBy("players", "uuid", player.id); // -> { id, data } | null

// 3. High-speed in-memory mutation (e.g. inside a loop running every tick)
if (entry) {
    Cache.mutate("players", entry.id, { $inc: { coins: 5 } });
}

// 4. Save all modified (dirty) records to the scoreboard
Cache.flush("players");

// 5. Memoize expensive queries with automatic invalidation when the table is written to
const leaderboard = Cache.remember(
    "top_10_ricchi",
    () => MCSQL.query("SELECT name, coins FROM players ORDER BY coins DESC LIMIT 10"),
    { ttl: 30_000, tags: ["table:players"] }
);
```

---

## 7. ACID Atomic Transactions (`SQLTransaction`)

`SQLTransaction` captures Copy-On-Write snapshots of scoreboards before each write. If a query or constraint (`PRIMARY KEY`, `FOREIGN KEY`, `ENUM`, trigger `BEFORE_*`) causes an error, **all changes are automatically rolled back**.

```javascript
// Atomic bank transfer between two players
function transferMoney(fromUuid, toUuid, amount) {
    return SQLTransaction.run((tx) => {
        const sender = tx.queryOne("SELECT coins FROM players WHERE uuid = ?", [fromUuid]);
        if (!sender || sender.coins < amount) {
            throw new Error("Insufficient balance to complete the transfer.");
        }

        tx.query("UPDATE players SET coins = coins - ? WHERE uuid = ?", [amount, fromUuid]);
        tx.query("UPDATE players SET coins = coins + ? WHERE uuid = ?", [amount, toUuid]);
        tx.query(
            "INSERT INTO tx_logs (id, fromUuid, toUuid, amount, ts) VALUES (UUID(), ?, ?, ?, NOW())",
            [fromUuid, toUuid, amount]
        );
    });
}

// Nested transactions with automatic or explicit SQL savepoints
MCSQL.query("BEGIN");
MCSQL.query("INSERT INTO players (uuid, name, coins) VALUES ('u1', 'Test', 100)");
MCSQL.query("SAVEPOINT sp1");
MCSQL.query("UPDATE players SET coins = 9999 WHERE uuid = 'u1'");
MCSQL.query("ROLLBACK TO SAVEPOINT sp1"); // Torna a coins = 100
MCSQL.query("COMMIT");
```

---

## 8. Reactive Triggers & Audit Log (`SQLTrigger`)

`SQLTrigger` allows you to react before (`BEFORE_*`) or after (`AFTER_*`) any `INSERT`, `UPDATE`, `DELETE` o `TRUNCATE`.

```javascript
import { world } from "@minecraft/server";
import { SQLTrigger } from "./libs/BedrockDB/index.js";

// 1. Validation or normalization before insertion/update
SQLTrigger.beforeInsert("players", (ctx) => {
    if (ctx.newRow.coins < 0) {
        ctx.cancel("The initial balance cannot be negative.");
    }
    ctx.newRow.name = ctx.newRow.name.trim();
});

// 2. Watch a specific field (e.g. update the ActionBar when the balance changes)
SQLTrigger.watchField("players", "coins", ({ oldValue, newValue, newRow }) => {
    const player = world.getAllPlayers().find(p => p.id === newRow.uuid);
    player?.onScreenDisplay.setActionBar(`§eSaldo: §f${newValue} ⛁ §7(${newValue >= oldValue ? "+" : ""}${newValue - oldValue})`);
});

// 3. Automatic persistent audit log in _db_audit
SQLTrigger.enableAuditLog({
    tables: ["players", "vehicles"],
    maxEntries: 500
});
```

---

## 9. Persistent Timers & Auto-Flush (`SQLScheduler`)

Unlike `system.runTimeout`, the timers in `SQLScheduler` are stored in the table `_db_schedules` and **survive `/reload` and server restarts**.

```javascript
// 1. Register the persistent handler when the script starts
SQLScheduler.registerHandler("release_prisoner", ({ uuid }) => {
    MCSQL.query("UPDATE players SET jailed = FALSE WHERE uuid = ?", [uuid]);
});

// 2. Schedule the prisoner's release in 10 minutes (600,000 ms) with a deduplication key
SQLScheduler.schedule("release_prisoner", 600_000, { uuid: player.id }, {
    key: `jail:${player.id}`,
    maxRetries: 2
});

// 3. Enable automatic cache flushing with a maximum budget of 5 writes per tick
SQLScheduler.enableCacheAutoFlush({
    intervalTicks: 40,
    maxWritesPerTick: 5
});

// 4. Automatically save and evict player data when they leave the server
SQLScheduler.bindPlayerLeave("players", "uuid", {
    flush: true,
    evict: true
});
```

---

## 10. Interactive Console & Chat Commands (`BedrockDBEnv` / `SQLCommand`)

Operators with `GameDirectors` permissions can administer the entire database directly in-game in two ways:

### 10.1 MariaDB-Style Interactive Terminal (`/uc:bedrockdb connect`)
1. Type in chat: `/uc:bedrockdb connect`
2. Your prompt becomes private (`bedrockDB@TuoNome$`): messages you type in chat are not sent to other players.
3. You can write **multi-line** queries, ending them with a semicolon `;`:
   ```sql
   SELECT name, role, coins
   FROM players
   WHERE coins >= 500
   ORDER BY coins DESC;
   ```
4. **Special console commands:**
   * `help;` — Displays the list of terminal commands.
   * `\c` oppure `clear` — Clears the current multi-line query buffer.
   * `exit` oppure `\q` — Disconnects the terminal and restores normal chat.
   * `/uc:bedrockdb exec "SHOW TABLES;"` — Executes a quick query without opening a session.

### 10.2 Single Command (`/uc:sql`)
Executes a single query by passing it as a quoted string:
```text
/uc:sql "SELECT * FROM players LIMIT 10"
/uc:sql "DELETE FROM vehicles WHERE impounded = TRUE" true
```

### 10.3 Built-in Diagnostic Meta-Commands
Available in both `BedrockDBEnv` and in `/uc:sql` as well as through `SQLInterpreter.interpret()`:
* `SHOW TABLES;` — Lists all tables in the world, including record counts, primary keys, and foreign keys.
* `SHOW VIEWS;` — Lists all saved virtual SQL views.
* `DESCRIBE <tabella_o_vista>;` — Displays columns, types (`ENUM`, `INT`, etc.), constraints, and relationships.
* `SHOW FUNCTIONS;` — Lists all available scalar and Minecraft-aware functions.
* `SHOW TRIGGERS;` — Displays all active triggers and watched fields.
* `SHOW SCHEDULES;` — Displays queued persistent timers and the remaining time.
* `CACHE STATS;` — Displays the hit rate, in-memory records, and `dirty` records awaiting a flush.
* `EXPLAIN <query>;` — Shows how `MCSQL` translates a query into `Storage`.
* `VALIDATE <query>;` — Validates syntax and constraints without applying any changes.
