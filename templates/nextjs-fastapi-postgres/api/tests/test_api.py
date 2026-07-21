def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_register_login_and_crud(client, auth_headers):
    # create
    r = client.post("/api/items", json={"title": "First", "description": "hi"}, headers=auth_headers)
    assert r.status_code == 201
    item = r.json()
    assert item["title"] == "First"

    # list
    r = client.get("/api/items", headers=auth_headers)
    assert r.status_code == 200
    assert len(r.json()) == 1

    # update
    r = client.patch(f"/api/items/{item['id']}", json={"title": "Renamed"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["title"] == "Renamed"

    # delete
    r = client.delete(f"/api/items/{item['id']}", headers=auth_headers)
    assert r.status_code == 204
    assert client.get("/api/items", headers=auth_headers).json() == []


def test_items_require_auth(client):
    assert client.get("/api/items").status_code == 401
