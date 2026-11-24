"""What the API returns: stored rows turned into what the screens show.

Every number here comes from stored runs, judgements and metrics. Nothing is
recomputed in the browser, which is how the MVP came to drop unrated ranks
before discounting.
"""

import nh3

from .boost import parse_qf
from .rubric import rubric_for
from .scoring.metrics import metric_name
from .service import RATING_VALUES, canonical_map, latest_metrics, ok_runs, rating_pool

# ADS titles and abstracts carry a little HTML (sub/superscripts, italics, line
# breaks). Keep that, drop everything else, so the page renders N<sub>2</sub>
# instead of printing the tags.
ALLOWED_TAGS = {"sub", "sup", "i", "b", "em", "strong", "br"}

# A difference smaller than this is reported as no change (open question D7,
# the tie band).
TIE_BAND = 0.01

# How many authors a result shows before "and N more", as on SciX.
AUTHORS_SHOWN = 4


def clean_html(text):
    if not text:
        return text
    return nh3.clean(text, tags=ALLOWED_TAGS, attributes={})


def _weights(qf, config):
    """{field: weight} for a canonical or raw qf string."""
    canonical = parse_qf(qf, config["QF_FIELDS"])
    return {f: float(w) for f, w in (term.split("^") for term in canonical.split())}


def production_weights(config):
    return _weights(config["PRODUCTION_DEFAULT_QF"], config)


def describe_change(run, baseline_env, config):
    """What a run changes relative to production's default ranking, as short
    phrases, plus warnings about what the change really does."""
    params = run.boost_config.params
    changes, warnings = [], []
    if run.environment != baseline_env:
        changes.append(config["ENVIRONMENTS"][run.environment]["label"])
    if "qf" in params:
        prod = production_weights(config)
        new = _weights(params["qf"], config)
        for field in sorted(set(prod) | set(new)):
            if field not in new:
                changes.append(f"no {field}")
            elif field not in prod:
                changes.append(f"+{field} {new[field]:g}")
            elif new[field] != prod[field]:
                changes.append(f"{field} {prod[field]:g} → {new[field]:g}")
        missing = [f for f in prod if f not in new]
        if missing:
            warnings.append(
                f"Searches {len(prod) - len(missing)} of production's {len(prod)} fields: "
                f"{', '.join(missing)} not searched."
            )
        if not changes:
            changes.append("production's field weights")
    if "boost" in params:
        changes.append(f"boost {params['boost']}")
        warnings.append("Applied twice and on top of cite_read_boost, so it acts like its square.")
    return changes, warnings


def _grade_of(session, canonical_of):
    """{canonical bibcode: 0-3, or "skip"}. Unrated records are absent."""
    return {
        canonical_of.get(j.bibcode, j.bibcode): ("skip" if j.rating is None else j.rating)
        for j in session.judgements
    }


def _authors(authors):
    authors = authors or []
    return {"shown": authors[:AUTHORS_SHOWN], "total": len(authors)}


def _metric_names(config):
    k, gain = config["SCORE_K"], config["NDCG_GAIN"]
    return {
        "ndcg": metric_name("ndcg", k=k, gain=gain),
        "judged": metric_name("judged", k=k),
        "precision": metric_name("p", k=k, rel=2),
        "success": metric_name("success", k=k, rel=2),
        "overlap": metric_name("overlap", k=k),
        "rbo": metric_name("rbo_ext", k=k, p=0.9),
    }


HEADLINE = {
    "topical": ("ndcg", "NDCG@{k}"),
    "author": ("precision", "Precision@{k}"),
    "known_item": ("success", "Found in top {k}"),
}


def session_summary(session):
    return {
        "id": session.id,
        "query": session.query,
        "intent": session.intent,
        "created_at": session.created_at.isoformat() if session.created_at else None,
        "tweaks": max(len(session.runs) - 1, 0),
        "rated": sum(1 for j in session.judgements if j.rating is not None),
    }


def session_payload(session, config):
    """The workspace: session details, and every run as a comparable column."""
    k = config["SCORE_K"]
    names = _metric_names(config)
    runs = ok_runs(session)
    canonical_of = canonical_map(runs)
    grades = _grade_of(session, canonical_of)
    baseline = session.runs[0] if session.runs else None
    baseline_ok = baseline is not None and baseline.status == "ok"
    baseline_top = [canonical_of[r.bibcode] for r in baseline.results[:k]] if baseline_ok else []
    baseline_rank = {b: i + 1 for i, b in enumerate(baseline_top)}
    headline_key, headline_label = HEADLINE[session.intent]
    baseline_value = None
    if baseline_ok:
        baseline_values, baseline_params = latest_metrics(baseline)
        if baseline_params.get("pool_size"):
            baseline_value = baseline_values.get(names[headline_key])
    pool = rating_pool(session, config["RATE_DEPTH"])
    pool_keys = {canonical_of.get(r.bibcode, r.bibcode) for r in pool}

    columns = []
    for index, run in enumerate(session.runs):
        is_baseline = index == 0
        values, params = latest_metrics(run)
        changes, warnings = (
            ([], [])
            if is_baseline
            else describe_change(run, config["BASELINE_ENVIRONMENT"], config)
        )
        results, top = [], []
        for result in run.results:
            key = canonical_of.get(result.bibcode, result.bibcode)
            if result.rank <= k:
                top.append(key)
            was = baseline_rank.get(key)
            results.append(
                {
                    "rank": result.rank,
                    "bibcode": result.bibcode,
                    "title": clean_html(result.title),
                    "authors": _authors(result.authors),
                    "year": result.year,
                    "pub": result.pub,
                    "grade": grades.get(key),
                    "move": (
                        None
                        if is_baseline or result.rank > k
                        else ("new" if was is None else was - result.rank)
                    ),
                }
            )
        dropped = []
        if not is_baseline and run.status == "ok":
            for key in baseline_top:
                if key not in top:
                    record = next(r for r in baseline.results if canonical_of[r.bibcode] == key)
                    dropped.append(
                        {
                            "bibcode": record.bibcode,
                            "title": clean_html(record.title),
                            "was": baseline_rank[key],
                            "grade": grades.get(key),
                        }
                    )
        value = values.get(names[headline_key])
        if not params.get("pool_size"):
            # Nothing rated yet: every metric is 0 against an empty pool, which
            # would read as "no change". Show nothing instead.
            value = None
        delta = None
        if not is_baseline and value is not None and baseline_value is not None:
            delta = value - baseline_value
        relevant = sum(1 for b in top if isinstance(grades.get(b), int) and grades[b] >= 2)
        baseline_relevant = sum(
            1 for b in baseline_top if isinstance(grades.get(b), int) and grades[b] >= 2
        )
        overlap = values.get(names["overlap"])
        same = None if is_baseline else sum(1 for b in top if b in baseline_rank)
        columns.append(
            {
                "id": run.id,
                "is_baseline": is_baseline,
                "environment": run.environment,
                "environment_label": config["ENVIRONMENTS"][run.environment]["label"],
                "params": run.boost_config.params,
                "changes": changes,
                "warnings": warnings,
                "status": run.status,
                "error": run.error,
                "num_found": run.num_found,
                "results": results,
                "dropped": dropped,
                "metrics": (
                    None
                    if run.status != "ok" or not params
                    else {
                        "headline_label": headline_label.format(k=k),
                        "headline": value,
                        "delta": delta,
                        "verdict": _verdict(delta),
                        "relevant_in_top_k": relevant,
                        "relevant_change": None if is_baseline else relevant - baseline_relevant,
                        "rated_in_top_k": params.get("judged_in_top_k"),
                        "provisional": bool(params.get("incomplete")),
                        "range": [params.get("ndcg_lo"), params.get("ndcg_hi")],
                        "same_as_baseline": same,
                        "details": {
                            "ndcg": values.get(names["ndcg"]),
                            "precision": values.get(names["precision"]),
                            "success": values.get(names["success"]),
                            "rbo": values.get(names["rbo"]),
                            "overlap": overlap,
                            "gain": params.get("gain"),
                            "pool_size": params.get("pool_size"),
                        },
                    }
                ),
            }
        )

    rated = sum(1 for j in session.judgements if j.rating is not None)
    skipped = sum(1 for j in session.judgements if j.rating is None)
    return {
        "id": session.id,
        "query": session.query,
        "information_need": session.information_need,
        "goal": session.goal,
        "discipline": session.discipline,
        "intent": session.intent,
        "rating_mode": session.rating_mode,
        "rubric_version": session.rubric_version,
        "k": k,
        "counts": {
            "pool": len(pool_keys),
            "rated": rated,
            "skipped": skipped,
            "unrated": len(pool_keys - set(grades)),
        },
        "columns": columns,
    }


def _verdict(delta):
    if delta is None:
        return None
    if delta >= TIE_BAND:
        return "better"
    if delta <= -TIE_BAND:
        return "worse"
    return "same"


def pool_payload(session, config):
    """The blind rating list: no ranks, no environments, no column."""
    runs = ok_runs(session)
    canonical_of = canonical_map(runs)
    judgements = {canonical_of.get(j.bibcode, j.bibcode): j for j in session.judgements}
    # A stored 3 is shown back as "up" in binary mode and as "3" in graded mode.
    values = {stored: raw for raw, stored in RATING_VALUES[session.rating_mode].items()}
    records = []
    for result in rating_pool(session, config["RATE_DEPTH"]):
        judgement = judgements.get(canonical_of.get(result.bibcode, result.bibcode))
        records.append(
            {
                "bibcode": result.bibcode,
                "title": clean_html(result.title),
                "authors": _authors(result.authors),
                "year": result.year,
                "pub": result.pub,
                "doctype": result.doctype,
                "abstract": clean_html(result.abstract),
                "rating": None if judgement is None else values[judgement.rating],
                "note": None if judgement is None else judgement.note,
            }
        )
    return {
        "information_need": session.information_need,
        "rating_mode": session.rating_mode,
        "options": rubric_for(session.rubric_version, session.rating_mode),
        "records": records,
    }


def ideal_payload(session):
    """Rated records grouped by grade, in the rater's order, plus skips."""
    titles = {r.bibcode: r for run in session.runs for r in run.results}
    labels = {o["value"]: o["label"] for o in rubric_for(session.rubric_version, "graded")}
    if session.rating_mode == "binary":
        labels = {"3": "Right person", "0": "Wrong person"}
    buckets = {}
    for row in session.ideal_ranking:
        bucket = buckets.setdefault(
            row.tie_group,
            {
                "grade": row.tie_group,
                "label": labels.get(str(row.tie_group), ""),
                "ordered": row.ordered,
                "records": [],
            },
        )
        record = titles.get(row.bibcode)
        bucket["records"].append(
            {
                "bibcode": row.bibcode,
                "title": clean_html(record.title) if record else row.bibcode,
                "year": record.year if record else None,
                "pub": record.pub if record else None,
            }
        )
    skipped = [
        {"bibcode": j.bibcode, "title": clean_html(titles[j.bibcode].title), "note": j.note}
        for j in session.judgements
        if j.rating is None and j.bibcode in titles
    ]
    return {
        "buckets": [buckets[g] for g in sorted(buckets, reverse=True)],
        "skipped": skipped,
    }


def config_payload(config):
    rubric_version = config["RUBRIC_VERSION"]
    return {
        "environments": [
            {"name": name, "label": env["label"]} for name, env in config["ENVIRONMENTS"].items()
        ],
        "baseline_environment": config["BASELINE_ENVIRONMENT"],
        "default_variant_environment": config["DEFAULT_VARIANT_ENVIRONMENT"],
        "disciplines": [{"value": v, "label": label} for v, label in config["DISCIPLINES"]],
        "intents": [
            {"value": "topical", "label": "Topic"},
            {"value": "author", "label": "Author"},
            {"value": "known_item", "label": "Known paper"},
        ],
        "production_weights": [
            {"field": f, "weight": w} for f, w in sorted(production_weights(config).items())
        ],
        "qf_fields": sorted(config["QF_FIELDS"]),
        "score_k": config["SCORE_K"],
        "rubric": {
            "graded": rubric_for(rubric_version, "graded"),
            "binary": rubric_for(rubric_version, "binary"),
        },
    }
