'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { matches, applyUpdate, project, firstPath } = require('../src/document-store.cjs');

function pythonExpected() {
  const result = spawnSync('python', [path.join(__dirname, 'python-document-fixtures.py')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONPATH: process.env.PYTHONPATH ?? '' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const document = {
  _id: 'synthetic-doc', id: 'synthetic-user', role: 'admin',
  balance_xof: 500, active: true,
  contact: { phone: '22890123456', email: 'test@example.invalid' },
  roles: ['admin', 'support'],
  events: [{ kind: 'deposit', amount: 500 }, { kind: 'payout', amount: 200 }],
};
const queries = [
  { id: 'synthetic-user' },
  { 'contact.phone': { $regex: '^228', $options: 'i' } },
  { $or: [{ role: 'user' }, { role: 'admin' }] },
  { balance_xof: { $gte: 500, $lt: 501 } },
  { roles: { $in: ['owner', 'support'] } },
  { active: { $type: 'bool' } },
  { missing: { $exists: false } },
  { events: { $elemMatch: { kind: 'deposit', amount: { $gte: 500 } } } },
  { balance_xof: { $ne: 0, $nin: [1, 2] } },
];
const update = {
  $set: { 'contact.name': 'Synthetic' },
  $unset: { role: '' },
  $inc: { balance_xof: 25 },
  $addToSet: { roles: { $each: ['support', 'finance'] } },
  $push: { events: { kind: 'refund', amount: 25 } },
  $pull: { events: { kind: 'payout' } },
};

test('document filters and nested projections match the Python adapter vectors', () => {
  const expected = pythonExpected();
  assert.deepEqual(queries.map(query => matches(document, query)), expected.query_results);
  assert.deepEqual(project(document, { id: 1, 'contact.phone': 1, _id: 0 }), expected.projection);
});

test('document updates preserve Python modifier semantics', () => {
  assert.deepEqual(applyUpdate(document, update), pythonExpected().updated);
});

test('nested paths and projection do not expose unselected fields', () => {
  assert.equal(firstPath(document, 'contact.phone'), '22890123456');
  assert.deepEqual(project(document, { id: 1, _id: 0 }), { id: 'synthetic-user' });
});

test('collection names are restricted before SQL is created', () => {
  const { Collection } = require('../src/document-store.cjs');
  const fakeStore = { pool: { execute() {} }, transaction() {} };
  assert.throws(() => new Collection(fakeStore, 'users; DROP TABLE document_store'));
});
