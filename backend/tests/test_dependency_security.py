"""Compatibility checks for security-updated Python dependencies (no live providers)."""

import asyncio
from http.cookies import SimpleCookie
from importlib.metadata import version
from io import BytesIO
from pathlib import Path
import ssl

import aiohttp
import black
import certifi
from filelock import FileLock, Timeout
from packaging.version import Version
from PIL import Image
import pytest
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas


@pytest.mark.parametrize("package,minimum", [
    ("aiohttp", "3.14.4"),
    ("black", "26.10.1"),
    ("certifi", "2026.10.19"),
    ("filelock", "4.2.1"),
    ("pillow", "13.0.0"),
])
def test_installed_and_declared_python_dependencies_are_patched(package, minimum):
    assert Version(version(package)) >= Version(minimum)
    requirements = Path(__file__).resolve().parents[1] / "requirements.txt"
    pins = dict(line.split("==", 1) for line in requirements.read_text().splitlines()
                if "==" in line)
    assert Version(pins[package]) >= Version(minimum)


@pytest.mark.parametrize("image_format", ["PNG", "JPEG", "WEBP"])
def test_pillow_images_remain_compatible_with_pdf_generation(image_format):
    encoded = BytesIO()
    Image.new("RGB", (32, 32), "blue").save(encoded, image_format)
    encoded.seek(0)
    with Image.open(encoded) as image:
        image.load()
        assert image.size == (32, 32)
    encoded.seek(0)
    pdf = BytesIO()
    canvas = Canvas(pdf)
    canvas.drawImage(ImageReader(encoded), 0, 0, width=32, height=32)
    canvas.save()
    assert pdf.getvalue().startswith(b"%PDF")


def test_filelock_excludes_competing_locks_and_releases(tmp_path):
    filename = tmp_path / "resource.lock"
    with FileLock(filename):
        with pytest.raises(Timeout):
            FileLock(filename).acquire(timeout=0)
    with FileLock(filename, timeout=0):
        pass


def test_certifi_bundle_loads_with_certificate_verification_enabled():
    context = ssl.create_default_context(cafile=certifi.where())
    assert context.check_hostname
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.cert_store_stats()["x509_ca"] > 0


def test_aiohttp_does_not_send_shared_secure_cookies_over_http():
    async def check():
        jar = aiohttp.CookieJar()
        jar.update_cookies(SimpleCookie("session=test; Secure"))
        assert "session" not in jar.filter_cookies("http://example.invalid/")
        assert "session" in jar.filter_cookies("https://example.invalid/")
        async with aiohttp.ClientSession(cookie_jar=jar) as client:
            assert not client.closed
    asyncio.run(check())


def test_black_still_formats_python():
    assert black.format_str("amount=100\n", mode=black.Mode()) == "amount = 100\n"
