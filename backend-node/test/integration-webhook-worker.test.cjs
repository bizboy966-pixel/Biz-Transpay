'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matches, project } = require('../src/document-store.cjs');
const { createIntegrationWebhookWorker } = require('../src/integration-webhook-worker.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projection) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projection) : null;
  }
  find(query = {}, projection = null) {
    const collection = this;
    return {
      sortKey: null,
      sort(key) { this.sortKey = key; return this; },
      async to_list(limit) {
        let rows = collection.rows
          .filter(row => matches(row, query))
          .map(row => project(row, projection));
        if (this.sortKey) {
          rows.sort((left, right) => (
            String(left[this.sortKey] || '').localeCompare(String(right[this.sortKey] || ''))
          ));
        }
        return rows.slice(0, limit);
      },
    };
  }
  async insert_one(document) {
    if (this.rows.some(row => row.id === document.id)) {
      throw Object.assign(new Error('duplicate id'), { code: 'ER_DUP_ENTRY' });
    }
    this.rows.push(structuredClone(document));
    return { inserted_id: document.id };
  }
  async update_one(query, update) {
    const row = this.rows.find(item => matches(item, query));
    if (!row) return { matched_count: 0, modified_count: 0 };
    Object.assign(row, structuredClone(update.$set || update));
    return { matched_count: 1, modified_count: 1 };
  }
}

function setup({ deliverEvent, now = () => Date.parse('2026-10-31T10:00:00.000Z') } = {}) {
  const collections = {
    integration_operations: new Collection([{
      id: 'operation-deposit-1',
      user_id: 'merchant-1',
      environment: 'live',
      kind: 'deposit',
      business_id: 'deposit-1',
      status: 'pending',
      response: { id: 'deposit-1', status: 'pending' },
      reference: 'order-1',
      updated_at: '2026-10-31T09:59:00.000Z',
    }]),
    integration_webhooks: new Collection([{
      id: 'webhook-1',
      user_id: 'merchant-1',
      environment: 'live',
      active: true,
    }]),
    integration_webhook_events: new Collection(),
    momo_deposits: new Collection([{
      id: 'deposit-1',
      user_id: 'merchant-1',
      status: 'completed',
      amount: 600,
      currency: 'XOF',
    }]),
    transactions: new Collection(),
    crypto_deposits: new Collection(),
  };
  const worker = createIntegrationWebhookWorker({
    db: { collection: name => collections[name] },
    deliverEvent,
    now,
    logger: { warn() {} },
  });
  return { collections, worker };
}

test('API status reconciliation creates one durable, provider-neutral completion event', async () => {
  const deliveries = [];
  const { collections, worker } = setup({
    deliverEvent: async (userId, environment, destinationId, payload) => {
      deliveries.push({ userId, environment, destinationId, payload });
      return { status: 'delivered' };
    },
  });

  await worker.runOnce();
  await worker.runOnce();

  assert.equal(collections.integration_operations.rows[0].status, 'completed');
  assert.equal(collections.integration_webhook_events.rows.length, 1);
  const event = collections.integration_webhook_events.rows[0];
  assert.equal(event.status, 'delivered');
  assert.equal(event.event_type, 'deposit.status_changed');
  assert.deepEqual(event.destination_ids, ['webhook-1']);
  assert.equal(event.payload.data.status, 'completed');
  assert.equal(event.payload.data.previous_status, 'pending');
  assert.equal(event.payload.data.amount, 600);
  assert.equal(event.payload.data.currency, 'XOF');
  assert.equal(event.payload.data.reference, 'order-1');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].userId, 'merchant-1');
  assert.equal(deliveries[0].environment, 'live');
  assert.equal(deliveries[0].payload.id, event.id);
});

test('failed merchant webhook delivery is retried with the same event id', async () => {
  let time = Date.parse('2026-10-31T10:00:00.000Z');
  const deliveredEventIds = [];
  const { collections, worker } = setup({
    now: () => time,
    deliverEvent: async (userId, environment, destinationId, payload) => {
      deliveredEventIds.push(payload.id);
      return { status: deliveredEventIds.length === 1 ? 'failed' : 'delivered' };
    },
  });

  await worker.runOnce();
  assert.equal(collections.integration_webhook_events.rows[0].status, 'retry');
  time += 60_001;
  await worker.runOnce();

  assert.equal(collections.integration_webhook_events.rows[0].status, 'delivered');
  assert.equal(collections.integration_webhook_events.rows[0].attempts, 2);
  assert.equal(deliveredEventIds.length, 2);
  assert.equal(deliveredEventIds[0], deliveredEventIds[1]);
});
