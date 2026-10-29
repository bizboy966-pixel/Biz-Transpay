'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createReferralRoutes, getSummary } = require('../src/referral-routes.cjs');
const { matches, project } = require('../src/document-store.cjs');
const { SESSION_COOKIE_NAME } = require('../src/session-service.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projectionSpec) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projectionSpec) : null;
  }
  find(query, projectionSpec) {
    const rows = this.rows;
    return {
      async to_list() {
        return rows.filter(item => matches(item, query))
          .map(item => project(item, projectionSpec));
      },
    };
  }
}

class Database {
  constructor({ users = [], kyc = [], commissions = [] } = {}) {
    this.rows = {
      users: new Collection(users),
      kyc: new Collection(kyc),
      referral_commissions: new Collection(commissions),
    };
  }
  collection(name) { return this.rows[name] || new Collection(); }
}

function request(method, url, token = 'owner-session') {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
  return req;
}

function response() {
  return {
    status: 0,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

function data() {
  const users = [
    { id: 'sponsor', username: 'sponsor-name' },
    {
      id: 'invite-1', username: 'private-one', referred_by_user_id: 'sponsor',
      kyc_status: 'verified', phone: '+228 90 00 00 01', country: 'TG',
      referral_first_tx_id: 'tx-one', referral_first_amount: 18.25,
      referral_first_currency: 'XOF', referral_qualified_at: '2026-02-01T00:00:00Z',
    },
    {
      id: 'invite-2', username: 'private-two', referred_by_user_id: 'sponsor',
      kyc_status: 'verified', phone: '+228 90 00 00 03', country: 'TG',
      referral_first_tx_id: 'tx-two', referral_first_amount: '20.50',
      referral_first_currency: 'XAF', referral_qualified_at: '2026-02-02T00:00:00Z',
    },
    {
      id: 'invite-duplicate', username: 'private-three', referred_by_user_id: 'sponsor',
      kyc_status: 'verified', phone: '+228 90 00 00 03', country: 'TG',
      referral_first_tx_id: 'tx-three', referral_first_amount: 25,
      referral_first_currency: 'XOF', referral_qualified_at: '2026-02-03T00:00:00Z',
    },
    { id: 'other-owner', username: 'not-visible' },
  ];
  const kyc = [
    {
      user_id: 'invite-1', status: 'verified', verified_at: '2026-01-01T00:00:00Z',
      country: 'TG', document_type: 'passport', document_number: 'AA-123',
    },
    {
      user_id: 'invite-2', status: 'verified', verified_at: '2026-01-01T00:00:00Z',
      country: 'TG', document_type: 'passport', document_number: 'BB-123',
    },
    {
      user_id: 'invite-duplicate', status: 'verified', verified_at: '2026-01-01T00:00:00Z',
      country: 'TG', document_type: 'passport', document_number: 'CC-123',
    },
  ];
  const commissions = [{
    id: 'referral:sponsor', status: 'paid', amount: 0.41, currency: 'XOF',
    rate_percent: 2,
  }];
  return new Database({ users, kyc, commissions });
}

test('public referral invite validates immutable UUID codes and returns only the sponsor username', async () => {
  const sponsorId = '390e8400-e29b-41d4-a716-446655440000';
  const db = new Database({
    users: [{
      id: sponsorId, username: 'visible-name', email: 'private@example.test',
    }],
  });
  const service = createReferralRoutes({
    db, sessionService: { async authenticate() { throw new Error('not used'); } },
  });
  let res = response();
  await service.handleRoute(request('GET', `/api/referrals/invite/${sponsorId.toUpperCase()}`), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { username: 'visible-name' });
  res = response();
  await service.handleRoute(request('GET', '/api/referrals/invite/not-a-uuid'), res);
  assert.equal(res.status, 404);
});

test('referral summary counts invitations and only uniquely identified, verified qualified referrals', async () => {
  const summary = await getSummary(data(), 'sponsor');
  assert.deepEqual(summary, {
    code: 'sponsor',
    invited_count: 3,
    qualified_count: 1,
    required_count: 5,
    commission: {
      status: 'paid', amount: 0.41, currency: 'XOF', rate_percent: 2,
    },
  });
  assert.equal(JSON.stringify(summary).includes('private-one'), false);
});

test('authenticated referral summary uses only the session owner', async () => {
  const db = data();
  const service = createReferralRoutes({
    db,
    sessionService: {
      async authenticate(token) {
        assert.equal(token, 'owner-session');
        return { userId: 'sponsor' };
      },
    },
  });
  const res = response();
  await service.handleRoute(request('GET', '/api/referrals/me'), res);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).invited_count, 3);
  assert.equal(JSON.parse(res.body).code, 'sponsor');
});
