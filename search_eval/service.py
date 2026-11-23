"""The experiment loop: retrieve, rate, score, change a parameter, score again.

A session starts with two runs: the baseline (always the first run) and a
variant. Each later run is another variant scored against the same judged
pool, so the person tuning sees the effect of a qf or boost change at once,
and is asked to rate only the records that change brought in.
"""

import random

from sqlalchemy import select

from .adapters import AdapterError
from .boost import config_hash, normalize_params
from .models import (
    BoostConfig,
    IdealRanking,
    Judgement,
    Metric,
    RatingSession,
    Run,
    RunResult,
    rating_mode_for,
)
from .scoring.metrics import score_run

# What a rating form value means, per rating mode. A skip is unjudged (None),
# never 0. Thumbs are stored as 3 and 0 so both modes share one integer column.
RATING_VALUES = {
    "graded": {"3": 3, "2": 2, "1": 1, "0": 0, "skip": None},
    "binary": {"up": 3, "down": 0, "skip": None},
}


class SessionError(ValueError):
    """Bad input for a session. The message is shown on the form."""


# --- sessions and runs ------------------------------------------------------


def create_session(db, form, adapters, config):
    """Create a session and run its baseline and first variant."""
    for required in ("rater", "query", "information_need"):
        if not (form.get(required) or "").strip():
            raise SessionError(f"{required.replace('_', ' ').capitalize()} is required.")
    intent = form.get("intent") or "topical"
    if intent not in ("topical", "author", "known_item"):
        raise SessionError(f"Unknown intent {intent!r}.")

    params_a = normalize_params(_params_from(form, "a"), config["QF_FIELDS"])
    params_b = normalize_params(_params_from(form, "b"), config["QF_FIELDS"])
    env_a = form.get("env_a") or config["DEFAULT_ENVIRONMENT_A"]
    env_b = form.get("env_b") or config["DEFAULT_ENVIRONMENT_B"]
    for env in (env_a, env_b):
        if env not in adapters:
            raise SessionError(f"Unknown environment {env!r}.")
    if env_a == env_b and params_a == params_b:
        raise SessionError(
            "Both columns would run the same environment with the same parameters. "
            "Change the environment, qf or boost on one side."
        )

    session = RatingSession(
        rater=form["rater"].strip(),
        query=form["query"].strip(),
        information_need=form["information_need"].strip(),
        goal=(form.get("goal") or "").strip() or None,
        discipline=(form.get("discipline") or "").strip() or None,
        intent=intent,
        rating_mode=rating_mode_for(intent),
        rubric_version=config["RUBRIC_VERSION"],
    )
    db.add(session)
    db.flush()
    execute_run(db, session, env_a, params_a, adapters, config)
    execute_run(db, session, env_b, params_b, adapters, config)
    return session


def execute_run(db, session, env_name, params, adapters, config):
    """Retrieve one ranking and store it, or store why it failed.

    A failed run is kept rather than discarded, so a page can say that devapi
    rejected the token instead of silently showing one column.
    """
    adapter = adapters[env_name]
    run = Run(
        environment=env_name,
        base_url=adapter.base_url,
        rows=config["ROWS_RETRIEVED"],
        boost_config=_get_or_create_config(db, params),
    )
    # Append through the parent, not run.session = session: SQLAlchemy 2.0 no
    # longer adds an object to the session through a backref assignment.
    session.runs.append(run)
    db.add(run)
    try:
        result = adapter.search(session.query, config["ROWS_RETRIEVED"], params)
    except AdapterError as exc:
        run.status = "error"
        run.error = str(exc)
        db.flush()
        return run

    run.num_found = result.num_found
    run.qtime_ms = result.qtime_ms
    run.release = result.release
    for rank, record in enumerate(result.records, start=1):
        run.results.append(
            RunResult(
                rank=rank,
                bibcode=record.bibcode,
                identifiers=record.identifiers,
                title=record.title,
                authors=record.authors,
                year=record.year,
                pub=record.pub,
                abstract=record.abstract,
                entry_date=record.entry_date,
                doctype=record.doctype,
            )
        )
    db.flush()
    return run


def add_variant(db, session, form, adapters, config):
    """Run another variant against the existing pool: the tuning step."""
    env = form.get("env") or config["DEFAULT_ENVIRONMENT_B"]
    if env not in adapters:
        raise SessionError(f"Unknown environment {env!r}.")
    params = normalize_params(_params_from(form, ""), config["QF_FIELDS"])
    run = execute_run(db, session, env, params, adapters, config)
    score_session(db, session, config)
    return run


def _params_from(form, side):
    prefix = f"{side}_" if side else ""
    return {key: form.get(f"{prefix}{key}") for key in ("qf", "boost")}


def _get_or_create_config(db, params):
    digest = config_hash(params)
    existing = db.execute(
        select(BoostConfig).where(BoostConfig.hash == digest)
    ).scalar_one_or_none()
    if existing:
        return existing
    config = BoostConfig(params=params, hash=digest)
    db.add(config)
    db.flush()
    return config


# --- the rating pool --------------------------------------------------------


def canonical_map(runs):
    """Map every bibcode seen in the runs to one canonical bibcode.

    Two records are the same when they share any identifier, so a preprint and
    its published version collapse to whichever was seen first and earn gain
    once. The full canonical lookup on load comes with frozen record sets.
    """
    canonical_of, owner_of_identifier = {}, {}
    for run in runs:
        for result in run.results:
            ids = [result.bibcode, *(result.identifiers or [])]
            owner = next((owner_of_identifier[i] for i in ids if i in owner_of_identifier), None)
            owner = owner or result.bibcode
            canonical_of[result.bibcode] = owner
            for identifier in ids:
                owner_of_identifier.setdefault(identifier, owner)
    return canonical_of


def rating_pool(session, depth):
    """The records to rate: the union of every run's top `depth`, deduplicated,
    in an order that reveals nothing about which environment returned them.

    The order is a shuffle seeded by the session id, so it is stable across
    reloads but owes nothing to either system's ranking (synthesis R3).
    """
    runs = [r for r in session.runs if r.status == "ok"]
    canonical_of = canonical_map(runs)
    pool = {}
    for run in runs:
        for result in run.results[:depth]:
            pool.setdefault(canonical_of[result.bibcode], result)
    records = sorted(pool.values(), key=lambda r: r.bibcode)
    random.Random(session.id).shuffle(records)
    return records


def save_ratings(db, session, form, config):
    """Store the ratings submitted from the rating page, one row per record,
    then rebuild the ideal ranking and rescore every run."""
    values = RATING_VALUES[session.rating_mode]
    existing = {j.bibcode: j for j in session.judgements}
    identifiers = {r.bibcode: r.identifiers for run in session.runs for r in run.results}
    saved = 0
    for key, raw in form.items():
        if not key.startswith("rating:"):
            continue
        bibcode = key.split(":", 1)[1]
        # Only this session's own records can be rated. Anything else would sit
        # in the pool unseen, change IDCG, and never appear on a page.
        if bibcode not in identifiers:
            raise SessionError(f"{bibcode!r} is not one of this session's records.")
        if raw not in values:
            raise SessionError(f"{raw!r} is not a rating in {session.rating_mode} mode.")
        rating = values[raw]
        note = (form.get(f"note:{bibcode}") or "").strip() or None
        judgement = existing.get(bibcode)
        if judgement is None:
            judgement = Judgement(
                bibcode=bibcode,
                identifiers=identifiers[bibcode],
                rating_mode=session.rating_mode,
                rubric_version=session.rubric_version,
                rater=session.rater,
            )
            session.judgements.append(judgement)
            db.add(judgement)
        judgement.rating = rating
        judgement.note = note
        saved += 1
    db.flush()
    rebuild_ideal_ranking(db, session)
    score_session(db, session, config)
    return saved


def rebuild_ideal_ranking(db, session):
    """The ideal ranking is the judged pool in grade buckets, ties allowed.

    Records in one bucket share a tie_group. v0.1 does not ask for an order
    within a bucket; when it does, that order goes in `position` and the
    scoring module refuses any order that contradicts a grade.
    """
    # Delete and flush before inserting, so the (session, position) unique
    # constraint never sees the old and new rows at once.
    for row in list(session.ideal_ranking):
        db.delete(row)
    db.flush()
    db.expire(session, ["ideal_ranking"])
    rated = sorted(
        (j for j in session.judgements if j.rating is not None),
        key=lambda j: (-j.rating, j.bibcode),
    )
    for position, judgement in enumerate(rated, start=1):
        session.ideal_ranking.append(
            IdealRanking(
                position=position,
                bibcode=judgement.bibcode,
                identifiers=judgement.identifiers,
                tie_group=judgement.rating,
            )
        )
    db.flush()


# --- scoring ----------------------------------------------------------------


def judged_pool(session, canonical_of):
    """{canonical bibcode: grade} for every rated record. Skips are absent."""
    return {
        canonical_of.get(j.bibcode, j.bibcode): j.rating
        for j in session.judgements
        if j.rating is not None
    }


def score_session(db, session, config):
    """Score every successful run against the session's current pool.

    All runs share one pool and therefore one IDCG, which is what makes the
    per-run difference meaningful (synthesis convergence 3).
    """
    runs = [r for r in session.runs if r.status == "ok"]
    if not runs:
        return
    canonical_of = canonical_map(runs)
    pool = judged_pool(session, canonical_of)
    baseline = [canonical_of[r.bibcode] for r in runs[0].results]
    for run in runs:
        ranking = [canonical_of[r.bibcode] for r in run.results]
        scored = score_run(
            ranking,
            pool,
            k=config["SCORE_K"],
            gain=config["NDCG_GAIN"],
            intent=session.intent,
            incomplete_by=config["INCOMPLETE_BY"],
            min_judged=config["MIN_JUDGED_FRACTION"],
            max_interval=config["MAX_NDCG_INTERVAL"],
            other_ranking=baseline if run is not runs[0] else None,
        )
        for name, value in scored["metrics"].items():
            run.metrics.append(
                Metric(name=name, k=config["SCORE_K"], value=value, params=scored["params"])
            )
    db.flush()


def latest_metrics(run):
    """The newest value of each metric for a run, and the parameters of the
    scoring pass that produced them. Rows are appended in id order, so the last
    row seen for a name is its newest value."""
    ordered = sorted(run.metrics, key=lambda m: m.id or 0)
    values = {m.name: m.value for m in ordered}
    return values, (ordered[-1].params if ordered else {})


def get_session(db, session_id):
    return db.get(RatingSession, session_id)
