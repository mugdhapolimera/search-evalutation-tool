"""Solr parameters for a run: validation, canonical form, and the hash.

The stored config is exactly what is sent to the API. That rules out the MVP's
behaviour of logging a bad qf term and running the query without it, because
then the stored config no longer describes the run.
"""

import hashlib
import json
import re

# Parameters the tool sets itself, and parameters the RFC verified are harmful
# (Technical Design section 3).
REFUSED = {
    "q": "the query comes from the session",
    "rows": "set by ROWS_RETRIEVED",
    "start": "runs always start at rank 1",
    "fl": "the field list is fixed so every run is stored the same way",
    "sort": "a sorted run is not a relevance ranking",
    "defType": "replaces production's own query pipeline (0 of 10 results matched baseline)",
    "bf": "the additive boost function returns HTTP 500; use boost",
}

_QF_TERM = re.compile(
    r"^(?P<field>[A-Za-z_]+)(?:\^(?P<weight>[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?))?$"
)


class InvalidParams(ValueError):
    """A parameter the tool will not send. The message says which and why."""


def parse_qf(qf, allowed_fields):
    """Validate a qf string and return its canonical form.

    Terms are `field` or `field^weight` with a positive weight. Order does not
    matter to Solr, so the canonical form sorts terms by field; a field given
    twice is an error rather than a silent overwrite.
    """
    allowed = {f.lower() for f in allowed_fields}
    seen = {}
    for term in qf.split():
        m = _QF_TERM.match(term)
        if not m:
            raise InvalidParams(f"qf term {term!r} is not field or field^weight")
        field = m.group("field").lower()
        if field not in allowed:
            raise InvalidParams(f"qf field {field!r} is not in QF_FIELDS")
        weight = float(m.group("weight")) if m.group("weight") is not None else 1.0
        if weight <= 0:
            raise InvalidParams(f"qf weight for {field!r} must be positive, got {weight:g}")
        if field in seen:
            raise InvalidParams(f"qf field {field!r} appears twice")
        seen[field] = weight
    if not seen:
        raise InvalidParams("qf is empty")
    return " ".join(f"{field}^{weight:.10g}" for field, weight in sorted(seen.items()))


def normalize_params(raw, allowed_fields):
    """Turn form or API input into the dict of Solr params a run sends.

    Empty values are dropped, so "no qf" and "qf left blank" are the same
    config and hash the same way.
    """
    params = {}
    for key, value in (raw or {}).items():
        if value is None:
            continue
        value = str(value).strip()
        if not value:
            continue
        if key in REFUSED:
            raise InvalidParams(f"{key} is not allowed: {REFUSED[key]}")
        params[key] = value
    if "qf" in params:
        params["qf"] = parse_qf(params["qf"], allowed_fields)
    return params


def config_hash(params):
    """Stable across key order, so identical settings always share a hash."""
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def describe(params):
    """A one-line label for a config, for the results page."""
    if not params:
        return "default ranking"
    return " · ".join(f"{k}={v}" for k, v in sorted(params.items()))
