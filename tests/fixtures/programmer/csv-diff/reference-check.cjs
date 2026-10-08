/* global require, console */
/* eslint @typescript-eslint/no-require-imports: "off" */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseCsv, compareCsv, exportDiffCsv } = require('./csv.cjs');
let checks = 0;
const check = (fn) => {
  fn();
  checks++;
};
const left = parseCsv(fs.readFileSync('left.csv', 'utf8'));
const right = parseCsv(fs.readFileSync('right.csv', 'utf8'));
check(() => assert.deepEqual(left.headers, ['id', 'name', 'amount', 'note']));
check(() =>
  assert.deepEqual(left.rows[0], ['001', '甲,公司', '100.00', '首行\n次行']),
);
check(() =>
  assert.deepEqual(parseCsv('id,note,empty\r\n001,"他说""好""",\r\n').rows, [
    ['001', '他说"好"', ''],
  ]),
);
check(() =>
  assert.deepEqual(parseCsv('id,note\n001,"a\r\nb"\n').rows, [
    ['001', 'a\r\nb'],
  ]),
);
for (const invalid of [
  '',
  'id,id\n1,2',
  ',name\n1,a',
  'id,name\n1',
  'id,name\n1,a,b',
  'id,name\n1,"open',
  'id,name\n1,a"b',
  'id,name\n1,"a"tail',
]) {
  check(() => assert.throws(() => parseCsv(invalid)));
}
const before = JSON.stringify([left, right]);
const result = compareCsv(left, right, 'id');
check(() => assert.equal(result.blocked, false));
check(() => assert.deepEqual(result.issues, []));
check(() => assert.equal(result.unchanged, 1));
check(() => assert.equal(result.added.length, 1));
check(() => assert.equal(result.removed.length, 1));
check(() => assert.equal(result.changed.length, 1));
check(() => assert.equal(result.added[0].id, '004'));
check(() => assert.equal(result.removed[0].id, '003'));
check(() => assert.equal(result.changed[0].key, '002'));
check(() => assert.deepEqual(result.changed[0].columns, ['amount', 'note']));
check(() => assert.equal(result.changed[0].before.amount, '50.00'));
check(() => assert.equal(result.changed[0].after.amount, '55.00'));
check(() => assert.equal(JSON.stringify([left, right]), before));
check(() => assert.throws(() => compareCsv(left, right, 'unknown')));
check(() =>
  assert.throws(() => compareCsv(left, parseCsv('id,note\n001,a'), 'id')),
);
const bad = compareCsv(
  parseCsv('id,name\n001,a\n001,b\n,c\n'),
  parseCsv('id,name\n002,d\n'),
  'id',
);
check(() => assert.equal(bad.blocked, true));
check(() =>
  assert.equal(bad.issues.filter((x) => x.type === 'duplicate-key').length, 2),
);
check(() =>
  assert.equal(bad.issues.filter((x) => x.type === 'missing-key').length, 1),
);
check(() => assert.deepEqual(bad.issues.map((x) => x.row).sort(), [2, 3, 4]));
check(() => assert.ok(bad.issues.every((x) => x.side === 'left')));
check(() => assert.throws(() => exportDiffCsv(bad)));
const magic = compareCsv(
  parseCsv('id,__proto__\n__proto__,a\nconstructor,b\n'),
  parseCsv('id,__proto__\n__proto__,c\nconstructor,b\n'),
  'id',
);
check(() => assert.equal(magic.changed[0].before.__proto__, 'a'));
check(() => assert.equal(magic.changed[0].after.__proto__, 'c'));
check(() => assert.equal(magic.unchanged, 1));
const exported = parseCsv(exportDiffCsv(result));
check(() =>
  assert.deepEqual(exported.headers, [
    'change',
    'key',
    'column',
    'before',
    'after',
  ]),
);
check(() => assert.equal(exported.rows.length, 8));
check(() =>
  assert.ok(
    exported.rows.some(
      (r) =>
        JSON.stringify(r) ===
        JSON.stringify(['changed', '002', 'amount', '50.00', '55.00']),
    ),
  ),
);
check(() => assert.ok(exported.rows.every((r) => r[1] !== '001')));
for (const unsafe of [
  '=1+1',
  '+SUM(A1)',
  '-5.00',
  '@SUM(A1)',
  '\t=1+1',
  '\r=1+1',
]) {
  const q = (s) => '"' + s.replaceAll('"', '""') + '"';
  const dangerous = compareCsv(
    parseCsv('id,note\n'),
    parseCsv('id,note\n001,' + q(unsafe) + '\n'),
    'id',
  );
  const cell = parseCsv(exportDiffCsv(dangerous)).rows[0][4];
  check(() => assert.equal(cell, "'" + unsafe));
}
for (let count = 1; count <= 30; count++) {
  const a =
    'id,value\n' +
    Array.from(
      { length: count },
      (_, i) => String(i).padStart(3, '0') + ',' + i,
    ).join('\n');
  const b =
    'id,value\n' +
    Array.from(
      { length: count },
      (_, i) => String(i).padStart(3, '0') + ',' + (i % 2 ? i + 1 : i),
    ).join('\n');
  const r = compareCsv(parseCsv(a), parseCsv(b), 'id');
  check(() => assert.equal(r.changed.length, Math.floor(count / 2)));
  check(() => assert.equal(r.unchanged, Math.ceil(count / 2)));
}
console.log(
  JSON.stringify({
    passed: true,
    checks,
    source: 'immutable programmer CSV reference',
  }),
);
