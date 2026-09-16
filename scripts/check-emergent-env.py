"""Validate required deployment configuration without printing secret values."""
import os
import sys
from urllib.parse import urlparse


REQUIRED = (
    "MONGO_URL",
    "DB_NAME",
    "SESSION_SECRET",
    "JWT_SECRET",
    "SECRETS_ENCRYPTION_KEY",
    "OFFICIAL_DOMAIN",
    "CORS_ORIGINS",
    "CSRF_TRUSTED_ORIGINS",
    "CLOUDFLARE_TURNSTILE_SECRET_KEY",
    "CLOUDFLARE_TURNSTILE_SITE_KEY",
    "CLOUDFLARE_TURNSTILE_ALLOWED_HOSTNAMES",
)

PROVIDER_GROUPS = {
    "PayDunya": (
        "PAYDUNYA_MASTER_KEY",
        "PAYDUNYA_PRIVATE_KEY",
        "PAYDUNYA_PUBLIC_KEY",
        "PAYDUNYA_TOKEN",
    ),
    "FedaPay": (
        "FEDAPAY_SECRET_KEY",
        "FEDAPAY_PUBLIC_KEY",
        "FEDAPAY_WEBHOOK_SECRET",
    ),
    "IzichangePay": (
        "IZIPAY_API_KEY",
        "IZIPAY_WEBHOOK_SECRET",
    ),
    "Mbiyo": (
        "MBIYO_API_KEY",
        "MBIYO_PUBLIC_KEY",
        "MBIYO_SECRET_KEY",
        "MBIYO_WEBHOOK_SECRET",
    ),
    "Telegram": (
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_CHAT_ID",
    ),
}


def configured(name: str) -> bool:
    return bool(os.environ.get(name, "").strip())


def main() -> int:
    missing = [name for name in REQUIRED if not configured(name)]
    jwt = os.environ.get("JWT_SECRET", "")
    session = os.environ.get("SESSION_SECRET", "")
    domain = os.environ.get("OFFICIAL_DOMAIN", "")
    errors = []

    if missing:
        errors.append("Required variables missing: " + ", ".join(missing))
    if jwt and session and jwt == session:
        errors.append("JWT_SECRET and SESSION_SECRET must be different in production.")
    if domain:
        parsed = urlparse(domain)
        if parsed.scheme != "https" or not parsed.netloc:
            errors.append("OFFICIAL_DOMAIN must be an absolute HTTPS URL.")
    if configured("REACT_APP_BACKEND_URL"):
        backend_url = os.environ["REACT_APP_BACKEND_URL"].strip()
        if backend_url and not backend_url.startswith("https://"):
            errors.append("REACT_APP_BACKEND_URL must be empty or use HTTPS.")

    for label, names in PROVIDER_GROUPS.items():
        present = [name for name in names if configured(name)]
        if present and len(present) != len(names):
            absent = [name for name in names if name not in present]
            errors.append(f"{label} is only partially configured; missing: {', '.join(absent)}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    enabled = [
        label for label, names in PROVIDER_GROUPS.items()
        if all(configured(name) for name in names)
    ]
    print("Emergent production environment is structurally valid.")
    print("Fully configured optional integrations: " + (", ".join(enabled) or "none"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())