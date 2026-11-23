"""The ADS adapter against a response recorded from the production API.

Recorded 23 Nov 2026 for q="triton atmosphere", rows=5. Abstracts are cut to
120 characters and author lists to four, which the parser doesn't depend on.
"""

import json
from pathlib import Path

import pytest
import requests

from search_eval.adapters import ADS_FIELDS, AdapterError, ADSApiAdapter, parse_ads_response

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "ads_triton_atmosphere.json").read_text()
)


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


class FakeHttp:
    def __init__(self, response=None, raises=None):
        self.response = response
        self.raises = raises
        self.calls = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append({"url": url, "params": params, "headers": headers})
        if self.raises:
            raise self.raises
        return self.response


def test_parses_the_recorded_response():
    result = parse_ads_response(FIXTURE)
    assert len(result.records) == 5
    assert result.num_found == FIXTURE["response"]["numFound"]
    assert all(r.bibcode and r.title for r in result.records)


def test_every_identifier_travels_with_the_record():
    """A preprint merged into its publisher record carries both bibcodes and
    both DOIs, so a judgement still matches after the merge."""
    by_bibcode = {r.bibcode: r for r in parse_ads_response(FIXTURE).records}
    merged = by_bibcode["2024A&A...682L..24S"]
    assert "2024arXiv240202476S" in merged.identifiers
    assert "10.1051/0004-6361/202348756" in merged.identifiers
    assert "10.48550/arXiv.2402.02476" in merged.identifiers
    assert merged.identifiers[0] == merged.bibcode
    assert len(merged.identifiers) == len(set(merged.identifiers))


def test_entry_date_is_read_from_the_field_the_api_returns():
    """`entdate` is search-only and never comes back in fl; `entry_date` does."""
    assert "entry_date" in ADS_FIELDS and "entdate" not in ADS_FIELDS
    assert all(r.entry_date for r in parse_ads_response(FIXTURE).records)


def test_missing_fields_come_back_empty_not_as_placeholders():
    by_bibcode = {r.bibcode: r for r in parse_ads_response(FIXTURE).records}
    assert by_bibcode["1990Natur.344..315I"].abstract == ""


def test_request_carries_query_rows_fields_and_params():
    http = FakeHttp(FakeResponse(200, FIXTURE))
    adapter = ADSApiAdapter("prod", "https://api.example/v1/", "tok", http=http)
    adapter.search("triton atmosphere", 5, {"qf": "title^2"})
    call = http.calls[0]
    assert call["url"] == "https://api.example/v1/search/query"
    assert call["params"]["q"] == "triton atmosphere"
    assert call["params"]["rows"] == 5
    assert call["params"]["qf"] == "title^2"
    assert call["params"]["fl"] == ",".join(ADS_FIELDS)
    assert "defType" not in call["params"]
    assert call["headers"]["Authorization"] == "Bearer tok"


def test_a_rejected_token_says_so():
    """What devapi actually answered with the production token."""
    body = {
        "message": "The access token provided is expired, revoked, malformed, "
        "or invalid for other reasons."
    }
    adapter = ADSApiAdapter(
        "dev", "https://devapi.example/v1", "tok", http=FakeHttp(FakeResponse(401, body))
    )
    with pytest.raises(AdapterError, match="HTTP 401.*access token provided is expired"):
        adapter.search("q", 5, {})


def test_no_token_fails_before_any_request():
    http = FakeHttp(FakeResponse(200, FIXTURE))
    with pytest.raises(AdapterError, match="No API token is configured for 'dev'"):
        ADSApiAdapter("dev", "https://devapi.example/v1", "", http=http).search("q", 5, {})
    assert http.calls == []


def test_network_failure_is_an_adapter_error():
    http = FakeHttp(raises=requests.ConnectionError("connection refused"))
    with pytest.raises(AdapterError, match="could not reach"):
        ADSApiAdapter("prod", "https://api.example/v1", "tok", http=http).search("q", 5, {})
