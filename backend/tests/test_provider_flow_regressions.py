"""Regression tests for ordinary provider payment and payout handling."""

import asyncio
from functools import wraps
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def run_async(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))
    return wrapper


async def disabled_afribapay_config(*args, **kwargs):
    return {"enabled": False, "catalog": []}


class MemoryCollection:
    def __init__(self, docs=None):
        self.docs = list(docs or [])

    async def create_index(self, *args, **kwargs):
        return None

    @staticmethod
    def _value(doc, path):
        value = doc
        for part in path.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        return value

    @classmethod
    def _matches(cls, doc, query):
        for key, expected in query.items():
            actual = cls._value(doc, key)
            if not isinstance(expected, dict):
                if actual != expected:
                    return False
                continue
            if "$in" in expected and actual not in expected["$in"]:
                return False
            if "$nin" in expected and actual in expected["$nin"]:
                return False
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            if "$exists" in expected and (actual is not None) != expected["$exists"]:
                return False
        return True

    @staticmethod
    def _set_path(doc, path, value):
        target = doc
        parts = path.split(".")
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = value

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return SimpleNamespace(inserted_id=doc.get("id"))

    async def find_one(self, query, projection=None, **kwargs):
        for doc in reversed(self.docs):
            if self._matches(doc, query):
                return dict(doc)
        return None

    async def update_one(self, query, update, **kwargs):
        for doc in reversed(self.docs):
            if not self._matches(doc, query):
                continue
            before = repr(doc)
            for path, value in update.get("$set", {}).items():
                self._set_path(doc, path, value)
            for path, value in update.get("$inc", {}).items():
                self._set_path(
                    doc, path, (self._value(doc, path) or 0) + value)
            for path, value in update.get("$addToSet", {}).items():
                target = doc
                parts = path.split(".")
                for part in parts[:-1]:
                    target = target.setdefault(part, {})
                values = target.setdefault(parts[-1], [])
                if value not in values:
                    values.append(value)
            for path in update.get("$unset", {}):
                target = doc
                parts = path.split(".")
                for part in parts[:-1]:
                    target = target.get(part, {})
                if isinstance(target, dict):
                    target.pop(parts[-1], None)
            return SimpleNamespace(
                matched_count=1, modified_count=int(repr(doc) != before))
        return SimpleNamespace(matched_count=0, modified_count=0)


class MemoryDB:
    def __init__(self):
        self.settings = MemoryCollection()
        self.webhook_events = MemoryCollection()
        self.crypto_deposits = MemoryCollection()
        self.link_payments = MemoryCollection()
        self.payment_links = MemoryCollection()
        self.momo_deposits = MemoryCollection()
        self.merchant_payouts = MemoryCollection()
        self.transactions = MemoryCollection()


@pytest.mark.parametrize(
    ("configured_code", "requested_code"),
    [("togocel_tg", "tmoney_tg"),
     ("togocel_tg", "t-money-togo"),
     ("togocel_tg", "togocel_tg"),
     ("moov_tg", "moov_tg")],
)
@run_async
async def test_public_link_payment_accepts_active_configured_operator(
        monkeypatch, configured_code, requested_code):
    db = MemoryDB()
    db.payment_links.docs.append({
        "id": "link-1", "slug": "test-link", "active": True,
        "amount": 1000, "amount_type": "fixed",
        "currency": "XOF", "user_id": "merchant-1",
        "title": "Test", "fee_bearer": "customer",
    })
    monkeypatch.setattr(server, "db", db)
    operator = {
        "country": "TG", "code": configured_code, "currency": "XOF",
        "name": "Opérateur", "active": True, "min": 100, "max": 500000,
        "endpoint_slug": "t-money-togo" if configured_code == "togocel_tg" else "moov-togo",
    }
    cfg = {
        "enabled": True, "mode": "live",
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [operator],
    }
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)
    async def no_turnstile(*args):
        return None
    async def no_notify(*args):
        return None
    submitted = []
    async def create_invoice(*args, **kwargs):
        return {"token": "invoice-1"}
    async def softpay(*args, **kwargs):
        submitted.append(kwargs["operator"]["code"])
        return {"response_code": "00", "reference": "provider-1"}
    monkeypatch.setattr(server, "_require_turnstile", no_turnstile)
    monkeypatch.setattr(
        server, "get_paydunya_config", lambda decrypt=False: value(cfg))
    monkeypatch.setattr(server, "get_mbiyo_config",
                        lambda decrypt=False: value({"enabled": False, "catalog": []}))
    monkeypatch.setattr(server.paydunya, "create_invoice", create_invoice)
    monkeypatch.setattr(server.paydunya, "softpay_payment", softpay)
    monkeypatch.setattr(server, "_notify_integration_link_payment", no_notify)
    request = Request({
        "type": "http", "method": "POST", "path": "/api/links/pay/mobile-money",
        "scheme": "https", "headers": [(b"host", b"example.test")],
        "query_string": b"", "server": ("example.test", 443),
    })
    payload = server.LinkPayMoMoRequest(
        slug="test-link", full_name="Test Buyer", email="buyer@example.test",
        country="TG", operator=requested_code, phone_number="90112233")

    result = await server.start_link_payment_momo(payload, request)

    assert result["method"] == "mobile_money"
    assert result["status"] == "pending"
    assert submitted == [configured_code]
    assert db.momo_deposits.docs[0]["operator_snapshot"]["code"] == configured_code
    assert len(db.link_payments.docs) == 1


@pytest.mark.parametrize("restriction", ["active", "archived", "hidden"])
@run_async
async def test_public_link_payment_keeps_tmoney_restrictions(monkeypatch, restriction):
    db = MemoryDB()
    db.payment_links.docs.append({
        "id": "link-1", "slug": "test-link", "active": True,
        "amount": 1000, "amount_type": "fixed",
        "currency": "XOF", "user_id": "merchant-1",
    })
    monkeypatch.setattr(server, "db", db)
    operator = {"country": "TG", "code": "togocel_tg",
                "currency": "XOF", "active": True}
    operator[restriction] = False if restriction == "active" else True
    cfg = {
        "enabled": True, "master_key_encrypted": "configured",
        "private_key_encrypted": "configured", "token_encrypted": "configured",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [operator],
    }
    async def value(payload):
        return payload
    async def no_turnstile(*args):
        return None
    monkeypatch.setattr(server, "_require_turnstile", no_turnstile)
    monkeypatch.setattr(
        server, "get_paydunya_config", lambda decrypt=False: value(cfg))
    monkeypatch.setattr(server, "get_mbiyo_config",
                        lambda decrypt=False: value({"enabled": False, "catalog": []}))
    request = Request({
        "type": "http", "method": "POST", "path": "/api/links/pay/mobile-money",
        "headers": [(b"host", b"example.test")], "query_string": b"",
    })
    payload = server.LinkPayMoMoRequest(
        slug="test-link", full_name="Test Buyer", email="buyer@example.test",
        country="TG", operator="tmoney_tg", phone_number="90112233")

    with pytest.raises(HTTPException) as exc:
        await server.start_link_payment_momo(payload, request)
    assert exc.value.status_code == 400
    assert not db.momo_deposits.docs
    assert not db.link_payments.docs


def test_public_mobile_money_config_hides_provider_identity():
    config = server._mbiyo_public_config({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{
            "country": "GN", "country_label": "Guinée",
            "code": "mbiyo_orange_gn", "network": "orange",
            "name": "Orange Money", "currency": "GNF",
            "min": 500, "max": 1500000, "active": True,
        }],
    })
    assert config["catalog"][0]["code"] == "orange_gn"
    assert "provider" not in config["catalog"][0]
    fees = server._public_fee_provider_mobile_money(config["catalog"])
    assert "provider" not in fees["operators"][0]


def test_mbiyo_public_config_exposes_split_admin_fees():
    config = server._mbiyo_public_config({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{
            "country": "TG", "code": "mbiyo_moov_tg", "network": "moov",
            "name": "Moov Money", "currency": "XOF", "active": True,
            "gateway_fee_pct": 1.5, "platform_fee_pct": 2,
            "gateway_fee_fixed": 10, "platform_fee_fixed": 5,
        }],
    })
    assert config["catalog"][0]["fee_pct"] == 3.5
    assert config["catalog"][0]["fee_fixed"] == 15


@run_async
async def test_deposit_provider_falls_back_when_paydunya_has_no_enabled_mode(
        monkeypatch):
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)

    shared_route = {
        "country": "TG", "code": "tmoney_tg", "currency": "XOF",
        "active": True,
    }
    monkeypatch.setattr(server, "get_paydunya_config", lambda: value({
        "enabled": True,
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {
            "softpay_direct": {"enabled": False},
            "psr": {"enabled": False},
            "par_redirect": {"enabled": False},
        },
        "catalog": [shared_route],
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", lambda: value({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{**shared_route, "code": "mbiyo_tmoney_tg"}],
    }))

    assert await server._resolve_deposit_provider(
        "TG", "tmoney_tg", "XOF") == "mbiyo"


@pytest.mark.parametrize("configured_code", ["tmoney_tg", "togocel_tg"])
@run_async
async def test_deposit_provider_uses_ready_paydunya_route(monkeypatch, configured_code):
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)

    shared_route = {
        "country": "TG", "code": configured_code, "currency": "XOF",
        "active": True,
    }
    monkeypatch.setattr(server, "get_paydunya_config", lambda: value({
        "enabled": True,
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [shared_route],
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", lambda: value({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{**shared_route, "code": "mbiyo_tmoney_tg"}],
    }))

    assert await server._resolve_deposit_provider(
        "TG", "tmoney_tg", "XOF") == "paydunya"


@run_async
async def test_direct_deposit_avoids_redirect_only_paydunya(monkeypatch):
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)

    shared_route = {
        "country": "TG", "code": "tmoney_tg", "currency": "XOF",
        "active": True,
    }
    monkeypatch.setattr(server, "get_paydunya_config", lambda: value({
        "enabled": True,
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {
            "softpay_direct": {"enabled": False},
            "par_redirect": {"enabled": True},
        },
        "catalog": [shared_route],
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", lambda: value({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{**shared_route, "code": "mbiyo_tmoney_tg"}],
    }))

    assert await server._resolve_deposit_provider(
        "TG", "tmoney_tg", "XOF", required_mode="softpay_direct") == "mbiyo"


@run_async
async def test_unavailable_deposit_error_does_not_disclose_provider(monkeypatch):
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)

    monkeypatch.setattr(server, "get_paydunya_config", lambda: value({
        "enabled": True,
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [{
            "country": "TG", "code": "tmoney_tg",
            "currency": "XOF", "active": True,
        }],
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", lambda: value({
        "enabled": False, "catalog": [],
    }))

    with pytest.raises(HTTPException) as exc:
        await server._resolve_deposit_provider("TG", "tmoney_tg", "XOF")
    assert exc.value.status_code == 503
    assert "paydunya" not in str(exc.value.detail).lower()
    assert "mbiyo" not in str(exc.value.detail).lower()


def test_public_withdrawal_catalog_keeps_active_provider_routes_distinct():
    config = server._public_transfer_config({
        "mobile_money": {
            "enabled": True,
            "operators": [{
                "country": "TG", "code": "t-money-togo",
                "name": "TMoney", "currency": "XOF", "active": True,
                "withdraw_mode": "t-money-togo",
            }],
        },
        "paydunya": {"enabled": True},
        "mbiyo": {
            "enabled": True,
            "operators": [{
                "country": "TG", "code": "mbiyo_moov_tg",
                "name": "Moov Money", "currency": "XOF", "active": True,
            }],
        },
    })
    operators = config["mobile_money"]["operators"]
    assert config["mobile_money"]["enabled"] is True
    assert {operator["code"] for operator in operators} == {
        "t-money-togo", "moov_tg",
    }
    assert all("provider" not in operator for operator in operators)


def test_public_withdrawal_catalog_hides_routes_owned_by_another_provider():
    config = server._public_transfer_config({
        "mobile_money": {
            "enabled": True,
            "operators": [
                {
                    "provider": "paydunya", "country": "TG",
                    "code": "t-money-togo", "withdraw_mode": "t-money-togo",
                    "name": "TMoney", "currency": "XOF", "active": True,
                },
                {
                    "provider": "mbiyo", "country": "TG",
                    "code": "mbiyo_tmoney_tg", "network": "togocom",
                    "name": "TMoney", "currency": "XOF", "active": True,
                },
                {
                    "provider": "afribapay", "country": "TG",
                    "code": "afribapay_tmoney_tg", "public_code": "tmoney_tg",
                    "operator": "tmoney", "name": "TMoney",
                    "currency": "XOF", "active": True,
                },
            ],
        },
        "paydunya": {"enabled": True},
        "mbiyo": {"enabled": True},
        "afribapay": {"enabled": True},
    })

    operators = config["mobile_money"]["operators"]
    assert [operator["code"] for operator in operators] == ["t-money-togo"]
    assert all("provider" not in operator for operator in operators)


def test_withdrawal_route_resolver_is_scoped_to_selected_provider():
    paydunya_route = next(
        op for op in server.paydunya.default_withdrawal_catalog()
        if op["country"] == "TG" and op["withdraw_mode"] == "moov-togo"
    )
    mbiyo_route = next(
        op for op in server.mbiyo.default_catalog()
        if op["country"] == "TG" and op["network"] == "moov"
    )
    afribapay_route = next(
        op for op in server.afribapay.default_payout_catalog()
        if op["country"] == "TG" and op["operator"] == "moov"
    )
    catalogue = [paydunya_route, mbiyo_route, afribapay_route]

    assert server._active_withdrawal_operator(
        catalogue, "paydunya", "TG", "moov-togo", "XOF"
    )["withdraw_mode"] == "moov-togo"
    assert server._active_withdrawal_operator(
        catalogue, "mbiyo", "TG", "moov_tg", "XOF"
    )["network"] == "moov"
    assert server._active_withdrawal_operator(
        catalogue, "afribapay", "TG", "moov_tg", "XOF"
    )["operator"] == "moov"


def test_withdrawal_route_identity_and_defaults_keep_one_provider_active():
    paydunya_route = next(
        op for op in server.paydunya.default_withdrawal_catalog()
        if op["country"] == "TG" and op["withdraw_mode"] == "moov-togo"
    )
    mbiyo_route = next(
        op for op in server.mbiyo.default_catalog()
        if op["country"] == "TG" and op["network"] == "moov"
    )
    afribapay_route = next(
        op for op in server.afribapay.default_payout_catalog()
        if op["country"] == "TG" and op["operator"] == "moov"
    )
    routes = [afribapay_route, mbiyo_route, paydunya_route]

    assert {
        server._withdrawal_route_identity(route) for route in routes
    } == {("TG", "moov")}
    server._deactivate_duplicate_withdrawal_routes(routes)
    assert paydunya_route["active"] is True
    assert mbiyo_route["active"] is False
    assert afribapay_route["active"] is False


def test_legacy_provider_codes_keep_their_provider_when_catalogue_is_merged():
    catalogue = server._merged_mobile_money(
        server.DEFAULT_TRANSFER_CONFIG,
        {"operators": [{
            "country": "TG",
            "code": "afribapay_moov_tg",
            "currency": "XOF",
            "active": True,
        }]},
    )
    route = next(
        op for op in catalogue["operators"]
        if op["code"] == "afribapay_moov_tg"
    )

    assert route["provider"] == "afribapay"
    assert route["active"] is True
    assert route.get("archived") is False


def test_withdrawal_catalog_rejects_same_active_route_on_multiple_providers():
    paydunya_route = next(
        op for op in server.paydunya.default_withdrawal_catalog()
        if op["country"] == "TG" and op["withdraw_mode"] == "moov-togo"
    )
    mbiyo_route = next(
        op for op in server.mbiyo.default_catalog()
        if op["country"] == "TG" and op["network"] == "moov"
    )

    with pytest.raises(HTTPException, match="un seul prestataire"):
        server._validate_withdrawal_catalog({
            "operators": [paydunya_route, mbiyo_route],
        })

    mbiyo_route["active"] = False
    server._validate_withdrawal_catalog({
        "operators": [paydunya_route, mbiyo_route],
    })


@run_async
async def test_transfer_config_migrates_mbiyo_payout_catalog_only_once(monkeypatch):
    db = MemoryDB()
    db.settings.docs.append({
        "id": "transfer_config",
        "mobile_money": {"enabled": True, "operators": []},
    })
    monkeypatch.setattr(server, "db", db)
    legacy_catalog = [{
        "country": "ZZ",
        "country_label": "Test Country",
        "code": "mbiyo_test_route",
        "network": "test-route",
        "currency": "XOF",
        "name": "Test Network",
        "active": True,
    }]

    async def paydunya_config():
        return {"enabled": False}

    async def mbiyo_config():
        return {"enabled": False, "catalog": legacy_catalog}

    async def afribapay_config():
        return {"enabled": False}

    monkeypatch.setattr(server, "get_paydunya_config", paydunya_config)
    monkeypatch.setattr(server, "_paydunya_credentials_configured", lambda _: False)
    monkeypatch.setattr(server, "get_mbiyo_config", mbiyo_config)
    monkeypatch.setattr(server, "get_afribapay_config", afribapay_config)
    monkeypatch.setattr(server, "_afribapay_ready", lambda *args, **kwargs: False)

    first = await server.get_transfer_config()
    assert any(
        op.get("provider") == "mbiyo" and op["code"] == "mbiyo_test_route"
        for op in first["mobile_money"]["operators"]
    )
    assert db.settings.docs[0]["withdrawal_catalog_migration_version"] == 1

    legacy_catalog.append({
        **legacy_catalog[0],
        "code": "mbiyo_later_deposit_route",
        "network": "later-deposit-route",
    })
    second = await server.get_transfer_config()
    assert not any(
        op.get("provider") == "mbiyo"
        and op["code"] == "mbiyo_later_deposit_route"
        for op in second["mobile_money"]["operators"]
    )


def test_public_withdrawal_config_exposes_provider_fees_without_identity():
    config = server._public_transfer_config({
        "mobile_money": {"enabled": True, "operators": []},
        "paydunya": {"enabled": False},
        "mbiyo": {
            "enabled": True,
            "operators": [{
                "country": "TG", "country_label": "Togo",
                "code": "mbiyo_tmoney_tg", "name": "TMoney",
                "currency": "XOF", "active": True,
                "gateway_fee_pct": 1.5, "platform_fee_pct": 0.5,
                "gateway_fee_fixed": 10, "platform_fee_fixed": 15,
                "min": 100, "max": 500000,
            }],
        },
    })

    mobile_money = config["mobile_money"]
    assert mobile_money["enabled"] is True
    assert len(mobile_money["operators"]) == 1
    operator = mobile_money["operators"][0]
    assert operator["code"] == "tmoney_tg"
    assert operator["fee_pct"] == 2
    assert operator["fee_fixed"] == 25
    assert "provider" not in operator


@run_async
async def test_customer_withdrawal_fee_grid_uses_effective_provider_catalog(
        monkeypatch):
    async def value(payload):
        return payload

    withdrawal = {
        "mobile_money": {"enabled": True, "operators": []},
        "paydunya": {"enabled": False},
        "mbiyo": {
            "enabled": True,
            "operators": [{
                "country": "BJ", "country_label": "Bénin",
                "code": "mbiyo_mtn_bj", "name": "MTN MoMo",
                "currency": "XOF", "active": True,
                "gateway_fee_pct": 1, "platform_fee_pct": 2,
                "gateway_fee_fixed": 5, "platform_fee_fixed": 10,
                "min": 500, "max": 1000000,
            }],
        },
        "crypto": {"enabled": False},
    }
    monkeypatch.setattr(
        server, "get_deposit_config",
        lambda: value({"crypto": {"enabled": False}}))
    monkeypatch.setattr(server, "get_transfer_config", lambda: value(withdrawal))
    monkeypatch.setattr(
        server, "get_paydunya_config", lambda: value({"enabled": False}))
    monkeypatch.setattr(
        server, "get_mbiyo_config", lambda: value({"enabled": False}))
    monkeypatch.setattr(server, "get_platform_config", lambda: value({}))

    result = await server.public_fees_config(uid="customer-1")
    mobile_money = result["withdrawal"]["mobile_money"]
    assert mobile_money["enabled"] is True
    assert mobile_money["operators"][0]["name"] == "MTN MoMo"
    assert mobile_money["operators"][0]["fee_pct"] == 3
    assert mobile_money["operators"][0]["fee_fixed"] == 15
    assert "provider" not in mobile_money["operators"][0]


def test_mbiyo_transaction_id_ignores_unrelated_nested_ids():
    assert server._mbiyo_transaction_id({
        "data": {
            "transaction_id": "MBIYO-123",
            "customer": {"id": "CUSTOMER-9"},
        },
    }) == "MBIYO-123"
    assert server._mbiyo_transaction_id({
        "data": {"customer": {"id": "CUSTOMER-9"}},
    }) is None


def test_mobile_number_match_accepts_country_prefix_only_for_same_number():
    assert server._same_mobile_number("22891978352", "91978352")
    assert server._same_mobile_number("+228 91 97 83 52", "91978352")
    assert server._same_mobile_number("00228 91 97 83 52", "+22891978352")
    assert not server._same_mobile_number("22890978352", "91978352")
    assert not server._same_mobile_number("8352", "91978352")


def test_provider_neutral_route_resolves_internal_mbiyo_code():
    catalog = [{
        "country": "GN", "code": "mbiyo_orange_gn",
        "network": "orange", "active": True,
    }]
    assert server._active_mbiyo_operator(
        catalog, "GN", "orange_gn")["network"] == "orange"


def _izipay_webhook_request(event, monkeypatch):
    raw = b'{"signed":"event"}'
    monkeypatch.setattr(
        server.izipay, "verify_webhook", lambda payload, signature: event)
    monkeypatch.setattr(server.izipay, "event_id", lambda payload: payload["id"])
    request = Request({
        "type": "http", "method": "POST", "path": "/api/webhooks/izipay",
        "headers": [(b"x-izipay-signature", b"test-signature")],
        "query_string": b"",
    })
    request._body = raw
    return request


@run_async
async def test_ordinary_provider_payout_callback_completes_transaction(
        monkeypatch):
    fake = MemoryDB()
    fake.transactions.docs.append({
        "id": "crypto-withdrawal-1", "user_id": "user-a",
        "status": "pending", "amount": 105, "currency": "USDT",
        "reference": "withdrawal-1",
        "metadata": {
            "transfer_type": "biz_to_crypto", "crypto": "USDT",
            "network": "TRC20", "recipient_gets": 100,
            "total_debit": 105, "operation_id": "withdrawal-operation",
        },
    })
    monkeypatch.setattr(server, "db", fake)
    notifications = []

    async def notify(*args, **kwargs):
        notifications.append((args, kwargs))

    monkeypatch.setattr(server, "notify", notify)
    request = _izipay_webhook_request({
        "id": "event-complete-1", "event": "payout.completed",
        "data": {
            "merchantReference": "crypto-withdrawal-1",
            "payoutId": "provider-payout-1",
            "status": "completed", "txHash": "chain-tx-1",
        },
    }, monkeypatch)

    result = await server.izipay_webhook(request)

    saved = fake.transactions.docs[0]
    assert result == {"received": True}
    assert saved["status"] == "completed"
    assert saved["metadata"]["tx_hash"] == "chain-tx-1"
    assert saved["metadata"]["izipay_payout_id"] == "provider-payout-1"
    assert fake.webhook_events.docs[0]["processed"] is True
    assert notifications
    assert notifications[0][0][1] == "withdrawal_success"


@run_async
async def test_ordinary_provider_payout_failure_refunds_once(monkeypatch):
    fake = MemoryDB()
    fake.transactions.docs.append({
        "id": "crypto-withdrawal-failed", "user_id": "user-a",
        "status": "pending", "amount": 105, "currency": "USDT",
        "metadata": {
            "transfer_type": "biz_to_crypto", "crypto": "USDT",
            "recipient_gets": 100, "total_debit": 105,
            "operation_id": "failed-withdrawal-operation",
        },
    })
    monkeypatch.setattr(server, "db", fake)
    refunds, notifications = [], []

    async def refund(user_id, field, amount, operation_id):
        refunds.append((user_id, field, amount, operation_id))

    async def notify(*args, **kwargs):
        notifications.append((args, kwargs))

    monkeypatch.setattr(server, "_refund_wallet_once", refund)
    monkeypatch.setattr(server, "notify", notify)
    request = _izipay_webhook_request({
        "id": "event-failed-1", "event": "payout.failed",
        "data": {
            "merchantReference": "crypto-withdrawal-failed",
            "payoutId": "provider-payout-failed",
            "status": "failed", "reason": "provider rejected",
        },
    }, monkeypatch)

    await server.izipay_webhook(request)

    saved = fake.transactions.docs[0]
    assert saved["status"] == "failed"
    assert saved["metadata"]["refunded_at"]
    assert refunds == [(
        "user-a", "balance_usdt", 105,
        "crypto-transfer:failed-withdrawal-operation",
    )]
    assert notifications
    assert notifications[0][0][1] == "withdrawal_failed"


@run_async
async def test_non_usdt_provider_deposit_settlement_credits_once(monkeypatch):
    fake = MemoryDB()
    fake.crypto_deposits.docs.append({
        "id": "btc-deposit", "user_id": "user-a", "status": "pending",
        "amount": 0.01, "coin": "BTC", "network": "BTC",
        "usdt_rate": 50000, "fee_pct": 1.5,
        "gateway_fee_pct": 1, "platform_fee_pct": 0.5,
        "gateway_fee_fixed": 0, "platform_fee_fixed": 0,
    })
    monkeypatch.setattr(server, "db", fake)
    credits, transactions = [], []

    async def credit(user_id, field, amount, operation_id):
        credits.append((user_id, field, amount, operation_id))
        return True

    async def record(*args, **kwargs):
        transactions.append((args, kwargs))

    monkeypatch.setattr(server, "_credit_wallet_once", credit)
    monkeypatch.setattr(server, "record_tx", record)

    assert await server._settle_izipay_payment(
        "btc-deposit", "intent-btc", "tx-btc", "webhook")
    assert await server._settle_izipay_payment(
        "btc-deposit", "intent-btc", "tx-btc", "reconcile")

    saved = fake.crypto_deposits.docs[0]
    assert len(credits) == 1
    btc_wallet_field = server._crypto_wallet_field("BTC.BTC")
    assert credits[0][1:3] == (btc_wallet_field, 0.00985)
    assert saved["amount_gross_usdt"] == 500
    assert saved["amount_crypto"] == 0.01
    assert saved["fee"] == 0.00015
    assert saved["amount_net"] == 0.00985
    assert saved["amount_net_usdt"] == 492.5
    assert saved["amount_net_currency"] == "BTC.BTC"
    assert saved["status"] == "confirmed"
    assert len(transactions) == 1
    assert transactions[0][0][3:5] == (0.00985, "BTC.BTC")


@run_async
async def test_link_payment_provider_settlement_credits_and_consumes_once(
        monkeypatch):
    fake = MemoryDB()
    fake.link_payments.docs.append({
        "id": "link-payment-1", "link_id": "link-1", "status": "pending",
        "coin": "BTC", "network": "BTC", "usdt_rate": 50000,
        "charged_amount": 0.01, "charged_amount_usdt": 500,
        "fee": 5, "fee_currency": "USDT", "gateway_fee": 3,
        "platform_fee": 2, "wallet_credit_amount": 495,
        "single_use_claim_id": "claim-1", "customer_email": "buyer@example.com",
    })
    fake.payment_links.docs.append({
        "id": "link-1", "user_id": "merchant-owner",
        "active": True, "payments_received": 0, "total_received": 0,
        "link_payment_operation_ids": [], "single_use_claim_id": "claim-1",
    })
    monkeypatch.setattr(server, "db", fake)
    credits, transactions = [], []

    async def credit(user_id, field, amount, operation_id):
        credits.append((user_id, field, amount, operation_id))

    async def record(*args, **kwargs):
        transactions.append((args, kwargs))

    monkeypatch.setattr(server, "_credit_wallet_once", credit)
    monkeypatch.setattr(server, "record_tx", record)

    await server._settle_izipay_payment(
        "link-payment-1", "intent-link", "tx-link", "webhook")
    await server._settle_izipay_payment(
        "link-payment-1", "intent-link", "tx-link", "reconcile")

    payment = fake.link_payments.docs[0]
    link = fake.payment_links.docs[0]
    assert payment["status"] == "paid"
    assert payment["amount_net"] == 495
    assert len(credits) == 1
    assert credits[0][:3] == ("merchant-owner", "balance_usdt", 495)
    assert link["payments_received"] == 1
    assert link["total_received"] == 495
    assert link["active"] is False
    assert link["link_payment_operation_ids"] == ["link-payment-1"]
    assert len(transactions) == 1


@run_async
async def test_provider_failure_does_not_override_settlement_or_claim(
        monkeypatch):
    fake = MemoryDB()
    fake.link_payments.docs.extend([
        {"id": "link-settling", "link_id": "link-a",
         "single_use_claim_id": "claim-settling", "status": "settling"},
        {"id": "link-pending", "link_id": "link-b",
         "single_use_claim_id": "claim-pending", "status": "pending"},
    ])
    monkeypatch.setattr(server, "db", fake)
    released = []

    async def release(link_id, claim_id):
        released.append((link_id, claim_id))

    monkeypatch.setattr(server, "_release_single_use_link", release)
    await server._fail_izipay_payment("link-settling", "expired")
    await server._fail_izipay_payment("link-pending", "expired")

    assert fake.link_payments.docs[0]["status"] == "settling"
    assert fake.link_payments.docs[1]["status"] == "expired"
    assert released == [("link-b", "claim-pending")]


@run_async
async def test_provider_payout_failure_refunds_once_and_ignores_late_success(
        monkeypatch):
    fake = MemoryDB()
    payout = {
        "id": "payout-1", "merchant_id": "merchant-a",
        "status": "pending", "total_debit": 105,
        "amount": 0.01, "coin": "BTC",
    }
    fake.merchant_payouts.docs.append(dict(payout))
    fake.transactions.docs.append({
        "id": "tx-payout-1", "status": "pending",
        "metadata": {"merchant_payout_id": "payout-1"},
    })
    monkeypatch.setattr(server, "db", fake)
    refunds = []

    async def refund(user_id, field, amount, operation_id):
        refunds.append((user_id, field, amount, operation_id))

    monkeypatch.setattr(server, "_refund_wallet_once", refund)
    await server._apply_merchant_payout_status(
        dict(payout), "failed", {"reason": "provider rejected"})
    await server._apply_merchant_payout_status(
        dict(fake.merchant_payouts.docs[0]), "completed", {})

    saved = fake.merchant_payouts.docs[0]
    assert saved["status"] == "failed"
    assert saved["refunded_at"]
    assert fake.transactions.docs[0]["status"] == "failed"
    assert len(refunds) == 1
    assert refunds[0][2:] == (105, "merchant-payout:payout-1")


@run_async
async def test_provider_reconciliation_routes_success_through_settlement(
        monkeypatch):
    async def configured_credentials():
        return {"enabled": True}

    async def get_payment_intent(intent_id):
        assert intent_id == "intent-1"
        return {
            "status": "completed", "merchantReference": "deposit-1",
            "txHash": "tx-1",
        }

    monkeypatch.setattr(server, "izipay", SimpleNamespace(
        is_configured=lambda: True,
        get_payment_intent=get_payment_intent,
    ))
    monkeypatch.setattr(
        server, "_load_izipay_credentials", configured_credentials)
    settled = []

    async def settle(*args, **kwargs):
        settled.append((args, kwargs))

    monkeypatch.setattr(server, "_settle_izipay_payment", settle)
    await server._reconcile_intent("intent-1")

    assert settled == [(("deposit-1", "intent-1", "tx-1"),
                        {"source": "reconcile"})]


@run_async
async def test_expired_mbiyo_deposit_fails_without_retry(monkeypatch):
    fake = MemoryDB()
    fake.momo_deposits.docs.append({
        "id": "momo-expired", "provider": "mbiyo", "status": "pending",
        "pending_expires_at": "2000-01-01T00:00:00+00:00",
    })
    monkeypatch.setattr(server, "db", fake)

    expired = await server._expire_momo_deposit_if_due(
        dict(fake.momo_deposits.docs[0]))

    assert expired is True
    saved = fake.momo_deposits.docs[0]
    assert saved["status"] == "failed"
    assert saved["failed_reason"] == "expired"
    assert saved["retryable"] is False