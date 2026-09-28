import asyncio
from pathlib import Path

import httpx
import pytest
from starlette.responses import FileResponse

import server


def test_frontend_fallback_serves_root_level_public_files(monkeypatch, tmp_path):
    build_dir = tmp_path / "build"
    build_dir.mkdir()
    logo_file = build_dir / "logo-mark.png"
    logo_file.write_bytes(b"png-data")
    (build_dir / "index.html").write_text("<html>app</html>", encoding="utf-8")
    monkeypatch.setattr(server, "FRONTEND_BUILD_DIR", build_dir)

    response = asyncio.run(server.frontend_fallback("logo-mark.png"))

    assert isinstance(response, FileResponse)
    assert Path(response.path) == logo_file
    assert response.media_type == "image/png"


def test_frontend_fallback_does_not_serve_files_outside_build(monkeypatch, tmp_path):
    build_dir = tmp_path / "build"
    build_dir.mkdir()
    index_file = build_dir / "index.html"
    index_file.write_text("<html>app</html>", encoding="utf-8")
    secret_file = tmp_path / "private.txt"
    secret_file.write_text("not public", encoding="utf-8")
    monkeypatch.setattr(server, "FRONTEND_BUILD_DIR", build_dir)

    response = asyncio.run(server.frontend_fallback("../private.txt"))

    assert isinstance(response, FileResponse)
    assert Path(response.path) == index_file


def test_frontend_fallback_keeps_api_paths_out_of_spa(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "FRONTEND_BUILD_DIR", tmp_path)

    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.frontend_fallback("api/users"))

    assert error.value.status_code == 404


def test_frontend_fallback_supports_head_requests():
    route = next(
        route
        for route in server.app.routes
        if getattr(route, "name", None) == "frontend_fallback"
    )

    assert {"GET", "HEAD"}.issubset(route.methods)


def test_frontend_public_asset_is_served_as_image_for_get_and_head(
    monkeypatch, tmp_path
):
    build_dir = tmp_path / "build"
    build_dir.mkdir()
    (build_dir / "index.html").write_text("<html>app</html>", encoding="utf-8")
    (build_dir / "social-preview.jpg").write_bytes(b"jpeg-data")
    monkeypatch.setattr(server, "FRONTEND_BUILD_DIR", build_dir)

    async def request_asset(method):
        transport = httpx.ASGITransport(app=server.app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            return await client.request(method, "/social-preview.jpg")

    get_response = asyncio.run(request_asset("GET"))
    head_response = asyncio.run(request_asset("HEAD"))

    assert get_response.status_code == 200
    assert get_response.headers["content-type"] == "image/jpeg"
    assert get_response.content == b"jpeg-data"
    assert head_response.status_code == 200
    assert head_response.headers["content-type"] == "image/jpeg"
    assert head_response.content == b""