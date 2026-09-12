"""Small compatibility layer for the imported Stripe checkout API.

The source project was exported with an internal ``emergentintegrations``
package that is not published in Replit's package registry.  Keep the
application-facing interface unchanged while delegating to the public Stripe
SDK already listed in requirements.txt.
"""

import json
import os
from dataclasses import dataclass
from typing import Any, Dict

import stripe


@dataclass
class CheckoutSessionRequest:
    amount: float
    currency: str
    success_url: str
    cancel_url: str
    metadata: Dict[str, str]


@dataclass
class CheckoutSessionResponse:
    session_id: str
    url: str


@dataclass
class CheckoutStatus:
    session_id: str
    status: str
    payment_status: str


@dataclass
class CheckoutEvent:
    session_id: str
    payment_status: str


class StripeCheckout:
    def __init__(self, api_key: str, webhook_url: str) -> None:
        self.api_key = api_key
        self.webhook_url = webhook_url

    async def create_checkout_session(
        self, request: CheckoutSessionRequest
    ) -> CheckoutSessionResponse:
        stripe.api_key = self.api_key
        session = await stripe.checkout.Session.create_async(
            mode="payment",
            line_items=[
                {
                    "price_data": {
                        "currency": request.currency,
                        "product_data": {"name": "Biz-transPay deposit"},
                        "unit_amount": round(request.amount * 100),
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
            url=session.url,
        )

    async def get_checkout_status(self, session_id: str) -> CheckoutStatus:
        stripe.api_key = self.api_key
        session = await stripe.checkout.Session.retrieve_async(session_id)
        return CheckoutStatus(
            session_id=session.id,
            status=session.status or "",
            payment_status=session.payment_status or "",
        )

    async def handle_webhook(self, body: bytes, signature: str) -> CheckoutEvent:
        webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
        if webhook_secret:
            event: Any = stripe.Webhook.construct_event(
                body, signature, webhook_secret
            )
        else:
            event = stripe.Event.construct_from(
                json.loads(body.decode("utf-8")), self.api_key
            )

        session = event.data.object
        return CheckoutEvent(
            session_id=session.id,
            payment_status=session.payment_status or "",
        )