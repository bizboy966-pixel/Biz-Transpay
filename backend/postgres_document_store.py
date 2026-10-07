"""Small Mongo-shaped document store backed by Replit PostgreSQL.

The application deliberately keeps its existing collection API while documents
are stored as JSONB.  This module contains no schema-creation side effects:
the ``document_store`` table is provisioned by the deployment database schema.
"""
from __future__ import annotations

import copy
import json
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, AsyncIterator

import asyncpg


def _path_values(document: Any, path: str) -> list[Any]:
    values = [document]
    for part in path.split("."):
        next_values: list[Any] = []
        for value in values:
            if isinstance(value, dict) and part in value:
                next_values.append(value[part])
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict) and part in item:
                        next_values.append(item[part])
        values = next_values
    return values


def _first(document: dict, path: str, missing: Any = None) -> Any:
    values = _path_values(document, path)
    return values[0] if values else missing


def _equal(value: Any, expected: Any) -> bool:
    if isinstance(value, list) and not isinstance(expected, list):
        return expected in value
    return value == expected


def _comparable(value: Any, expected: Any) -> tuple[Any, Any]:
    """Make ISO JSONB timestamps comparable to datetime query values."""
    if isinstance(value, str) and isinstance(expected, (date, datetime)):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value, expected
    if isinstance(expected, str) and isinstance(value, (date, datetime)):
        try:
            expected = datetime.fromisoformat(expected.replace("Z", "+00:00"))
        except ValueError:
            return value, expected
    if isinstance(value, datetime) and isinstance(expected, datetime):
        if value.tzinfo is None and expected.tzinfo is not None:
            value = value.replace(tzinfo=expected.tzinfo)
        elif expected.tzinfo is None and value.tzinfo is not None:
            expected = expected.replace(tzinfo=value.tzinfo)
    return value, expected


def _condition(values: list[Any], condition: Any, exists: bool) -> bool:
    if not isinstance(condition, dict) or not any(
        str(key).startswith("$") for key in condition
    ):
        return any(_equal(value, condition) for value in values)
    for operator, expected in condition.items():
        flattened = [item for value in values for item in value] if any(
            isinstance(value, list) for value in values
        ) else values
        if operator == "$exists" and exists != bool(expected):
            return False
        if operator == "$ne" and any(_equal(value, expected) for value in values):
            return False
        if operator == "$in" and not any(
            any(_equal(value, candidate) for candidate in expected)
            for value in flattened
        ):
            return False
        if operator == "$nin" and any(
            any(_equal(value, candidate) for candidate in expected)
            for value in flattened
        ):
            return False
        if operator in {"$gt", "$gte", "$lt", "$lte"}:
            comparisons = {
                "$gt": lambda a, b: a > b,
                "$gte": lambda a, b: a >= b,
                "$lt": lambda a, b: a < b,
                "$lte": lambda a, b: a <= b,
            }
            try:
                if not any(
                    comparisons[operator](*_comparable(value, expected))
                    for value in values
                ):
                    return False
            except (TypeError, ValueError):
                return False
        if operator == "$regex":
            flags = re.IGNORECASE if "i" in str(condition.get("$options", "")) else 0
            if not any(re.search(str(expected), str(value), flags) for value in values):
                return False
        if operator == "$elemMatch":
            if not any(
                isinstance(value, list)
                and any(_matches(item, expected) if isinstance(item, dict)
                        else _condition([item], expected, True) for item in value)
                for value in values
            ):
                return False
        if operator == "$type" and not any(
            (expected == "string" and isinstance(value, str))
            or (expected == "object" and isinstance(value, dict))
            or (expected == "array" and isinstance(value, list))
            or (expected == "bool" and isinstance(value, bool))
            or (expected == "number" and isinstance(value, (int, float)))
            for value in values
        ):
            return False
    return True


def _matches(document: dict, query: dict) -> bool:
    for key, expected in query.items():
        if key == "$or" and not any(_matches(document, part) for part in expected):
            return False
        if key == "$and" and not all(_matches(document, part) for part in expected):
            return False
        if key.startswith("$"):
            continue
        values = _path_values(document, key)
        if not _condition(values, expected, bool(values)):
            return False
    return True


def _query_candidate_filter(query: dict | None) -> dict | None:
    """Extract safe top-level string equalities for PostgreSQL pre-filtering.

    The adapter still applies its full Mongo-shaped matcher in Python.  A
    candidate is included here only when every matching document must have the
    same top-level string value (or an array containing that value).
    """
    if not isinstance(query, dict):
        return None
    candidates = {
        key: value
        for key, value in query.items()
        if not key.startswith("$") and "." not in key and isinstance(value, str)
    }
    return candidates or None


def _is_simple_string_query(query: dict) -> bool:
    return isinstance(query, dict) and all(
        not key.startswith("$")
        and "." not in key
        and isinstance(value, str)
        for key, value in query.items()
    )


def _set_path(document: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    target = document
    for part in parts[:-1]:
        if not isinstance(target.get(part), dict):
            target[part] = {}
        target = target[part]
    target[parts[-1]] = copy.deepcopy(value)


def _unset_path(document: dict, path: str) -> None:
    parts = path.split(".")
    target: Any = document
    for part in parts[:-1]:
        if not isinstance(target, dict) or part not in target:
            return
        target = target[part]
    if isinstance(target, dict):
        target.pop(parts[-1], None)


def _apply_update(document: dict, update: dict, inserting: bool = False) -> dict:
    result = copy.deepcopy(document)
    if not any(key.startswith("$") for key in update):
        replacement = copy.deepcopy(update)
        replacement.setdefault("_id", result.get("_id", str(uuid.uuid4())))
        return replacement
    for operator, values in update.items():
        if operator == "$set" or (operator == "$setOnInsert" and inserting):
            for path, value in values.items():
                _set_path(result, path, value)
        elif operator == "$unset":
            for path in values:
                _unset_path(result, path)
        elif operator == "$inc":
            for path, amount in values.items():
                _set_path(result, path, (_first(result, path, 0) or 0) + amount)
        elif operator in {"$addToSet", "$push"}:
            for path, value in values.items():
                current = _first(result, path, [])
                if not isinstance(current, list):
                    current = []
                current = copy.deepcopy(current)
                additions = value.get("$each", []) if isinstance(value, dict) and "$each" in value else [value]
                for item in additions:
                    if operator == "$push" or item not in current:
                        current.append(copy.deepcopy(item))
                _set_path(result, path, current)
        elif operator == "$pull":
            for path, value in values.items():
                current = _first(result, path, [])
                if isinstance(current, list):
                    current = [item for item in current if not _condition([item], value, True)]
                    _set_path(result, path, current)
    return result


def _project(document: dict, projection: dict | None) -> dict:
    if not projection:
        return copy.deepcopy(document)
    include = [key for key, value in projection.items() if value and key != "_id"]
    exclude = [key for key, value in projection.items() if not value]
    if include:
        result: dict[str, Any] = {}
        for path in include:
            value = _first(document, path, ...)
            if value is not ...:
                _set_path(result, path, value)
        if projection.get("_id", 1) and "_id" in document:
            result["_id"] = document["_id"]
    else:
        result = copy.deepcopy(document)
    for path in exclude:
        _unset_path(result, path)
    return result


@dataclass
class Result:
    inserted_id: str | None = None
    matched_count: int = 0
    modified_count: int = 0
    deleted_count: int = 0
    upserted_id: str | None = None


class Cursor:
    def __init__(self, collection: "Collection", query: dict, projection: dict | None):
        self.collection, self.query, self.projection = collection, query, projection
        self._sort: list[tuple[str, int]] = []
        self._limit: int | None = None
        self._skip = 0

    def sort(self, key: str | list[tuple[str, int]], direction: int = 1) -> "Cursor":
        self._sort = [(key, direction)] if isinstance(key, str) else list(key)
        return self

    def limit(self, value: int) -> "Cursor":
        self._limit = value
        return self

    def skip(self, value: int) -> "Cursor":
        self._skip = value
        return self

    async def _items(self) -> list[dict]:
        candidate_filter = _query_candidate_filter(self.query)
        push_page = (
            candidate_filter is not None
            and _is_simple_string_query(self.query)
            and not self._sort
            and self._skip >= 0
            and (self._limit is None or self._limit >= 0)
        )
        rows = await self.collection._rows(
            candidate_filter=candidate_filter,
            limit=self._limit if push_page else None,
            offset=self._skip if push_page else 0,
        )
        docs = [row for row in rows if _matches(row, self.query)]
        for key, direction in reversed(self._sort):
            docs.sort(key=lambda item: (_first(item, key) is None, _first(item, key)), reverse=direction < 0)
        docs = docs[self._skip:]
        if self._limit is not None:
            docs = docs[:self._limit]
        return [_project(doc, self.projection) for doc in docs]

    async def to_list(self, length: int | None = None) -> list[dict]:
        items = await self._items()
        return items if length is None or length < 0 else items[:length]

    def __aiter__(self) -> AsyncIterator[dict]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[dict]:
        for item in await self._items():
            yield item


class AggregateCursor(Cursor):
    def __init__(self, collection: "Collection", pipeline: list[dict]):
        super().__init__(collection, {}, None)
        self.pipeline = pipeline

    async def _items(self) -> list[dict]:
        candidate_filter = {}
        for stage in self.pipeline:
            if "$match" not in stage:
                break
            candidate_filter.update(_query_candidate_filter(stage["$match"]) or {})
        docs = await self.collection._rows(candidate_filter=candidate_filter or None)
        for stage in self.pipeline:
            if "$match" in stage:
                docs = [doc for doc in docs if _matches(doc, stage["$match"])]
            elif "$sort" in stage:
                for key, direction in reversed(list(stage["$sort"].items())):
                    docs.sort(key=lambda item: (_first(item, key) is None, _first(item, key)), reverse=direction < 0)
            elif "$limit" in stage:
                docs = docs[:stage["$limit"]]
            elif "$project" in stage:
                docs = [_project(doc, stage["$project"]) for doc in docs]
            elif "$group" in stage:
                spec, grouped = stage["$group"], {}
                for doc in docs:
                    group_key = _first(doc, str(spec["_id"])[1:]) if isinstance(spec["_id"], str) and spec["_id"].startswith("$") else spec["_id"]
                    bucket = grouped.setdefault(str(group_key), {"_id": group_key})
                    for field, operation in spec.items():
                        if field == "_id":
                            continue
                        if "$sum" in operation:
                            value = operation["$sum"]
                            increment = 1 if value == 1 else (_first(doc, value[1:], 0) if isinstance(value, str) and value.startswith("$") else value)
                            bucket[field] = bucket.get(field, 0) + (increment or 0)
                docs = list(grouped.values())
        return docs


class Collection:
    def __init__(self, store: "PostgresDocumentStore", name: str):
        self.store, self.name = store, name

    async def _lock_mutations(self, connection) -> None:
        """Serialize read/match/write mutations for this collection.

        The two-key advisory-lock form is supported by PostgreSQL versions
        predating ``hashtextextended`` too. Hash collisions can only cause
        unrelated collections to serialize; they cannot weaken correctness.
        """
        await connection.execute(
            "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
            "postgres_document_store",
            self.name,
        )

    async def _rows(
        self,
        connection=None,
        candidate_filter: dict | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[dict]:
        conn = connection or await self.store.pool.acquire()
        try:
            sql = "SELECT document FROM document_store WHERE collection=$1"
            args: list[Any] = [self.name]
            if candidate_filter:
                filter_arg = len(args) + 1
                sql += f"""
                    AND NOT EXISTS (
                        SELECT 1
                        FROM jsonb_each(${filter_arg}::jsonb) AS candidate(field_name, field_value)
                        WHERE NOT (
                            (document -> candidate.field_name) = candidate.field_value
                            OR (document -> candidate.field_name)
                                @> jsonb_build_array(candidate.field_value)
                        )
                    )
                """
                args.append(self.store.encode(candidate_filter))
            if limit is not None:
                args.append(max(0, int(limit)))
                sql += f" LIMIT ${len(args)}"
            if offset:
                args.append(max(0, int(offset)))
                sql += f" OFFSET ${len(args)}"
            rows = await conn.fetch(sql, *args)
            documents = []
            for row in rows:
                document = row["document"]
                if isinstance(document, str):
                    document = json.loads(document)
                documents.append(dict(document))
            return documents
        finally:
            if connection is None:
                await self.store.pool.release(conn)

    def find(self, query=None, projection=None) -> Cursor:
        return Cursor(self, query or {}, projection)

    async def create_index(self, *args, **kwargs) -> str:
        """Compatibility no-op; PostgreSQL schema/indexes are provisioned separately."""
        return kwargs.get("name", "document_store_index")

    async def find_one(self, query=None, projection=None) -> dict | None:
        items = await self.find(query, projection).limit(1).to_list(1)
        return items[0] if items else None

    async def insert_one(self, document: dict) -> Result:
        doc = copy.deepcopy(document)
        doc.setdefault("_id", str(uuid.uuid4()))
        doc_id = str(doc.get("id") or doc["_id"])
        try:
            await self.store.pool.execute(
                """INSERT INTO document_store(collection, doc_id, document)
                   VALUES($1,$2,$3::jsonb)""", self.name, doc_id, self.store.encode(doc)
            )
        except asyncpg.UniqueViolationError as exc:
            from pymongo.errors import DuplicateKeyError
            raise DuplicateKeyError(str(exc)) from exc
        return Result(inserted_id=doc_id)

    async def replace_one(self, query: dict, replacement: dict,
                          upsert: bool = False) -> Result:
        """Replace the first matching document with Mongo-compatible semantics.

        A few legacy application flows use replacement writes for singleton
        documents such as KYC submissions and API-key configuration.  The
        PostgreSQL adapter previously implemented only modifier updates, so
        those first-write paths failed after the MongoDB migration.
        """
        async with self.store.pool.acquire() as conn:
            try:
                async with conn.transaction():
                    await self._lock_mutations(conn)
                    rows = await self._rows(
                        conn, candidate_filter=_query_candidate_filter(query)
                    )
                    matches = [doc for doc in rows if _matches(doc, query)]
                    if not matches:
                        if not upsert:
                            return Result()
                        doc = copy.deepcopy(replacement)
                        doc.setdefault("_id", str(uuid.uuid4()))
                        doc_id = str(doc.get("id") or doc["_id"])
                        await conn.execute(
                            """INSERT INTO document_store(collection, doc_id, document)
                               VALUES($1,$2,$3::jsonb)""",
                            self.name, doc_id, self.store.encode(doc),
                        )
                        return Result(upserted_id=doc_id)

                    old = matches[0]
                    doc = copy.deepcopy(replacement)
                    doc.setdefault("_id", old.get("_id", str(uuid.uuid4())))
                    old_doc_id = str(old.get("id") or old["_id"])
                    new_doc_id = str(doc.get("id") or old_doc_id)
                    await conn.execute(
                        """UPDATE document_store
                           SET doc_id=$3, document=$4::jsonb, updated_at=now()
                           WHERE collection=$1 AND doc_id=$2""",
                        self.name, old_doc_id, new_doc_id, self.store.encode(doc),
                    )
                    return Result(matched_count=1, modified_count=int(doc != old))
            except asyncpg.UniqueViolationError as exc:
                from pymongo.errors import DuplicateKeyError
                raise DuplicateKeyError(str(exc)) from exc

    async def update_one(self, query: dict, update: dict, upsert: bool = False) -> Result:
        return await self._update(query, update, upsert, many=False)

    async def update_many(self, query: dict, update: dict, upsert: bool = False) -> Result:
        return await self._update(query, update, upsert, many=True)

    async def _update(self, query, update, upsert, many):
        async with self.store.pool.acquire() as conn:
            try:
                async with conn.transaction():
                    await self._lock_mutations(conn)
                    rows = await self._rows(
                        conn, candidate_filter=_query_candidate_filter(query)
                    )
                    matches = [doc for doc in rows if _matches(doc, query)]
                    if not matches and upsert:
                        base = {key: value for key, value in query.items() if not key.startswith("$") and not isinstance(value, dict)}
                        doc = _apply_update(base, update, inserting=True)
                        doc.setdefault("_id", str(uuid.uuid4()))
                        doc_id = str(doc.get("id") or doc["_id"])
                        await conn.execute("INSERT INTO document_store(collection,doc_id,document) VALUES($1,$2,$3::jsonb)", self.name, doc_id, self.store.encode(doc))
                        return Result(matched_count=0, modified_count=0, upserted_id=doc_id)
                    chosen = matches if many else matches[:1]
                    for old in chosen:
                        new = _apply_update(old, update)
                        doc_id = str(new.get("id") or new.get("_id"))
                        await conn.execute("UPDATE document_store SET document=$3::jsonb, updated_at=now() WHERE collection=$1 AND doc_id=$2", self.name, doc_id, self.store.encode(new))
                    return Result(matched_count=len(chosen), modified_count=sum(a != b for a, b in zip(chosen, [_apply_update(d, update) for d in chosen])))
            except asyncpg.UniqueViolationError as exc:
                from pymongo.errors import DuplicateKeyError
                raise DuplicateKeyError(str(exc)) from exc

    async def delete_one(self, query: dict) -> Result:
        return await self._delete(query, False)

    async def delete_many(self, query: dict) -> Result:
        return await self._delete(query, True)

    async def _delete(self, query, many):
        async with self.store.pool.acquire() as conn:
            async with conn.transaction():
                await self._lock_mutations(conn)
                rows = await self._rows(
                    conn, candidate_filter=_query_candidate_filter(query)
                )
                matches = [doc for doc in rows if _matches(doc, query)]
                if not many:
                    matches = matches[:1]
                for doc in matches:
                    await conn.execute("DELETE FROM document_store WHERE collection=$1 AND doc_id=$2", self.name, str(doc.get("id") or doc["_id"]))
                return Result(deleted_count=len(matches))

    async def count_documents(self, query: dict) -> int:
        query = query or {}
        rows = await self._rows(candidate_filter=_query_candidate_filter(query))
        return len([doc for doc in rows if _matches(doc, query)])

    async def distinct(self, field: str) -> list[Any]:
        result = []
        for doc in await self._rows():
            value = _first(doc, field, None)
            if value is not None and value not in result:
                result.append(value)
        return result

    def aggregate(self, pipeline: list[dict]) -> Cursor:
        return AggregateCursor(self, pipeline)


class PostgresDocumentStore:
    def __init__(self, url: str):
        if not url:
            raise RuntimeError("DATABASE_URL est requis pour PostgreSQL Replit")
        self.url = url
        self.pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        if self.pool is None:
            self.pool = await asyncpg.create_pool(self.url, min_size=1, max_size=10)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    def __getattr__(self, name: str) -> Collection:
        return Collection(self, name)

    @staticmethod
    def encode(document: dict) -> str:
        return json.dumps(document, default=str, separators=(",", ":"))


class _DatabaseProxy:
    def __init__(self, store: PostgresDocumentStore):
        self.store = store

    def __getattr__(self, name: str) -> Collection:
        return getattr(self.store, name)


def create_database(url: str) -> tuple[PostgresDocumentStore, _DatabaseProxy]:
    store = PostgresDocumentStore(url)
    return store, _DatabaseProxy(store)