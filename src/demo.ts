/**
 * The 60-second artefact: two erasures, one adversary. Run: `npm run demo`
 */
import { createEstate, seed, makeSubjects } from './estate.ts';
import { discover, erase, reidentify, naiveErase } from './erase.ts';

const SUBJECTS = makeSubjects(200);
const key = (s: typeof SUBJECTS[number]) =>
  `${s.postcode}|${s.birthYear}|${s.orderCount}`;
const counts = new Map<string, number>();
for (const s of SUBJECTS) counts.set(key(s), (counts.get(key(s)) ?? 0) + 1);
const subject = SUBJECTS.find((s) => counts.get(key(s)) === 1)!;

function fresh() {
  const db = createEstate();
  seed(db, SUBJECTS);
  return db;
}

console.log('\n  ERASURE - "we deleted them from the users table"');
console.log('  ' + '-'.repeat(68));
console.log(`  Subject: ${subject.fullName} <${subject.email}>`);
console.log(`  Quasi-identifiers: ${subject.postcode}, born ${subject.birthYear}, ` +
            `${subject.orderCount} orders\n`);

const found = discover();
console.log(`  Lineage discovery: ${found.length} PII columns across ` +
            `${new Set(found.map((f) => f.store)).size} stores\n`);
console.log('    table                 column          store        found via');
console.log('    ' + '-'.repeat(64));
for (const f of found) {
  console.log(`    ${f.table.padEnd(21)} ${f.column.padEnd(15)} ` +
              `${f.store.padEnd(12)} ${f.reason}${f.hops ? ` (${f.hops} hop)` : ''}`);
}

// --- the naive path --------------------------------------------------------
const a = fresh();
console.log('\n  ATTEMPT 1 - delete from the tables everyone remembers');
console.log('  ' + '-'.repeat(68));
const beforeA = reidentify(a, subject);
naiveErase(a, subject);
const afterA = reidentify(a, subject);
console.log(`    before: identifiable via ${beforeA.via}`);
console.log(`    after:  ${afterA.succeeded ? 'STILL IDENTIFIABLE' : 'not identifiable'}` +
            `${afterA.via ? ` via ${afterA.via}` : ''}`);
console.log('    The company now believes it is compliant. It is not.');
a.close();

// --- the lineage path ------------------------------------------------------
const b = fresh();
console.log('\n  ATTEMPT 2 - lineage-driven erasure');
console.log('  ' + '-'.repeat(68));
const beforeB = reidentify(b, subject);
const cert = erase(b, subject, { dryRun: false });
const afterB = reidentify(b, subject);
console.log(`    before: identifiable via ${beforeB.via}`);
console.log(`    after:  ${afterB.succeeded ? 'STILL IDENTIFIABLE' : 'not identifiable'}`);
console.log(`\n    tables erased:  ${cert.tablesTouched.join(', ')}`);
console.log(`    rows affected:  ${cert.rowsAffected}`);
for (const r of cert.retained) {
  console.log(`    retained:       ${r.table}`);
  console.log(`                    ${r.basis}`);
}
b.close();

console.log('\n  The adversary succeeded BEFORE erasure in both runs. That is what');
console.log('  makes its failure afterwards mean something: a re-identification');
console.log('  check that never worked would report the same clean result on an');
console.log('  erasure that did nothing at all.\n');
