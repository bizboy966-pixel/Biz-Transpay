'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createKycRoutes, validateRasterImage, validateSubmission } = require('../src/kyc-routes.cjs');
const { SessionService, SESSION_COOKIE_NAME } = require('../src/session-service.cjs');
const { matches, applyUpdate, project } = require('../src/document-store.cjs');

class MemoryCollection {
  constructor() { this.documents = []; }
  async insert_one(document) {
    this.documents.push(structuredClone(document));
    return { inserted_id: document.id };
  }
  async find_one(query, projectionSpec) {
    const found = this.documents.find(doc => matches(doc, query));
    return found ? project(found, projectionSpec) : null;
  }
  find(query, projectionSpec) {
    const collection = this;
    return {
      sortKeys: [],
      sort(spec) {
        this.sortKeys = typeof spec === 'string' ? [[spec, -1]] : spec;
        return this;
      },
      async to_list(limit) {
        let rows = collection.documents.filter(doc => matches(doc, query))
          .map(doc => structuredClone(doc));
        rows.sort((a, b) => {
          for (const [key, direction] of this.sortKeys) {
            const av = key.split('.').reduce((value, part) => value?.[part], a);
            const bv = key.split('.').reduce((value, part) => value?.[part], b);
            if (av !== bv) return (av > bv ? 1 : -1) * direction;
          }
          return 0;
        });
        if (limit !== undefined) rows = rows.slice(0, limit);
        return rows.map(row => project(row, projectionSpec));
      },
    };
  }
  async replace_one(query, replacement, upsert = false) {
    const index = this.documents.findIndex(doc => matches(doc, query));
    if (index >= 0) this.documents[index] = structuredClone(replacement);
    else if (upsert) this.documents.push(structuredClone(replacement));
    return { matched_count: index >= 0 ? 1 : 0, upserted_id: index < 0 && upsert ? replacement.user_id : null };
  }
  async update_one(query, update) {
    const index = this.documents.findIndex(doc => matches(doc, query));
    if (index < 0) return { matched_count: 0, modified_count: 0 };
    this.documents[index] = applyUpdate(this.documents[index], update, false, query);
    return { matched_count: 1, modified_count: 1 };
  }
}

class MemoryDatabase {
  constructor() { this.collections = new Map(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
}

const jwtSecret = 'kyc-test-jwt-secret';
const IMAGE = bytes => `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
const VALID_SUBMISSION = {
  full_name: 'Utilisateur Test',
  phone: '+22890000001',
  document_type: 'cni',
  document_number: 'DOC-12345',
  activity_description: 'Commerce de détail',
  activity_details: 'Vente de produits numériques et accessoires.',
  platform_status: 'available',
  platform_url: 'https://shop.example.invalid',
  document_front: IMAGE([0xff, 0xd8, 0xff, 0x00]),
  document_back: null,
  selfie: IMAGE([0xff, 0xd8, 0xff, 0x01]),
};

async function setup() {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one({
    id: 'owner', email: 'owner@example.invalid', role: 'user', kyc_status: 'not_started',
  });
  await db.collection('users').insert_one({
    id: 'other', email: 'other@example.invalid', role: 'user', kyc_status: 'verified',
  });
  const sessionService = new SessionService(db, { jwtSecret });
  const issued = await sessionService.issue('owner', {
    userPinRequired: false, userPinAuthenticated: true,
  });
  const cookie = issued.setCookie.find(value => value.startsWith(`${SESSION_COOKIE_NAME}=`))
    .split(';')[0];
  const notifications = [];
  const handle = createKycRoutes({
    db, sessionService, notifyAdminKyc: event => notifications.push(event),
  });
  return { db, cookie, handle, notifications };
}

async function invoke(handle, cookie, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.url = url;
  req.method = method;
  req.headers = { cookie };
  const response = {
    status: 0,
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(data) { this.body = data; },
  };
  await handle(req, response);
  return { status: response.status, body: JSON.parse(response.body || '{}') };
}

test('KYC accepts only bounded JPEG, PNG, and WebP data URLs with matching signatures', () => {
  const jpeg = IMAGE([0xff, 0xd8, 0xff, 0x01]);
  assert.equal(validateRasterImage(jpeg, 'selfie', { required: true }), jpeg);
  assert.throws(() => validateRasterImage('data:image/svg+xml;base64,PHN2Zz4=', 'selfie'));
  assert.throws(() => validateRasterImage(IMAGE([0x00, 0x00, 0x00]), 'selfie'));
  assert.throws(() => validateRasterImage(null, 'selfie', { required: true }));
});

test('KYC submission validates business details and rejects invalid platform URLs', () => {
  assert.equal(validateSubmission(VALID_SUBMISSION).activity_details,
    'Vente de produits numériques et accessoires.');
  assert.throws(() => validateSubmission({
    ...VALID_SUBMISSION, platform_url: 'http://user:password@example.invalid',
  }));
  assert.throws(() => validateSubmission({
    ...VALID_SUBMISSION, activity_details: '  court  ',
  }));
  assert.throws(() => validateSubmission({
    ...VALID_SUBMISSION, platform_status: 'not_available',
  }));
});

test('KYC status and documents are scoped to the authenticated user', async () => {
  const { db, cookie, handle } = await setup();
  await db.collection('kyc').insert_one({
    user_id: 'owner', status: 'pending', document_number: 'DOC-OWNER',
  });
  await db.collection('kyc').insert_one({
    user_id: 'other', status: 'verified', document_number: 'DOC-OTHER',
  });
  const response = await invoke(handle, cookie, 'GET', '/api/kyc');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'not_started');
  assert.equal(response.body.submission.document_number, 'DOC-OWNER');
  assert.doesNotMatch(JSON.stringify(response.body), /DOC-OTHER/);
  const unauthorized = await invoke(handle, '', 'GET', '/api/kyc');
  assert.equal(unauthorized.status, 401);
});

test('KYC submission stores only the authenticated owner and queues a safe admin event', async () => {
  const { db, cookie, handle, notifications } = await setup();
  const response = await invoke(handle, cookie, 'POST', '/api/kyc/submit', {
    ...VALID_SUBMISSION, user_id: 'other',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'pending');
  const stored = await db.collection('kyc').find_one({ user_id: 'owner' });
  assert.equal(stored.document_number, 'DOC-12345');
  assert.equal(stored.user_id, 'owner');
  assert.equal(stored.status, 'pending');
  assert.equal(await db.collection('kyc').find_one({ user_id: 'other' }), null);
  assert.equal((await db.collection('users').find_one({ id: 'owner' })).kyc_status, 'pending');
  assert.deepEqual(notifications.map(event => [event.type, event.userId, event.status]), [
    ['kyc_submitted', 'owner', 'pending'],
  ]);
});

test('invalid KYC images fail before persisting or changing account status', async () => {
  const { db, cookie, handle, notifications } = await setup();
  const response = await invoke(handle, cookie, 'POST', '/api/kyc/submit', {
    ...VALID_SUBMISSION, selfie: 'data:image/svg+xml;base64,PHN2Zz4=',
  });
  assert.equal(response.status, 422);
  assert.equal(await db.collection('kyc').find_one({ user_id: 'owner' }), null);
  assert.equal((await db.collection('users').find_one({ id: 'owner' })).kyc_status, 'not_started');
  assert.equal(notifications.length, 0);
});
