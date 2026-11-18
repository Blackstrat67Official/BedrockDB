# BedrockDB & MCSQL — Guida Ufficiale (v1.0.0)

**BedrockDB** è un motore database relazionale e document-oriented (JSON) progettato per **Minecraft Bedrock Script API (`@minecraft/server`)**.
Sfrutta le scoreboard native di Minecraft come livello di persistenza zero-dipendenze, aggiungendo un interprete SQL completo (**MCSQL**), chiavi primarie ed esterne, viste virtuali, cache indicizzata $O(1)$ in RAM, transazioni ACID, trigger reattivi, timer persistenti e una console interattiva stile MariaDB direttamente in chat.

---

## Indice

1. [Architettura & Limiti di Minecraft](#1-architettura--limiti-di-minecraft)
2. [Installazione & Configurazione](#2-installazione--configurazione)
3. [Motore SQL (`MCSQL`)](#3-motore-sql-mcsql)
4. [Funzioni SQL & Tipi Dinamici (`MCSQLDataType`)](#4-funzioni-sql--tipi-dinamici-mcsqldatatype)
5. [API Diretta (`Storage` & `QueryBuilder`)](#5-api-diretta-storage--querybuilder)
6. [Cache Indicizzata in RAM (`Cache`)](#6-cache-indicizzata-in-ram-cache)
7. [Transazioni Atomiche ACID (`SQLTransaction`)](#7-transazioni-atomiche-acid-sqltransaction)
8. [Trigger Reattivi & Audit Log (`SQLTrigger`)](#8-trigger-reattivi--audit-log-sqltrigger)
9. [Timer Persistenti & Auto-Flush (`SQLScheduler`)](#9-timer-persistenti--auto-flush-sqlscheduler)
10. [Console Interattiva & Comandi Chat (`BedrockDBEnv` / `SQLCommand`)](#10-console-interattiva--comandi-chat-bedrockdbenv--sqlcommand)

---

## 1. Architettura & Limiti di Minecraft

BedrockDB mappa i concetti di un database relazionale direttamente sulle strutture native del mondo Minecraft:

| Concetto Database | Implementazione in Minecraft Bedrock |
| :--- | :--- |
| **Tabella** | `ScoreboardObjective` (es. `players`, `vehicles`) |
| **Riga (Record)** | Partecipante fittizio (`ScoreboardIdentity`) serializzato in JSON |
| **Primary Key Interna (`id`)** | Punteggio numerico (`score >= 1`) gestito da un contatore monotonico `__seq__` |
| **Metadati di Sistema** | Tabelle riservate con prefisso `_db_` (`_db_schemas`, `_db_views`, `_db_schedules`, `_db_audit`) |

### Limiti tecnici di Minecraft da tenere a mente
* **Nome tabella:** massimo **16 caratteri** (limite imposto da Bedrock per gli ID degli obiettivi scoreboard).
* **Dimensione singolo record:** massimo **32.767 caratteri** JSON per riga.
* **Runtime:** QuickJS (ES2023) senza accesso a filesystem esterno; tutti i dati vengono salvati nativamente nel file del mondo.

---

## 2. Installazione & Configurazione

### 2.1 `manifest.json`
Assicurati che il Behavior Pack dichiari la dipendenza `@minecraft/server` in versione `2.0.0-beta` (necessaria per la registrazione dei comandi custom e l'intercettazione privata della chat) e attiva l'esperimento **Beta APIs** nelle impostazioni del mondo.

```json
{
  "format_version": 2,
  "header": {
    "name": "MyServer Core [BP]",
    "description": "Behavior Pack con BedrockDB",
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

// Registra i comandi /uc:sql e /uc:bedrockdb all'avvio del server
system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
    SQLCommand.register(customCommandRegistry);
    BedrockDBEnv.register(customCommandRegistry);
});
```

---

## 3. Motore SQL (`MCSQL`)

`MCSQL` compila query SQL reali in piani di esecuzione ottimizzati per `Storage`, mantenendo una **Plan Cache** interna per evitare di riparsare query ripetute nei loop di gameplay.

### 3.1 Query Parametriche (Sicurezza & Performance)
Supporta tre stili di placeholder per evitare errori di sintassi o injection:
* **Posizionali (`?`):** `MCSQL.query("SELECT * FROM players WHERE coins >= ? AND job = ?", [500, "Polizia"])`
* **Indicizzati (`$1, $2`):** `MCSQL.query("SELECT * FROM players WHERE job = $1 OR rank = $1", ["Admin"])`
* **Nominativi (`:param`):** `MCSQL.query("SELECT * FROM players WHERE uuid = :id", { id: player.id })`

### 3.2 DDL: Tabelle, Vincoli, ENUM & Viste Virtuali

```javascript
// Creazione tabella con PRIMARY KEY, ENUM, UNIQUE, NOT NULL e DEFAULT dinamici
MCSQL.query(`
    CREATE TABLE IF NOT EXISTS players (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role ENUM('cittadino', 'polizia', 'medico', 'staff') DEFAULT 'cittadino',
        coins INT DEFAULT 100,
        createdAt INT DEFAULT NOW()
    )
`);

// Creazione tabella figlia con FOREIGN KEY e azioni referenziali (CASCADE / RESTRICT / SET NULL)
MCSQL.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
        plate TEXT PRIMARY KEY,
        ownerUuid TEXT REFERENCES players(uuid) ON DELETE CASCADE ON UPDATE CASCADE,
        model TEXT NOT NULL,
        impounded BOOLEAN DEFAULT FALSE
    )
`);

// Modifica vincoli su tabella esistente
MCSQL.query("ALTER TABLE players ADD UNIQUE (name)");

// Creazione Vista Virtuale persistente (salvata in _db_views)
MCSQL.query(`
    CREATE OR REPLACE VIEW police_roster AS
    SELECT uuid, name, coins
    FROM players
    WHERE role = 'polizia'
`);

// Pulizia e rimozione
MCSQL.query("TRUNCATE TABLE vehicles RESTART IDENTITY");
MCSQL.query("DROP VIEW IF EXISTS police_roster");
MCSQL.query("DROP TABLE IF EXISTS vehicles");
```

### 3.3 DML: `INSERT`, `UPDATE`, `DELETE`

```javascript
// INSERT singolo o multi-riga
const res = MCSQL.query(
    "INSERT INTO players (uuid, name, role, coins) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    ["p-1", "Alex", "polizia", 1500, "p-2", "Marco", "cittadino", 300]
);
// res -> { affectedRows: 2, insertId: 1, insertIds: [1, 2] }

// INSERT diretto da oggetto JSON
MCSQL.query("INSERT INTO players JSON ?", [{ uuid: "p-3", name: "Sara", coins: 800 }]);

// UPDATE con incremento atomico e rimozione proprietà (UNSET)
MCSQL.query("UPDATE players SET coins = coins + 250, UNSET tempFlag WHERE uuid = ?", ["p-1"]);

// DELETE (richiede sempre WHERE o WHERE ALL per sicurezza)
MCSQL.query("DELETE FROM vehicles WHERE impounded = TRUE");
MCSQL.query("DELETE FROM vehicles WHERE ALL");
```

### 3.4 Query `SELECT`, `JOIN`, Subquery e Aggregazioni

```javascript
// INNER JOIN & LEFT JOIN con Hash Join O(N + M)
const fleet = MCSQL.query(`
    SELECT p.name AS proprietario, v.plate AS targa, v.model
    FROM players p
    INNER JOIN vehicles v ON p.uuid = v.ownerUuid
    WHERE v.impounded = FALSE
    ORDER BY p.name ASC
    LIMIT 10 OFFSET 0
`);

// Subquery annidate (IN, EXISTS, e subquery scalari)
const richCitizens = MCSQL.query(`
    SELECT name, coins
    FROM players
    WHERE coins > (SELECT AVG(coins) FROM players)
      AND uuid IN (SELECT ownerUuid FROM vehicles)
`);

// Aggregazioni e GROUP BY
const statsByRole = MCSQL.query(`
    SELECT role, COUNT(*) AS totale, SUM(coins) AS patrimonioTotale, AVG(coins) AS media
    FROM players
    GROUP BY role
    ORDER BY patrimonioTotale DESC
`);

// Metodi rapidi per riga singola o valore scalare
const singlePlayer = MCSQL.queryOne("SELECT * FROM players WHERE uuid = ?", ["p-1"]);
const totalCoins = MCSQL.scalar("SELECT SUM(coins) FROM players");

// Ispezione del piano di esecuzione senza modificare dati
const plan = MCSQL.explain("SELECT * FROM players WHERE coins >= ?", [1000]);
```

---

## 4. Funzioni SQL & Tipi Dinamici (`MCSQLDataType`)

Le funzioni registrate in `MCSQLDataType` possono essere invocate direttamente dentro `SELECT`, `INSERT`, `UPDATE`, `WHERE` e nelle clausole `DEFAULT`.

### 4.1 Funzioni Built-in Generali
* **Identificatori & Tempo:** `UUID()`, `SHORT_UUID([len=8])`, `NOW()`, `ISO_DATE([timestampMs])`
* **Validazione:** `ENUM(valore, 'opt1', 'opt2', ...)`
* **Stringhe:** `UPPER(txt)`, `LOWER(txt)`, `TRIM(txt)`, `CONCAT(a, b, ...)`, `COALESCE(a, b, ...)`
* **Matematica & Random:** `RAND()`, `RAND_INT(min, max)`, `ROUND(num, [dec])`, `FLOOR(num)`, `CEIL(num)`, `ABS(num)`
* **JSON:** `JSON_ARRAY(v1, v2, ...)`, `JSON_OBJECT('k1', v1, 'k2', v2)`

### 4.2 Funzioni Spaziali & Minecraft-Aware

| Funzione | Descrizione |
| :--- | :--- |
| `PLAYER_POS(nameOrId)` | Restituisce `{ x, y, z, dimension }` del giocatore online o `NULL`. |
| `PLAYER_ID(playerName)` | Restituisce l'ID univoco del giocatore online dal nome. |
| `ONLINE_COUNT()` | Restituisce il numero di giocatori attualmente connessi. |
| `DISTANCE(posA, posB)` | Distanza euclidea 3D tra due punti (o 6 numeri `x1,y1,z1,x2,y2,z2`). |
| `DISTANCE_2D(posA, posB)` | Distanza orizzontale sul piano `(X, Z)`. |
| `HAS_TAG(nameOrId, tag)` | Verifica se un giocatore online possiede uno specifico tag Minecraft. |
| `SCORE(target, objective)` | Legge un punteggio da una scoreboard vanilla di Minecraft. |

```javascript
// Esempio: Salva la posizione attuale di Steve nella tabella homes
MCSQL.query(
    "INSERT INTO homes (id, owner, name, coords) VALUES (UUID(), ?, ?, PLAYER_POS(?))",
    ["Steve", "Villa", "Steve"]
);

// Esempio: Query spaziale — trova tutti i negozi entro 30 blocchi da Steve
const nearbyShops = MCSQL.query(`
    SELECT name, owner
    FROM shops
    WHERE DISTANCE(coords, PLAYER_POS('Steve')) <= 30
`);

// Esempio: SELECT senza FROM
const serverInfo = MCSQL.queryOne("SELECT UUID() AS sessionId, NOW() AS serverTime, ONLINE_COUNT() AS online");
```

### 4.3 Registrare Funzioni Custom

```javascript
MCSQLDataType.register("TAX", ([amount, rate = 0.22]) => {
    return Math.round(Number(amount) * Number(rate));
}, {
    minArgs: 1,
    maxArgs: 2,
    signature: "TAX(amount, [rate=0.22])",
    description: "Calcola l'imposta su un importo."
});

// Utilizzo immediato in SQL:
// SELECT name, coins, TAX(coins) AS tasse FROM players;
```

---

## 5. API Diretta (`Storage` & `QueryBuilder`)

Per operazioni ad altissima frequenza o logica complessa in JavaScript, puoi usare `Storage` senza passare dal parser SQL.

```javascript
// CRUD diretto
const rowId = Storage.insert("players", { uuid: "p-10", name: "Luca", coins: 500, stats: { kills: 2 } });
const byId = Storage.findById("players", rowId);

// Operatori WHERE avanzati ($gt, $gte, $lt, $lte, $ne, $between, $in, $nin, $contains, $like, $regex, $exists, $and, $or, $not)
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

// Modificatori atomici ($inc, $push, $pull, $unset)
Storage.update("players", { uuid: "p-10" }, {
    $inc: { coins: 150 },
    $push: { badges: "veterano" }
});

// Upsert (aggiorna se esiste, altrimenti inserisce)
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

## 6. Cache Indicizzata in RAM (`Cache`)

`Cache` mantiene in memoria i record caldi con **indici secondari $O(1)$**, eviction **LRU**, scadenza **TTL** e modalità **Write-Behind** (modifica in RAM a 20 TPS e salva su scoreboard solo al `flush()`).

```javascript
// 1. Configura la cache per la tabella players
Cache.define("players", {
    indexes: ["uuid", "name"], // Lookup istantanei O(1) per uuid e name
    maxSize: 200,              // Massimo 200 record in RAM (LRU)
    ttl: 0,                    // Nessuna scadenza automatica
    writeBehind: true,         // Le mutate() restano in RAM fino al flush()
    autoSync: true,            // Si sincronizza se Storage viene modificato esternamente
    preload: true              // Precarica subito i record all'avvio
});

// 2. Lookup O(1) senza toccare Storage
const entry = Cache.getBy("players", "uuid", player.id); // -> { id, data } | null

// 3. Mutazione in RAM ad altissima velocità (es. dentro un loop ogni tick)
if (entry) {
    Cache.mutate("players", entry.id, { $inc: { coins: 5 } });
}

// 4. Salva su scoreboard tutti i record modificati (dirty)
Cache.flush("players");

// 5. Memoizzazione di query costose con invalidazione automatica su scrittura tabella
const leaderboard = Cache.remember(
    "top_10_ricchi",
    () => MCSQL.query("SELECT name, coins FROM players ORDER BY coins DESC LIMIT 10"),
    { ttl: 30_000, tags: ["table:players"] }
);
```

---

## 7. Transazioni Atomiche ACID (`SQLTransaction`)

`SQLTransaction` cattura snapshot Copy-On-Write delle scoreboard prima di ogni scrittura. Se una query o un vincolo (`PRIMARY KEY`, `FOREIGN KEY`, `ENUM`, trigger `BEFORE_*`) genera un errore, **tutte le modifiche vengono annullate automaticamente**.

```javascript
// Trasferimento bancario atomico tra due giocatori
function transferMoney(fromUuid, toUuid, amount) {
    return SQLTransaction.run((tx) => {
        const sender = tx.queryOne("SELECT coins FROM players WHERE uuid = ?", [fromUuid]);
        if (!sender || sender.coins < amount) {
            throw new Error("Saldo insufficiente per completare il bonifico.");
        }

        tx.query("UPDATE players SET coins = coins - ? WHERE uuid = ?", [amount, fromUuid]);
        tx.query("UPDATE players SET coins = coins + ? WHERE uuid = ?", [amount, toUuid]);
        tx.query(
            "INSERT INTO tx_logs (id, fromUuid, toUuid, amount, ts) VALUES (UUID(), ?, ?, ?, NOW())",
            [fromUuid, toUuid, amount]
        );
    });
}

// Transazioni annidate con Savepoint automatici o espliciti via SQL
MCSQL.query("BEGIN");
MCSQL.query("INSERT INTO players (uuid, name, coins) VALUES ('u1', 'Test', 100)");
MCSQL.query("SAVEPOINT sp1");
MCSQL.query("UPDATE players SET coins = 9999 WHERE uuid = 'u1'");
MCSQL.query("ROLLBACK TO SAVEPOINT sp1"); // Torna a coins = 100
MCSQL.query("COMMIT");
```

---

## 8. Trigger Reattivi & Audit Log (`SQLTrigger`)

`SQLTrigger` permette di reagire prima (`BEFORE_*`) o dopo (`AFTER_*`) qualsiasi operazione `INSERT`, `UPDATE`, `DELETE` o `TRUNCATE`.

```javascript
import { world } from "@minecraft/server";
import { SQLTrigger } from "./libs/BedrockDB/index.js";

// 1. Validazione o normalizzazione prima dell'inserimento/aggiornamento
SQLTrigger.beforeInsert("players", (ctx) => {
    if (ctx.newRow.coins < 0) {
        ctx.cancel("Il saldo iniziale non può essere negativo.");
    }
    ctx.newRow.name = ctx.newRow.name.trim();
});

// 2. Osserva un singolo campo specifico (es. aggiorna l'ActionBar al cambio monete)
SQLTrigger.watchField("players", "coins", ({ oldValue, newValue, newRow }) => {
    const player = world.getAllPlayers().find(p => p.id === newRow.uuid);
    player?.onScreenDisplay.setActionBar(`§eSaldo: §f${newValue} ⛁ §7(${newValue >= oldValue ? "+" : ""}${newValue - oldValue})`);
});

// 3. Audit Log automatico persistente in _db_audit
SQLTrigger.enableAuditLog({
    tables: ["players", "vehicles"],
    maxEntries: 500
});
```

---

## 9. Timer Persistenti & Auto-Flush (`SQLScheduler`)

A differenza di `system.runTimeout`, i timer di `SQLScheduler` vengono salvati nella tabella `_db_schedules` e **sopravvivono a `/reload` e riavvii del server**.

```javascript
// 1. Registra l'handler persistente all'avvio dello script
SQLScheduler.registerHandler("release_prisoner", ({ uuid }) => {
    MCSQL.query("UPDATE players SET jailed = FALSE WHERE uuid = ?", [uuid]);
});

// 2. Programma la scarcerazione tra 10 minuti (600.000 ms) con chiave anti-duplicato
SQLScheduler.schedule("release_prisoner", 600_000, { uuid: player.id }, {
    key: `jail:${player.id}`,
    maxRetries: 2
});

// 3. Attiva il flush automatico della Cache con budget massimo di 5 scritture per tick
SQLScheduler.enableCacheAutoFlush({
    intervalTicks: 40,
    maxWritesPerTick: 5
});

// 4. Salva ed evicta automaticamente i dati del giocatore quando esce dal server
SQLScheduler.bindPlayerLeave("players", "uuid", {
    flush: true,
    evict: true
});
```

---

## 10. Console Interattiva & Comandi Chat (`BedrockDBEnv` / `SQLCommand`)

Gli operatori con permessi `GameDirectors` possono amministrare l'intero database direttamente dal gioco in due modi:

### 10.1 Terminale Interattivo Stile MariaDB (`/uc:bedrockdb connect`)
1. Digita in chat: `/uc:bedrockdb connect`
2. Il tuo prompt diventa privato (`bedrockDB@TuoNome$`): i messaggi che scrivi in chat non vengono inviati agli altri giocatori.
3. Puoi scrivere query su **più righe** terminandole con il punto e virgola `;`:
   ```sql
   SELECT name, role, coins
   FROM players
   WHERE coins >= 500
   ORDER BY coins DESC;
   ```
4. **Comandi speciali della console:**
   * `help;` — Mostra l'elenco dei comandi del terminale.
   * `\c` oppure `clear` — Svuota il buffer della query multi-linea corrente.
   * `exit` oppure `\q` — Disconnette il terminale e ripristina la chat normale.
   * `/uc:bedrockdb exec "SHOW TABLES;"` — Esegue una query rapida senza aprire la sessione.

### 10.2 Comando Singolo (`/uc:sql`)
Esegue una singola query passandola come stringa tra virgolette:
```text
/uc:sql "SELECT * FROM players LIMIT 10"
/uc:sql "DELETE FROM vehicles WHERE impounded = TRUE" true
```

### 10.3 Meta-Comandi Diagnostici Integrati
Disponibili sia in `BedrockDBEnv` che in `/uc:sql` e via `SQLInterpreter.interpret()`:
* `SHOW TABLES;` — Elenca tutte le tabelle nel mondo con numero di record, Primary Key e Foreign Key.
* `SHOW VIEWS;` — Elenca tutte le viste SQL virtuali salvate.
* `DESCRIBE <tabella_o_vista>;` — Mostra colonne, tipi (`ENUM`, `INT`, ecc.), vincoli e relazioni.
* `SHOW FUNCTIONS;` — Elenca tutte le funzioni scalari e Minecraft-aware disponibili.
* `SHOW TRIGGERS;` — Mostra tutti i trigger attivi e i campi osservati.
* `SHOW SCHEDULES;` — Mostra i timer persistenti in coda e il tempo rimanente.
* `CACHE STATS;` — Mostra hit rate, record in RAM e record `dirty` in attesa di flush.
* `EXPLAIN <query>;` — Mostra come `MCSQL` traduce una query in chiamate `Storage`.
* `VALIDATE <query>;` — Verifica sintassi e vincoli senza eseguire modifiche.