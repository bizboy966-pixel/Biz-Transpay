'use strict';
const { randomUUID } = require('node:crypto');

function pathValues(document, path) {
  let values = [document];
  for (const part of path.split('.')) {
    const next = [];
    for (const value of values) {
      if (value && typeof value === 'object' && !Array.isArray(value)
          && Object.hasOwn(value, part)) next.push(value[part]);
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && Object.hasOwn(item, part)) next.push(item[part]);
        }
      }
    }
    values = next;
  }
  return values;
}

function firstPath(document, path, fallback = null) {
  const values = pathValues(document, path);
  return values.length ? values[0] : fallback;
}

function setPath(document, path, value) {
  const parts = path.split('.');
  let target = document;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = structuredClone(value);
}

function unsetPath(document, path) {
  const parts = path.split('.');
  let target = document;
  for (const part of parts.slice(0, -1)) {
    target = target?.[part];
    if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  }
  if (target && typeof target === 'object') delete target[parts.at(-1)];
}

function equal(a, b) {
  if (Array.isArray(a) && !Array.isArray(b)) return a.some(item => equal(item, b));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a).sort(); const keysB = Object.keys(b).sort();
    return keysA.length === keysB.length && keysA.every((key, i) =>
      key === keysB[i] && equal(a[key], b[key]));
  }
  return a === b;
}

function compare(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  if ((typeof a === 'number' || typeof a === 'bigint')
      && (typeof b === 'number' || typeof b === 'bigint')) return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'number') {
    const n = Date.parse(a);
    if (Number.isFinite(n) && Number.isFinite(b)) return n - b;
  }
  if (typeof a === 'number' && typeof b === 'string') {
    const n = Date.parse(b);
    if (Number.isFinite(n) && Number.isFinite(a)) return a - n;
  }
  return 0;
}

function condition(values, expected, exists) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || !Object.keys(expected).some(key => key.startsWith('$'))) {
    return values.some(value => equal(value, expected));
  }
  for (const [op, target] of Object.entries(expected)) {
    const flattened = values.flatMap(value => Array.isArray(value) ? value : [value]);
    if (op === '$exists' && exists !== Boolean(target)) return false;
    if (op === '$eq' && !values.some(value => equal(value, target))) return false;
    if (op === '$ne' && values.some(value => equal(value, target))) return false;
    if (op === '$in' && !flattened.some(value => target.some(item => equal(value, item)))) return false;
    if (op === '$nin' && flattened.some(value => target.some(item => equal(value, item)))) return false;
    if (['$gt', '$gte', '$lt', '$lte'].includes(op)) {
      const tests = { $gt: n => n > 0, $gte: n => n >= 0, $lt: n => n < 0, $lte: n => n <= 0 };
      if (!values.some(value => value !== null && value !== undefined && tests[op](compare(value, target)))) return false;
    }
    if (op === '$regex') {
      const pattern = String(target);
      if (pattern.length > 256) return false;
      let re;
      try { re = new RegExp(pattern, String(expected.$options || '').includes('i') ? 'i' : ''); }
      catch { return false; }
      if (!values.some(value => re.test(String(value)))) return false;
    }
    if (op === '$elemMatch') {
      if (!values.some(value => Array.isArray(value) && value.some(item =>
        item && typeof item === 'object' ? matches(item, target)
          : condition([item], target, true)))) return false;
    }
    if (op === '$type') {
      const check = target === 'string' ? value => typeof value === 'string'
        : target === 'object' ? value => value !== null && typeof value === 'object' && !Array.isArray(value)
          : target === 'array' ? Array.isArray
            : target === 'bool' ? value => typeof value === 'boolean'
              : target === 'number' ? value => typeof value === 'number' : () => false;
      if (!values.some(check)) return false;
    }
  }
  return true;
}

function matches(document, query = {}) {
  for (const [key, expected] of Object.entries(query)) {
    if (key === '$or' && !expected.some(part => matches(document, part))) return false;
    if (key === '$and' && !expected.every(part => matches(document, part))) return false;
    if (key.startsWith('$')) continue;
    const values = pathValues(document, key);
    if (!condition(values, expected, values.length > 0)) return false;
  }
  return true;
}

function applyUpdate(document, update, inserting = false) {
  const result = structuredClone(document);
  if (!Object.keys(update).some(key => key.startsWith('$'))) {
    return { ...structuredClone(update), _id: update._id ?? result._id ?? randomUUID() };
  }
  for (const [operator, values] of Object.entries(update)) {
    if (operator === '$set' || (operator === '$setOnInsert' && inserting)) {
      for (const [path, value] of Object.entries(values)) setPath(result, path, value);
    } else if (operator === '$unset') {
      for (const path of Object.keys(values)) unsetPath(result, path);
    } else if (operator === '$inc') {
      for (const [path, amount] of Object.entries(values)) {
        setPath(result, path, (firstPath(result, path, 0) || 0) + amount);
      }
    } else if (operator === '$addToSet' || operator === '$push') {
      for (const [path, value] of Object.entries(values)) {
        let current = firstPath(result, path, []);
        if (!Array.isArray(current)) current = [];
        const additions = value && typeof value === 'object' && !Array.isArray(value)
          && Object.hasOwn(value, '$each') ? value.$each : [value];
        for (const item of additions) {
          if (operator === '$push' || !current.some(existing => equal(existing, item))) {
            current.push(structuredClone(item));
          }
        }
        setPath(result, path, current);
      }
    } else if (operator === '$pull') {
      for (const [path, value] of Object.entries(values)) {
        const current = firstPath(result, path, []);
        if (Array.isArray(current)) {
          setPath(result, path, current.filter(item => !condition([item], value, true)));
        }
      }
    }
  }
  return result;
}

function project(document, projection) {
  if (!projection || !Object.keys(projection).length) return structuredClone(document);
  const include = Object.entries(projection).filter(([key, value]) => value && key !== '_id').map(([key]) => key);
  const exclude = Object.entries(projection).filter(([, value]) => !value).map(([key]) => key);
  let result = {};
  if (!include.length) result = structuredClone(document);
  else {
    for (const path of include) {
      const value = firstPath(document, path, undefined);
      if (value !== undefined) setPath(result, path, value);
    }
    if (projection._id !== 0 && document._id !== undefined) result._id = document._id;
  }
  for (const path of exclude) unsetPath(result, path);
  return result;
}

function simpleCandidate(query) {
  if (!query || Object.keys(query).some(key => key.startsWith('$'))) return null;
    const entries = Object.entries(query).filter(([key, value]) =>
      /^[A-Za-z0-9_]+$/.test(key) && typeof value === 'string');
  return entries.length ? Object.fromEntries(entries) : null;
}

function safeCollection(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error('Invalid collection name');
  }
  return name;
}

class Cursor {
  constructor(collection, query = {}, projectionSpec = null) {
    this.collection = collection; this.query = query || {}; this.projectionSpec = projectionSpec;
    this.sortSpec = []; this.limitValue = null; this.skipValue = 0;
  }
  sort(key, direction = 1) {
    this.sortSpec = typeof key === 'string' ? [[key, direction]] : key;
    return this;
  }
  limit(value) { this.limitValue = Number(value); return this; }
  skip(value) { this.skipValue = Number(value); return this; }
  async items() {
    let documents = await this.collection._all(simpleCandidate(this.query));
    documents = documents.filter(doc => matches(doc, this.query));
    for (const [key, direction] of [...this.sortSpec].reverse()) {
      documents.sort((a, b) => {
        const av = firstPath(a, key); const bv = firstPath(b, key);
        const missing = (av === null || av === undefined ? 1 : 0)
          - (bv === null || bv === undefined ? 1 : 0);
        return (direction < 0 ? -missing : missing)
          || compare(av, bv) * (direction < 0 ? -1 : 1);
      });
    }
    documents = documents.slice(this.skipValue);
    if (this.limitValue !== null) documents = documents.slice(0, this.limitValue);
    return documents.map(doc => project(doc, this.projectionSpec));
  }
  async to_list(length) {
    const docs = await this.items();
    return length === undefined || length < 0 ? docs : docs.slice(0, length);
  }
  async *[Symbol.asyncIterator]() { yield* await this.items(); }
}

class Collection {
  constructor(store, name) { this.store = store; this.name = safeCollection(name); }
  find(query = {}, projectionSpec = null) { return new Cursor(this, query, projectionSpec); }
  async find_one(query = {}, projectionSpec = null) {
    return (await this.find(query, projectionSpec).limit(1).to_list(1))[0] ?? null;
  }
  async _all(candidate = null, connection = null) {
    const executor = connection ?? this.store.pool;
    const params = [this.name];
    let sql = 'SELECT document FROM document_store WHERE collection=?';
    if (candidate) {
      const clauses = [];
      for (const [field, value] of Object.entries(candidate)) {
        const jsonPath = `$.${field}`;
        clauses.push('(JSON_UNQUOTE(JSON_EXTRACT(document, ?)) = ? OR JSON_CONTAINS(document, JSON_QUOTE(?), ?))');
        params.push(jsonPath, value, value, jsonPath);
      }
      sql += ` AND ${clauses.join(' AND ')}`;
    }
    const [rows] = await executor.execute(sql, params);
    return rows.map(row => typeof row.document === 'string' ? JSON.parse(row.document) : row.document);
  }
  async create_index() { return 'document_store_index'; }
  async insert_one(document) {
    const doc = structuredClone(document);
    doc._id ??= randomUUID();
    const id = String(doc.id ?? doc._id);
    await this.store.pool.execute(
      'INSERT INTO document_store(collection, doc_id, document) VALUES (?, ?, ?)',
      [this.name, id, JSON.stringify(doc)]);
    return { inserted_id: id };
  }
  async insert_many(documents, ordered = true) {
    const inserted_ids = [];
    for (const doc of documents) {
      try { inserted_ids.push((await this.insert_one(doc)).inserted_id); }
      catch (error) {
        if (ordered) throw error;
        // Duplicate identifiers are ignored for resumable unordered fan-out.
        if (error.code !== 'ER_DUP_ENTRY') throw error;
      }
    }
    return { inserted_ids };
  }
  async _mutate(callback) {
    return this.store.transaction(async (repo, connection) => {
      await repo.lockCollection(this.name);
      return callback(connection);
    });
  }
  async replace_one(query, replacement, upsert = false) {
    return this._mutate(async connection => {
      const found = (await this._all(simpleCandidate(query), connection)).find(doc => matches(doc, query));
      if (!found) {
        if (!upsert) return { matched_count: 0, modified_count: 0 };
        const newDoc = structuredClone(replacement); newDoc._id ??= randomUUID();
        const id = String(newDoc.id ?? newDoc._id);
        await connection.execute('INSERT INTO document_store(collection, doc_id, document) VALUES(?, ?, ?)',
          [this.name, id, JSON.stringify(newDoc)]);
        return { matched_count: 0, modified_count: 0, upserted_id: id };
      }
      const newDoc = structuredClone(replacement); newDoc._id ??= found._id ?? randomUUID();
      const oldId = String(found.id ?? found._id); const newId = String(newDoc.id ?? oldId);
      await connection.execute(
        'UPDATE document_store SET doc_id=?, document=?, updated_at=UTC_TIMESTAMP(6) WHERE collection=? AND doc_id=?',
        [newId, JSON.stringify(newDoc), this.name, oldId]);
      return { matched_count: 1, modified_count: Number(JSON.stringify(newDoc) !== JSON.stringify(found)) };
    });
  }
  async update_one(query, update, upsert = false) { return this._update(query, update, upsert, false); }
  async update_many(query, update, upsert = false) { return this._update(query, update, upsert, true); }
  async _update(query, update, upsert, many) {
    return this._mutate(async connection => {
      const rows = await this._all(simpleCandidate(query), connection);
      const matchesList = rows.filter(doc => matches(doc, query));
      if (!matchesList.length && upsert) {
        const base = Object.fromEntries(Object.entries(query)
          .filter(([key, value]) => !key.startsWith('$') && (!value || typeof value !== 'object')));
        const doc = applyUpdate(base, update, true); doc._id ??= randomUUID();
        const id = String(doc.id ?? doc._id);
        await connection.execute('INSERT INTO document_store(collection, doc_id, document) VALUES(?, ?, ?)',
          [this.name, id, JSON.stringify(doc)]);
        return { matched_count: 0, modified_count: 0, upserted_id: id };
      }
      const chosen = many ? matchesList : matchesList.slice(0, 1);
      let modified = 0;
      for (const old of chosen) {
        const next = applyUpdate(old, update);
        const id = String(next.id ?? next._id);
        await connection.execute(
          'UPDATE document_store SET document=?, updated_at=UTC_TIMESTAMP(6) WHERE collection=? AND doc_id=?',
          [JSON.stringify(next), this.name, id]);
        if (JSON.stringify(old) !== JSON.stringify(next)) modified++;
      }
      return { matched_count: chosen.length, modified_count: modified };
    });
  }
  async delete_one(query) { return this._delete(query, false); }
  async delete_many(query) { return this._delete(query, true); }
  async _delete(query, many) {
    return this._mutate(async connection => {
      const rows = await this._all(simpleCandidate(query), connection);
      const chosen = rows.filter(doc => matches(doc, query)).slice(0, many ? undefined : 1);
      for (const doc of chosen) {
        await connection.execute('DELETE FROM document_store WHERE collection=? AND doc_id=?',
          [this.name, String(doc.id ?? doc._id)]);
      }
      return { deleted_count: chosen.length };
    });
  }
  async count_documents(query = {}) {
    return (await this._all(simpleCandidate(query))).filter(doc => matches(doc, query)).length;
  }
  async distinct(path) {
    const seen = new Set(); const values = [];
    for (const doc of await this._all()) {
      const value = firstPath(doc, path);
      if (value === null || value === undefined) continue;
      const key = JSON.stringify(value);
      if (!seen.has(key)) { seen.add(key); values.push(value); }
    }
    return values;
  }
  aggregate(pipeline) { return new AggregateCursor(this, pipeline); }
}

class AggregateCursor extends Cursor {
  constructor(collection, pipeline) { super(collection); this.pipeline = pipeline; }
  async items() {
    let docs = await this.collection._all();
    for (const stage of this.pipeline) {
      if (stage.$match) docs = docs.filter(doc => matches(doc, stage.$match));
      else if (stage.$sort) {
        for (const [key, direction] of Object.entries(stage.$sort).reverse()) {
          docs.sort((a, b) => compare(firstPath(a, key), firstPath(b, key)) * (direction < 0 ? -1 : 1));
        }
      } else if (stage.$limit !== undefined) docs = docs.slice(0, stage.$limit);
      else if (stage.$project) docs = docs.map(doc => project(doc, stage.$project));
      else if (stage.$group) {
        const spec = stage.$group; const grouped = new Map();
        for (const doc of docs) {
          const id = typeof spec._id === 'string' && spec._id.startsWith('$')
            ? firstPath(doc, spec._id.slice(1)) : spec._id;
          const key = JSON.stringify(id);
          if (!grouped.has(key)) grouped.set(key, { _id: id });
          const bucket = grouped.get(key);
          for (const [field, operation] of Object.entries(spec)) {
            if (field === '_id' || !Object.hasOwn(operation, '$sum')) continue;
            const value = operation.$sum;
            const increment = value === 1 ? 1 : typeof value === 'string' && value.startsWith('$')
              ? firstPath(doc, value.slice(1), 0) : value;
            bucket[field] = (bucket[field] || 0) + (increment || 0);
          }
        }
        docs = [...grouped.values()];
      }
    }
    return docs;
  }
}

module.exports = {
  Collection, Cursor, matches, applyUpdate, project, pathValues, firstPath,
};
