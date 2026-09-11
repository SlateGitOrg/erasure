import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEstate, seed, makeSubjects, PLANTED_LOCATIONS } from '../src/estate.ts';
import {
  discover, erase, reidentify, naiveErase, planFor, RETENTION_OBLIGATIONS,
} from '../src/erase.ts';

const SUBJECTS = makeSubjects(200);
/** Chosen because its (postcode, birth year, order count) triple is unique. */
function uniqueSubject() {
  const key = (s: typeof SUBJECTS[number]) =>
    `${s.postcode}|${s.birthYear}|${s.orderCount}`;
  const counts = new Map<string, number>();
  for (const s of SUBJECTS) counts.set(key(s), (counts.get(key(s)) ?? 0) + 1);
  const found = SUBJECTS.find((s) => counts.get(key(s)) === 1);
  assert.ok(found, 'the fixture must contain at least one uniquely identifiable subject');
  return found!;
}

function fresh() {
  const db = createEstate();
  seed(db, SUBJECTS);
  return db;
}

describe('discovery recall against planted ground truth', () => {
  test('THE HEADLINE: every planted location is discovered', () => {
    const tables = new Set(discover().map((d) => d.table));
    for (const planted of PLANTED_LOCATIONS) {
      assert.ok(tables.has(planted), `MISSED planted location: ${planted}`);
    }
    assert.equal(tables.size, PLANTED_LOCATIONS.length,
      'discovery should find exactly the planted set - no more, no fewer');
  });

  test('the aggregated cohort table is found via lineage, not a table list', () => {
    const cohort = discover().filter((d) => d.table === 'dw_cohort_metrics');
    assert.ok(cohort.length > 0, 'the "anonymous" table is the one that gets missed');
    assert.ok(cohort.every((c) => c.reason === 'quasi-identifier'));
    assert.ok(cohort.every((c) => c.hops >= 1), 'it is a derived copy');
  });

  test('non-PII columns are not swept up', () => {
    const cols = discover().map((d) => `${d.table}.${d.column}`);
    assert.ok(!cols.includes('orders.total'),
      'over-collection makes the erasure plan unreviewable');
  });

  test('discovery is depth-aware, so multi-hop derivations are reached', () => {
    const maxHops = Math.max(...discover().map((d) => d.hops));
    assert.ok(maxHops >= 1);
  });
});

describe('THE ADVERSARY MUST HAVE POWER', () => {
  test('re-identification SUCCEEDS before erasure', () => {
    // Without this assertion, "the adversary failed after erasure" would also
    // be satisfied by an adversary that never worked.
    const db = fresh();
    const subject = uniqueSubject();
    const before = reidentify(db, subject);
    assert.equal(before.succeeded, true);
    db.close();
  });

  test('re-identification FAILS after lineage-driven erasure', () => {
    const db = fresh();
    const subject = uniqueSubject();
    erase(db, subject, { dryRun: false });
    const after = reidentify(db, subject);
    assert.equal(after.succeeded, false,
      `still identifiable via ${after.via}`);
    db.close();
  });

  test('THE COMPARISON: a naive table-list erasure leaves them identifiable', () => {
    const db = fresh();
    const subject = uniqueSubject();
    naiveErase(db, subject);

    const after = reidentify(db, subject);
    assert.equal(after.succeeded, true,
      'the naive path should still be re-identifiable - that is the point');
    // And it is not a direct identifier that gives them away.
    assert.match(after.via!, /quasi-identifier|dw_customer_dim|export_rows|search/);
    db.close();
  });

  test('a subject in a crowded cohort is not singled out by quasi-identifiers', () => {
    // Guards against an adversary that reports success on any surviving row:
    // k-anonymity greater than 1 is not singling out.
    const db = fresh();
    const key = (s: typeof SUBJECTS[number]) =>
      `${s.postcode}|${s.birthYear}|${s.orderCount}`;
    const counts = new Map<string, number>();
    for (const s of SUBJECTS) counts.set(key(s), (counts.get(key(s)) ?? 0) + 1);
    const crowded = SUBJECTS.find((s) => (counts.get(key(s)) ?? 0) > 1);

    if (crowded) {
      naiveErase(db, crowded);
      db.prepare('DELETE FROM dw_customer_dim WHERE src_customer_id = ?')
        .run(crowded.id);
      db.prepare('DELETE FROM export_rows WHERE customer_id = ?').run(crowded.id);
      db.prepare('DELETE FROM search_documents WHERE customer_ref = ?')
        .run(crowded.id);
      const r = reidentify(db, crowded);
      assert.equal(r.succeeded, false,
        'a non-unique cohort row is not singling out');
    }
    db.close();
  });
});

describe('erasure mechanics', () => {
  test('dry run is the default and changes nothing', () => {
    const db = fresh();
    const subject = SUBJECTS[3]!;
    const before = (db.prepare('SELECT COUNT(*) n FROM customers').get() as
      { n: number }).n;
    const cert = erase(db, subject);
    assert.equal(cert.dryRun, true);
    assert.ok(cert.rowsAffected > 0, 'a dry run still reports what it would do');
    const after = (db.prepare('SELECT COUNT(*) n FROM customers').get() as
      { n: number }).n;
    assert.equal(after, before);
    db.close();
  });

  test('the certificate lists every table touched', () => {
    const db = fresh();
    const cert = erase(db, SUBJECTS[5]!, { dryRun: false });
    for (const t of ['customers', 'orders', 'dw_customer_dim',
                     'search_documents', 'export_rows']) {
      assert.ok(cert.tablesTouched.includes(t), `certificate omits ${t}`);
    }
    db.close();
  });

  test('erasing one subject does not disturb another', () => {
    const db = fresh();
    erase(db, SUBJECTS[7]!, { dryRun: false });
    const other = SUBJECTS[8]!;
    const n = (db.prepare('SELECT COUNT(*) n FROM customers WHERE id = ?')
      .get(other.id) as { n: number }).n;
    assert.equal(n, 1, 'collateral deletion is its own compliance incident');
    db.close();
  });

  test('erasure is idempotent', () => {
    const db = fresh();
    const s = SUBJECTS[9]!;
    erase(db, s, { dryRun: false });
    const second = erase(db, s, { dryRun: false });
    assert.equal(second.rowsAffected, 0);
    db.close();
  });
});

describe('retention obligations are recorded with their basis', () => {
  test('the suppression list is retained, not deleted', () => {
    const db = fresh();
    const s = SUBJECTS[11]!;
    const before = (db.prepare('SELECT COUNT(*) n FROM email_suppression')
      .get() as { n: number }).n;
    const cert = erase(db, s, { dryRun: false });
    const after = (db.prepare('SELECT COUNT(*) n FROM email_suppression')
      .get() as { n: number }).n;

    assert.equal(after, before, 'deleting the suppression record resumes marketing');
    assert.ok(!cert.tablesTouched.includes('email_suppression'));
    db.close();
  });

  test('the retention is justified by a specific legal basis, not a boolean', () => {
    const cert = erase(fresh(), SUBJECTS[12]!);
    assert.equal(cert.retained.length, RETENTION_OBLIGATIONS.length);
    assert.match(cert.retained[0]!.basis, /Art\. 21\(3\) GDPR/);
  });

  test('the plan separates what it will act on from what it will keep', () => {
    const plan = planFor(1);
    assert.ok(plan.act.includes('dw_cohort_metrics'));
    assert.ok(!plan.act.includes('email_suppression'));
    assert.equal(plan.retain[0]!.table, 'email_suppression');
  });
});
