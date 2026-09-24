"""Small Resend API adapter. Credentials are supplied only at runtime."""

import httpx

RESEND_EMAILS_URL = "https://api.resend.com/emails"


async def send_resend_email(
    *,
    api_key: str,
    sender: str,
    recipient: str,
    subject: str,
    text: str,
    html: str,
    idempotency_key: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> None:
    if not api_key or not sender or not recipient:
        raise ValueError("Resend delivery is not configured")

    async with httpx.AsyncClient(timeout=8.0, transport=transport) as client:
        response = await client.post(
            RESEND_EMAILS_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Idempotency-Key": idempotency_key,
            },
            json={
                "from": sender,
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