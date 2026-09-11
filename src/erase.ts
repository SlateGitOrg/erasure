import { DatabaseSync } from 'node:sqlite';
import { COLUMNS, type Column, type Subject } from './estate.ts';

/**
 * Lineage-driven erasure, and the adversary that checks it worked.
 *
 * THE DIFFERENTIATOR LIVES HERE.
 *
 * The usual implementation is a hand-written list of tables to delete from.
 * It is accurate on the day it is written and wrong by the end of the month,
 * and nothing in the system can tell you it has gone stale. Worse, it can only
 * ever cover DIRECT identifiers, so the aggregated "anonymous" cohort table
 * survives - and a postcode plus a birth year plus an order count identifies
 * most people in a small area.
 *
 * So discovery follows the lineage graph, and the result is verified by an
 * adversary that actively tries to reconstruct the erased subject from what
 * remains. The adversary is the part that makes "erased" a claim rather than
 * a hope - and it is only meaningful because it is asserted to SUCCEED before
 * erasure. A test that only checks it fails afterwards would pass on an
 * adversary that never worked at all.
 */

export interface DiscoveredLocation {
  readonly table: string;
  readonly column: string;
  readonly store: string;
  readonly reason: 'direct' | 'lineage' | 'quasi-identifier';
  readonly hops: number;
}

/** Follow lineage from the subject root outward. */
export function discover(root = 'customers'): DiscoveredLocation[] {
  const out: DiscoveredLocation[] = [];
  const rootCols = COLUMNS.filter((c) => c.table === root);
  for (const c of rootCols) {
    if (!c.truePii) continue;
    out.push({
      table: c.table, column: c.column, store: c.store,
      reason: c.identifierClass === 'quasi' ? 'quasi-identifier' : 'direct',
      hops: 0,
    });
  }

  // Transitive closure over derivedFrom. Depth matters: the cohort table is two
  // hops from the customer record and is exactly what a table list misses.
  let frontier = new Set(rootCols.map((c) => `${c.table}.${c.column}`));
  let hops = 1;
  const seen = new Set(frontier);

  while (frontier.size && hops < 10) {
    const next = new Set<string>();
    for (const col of COLUMNS) {
      if (!col.derivedFrom) continue;
      if (!frontier.has(col.derivedFrom)) continue;
      const key = `${col.table}.${col.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.add(key);
      out.push({
        table: col.table, column: col.column, store: col.store,
        reason: col.identifierClass === 'quasi' ? 'quasi-identifier' : 'lineage',
        hops,
      });
    }
    frontier = next;
    hops++;
  }
  return out;
}

export interface LegalHold {
  readonly table: string;
  /** The specific obligation, not a boolean. "Why" survives an audit. */
  readonly basis: string;
}

export const RETENTION_OBLIGATIONS: readonly LegalHold[] = [
  {
    table: 'email_suppression',
    basis:
      'Art. 21(3) GDPR - a suppression record is required to honour the ' +
      'objection itself; deleting it would resume the marketing',
  },
];

export interface ErasureCertificate {
  readonly subjectId: number;
  readonly tablesTouched: readonly string[];
  readonly rowsAffected: number;
  readonly retained: ReadonlyArray<{ table: string; basis: string }>;
  readonly dryRun: boolean;
  readonly completedAt: number;
}

/** Tables the plan will act on, and those it deliberately will not. */
export function planFor(subjectId: number): {
  act: string[]; retain: LegalHold[];
} {
  const held = new Set(RETENTION_OBLIGATIONS.map((h) => h.table));
  const tables = [...new Set(discover().map((d) => d.table))];
  return {
    act: tables.filter((t) => !held.has(t)),
    retain: RETENTION_OBLIGATIONS.filter((h) => tables.includes(h.table)),
  };
}

export function erase(
  db: DatabaseSync, subject: Subject, { dryRun = true } = {},
): ErasureCertificate {
  const plan = planFor(subject.id);
  let rows = 0;

  const count = (sql: string, ...args: Array<string | number>) =>
    (db.prepare(sql).get(...args) as { n: number }).n;

  const ops: Array<{ table: string; countSql: string; delSql: string;
    args: Array<string | number> }> = [
    { table: 'customers', countSql: 'SELECT COUNT(*) n FROM customers WHERE id = ?',
      delSql: 'DELETE FROM customers WHERE id = ?', args: [subject.id] },
    { table: 'orders', countSql: 'SELECT COUNT(*) n FROM orders WHERE customer_id = ?',
      delSql: 'DELETE FROM orders WHERE customer_id = ?', args: [subject.id] },
    { table: 'dw_customer_dim',
      countSql: 'SELECT COUNT(*) n FROM dw_customer_dim WHERE src_customer_id = ?',
      delSql: 'DELETE FROM dw_customer_dim WHERE src_customer_id = ?',
      args: [subject.id] },
    // The row a table-list implementation never touches.
    { table: 'dw_cohort_metrics',
      countSql: 'SELECT COUNT(*) n FROM dw_cohort_metrics WHERE postcode = ? ' +
                'AND birth_year = ? AND order_count = ?',
      delSql: 'DELETE FROM dw_cohort_metrics WHERE postcode = ? AND birth_year = ? ' +
              'AND order_count = ?',
      args: [subject.postcode, subject.birthYear, subject.orderCount] },
    { table: 'search_documents',
      countSql: 'SELECT COUNT(*) n FROM search_documents WHERE customer_ref = ?',
      delSql: 'DELETE FROM search_documents WHERE customer_ref = ?',
      args: [subject.id] },
    { table: 'export_rows',
      countSql: 'SELECT COUNT(*) n FROM export_rows WHERE customer_id = ?',
      delSql: 'DELETE FROM export_rows WHERE customer_id = ?', args: [subject.id] },
  ];

  const touched: string[] = [];
  for (const op of ops) {
    if (!plan.act.includes(op.table)) continue;
    const n = count(op.countSql, ...op.args);
    if (n === 0) continue;
    rows += n;
    touched.push(op.table);
    if (!dryRun) db.prepare(op.delSql).run(...op.args);
  }

  return {
    subjectId: subject.id,
    tablesTouched: touched,
    rowsAffected: rows,
    retained: plan.retain.map((h) => ({ table: h.table, basis: h.basis })),
    dryRun,
    completedAt: Date.now(),
  };
}

/**
 * The adversary.
 *
 * Given only the quasi-identifiers a data broker would already hold, can the
 * subject still be singled out from what remains? Uniqueness on
 * (postcode, birth year, order count) is singling out under GDPR whether or
 * not a name is attached.
 */
export function reidentify(db: DatabaseSync, subject: Subject): {
  succeeded: boolean; via: string | null; matches: number;
} {
  // Route 1: any surviving direct identifier.
  const direct = db.prepare(
    'SELECT COUNT(*) n FROM customers WHERE id = ?').get(subject.id) as
    { n: number };
  if (direct.n > 0) return { succeeded: true, via: 'customers (direct)', matches: direct.n };

  const dim = db.prepare(
    'SELECT COUNT(*) n FROM dw_customer_dim WHERE src_customer_id = ?')
    .get(subject.id) as { n: number };
  if (dim.n > 0) {
    return { succeeded: true, via: 'dw_customer_dim (direct)', matches: dim.n };
  }

  const exports = db.prepare(
    'SELECT COUNT(*) n FROM export_rows WHERE customer_id = ?').get(subject.id) as
    { n: number };
  if (exports.n > 0) {
    return { succeeded: true, via: 'export_rows (direct)', matches: exports.n };
  }

  const docs = db.prepare(
    'SELECT COUNT(*) n FROM search_documents WHERE customer_ref = ?')
    .get(subject.id) as { n: number };
  if (docs.n > 0) {
    return { succeeded: true, via: 'search_documents (direct)', matches: docs.n };
  }

  // Route 2: singling out on quasi-identifiers alone. This is the route that
  // survives a table-list erasure, and the one people argue is "anonymous".
  const cohort = db.prepare(
    `SELECT COUNT(*) n FROM dw_cohort_metrics
      WHERE postcode = ? AND birth_year = ? AND order_count = ?`)
    .get(subject.postcode, subject.birthYear, subject.orderCount) as { n: number };
  if (cohort.n === 1) {
    return {
      succeeded: true,
      via: 'dw_cohort_metrics (quasi-identifier: postcode + birth year + orders)',
      matches: 1,
    };
  }

  return { succeeded: false, via: null, matches: 0 };
}

/** What a naive implementation does: delete from the tables you remembered. */
export function naiveErase(db: DatabaseSync, subject: Subject): void {
  db.prepare('DELETE FROM customers WHERE id = ?').run(subject.id);
  db.prepare('DELETE FROM orders WHERE customer_id = ?').run(subject.id);
}

export function columnsFor(store: string): Column[] {
  return COLUMNS.filter((c) => c.store === store);
}
