import oracledb from 'oracledb';
import fs from 'fs';
import path from 'path';

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: process.env.DB_CONNECT_STRING
};

const DATA_DIR = path.resolve('data');

function titleCase(str) {
  if (!str) return str;
  return str
    .toLocaleLowerCase('tr-TR')
    .replace(/(^|[\s.\/(])(\p{L})/gu, (_, pre, ch) => pre + ch.toLocaleUpperCase('tr-TR'));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

async function execQuery(connection, query, params = {}) {
  await connection.execute(query, params, { autoCommit: true });
}

async function insertBatch(connection, table, columns, rows, batchSize) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const row of batch) {
      const params = {};
      const placeholders = columns.map(col => {
        params[col.key] = row[col.key];
        return `:${col.key}`;
      });
      const query = `INSERT INTO ${table} (${columns.map(c => c.key).join(', ')}) VALUES (${placeholders.join(', ')})`;
      await execQuery(connection, query, params);
    }
    inserted += batch.length;
  }
  return inserted;
}

async function createTables(connection) {
  // Skip schema creation as requested
  // await execQuery(connection, `CREATE SCHEMA geo`); // Skipped

  const tables = [
    {
      name: 'GEO_PROVINCES',
      drop: `DROP TABLE GEO_PROVINCES CASCADE CONSTRAINTS PURGE`,
      create: `CREATE TABLE GEO_PROVINCES (
        ID NUMBER PRIMARY KEY,
        NAME NVARCHAR2(255) NOT NULL,
        PLATE_CODE NUMBER NOT NULL
      )`
    },
    {
      name: 'GEO_DISTRICTS',
      drop: `DROP TABLE GEO_DISTRICTS CASCADE CONSTRAINTS PURGE`,
      create: `CREATE TABLE GEO_DISTRICTS (
        ID NUMBER PRIMARY KEY,
        NAME NVARCHAR2(255) NOT NULL,
        IDENTITY_NUMBER NUMBER NOT NULL,
        PROVINCE_ID NUMBER NOT NULL,
        FOREIGN KEY (PROVINCE_ID) REFERENCES GEO_PROVINCES(ID)
      )`
    },
    {
      name: 'GEO_NEIGHBORHOODS',
      drop: `DROP TABLE GEO_NEIGHBORHOODS CASCADE CONSTRAINTS PURGE`,
      create: `CREATE TABLE GEO_NEIGHBORHOODS (
        ID NUMBER PRIMARY KEY,
        NAME NVARCHAR2(255) NOT NULL,
        FULL_NAME NVARCHAR2(255) NOT NULL,
        IDENTITY_NUMBER NUMBER NOT NULL,
        PROVINCE_ID NUMBER NOT NULL,
        DISTRICT_ID NUMBER NOT NULL,
        FOREIGN KEY (PROVINCE_ID) REFERENCES GEO_PROVINCES(ID),
        FOREIGN KEY (DISTRICT_ID) REFERENCES GEO_DISTRICTS(ID)
      )`
    },
    // Skip streets table creation temporarily
    /*
    {
      name: 'GEO_STREETS',
      drop: `DROP TABLE GEO_STREETS CASCADE CONSTRAINTS PURGE`,
      create: `CREATE TABLE GEO_STREETS (
        ID NUMBER PRIMARY KEY,
        NAME NVARCHAR2(255) NOT NULL,
        FULL_NAME NVARCHAR2(255) NOT NULL,
        PROVINCE_ID NUMBER NOT NULL,
        DISTRICT_ID NUMBER NOT NULL,
        NEIGHBORHOOD_ID NUMBER NOT NULL,
        FOREIGN KEY (PROVINCE_ID) REFERENCES GEO_PROVINCES(ID),
        FOREIGN KEY (DISTRICT_ID) REFERENCES GEO_DISTRICTS(ID),
        FOREIGN KEY (NEIGHBORHOOD_ID) REFERENCES GEO_NEIGHBORHOODS(ID)
      )`
    }
    */
  ];

  for (const table of tables) {
    try {
      console.log(`Dropping table ${table.name} if exists...`);
      await connection.execute(table.drop);
      console.log(`Table ${table.name} dropped.`);
    } catch (err) {
      if (err.errorNum === 942) { // ORA-00942: table or view does not exist
        console.log(`Table ${table.name} does not exist, skipping drop.`);
      } else {
        throw err;
      }
    }
    try {
      console.log(`Creating table ${table.name}...`);
      await connection.execute(table.create);
      console.log(`Table ${table.name} created.`);
    } catch (err) {
      throw err;
    }
  }
}

async function run() {
  let connection;
  try {
    console.log('Connecting to Oracle...');
    connection = await oracledb.getConnection(config);
    console.log('Connected.');

    console.log('Creating tables...');
    await createTables(connection);
    console.log('Tables ready.');

    const provincesRaw = readJsonl(path.join(DATA_DIR, 'iller.jsonl'))
      .sort((a, b) => a.kimlikNo - b.kimlikNo);
    const provinces = provincesRaw.map(il => ({
      ID: il.kimlikNo,
      NAME: titleCase(il.adi),
      PLATE_CODE: il.kimlikNo
    }));
    console.log(`Inserting ${provinces.length} provinces...`);
    await insertBatch(connection, 'GEO_PROVINCES', [
      { key: 'ID' },
      { key: 'NAME' },
      { key: 'PLATE_CODE' }
    ], provinces, 200);
    console.log('Provinces inserted.');

    const districts = [];
    for (const il of provincesRaw) {
      const filePath = path.join(DATA_DIR, `il-${il.kimlikNo}`, 'ilceler.jsonl');
      districts.push(...readJsonl(filePath));
    }
    districts.sort((a, b) => a.kimlikNo - b.kimlikNo);
    const districtRows = districts.map(dc => ({
      ID: dc.kimlikNo,
      NAME: titleCase(dc.adi),
      IDENTITY_NUMBER: dc.kimlikNo,
      PROVINCE_ID: dc.il_id
    }));
    console.log(`Inserting ${districtRows.length} districts...`);
    await insertBatch(connection, 'GEO_DISTRICTS', [
      { key: 'ID' },
      { key: 'NAME' },
      { key: 'IDENTITY_NUMBER' },
      { key: 'PROVINCE_ID' }
    ], districtRows, 200);
    console.log('Districts inserted.');

    let totalNeighborhoods = 0;
    for (const il of provincesRaw) {
      const filePath = path.join(DATA_DIR, `il-${il.kimlikNo}`, 'mahalleler.jsonl');
      const mahalleler = readJsonl(filePath).sort((a, b) => a.kimlikNo - b.kimlikNo);
      const rows = mahalleler.map(mah => ({
        ID: mah.kimlikNo,
        NAME: titleCase(mah.adi) || 'Unknown',
        FULL_NAME: titleCase(mah.bilesenAdi) || 'Unknown',
        IDENTITY_NUMBER: mah.kimlikNo,
        PROVINCE_ID: mah.il_id,
        DISTRICT_ID: mah.ilce_id
      }));
      if (rows.length === 0) continue;
      console.log(`Inserting ${rows.length} neighborhoods for province ${il.kimlikNo}...`);
      await insertBatch(connection, 'GEO_NEIGHBORHOODS', [
        { key: 'ID' },
        { key: 'NAME' },
        { key: 'FULL_NAME' },
        { key: 'IDENTITY_NUMBER' },
        { key: 'PROVINCE_ID' },
        { key: 'DISTRICT_ID' }
      ], rows, 150);
      totalNeighborhoods += rows.length;
    }
    console.log(`Inserted ${totalNeighborhoods} neighborhoods.`);

    // Skip streets insertion temporarily
    /*
    let totalStreets = 0;
    for (const il of provincesRaw) {
      const filePath = path.join(DATA_DIR, `il-${il.kimlikNo}`, 'sokaklar.jsonl');
      const sokaklar = readJsonl(filePath).sort((a, b) => a.kimlikNo - b.kimlikNo);
      if (sokaklar.length === 0) continue;
      console.log(`Inserting ${sokaklar.length} streets for province ${il.kimlikNo}...`);
      const rows = sokaklar.map(sok => ({
        ID: sok.kimlikNo,
        NAME: titleCase(sok.adi),
        FULL_NAME: titleCase(sok.bilesenAdi),
        PROVINCE_ID: sok.il_id,
        DISTRICT_ID: sok.ilce_id,
        NEIGHBORHOOD_ID: sok.mahalle_id
      }));
      await insertBatch(connection, 'GEO_STREETS', [
        { key: 'ID' },
        { key: 'NAME' },
        { key: 'FULL_NAME' },
        { key: 'PROVINCE_ID' },
        { key: 'DISTRICT_ID' },
        { key: 'NEIGHBORHOOD_ID' }
      ], rows, 150);
      totalStreets += rows.length;
    }
    console.log(`Inserted ${totalStreets} streets.`);
    */
    console.log('Import finished successfully (streets skipped).');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.close();
      console.log('Connection closed.');
    }
  }
}

run();