import re

import pytest

from search_eval.boost import InvalidParams, config_hash, normalize_params, parse_qf

FIELDS = ["title", "abstract", "author", "keyword"]


def test_qf_is_sorted_and_weights_normalised():
    assert parse_qf("TITLE^2.0 abstract", FIELDS) == "abstract^1 title^2"
    assert parse_qf("abstract^1 title^2", FIELDS) == "abstract^1 title^2"


def test_term_order_does_not_change_the_hash():
    a = normalize_params({"qf": "title^2 abstract^1"}, FIELDS)
    b = normalize_params({"qf": "abstract^1 title^2"}, FIELDS)
    assert config_hash(a) == config_hash(b)


def test_different_settings_hash_differently():
    a = normalize_params({"qf": "title^2"}, FIELDS)
    b = normalize_params({"qf": "title^3"}, FIELDS)
    assert config_hash(a) != config_hash(b)


def test_blank_values_are_the_default_config():
    assert normalize_params({"qf": "", "boost": "  "}, FIELDS) == {}
    assert config_hash({}) == config_hash(normalize_params({"qf": None}, FIELDS))


@pytest.mark.parametrize(
    "qf, message",
    [
        ("body^2", "not in QF_FIELDS"),
        ("title^0", "must be positive"),
        ("title^two", "is not field or field^weight"),
        ("title^2 title^3", "appears twice"),
    ],
)
def test_bad_qf_is_rejected_not_dropped(qf, message):
    """The MVP logged a bad term and ran the query without it, so the stored
    config stopped describing the run. Here the run never happens."""
    with pytest.raises(InvalidParams, match=re.escape(message)):
        normalize_params({"qf": qf}, FIELDS)


@pytest.mark.parametrize("param", ["defType", "bf", "sort", "q", "rows", "fl", "start"])
def test_refused_params(param):
    with pytest.raises(InvalidParams, match=f"{param} is not allowed"):
        normalize_params({param: "anything"}, FIELDS)


def test_boost_is_passed_through_unchanged():
    params = normalize_params({"boost": " pow(citation_count,0.1) "}, FIELDS)
    assert params == {"boost": "pow(citation_count,0.1)"}


def test_production_default_qf_is_expressible():
    """The MVP's field list lacked ack, bibstem, first_author and identifier, so
    production's own query could not be passed as a starting point."""
    import config

    canonical = parse_qf(config.PRODUCTION_DEFAULT_QF, config.QF_FIELDS)
    assert canonical == config.PRODUCTION_DEFAULT_QF, "already in canonical (sorted) form"
