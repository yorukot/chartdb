/* global process */
// Writes the diagram file from a Postgres database's catalog, so the diagram
// shows the schema the migrations really built. Tables already in the file
// keep their position, size, and color; the areas and notes you drew stay.
//
//   node schema-sync/from-postgres.mjs [database-url] [--stdout]
//
// Teloi's conventions shape the drawing:
// - A foreign key between two tenant tables also pairs organization_id. Only
//   the other pair is drawn; the field's comment has the whole key.
// - organization_id -> organizations.id isn't drawn: every tenant table has it.
import fs from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const toStdout = args.includes('--stdout');
const url =
    args.find((a) => !a.startsWith('--')) ??
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@127.0.0.1:5432/teloi';
const file = process.env.SCHEMA_DIAGRAM ?? 'schema-sync/diagram.json';
const schema = process.env.SCHEMA_NAME ?? 'public';

const TENANT = '#8eb7ff'; // blue: belongs to an organization
const GLOBAL = '#ffe374'; // yellow: belongs to no organization
const INDEX_TYPES = new Set(['btree', 'hash', 'gist', 'gin', 'spgist', 'brin']);
const TYPE_NAMES = {
    bool: 'boolean',
    int2: 'smallint',
    int4: 'int',
    int8: 'bigint',
    float4: 'real',
    float8: 'double precision',
    bpchar: 'char',
};
const ON_DELETE = {
    a: 'NO ACTION',
    r: 'RESTRICT',
    c: 'CASCADE',
    n: 'SET NULL',
    d: 'SET DEFAULT',
};

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;

const tables = await q(
    `SELECT c.oid, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname <> 'goose_db_version'
     ORDER BY c.relname`,
    [schema]
);
const oids = tables.map((t) => t.oid);
const columns = await q(
    `SELECT a.attrelid AS table_oid, a.attnum, a.attname AS name, a.attnotnull AS not_null,
       coalesce(el.typname, t.typname) AS type, el.oid IS NOT NULL AS is_array,
       pg_get_expr(d.adbin, d.adrelid) AS "default", col_description(a.attrelid, a.attnum) AS comment
     FROM pg_attribute a
     JOIN pg_type t ON t.oid = a.atttypid
     LEFT JOIN pg_type el ON el.oid = t.typelem AND t.typcategory = 'A'
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ANY ($1) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attrelid, a.attnum`,
    [oids]
);
const constraints = await q(
    `SELECT conrelid AS table_oid, conname AS name, contype AS type, conkey, confrelid AS ref_oid,
       confkey, confdeltype, confdelsetcols, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = ANY ($1) AND contype IN ('p', 'u', 'f', 'c')
     ORDER BY conname`,
    [oids]
);
const indexes = await q(
    `SELECT i.indrelid AS table_oid, ic.relname AS name, i.indisunique AS unique,
       i.indisprimary AS primary, (i.indkey::int2[])[0:i.indnkeyatts - 1] AS keys,
       i.indexprs IS NOT NULL OR i.indpred IS NOT NULL AS special, am.amname AS method,
       pg_get_indexdef(i.indexrelid) AS def
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_am am ON am.oid = ic.relam
     WHERE i.indrelid = ANY ($1)
     ORDER BY ic.relname`,
    [oids]
);
const dbName = (await q('SELECT current_database() AS name'))[0].name;
await client.end();

const previous = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : undefined;
const previousTables = new Map(
    (previous?.tables ?? []).map((t) => [t.name, t])
);

const tableById = new Map(tables.map((t) => [t.oid, t]));
const columnsOf = (oid) => columns.filter((c) => c.table_oid === oid);
const column = (oid, attnum) =>
    columns.find((c) => c.table_oid === oid && c.attnum === attnum);
const hasOrg = (oid) =>
    columnsOf(oid).some((c) => c.name === 'organization_id');
const tableId = (name) => `t_${name}`;
const fieldId = (table, col) => `f_${table}_${col}`;
const now = Date.now();

// What each foreign key column refers to, for its comment.
const fkNotes = new Map();
const relationships = [];
for (const fk of constraints.filter((c) => c.type === 'f')) {
    const table = tableById.get(fk.table_oid);
    const ref = tableById.get(fk.ref_oid);
    const pairs = fk.conkey.map((attnum, i) => [
        column(fk.table_oid, attnum),
        column(fk.ref_oid, fk.confkey[i]),
    ]);
    const cleared = fk.confdelsetcols?.length
        ? ` (${fk.confdelsetcols.map((n) => column(fk.table_oid, n).name).join(', ')})`
        : '';
    const note =
        `→ ${ref?.name ?? '?'} (${pairs.map(([, r]) => r.name).join(', ')}) · ` +
        `ON DELETE ${ON_DELETE[fk.confdeltype]}${cleared}`;

    const tenantPair =
        pairs.length > 1 && hasOrg(fk.table_oid) && hasOrg(fk.ref_oid);
    const drawn = pairs.filter(
        ([c, r]) =>
            !(
                tenantPair &&
                c.name === 'organization_id' &&
                r.name === 'organization_id'
            )
    );
    for (const [c] of drawn) fkNotes.set(`${table.name}.${c.name}`, note);
    // When one pair points at the parent's id, that pair is the reference: draw only it.
    const toId = drawn.filter(([, r]) => r.name === 'id');
    if (toId.length > 0) drawn.splice(0, drawn.length, ...toId);

    if (
        !ref ||
        (ref.name === 'organizations' &&
            drawn[0]?.[0].name === 'organization_id')
    )
        continue;
    for (const [c, r] of drawn) {
        const unique = constraints.some(
            (u) =>
                u.table_oid === fk.table_oid &&
                (u.type === 'u' || u.type === 'p') &&
                u.conkey.length === 1 &&
                u.conkey[0] === c.attnum
        );
        // ChartDB's own import: source is the referenced side.
        relationships.push({
            id: `r_${fk.name}_${c.name}`,
            name: fk.name,
            sourceSchema: schema,
            sourceTableId: tableId(ref.name),
            sourceFieldId: fieldId(ref.name, r.name),
            targetSchema: schema,
            targetTableId: tableId(table.name),
            targetFieldId: fieldId(table.name, c.name),
            sourceCardinality: 'one',
            targetCardinality: unique ? 'one' : 'many',
            createdAt: now,
        });
    }
}

// A table comment that starts with [module] puts the table in that module's area.
const MODULES = [
    'account',
    'organization',
    'chat',
    'inbox',
    'integration',
    'billing',
];
const AREA_COLORS = [
    '#ffe374',
    '#9ef07a',
    '#8eb7ff',
    '#ff9f74',
    '#c05dcf',
    '#42e0c0',
];
const moduleOf = (t) => /^\[(\w+)\]/.exec(t.comment ?? '')?.[1] ?? null;
const commentOf = (t) => (t.comment ?? '').replace(/^\[\w+\]\s*/, '') || null;

// Lay each module out as columns of tables, the modules side by side.
const CELL_W = 290;
const GAP = 40;
const PAD = 50;
const heightOf = (t) => {
    const n = columnsOf(t.oid).length;
    return 50 + Math.min(n, 10) * 32 + (n > 10 ? 32 : 0);
};
const layout = new Map();
const moduleAreas = [];
let areaX = 0;
for (const [i, module] of [...MODULES, null].entries()) {
    // The most referenced tables first, so each module starts with its core.
    const referenced = (t) =>
        constraints.filter((c) => c.type === 'f' && c.ref_oid === t.oid).length;
    const members = tables
        .filter((t) => moduleOf(t) === module)
        .sort(
            (a, b) =>
                referenced(b) - referenced(a) || a.name.localeCompare(b.name)
        );
    if (members.length === 0) continue;
    const cols = Math.max(1, Math.ceil(members.length / 4));
    const colHeights = Array(cols).fill(PAD);
    for (const t of members) {
        const col = colHeights.indexOf(Math.min(...colHeights));
        layout.set(t.name, {
            x: areaX + PAD / 2 + col * CELL_W,
            y: colHeights[col],
            module,
        });
        colHeights[col] += heightOf(t) + GAP;
    }
    const width = cols * CELL_W + PAD / 2;
    if (module) {
        moduleAreas.push({
            id: `a_${module}`,
            name: module,
            x: areaX,
            y: 0,
            width,
            height: Math.max(...colHeights),
            color: AREA_COLORS[i % AREA_COLORS.length],
        });
    }
    areaX += width + 120;
}
const previousAreas = new Map((previous?.areas ?? []).map((a) => [a.id, a]));
const diagramTables = tables.map((t) => {
    const cols = columnsOf(t.oid);
    const cons = constraints.filter((c) => c.table_oid === t.oid);
    const pk = cons.find((c) => c.type === 'p');
    const uniqueCols = new Set(
        cons
            .filter((c) => c.type === 'u' && c.conkey.length === 1)
            .map((c) => c.conkey[0])
    );
    const fields = cols.map((c) => {
        const fkNote = fkNotes.get(`${t.name}.${c.name}`);
        return {
            id: fieldId(t.name, c.name),
            name: c.name,
            type: {
                id: TYPE_NAMES[c.type] ?? c.type,
                name: TYPE_NAMES[c.type] ?? c.type,
            },
            primaryKey: pk?.conkey.includes(c.attnum) ?? false,
            unique:
                uniqueCols.has(c.attnum) &&
                !(pk?.conkey.length === 1 && pk.conkey[0] === c.attnum),
            nullable: !c.not_null,
            isArray: c.is_array,
            default: c.default,
            comments: [c.comment, fkNote].filter(Boolean).join('\n') || null,
            createdAt: now,
        };
    });
    const tableNotes = [commentOf(t)];
    const tableIndexes = [];
    for (const i of indexes.filter((i) => i.table_oid === t.oid)) {
        const keys = i.keys.filter((k) => k > 0);
        if (keys.length === 0) {
            tableNotes.push(i.def);
            continue;
        }
        tableIndexes.push({
            id: `i_${i.name}`,
            name: i.name,
            unique: i.unique,
            fieldIds: keys.map((k) => fieldId(t.name, column(t.oid, k).name)),
            type: INDEX_TYPES.has(i.method) ? i.method : undefined,
            isPrimaryKey: i.primary,
            comments: i.special ? i.def : null,
            createdAt: now,
        });
    }
    const checkConstraints = cons
        .filter((c) => c.type === 'c')
        .map((c) => ({
            id: `c_${c.name}`,
            expression: c.def.replace(/^CHECK \((.*)\)$/s, '$1'),
            createdAt: now,
        }));

    const before = previousTables.get(t.name);
    const placed = layout.get(t.name);
    const position = before
        ? { x: before.x, y: before.y }
        : { x: placed.x, y: placed.y };
    return {
        id: tableId(t.name),
        name: t.name,
        schema,
        ...position,
        fields,
        indexes: tableIndexes,
        checkConstraints,
        color: before?.color ?? (hasOrg(t.oid) ? TENANT : GLOBAL),
        isView: false,
        createdAt: before?.createdAt ?? now,
        width: before?.width ?? null,
        comments: tableNotes.filter(Boolean).join('\n') || null,
        expanded: before?.expanded ?? null,
        parentAreaId: before
            ? (before.parentAreaId ?? null)
            : placed.module
              ? `a_${placed.module}`
              : null,
    };
});

const legend = {
    id: 'n_legend',
    content: [
        `從資料庫 ${dbName} 產生（node schema-sync/from-postgres.mjs）`,
        '',
        '每個大框是一個模組（只有它寫自己的表）。表的顏色：藍色屬於組織，黃色不屬於任何組織。',
        '每張表的 organization_id → organizations.id 沒有畫線。',
        '租戶表之間的 FK 也配對 organization_id，圖上只畫另一段；完整的 FK 和 ON DELETE 寫在欄位的備註。',
        '名稱、created_at、updated_at、set_updated_at trigger、uuidv7() 照慣例補上，畫新表時不用畫。',
    ].join('\n'),
    x: -520,
    y: 0,
    width: 420,
    height: 260,
    color: '#ffe374',
};
const previousLegend = previous?.notes?.find((n) => n.id === legend.id);
const notes = [
    previousLegend
        ? {
              ...legend,
              x: previousLegend.x,
              y: previousLegend.y,
              width: previousLegend.width,
              height: previousLegend.height,
          }
        : legend,
    ...(previous?.notes ?? []).filter((n) => n.id !== legend.id),
];

const diagram = {
    id: previous?.id ?? 'teloi',
    name: previous?.name ?? 'Teloi',
    createdAt: previous?.createdAt ?? new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    databaseType: 'postgresql',
    tables: diagramTables,
    relationships,
    dependencies: [],
    // Module areas keep where you moved them; areas you drew stay.
    areas: [
        ...moduleAreas.map((a) => {
            const was = previousAreas.get(a.id);
            return was
                ? {
                      ...a,
                      x: was.x,
                      y: was.y,
                      width: was.width,
                      height: was.height,
                  }
                : a;
        }),
        ...(previous?.areas ?? []).filter((a) => !a.id.startsWith('a_')),
    ],
    customTypes: [],
    notes,
};

const json = JSON.stringify(diagram, null, 2) + '\n';
if (toStdout) {
    process.stdout.write(json);
} else {
    fs.writeFileSync(file, json);
    console.log(
        `${file}: ${diagramTables.length} tables, ${relationships.length} relationships from ${dbName}`
    );
}
