import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from models import KycSubmit


BASE_SUBMISSION = {
    "full_name": "Test Merchant",
    "phone": "+22890000000",
    "document_type": "cni",
    "document_number": "TG123456",
    "activity_description": "Commerce en ligne",
    "activity_details": "Vente de vêtements en ligne aux particuliers.",
}


def test_kyc_requires_detailed_activity_description():
    with pytest.raises(ValidationError):
        KycSubmit(
            **{
                **BASE_SUBMISSION,
                "activity_details": "   ",
                "platform_status": "not_available",
            }
        )


def test_available_platform_requires_a_valid_url():
    with pytest.raises(ValidationError):
        KycSubmit(**{**BASE_SUBMISSION, "platform_status": "available"})

    with pytest.raises(ValidationError):
        KycSubmit(
            **{
                **BASE_SUBMISSION,
                "platform_status": "available",
                "platform_url": "javascript:alert(1)",
            }
        )


def test_not_available_platform_submits_a_request_without_url():
    submission = KycSubmit(
        **{**BASE_SUBMISSION, "platform_status": "not_available"}
    )

    assert submission.platform_url is None
    assert submission.activity_details == BASE_SUBMISSION["activity_details"]


def test_available_platform_keeps_validated_http_url():
    submission = KycSubmit(
        **{
            **BASE_SUBMISSION,
            "platform_status": "available",
            "platform_url": "https://shop.example",
        }
    )

    assert submission.model_dump(mode="json")["platform_url"] == "https://shop.example/"