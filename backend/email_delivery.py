"""Small Resend API adapter. Credentials are supplied only at runtime."""

import os
from urllib.parse import urlsplit

import httpx

RESEND_EMAILS_URL = "https://api.resend.com/emails"
RESEND_CONNECTOR_NAME = "resend"


def _connector_request_config() -> tuple[str, str] | None:
    hostname = os.environ.get("REPLIT_CONNECTORS_HOSTNAME", "").strip()
    identity = os.environ.get("REPL_IDENTITY", "").strip()
    deployment_renewal = os.environ.get("WEB_REPL_RENEWAL", "").strip()
    if not hostname or not (identity or deployment_renewal):
        return None

    if "://" not in hostname:
        scheme = "http" if hostname.startswith("localhost") else "https"
        hostname = f"{scheme}://{hostname}"
    try:
        parsed = urlsplit(hostname)
        parsed.port
    except ValueError:
        return None
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc
            or parsed.username or parsed.password or not parsed.hostname
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        return None
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        return None

    token = f"repl {identity}" if identity else f"depl {deployment_renewal}"
    return f"{parsed.scheme}://{parsed.netloc}/api/v2/proxy/emails", token


def resend_is_configured() -> bool:
    return bool(os.environ.get("RESEND_API_KEY", "").strip()
                or _connector_request_config())


async def send_resend_email(
    *,
    api_key: str = "",
    sender: str,
    recipient: str,
    subject: str,
    text: str,
    html: str,
    idempotency_key: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> None:
    if not sender or not recipient:
        raise ValueError("Resend delivery is not configured")

    headers = {"Idempotency-Key": idempotency_key}
    connector_config = _connector_request_config()
    if connector_config:
        request_url, connector_token = connector_config
        headers.update({
            "X-Replit-Token": connector_token,
            "Connector-Name": RESEND_CONNECTOR_NAME,
        })
    elif api_key:
        request_url = RESEND_EMAILS_URL
        headers["Authorization"] = f"Bearer {api_key}"
    else:
        raise ValueError("Resend delivery is not configured")

    async with httpx.AsyncClient(
            timeout=8.0, trust_env=False, transport=transport) as client:
        response = await client.post(
            request_url,
            headers=headers,
            json={
                "from": f"Biz-transPay <{sender}>",
                "to": [recipient],
                "subject": subject,
                "text": text,
                "html": html,
            },
        )
    if response.is_error:
        # Do not log or propagate the response body: it can contain private
        # delivery metadata. The caller records only the failure status.
        raise RuntimeError(f"Resend rejected the message ({response.status_code})")