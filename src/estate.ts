import { DatabaseSync } from 'node:sqlite';

/**
 * A multi-store estate with realistic PII propagation.
 *
 * The point of building this first is that erasure recall is only measurable
 * against planted ground truth. An erasure tool that deletes "everything it
 * knows about" on an estate whose true copies are unknown has proved nothing -
 * and that is the normal state of affairs, which is why organisations believe
 * they are compliant when they are not.
 */

export type StoreKind = 'oltp' | 'warehouse' | 'search' | 'export' | 'suppression';

export interface Column {
  readonly table: string;
  readonly column: string;
  readonly store: StoreKind;
  /** Ground truth for the classifier: is this actually PII? */
  readonly truePii: boolean;
  /** Direct identifier, or a quasi-identifier usable for re-identification. */
  readonly identifierClass: 'direct' | 'quasi' | 'none';
  /** Where this column's data came from. Drives lineage discovery. */
  readonly derivedFrom?: string;
}

export interface Subject {
  readonly id: number;
  readonly email: string;
  readonly fullName: string;
  readonly postcode: string;
  readonly birthYear: number;
  readonly orderCount: number;
}

export function createEstate(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
-- OLTP: the table everyone remembers to delete from.
CREATE TABLE customers (
  id INTEGER PRIMARY KEY, email TEXT, full_name TEXT,
  postcode TEXT, birth_year INTEGER
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY, customer_id INTEGER, total REAL, placed_at INTEGER
);

-- Warehouse: a copy nobody thinks of as a copy.
CREATE TABLE dw_customer_dim (
  sk INTEGER PRIMARY KEY, src_customer_id INTEGER, email_hash TEXT,
  full_name TEXT, postcode TEXT, birth_year INTEGER
);
-- Aggregated, and widely believed to be anonymous. It is not: a postcode plus
-- a birth year plus an order count identifies most people in a small area.
CREATE TABLE dw_cohort_metrics (
  postcode TEXT, birth_year INTEGER, order_count INTEGER, revenue REAL
);

-- Search index.
CREATE TABLE search_documents (
  doc_id TEXT PRIMARY KEY, body TEXT, customer_ref INTEGER
);

-- Flat-file exports sitting in object storage.
CREATE TABLE export_rows (
  export_name TEXT, row_json TEXT, customer_id INTEGER
);

-- The email provider's suppression list. Legally required to keep SOMETHING,
-- which is why "delete everything" is the wrong instruction.
CREATE TABLE email_suppression (
  email_hash TEXT PRIMARY KEY, reason TEXT, added_at INTEGER
);
`);
  return db;
}

/**
 * The estate's column catalogue, with ground truth.
 *
 * `derivedFrom` is what makes discovery survive schema change: the erasure
 * planner follows lineage rather than consulting a hand-written list of tables
 * that was accurate on the day somebody wrote it.
 */
export const COLUMNS: readonly Column[] = [
  // The primary key is itself a direct identifier, and omitting it is a real
  // and common modelling error: every foreign key that references it becomes
  // invisible to lineage, so the order history is never discovered.
  { table: 'customers', column: 'id', store: 'oltp', truePii: true,
    identifierClass: 'direct' },
  { table: 'customers', column: 'email', store: 'oltp', truePii: true,
    identifierClass: 'direct' },
  { table: 'customers', column: 'full_name', store: 'oltp', truePii: true,
    identifierClass: 'direct' },
  { table: 'customers', column: 'postcode', store: 'oltp', truePii: true,
    identifierClass: 'quasi' },
  { table: 'customers', column: 'birth_year', store: 'oltp', truePii: true,
    identifierClass: 'quasi' },
  { table: 'orders', column: 'customer_id', store: 'oltp', truePii: true,
    identifierClass: 'direct', derivedFrom: 'customers.id' },
  { table: 'orders', column: 'total', store: 'oltp', truePii: false,
    identifierClass: 'none' },

  { table: 'dw_customer_dim', column: 'email_hash', store: 'warehouse',
    truePii: true, identifierClass: 'direct', derivedFrom: 'customers.email' },
  { table: 'dw_customer_dim', column: 'full_name', store: 'warehouse',
    truePii: true, identifierClass: 'direct', derivedFrom: 'customers.full_name' },
  { table: 'dw_customer_dim', column: 'postcode', store: 'warehouse',
    truePii: true, identifierClass: 'quasi', derivedFrom: 'customers.postcode' },
  { table: 'dw_customer_dim', column: 'birth_year', store: 'warehouse',
    truePii: true, identifierClass: 'quasi', derivedFrom: 'customers.birth_year' },

  // THE HIDDEN COPY. Aggregated, presumed anonymous, and re-identifying.
  { table: 'dw_cohort_metrics', column: 'postcode', store: 'warehouse',
    truePii: true, identifierClass: 'quasi', derivedFrom: 'customers.postcode' },
  { table: 'dw_cohort_metrics', column: 'birth_year', store: 'warehouse',
    truePii: true, identifierClass: 'quasi', derivedFrom: 'customers.birth_year' },

  { table: 'search_documents', column: 'body', store: 'search', truePii: true,
    identifierClass: 'direct', derivedFrom: 'customers.full_name' },
  { table: 'search_documents', column: 'customer_ref', store: 'search',
    truePii: true, identifierClass: 'direct', derivedFrom: 'customers.id' },

  { table: 'export_rows', column: 'row_json', store: 'export', truePii: true,
    identifierClass: 'direct', derivedFrom: 'customers.email' },

  { table: 'email_suppression', column: 'email_hash', store: 'suppression',
    truePii: true, identifierClass: 'direct', derivedFrom: 'customers.email' },
];

/** Every location a subject's data genuinely reaches. The recall denominator. */
export const PLANTED_LOCATIONS: readonly string[] = [
  'customers', 'orders', 'dw_customer_dim', 'dw_cohort_metrics',
  'search_documents', 'export_rows', 'email_suppression',
];

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

export function seed(db: DatabaseSync, subjects: readonly Subject[]): void {
  const c = db.prepare(
    'INSERT INTO customers VALUES (?, ?, ?, ?, ?)');
  const o = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)');
  const d = db.prepare('INSERT INTO dw_customer_dim VALUES (?, ?, ?, ?, ?, ?)');
  const m = db.prepare('INSERT INTO dw_cohort_metrics VALUES (?, ?, ?, ?)');
  const s = db.prepare('INSERT INTO search_documents VALUES (?, ?, ?)');
  const e = db.prepare('INSERT INTO export_rows VALUES (?, ?, ?)');
  const sup = db.prepare('INSERT OR IGNORE INTO email_suppression VALUES (?, ?, ?)');

  let orderId = 1;
  for (const sub of subjects) {
    c.run(sub.id, sub.email, sub.fullName, sub.postcode, sub.birthYear);
    for (let i = 0; i < sub.orderCount; i++) {
      o.run(orderId++, sub.id, 10 + i, 1_700_000_000 + i);
    }
    d.run(sub.id * 100, sub.id, hash(sub.email), sub.fullName, sub.postcode,
          sub.birthYear);
    m.run(sub.postcode, sub.birthYear, sub.orderCount, sub.orderCount * 25);
    s.run(`doc-${sub.id}`, `Order history for ${sub.fullName}`, sub.id);
    e.run('monthly_marketing_2026_02',
          JSON.stringify({ email: sub.email, name: sub.fullName }), sub.id);
    sup.run(hash(sub.email), 'unsubscribed', 1_700_000_000);
  }
}

export function makeSubjects(n: number): Subject[] {
  const areas = ['SW1A 1AA', 'EC2R 8AH', 'M1 4BT', 'LS1 5AA', 'BS1 4DJ'];
  const out: Subject[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      id: i,
      email: `person${i}@example.com`,
      fullName: `Person ${i}`,
      // Deliberately spread thin: a postcode + birth year + order count combo
      // that is unique for some subjects is exactly the re-identification risk.
      postcode: areas[i % areas.length]!,
      birthYear: 1950 + (i % 50),
      orderCount: 1 + (i % 7),
    });
  }
  return out;
}
