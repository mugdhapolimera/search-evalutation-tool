"""One adapter per environment, all behind the same interface (RFC Objective 2).

Adding an environment, or later an external engine, is a new adapter and a
config entry. Nothing else in the service knows which API it is talking to.
"""

from dataclasses import dataclass, field

import requests

# Fixed so every run is stored the same way. Citation counts are deliberately
# absent: they steer a rater's attention, so they stay hidden while rating.
ADS_FIELDS = [
    "bibcode",
    "alternate_bibcode",
    "identifier",
    "doi",
    "title",
    "author",
    "year",
    "pub",
    "abstract",
    "entry_date",
    "doctype",
]


class AdapterError(RuntimeError):
    """A retrieval failed. The message is shown to the person running it."""


@dataclass
class Record:
    bibcode: str
    identifiers: list = field(default_factory=list)
    title: str = ""
    authors: list = field(default_factory=list)
    year: str = ""
    pub: str = ""
    abstract: str = ""
    entry_date: str = ""
    doctype: str = ""


@dataclass
class SearchResult:
    records: list
    num_found: int = 0
    qtime_ms: int = None
    release: str = None


class ADSApiAdapter:
    """The SciX/ADS search API: /v1/search/query on one environment's stack."""

    def __init__(self, name, base_url, token, http=None, timeout=30):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.http = http or requests.Session()
        self.timeout = timeout

    def search(self, query, rows, params):
        if not self.token:
            raise AdapterError(
                f"No API token is configured for {self.name!r}. "
                f"Set its token in the environment (see ENVIRONMENTS in config.py)."
            )
        request_params = {"q": query, "rows": rows, "fl": ",".join(ADS_FIELDS), **params}
        try:
            resp = self.http.get(
                f"{self.base_url}/search/query",
                params=request_params,
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise AdapterError(f"{self.name}: could not reach {self.base_url} ({exc})") from exc

        if resp.status_code != 200:
            raise AdapterError(f"{self.name}: HTTP {resp.status_code} — {_error_message(resp)}")
        return parse_ads_response(resp.json())


def parse_ads_response(body):
    header = body.get("responseHeader", {})
    response = body.get("response", {})
    records = [_record(doc) for doc in response.get("docs", [])]
    return SearchResult(
        records=records,
        num_found=response.get("numFound", 0),
        qtime_ms=header.get("QTime"),
    )


def _record(doc):
    bibcode = doc["bibcode"]
    identifiers = []
    for value in [
        bibcode,
        *_as_list(doc.get("alternate_bibcode")),
        *_as_list(doc.get("doi")),
        *_as_list(doc.get("identifier")),
    ]:
        if value and value not in identifiers:
            identifiers.append(value)
    title = _as_list(doc.get("title"))
    return Record(
        bibcode=bibcode,
        identifiers=identifiers,
        title=title[0] if title else "",
        authors=_as_list(doc.get("author")),
        year=str(doc.get("year", "") or ""),
        pub=doc.get("pub", "") or "",
        abstract=doc.get("abstract", "") or "",
        entry_date=doc.get("entry_date", "") or "",
        doctype=doc.get("doctype", "") or "",
    )


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _error_message(resp):
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:200] or "no response body"
    if isinstance(body, dict):
        return str(body.get("message") or body.get("error") or body)[:200]
    return str(body)[:200]


def adapters_from_config(config, http=None):
    """Build every configured environment's adapter."""
    adapters = {}
    for name, env in config["ENVIRONMENTS"].items():
        adapters[name] = ADSApiAdapter(
            name=name,
            base_url=env["base_url"],
            token=config.get(env["token_key"], ""),
            http=http,
            timeout=config.get("ADS_REQUEST_TIMEOUT", 30),
        )
    return adapters
