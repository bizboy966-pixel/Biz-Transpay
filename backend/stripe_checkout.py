"""Small async Stripe checkout adapter used by the FastAPI app.

The imported project referenced an Emergent-only Stripe wrapper that is not
available in Replit's package registry. This module keeps the existing server
interface while using the public Stripe SDK already listed in requirements.txt.
"""

from dataclasses import dataclass, field
import asyncio
import os
from typing import Any, Optional

import stripe


@dataclass
class CheckoutSessionRequest:
    amount: float
    currency: str
    success_url: str
    cancel_url: str
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass
class CheckoutSessionResponse:
    session_id: str
    url: Optional[str]


@dataclass
class CheckoutStatus:
    payment_status: Optional[str]
    status: Optional[str]


@dataclass
class CheckoutWebhookEvent:
    session_id: str
    payment_status: Optional[str]


class StripeCheckout:
    def __init__(self, api_key: str, webhook_url: str = "") -> None:
        self.api_key = api_key
        self.webhook_url = webhook_url

    async def create_checkout_session(
        self, request: CheckoutSessionRequest
    ) -> CheckoutSessionResponse:
        stripe.api_key = self.api_key
        session = await asyncio.to_thread(
            stripe.checkout.Session.create,
            mode="payment",
            line_items=[
                {
                    "price_data": {
                        "currency": request.currency,
                        "product_data": {"name": "Biz-transPay deposit"},
                        "unit_amount": int(round(request.amount * 100)),
                    },
                    "quantity": 1,
                }
            ],
            success_url=request.success_url,
            cancel_url=request.cancel_url,
            metadata=request.metadata,
        )
        return CheckoutSessionResponse(
            session_id=session.id,
            url=getattr(session, "url", None),
        )

    async def get_checkout_status(self, session_id: str) -> CheckoutStatus:
        stripe.api_key = self.api_key
        session = await asyncio.to_thread(stripe.checkout.Session.retrieve, session_id)
        return CheckoutStatus(
            payment_status=getattr(session, "payment_status", None),
            status=getattr(session, "status", None),
        )

    async def handle_webhook(self, payload: bytes, signature: str) -> CheckoutWebhookEvent:
        webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
        if not webhook_secret:
            raise RuntimeError("STRIPE_WEBHOOK_SECRET not configured")
        event = await asyncio.to_thread(
            stripe.Webhook.construct_event,
            payload,
            signature,
            webhook_secret,
        )
        session = event.data.object
        return CheckoutWebhookEvent(
            session_id=session.id,
            payment_status=getattr(session, "payment_status", None),
        )