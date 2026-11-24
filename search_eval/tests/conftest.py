"""Test wiring.

Runs against Postgres when TEST_DATABASE_URI is set (as in CI), otherwise
against a throwaway SQLite file, so the suite runs anywhere. Adapters are
replaced with fakes, so no test touches the network.
"""

import os

import pytest

from search_eval.adapters import AdapterError, Record, SearchResult
from search_eval.app import create_app
from search_eval.models import Base


class FakeAdapter:
    """Returns a fixed ranking per configuration, keyed by the qf/boost passed."""

    def __init__(self, name, rankings, base_url="https://fake.example/v1", fail_with=None):
        self.name = name
        self.base_url = base_url
        self.rankings = rankings
        self.fail_with = fail_with
        self.calls = []

    def search(self, query, rows, params):
        self.calls.append((query, rows, dict(params)))
        if self.fail_with:
            raise AdapterError(self.fail_with)
        key = params.get("qf") or params.get("boost") or "default"
        return SearchResult(records=[_record(r) for r in self.rankings[key][:rows]], num_found=999)


def _record(spec):
    if isinstance(spec, str):
        spec = {"bibcode": spec}
    bibcode = spec["bibcode"]
    return Record(
        bibcode=bibcode,
        identifiers=spec.get("identifiers", [bibcode]),
        title=spec.get("title", f"Title of {bibcode}"),
        authors=spec.get("authors", ["Author, A."]),
        year="2024",
        pub="Test Journal",
        abstract=f"Abstract of {bibcode}.",
        entry_date="2024-01-01T00:00:00Z",
    )


# Baseline and variant share A, C and D; the variant drops B and E and brings in
# F and G. "default" is the environment's own ranking.
RANKINGS = {
    "default": ["A", "B", "C", "D", "E"],
    "title^2": ["C", "A", "F", "D", "G"],
    "abstract^3": ["H", "C", "A", "D", "B"],
}


@pytest.fixture
def adapters():
    # Each adapter gets its own copy, so a test that changes one ranking never
    # leaks into the next test.
    return {
        "prod": FakeAdapter("prod", dict(RANKINGS)),
        "dev": FakeAdapter("dev", dict(RANKINGS)),
    }


@pytest.fixture
def app(tmp_path, adapters):
    uri = os.environ.get("TEST_DATABASE_URI") or f"sqlite:///{tmp_path / 'test.db'}"
    app = create_app(
        adapters=adapters,
        SQLALCHEMY_DATABASE_URI=uri,
        ROWS_RETRIEVED=5,
        SCORE_K=5,
        RATE_DEPTH=5,
        ENV="testing",
        LOG_STDOUT=False,
    )
    app.config["TESTING"] = True
    with app.app_context():
        Base.metadata.drop_all(app.db.engine)
        Base.metadata.create_all(app.db.engine)
    yield app
    with app.app_context():
        app.db.session.remove()
        Base.metadata.drop_all(app.db.engine)


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def api(client):
    """JSON helpers: api.post(path, body) and so on, returning (status, json)."""

    class Api:
        def _call(self, method, path, body=None):
            resp = getattr(client, method)(f"/api{path}", json=body)
            return resp.status_code, resp.get_json()

        def get(self, path):
            return self._call("get", path)

        def post(self, path, body=None):
            return self._call("post", path, body or {})

        def put(self, path, body=None):
            return self._call("put", path, body or {})

        def patch(self, path, body=None):
            return self._call("patch", path, body or {})

    return Api()


@pytest.fixture
def search(api):
    """Search like a person does: only the query, plus anything overridden."""

    def start(**overrides):
        body = {"query": "triton atmosphere", **overrides}
        return api.post("/sessions", body)

    return start
