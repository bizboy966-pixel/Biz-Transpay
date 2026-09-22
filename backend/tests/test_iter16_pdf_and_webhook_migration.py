"""Iteration 16 — Test PDF documentation endpoint + webhook URL migration."""
import os
import io
import uuid
import pytest
import requests
from pathlib import Path


def _get_backend_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v:
        return v.rstrip("/")
    envf = Path("/app/frontend/.env")
    for line in envf.read_text().splitlines():
        if line.startswith("REACT_APP_BACKEND_URL="):
            return line.split("=", 1)[1].strip().rstrip("/")
    raise RuntimeError("REACT_APP_BACKEND_URL not found")


BASE_URL = _get_backend_url()
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "bizboy966@gmail.com"
ADMIN_PW = "Password123!"


def _login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=90)
    assert r.status_code == 200, f"login failed {r.status_code}: {r.text[:200]}"
    return r.json()["token"]


def _register(email, password):
    r = requests.post(f"{API}/auth/register",
                      json={"email": email, "password": password,
                            "username": email.split("@")[0], "full_name": "Test User",
                            "account_type": "merchant", "country": "TG",
                            "phone": "+22890000000"},
                      timeout=30)
    assert r.status_code in (200, 201), f"register failed {r.status_code}: {r.text[:200]}"
    return r.json()["token"]


# ==================== WEBHOOK URL MIGRATION ====================
class TestWebhookMigration:
    def test_admin_webhook_url_not_emergent(self):
        token = _login(ADMIN_EMAIL, ADMIN_PW)
        r = requests.get(f"{API}/api-keys", headers={"Authorization": f"Bearer {token}"}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        wh_url = (data.get("webhook") or {}).get("url", "")
        print(f"Admin webhook.url = {wh_url}")
        assert wh_url, "webhook.url is empty"
        assert "emergent" not in wh_url.lower(), f"emergent leaked: {wh_url}"
        assert wh_url.startswith("https://biz-transppayy.com/api/v1/webhooks/"), \
            f"unexpected prefix: {wh_url}"

    def test_new_merchant_webhook_url_clean(self):
        email = f"TEST_iter16_{uuid.uuid4().hex[:8]}@test.com"
        token = _register(email, "Password123!")
        r = requests.get(f"{API}/api-keys", headers={"Authorization": f"Bearer {token}"}, timeout=30)
        assert r.status_code == 200, r.text
        wh_url = (r.json().get("webhook") or {}).get("url", "")
        print(f"New merchant webhook.url = {wh_url}")
        assert "emergent" not in wh_url.lower()
        assert wh_url.startswith("https://biz-transppayy.com/api/v1/webhooks/")

    def test_second_call_idempotent(self):
        """Calling GET /api/api-keys twice should not change the URL."""
        email = f"TEST_iter16_{uuid.uuid4().hex[:8]}@test.com"
        token = _register(email, "Password123!")
        headers = {"Authorization": f"Bearer {token}"}
        r1 = requests.get(f"{API}/api-keys", headers=headers, timeout=30).json()
        r2 = requests.get(f"{API}/api-keys", headers=headers, timeout=30).json()
        assert r1["webhook"]["url"] == r2["webhook"]["url"]
        assert "emergent" not in r1["webhook"]["url"].lower()


# ==================== PDF DOCUMENTATION ====================
class TestPdfDocumentation:
    @pytest.fixture(scope="class")
    def token(self):
        return _login(ADMIN_EMAIL, ADMIN_PW)

    def test_requires_auth(self):
        r = requests.get(f"{API}/api-keys/documentation.pdf", timeout=30)
        assert r.status_code in (401, 403), f"expected 401/403 got {r.status_code}"

    def test_download_pdf_headers(self, token):
        r = requests.get(f"{API}/api-keys/documentation.pdf",
                         headers={"Authorization": f"Bearer {token}"}, timeout=60)
        assert r.status_code == 200, r.text[:200]
        assert r.headers.get("content-type", "").startswith("application/pdf")
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd.lower()
        assert "biz-transpay-api-docs.pdf" in cd

    def test_pdf_magic_and_size(self, token):
        r = requests.get(f"{API}/api-keys/documentation.pdf",
                         headers={"Authorization": f"Bearer {token}"}, timeout=60)
        pdf = r.content
        assert pdf[:5] == b"%PDF-", f"bad magic: {pdf[:8]}"
        assert len(pdf) > 5000, f"pdf too small: {len(pdf)}"

    def test_pdf_content_sections(self, token):
        from pdfminer.high_level import extract_text
        r = requests.get(f"{API}/api-keys/documentation.pdf",
                         headers={"Authorization": f"Bearer {token}"}, timeout=60)
        text = extract_text(io.BytesIO(r.content))
        assert "biz-transppayy" in text.lower(), "domain not found"
        assert "emergent" not in text.lower(), "emergent leaked into PDF"
        required = [
            "Authentification", "Clés API", "Webhook", "HMAC",
            "Créer un paiement", "Codes de réponse HTTP",
            "Exemples d'intégration SDK", "Paiements Mobile Money",
            "Vérification et crédit automatiques",
            "mobile_money.payment.approved",
        ]
        for section in required:
            assert section in text, f"section missing: {section}\n---\n{text[:500]}"

        # Language snippets
        for lang in ["Node.js", "Python", "PHP", "Laravel", "JavaScript"]:
            assert lang in text, f"lang missing: {lang}"

        # Signature verification snippet
        assert "createHmac" in text or "hmac.new" in text, "signature verification snippet missing"
        assert "10 minutes" in text, "Mobile Money expiration rule missing"
        assert "exactement une fois" in text, "exactly-once credit rule missing"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
