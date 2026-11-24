"""The experiment loop: search, tweak, rate, order, score.

A session starts from a search. Its first run is always production's default
ranking: the baseline every tweak is compared against, so nobody sets it up.
Each tweak adds a run scored against the same pool of ratings, so the effect
of a qf or boost change shows at once, and only the records the change brought
in still need rating.
"""

import random

from sqlalchemy import select

from .adapters import AdapterError
from .boost import config_hash, normalize_params
from .models import (
    INTENTS,
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

# What a submitted rating means, per rating mode. A skip is unjudged (None),
# never 0. Thumbs are stored as 3 and 0 so both modes share one integer column.
RATING_VALUES = {
    "graded": {"3": 3, "2": 2, "1": 1, "0": 0, "skip": None},
    "binary": {"up": 3, "down": 0, "skip": None},
}


class SessionError(ValueError):
    """Bad input for a session. The message is shown to the person."""


class NotFound(LookupError):
    """No such session."""


# --- sessions and runs ------------------------------------------------------


def create_session(db, data, adapters, config):
    """Start a session from a search: store it and run the baseline.

    Only the query is required. The information need is asked for when the
    person starts rating, because that is when it matters.
    """
    query = (data.get("query") or "").strip()
    if not query:
        raise SessionError("Type a search first.")
    intent = data.get("intent") or "topical"
    if intent not in INTENTS:
        raise SessionError(f"Unknown kind of search {intent!r}.")
    discipline = _discipline(data.get("discipline"), config)
    baseline_env = config["BASELINE_ENVIRONMENT"]
    if baseline_env not in adapters:
        raise SessionError(f"The baseline environment {baseline_env!r} is not configured.")

    session = RatingSession(
        rater=_clean(data.get("rater")),
        query=query,
        information_need=_clean(data.get("information_need")),
        discipline=discipline,
        intent=intent,
        rating_mode=rating_mode_for(intent),
        rubric_version=config["RUBRIC_VERSION"],
    )
    db.add(session)
    db.flush()
    execute_run(db, session, baseline_env, {}, adapters, config)
    score_session(db, session, config)
    return session


def update_session(db, session, data, config):
    """Change the information need, goal, discipline or kind of search.

    The kind of search sets the rating mode, so it can only change while
    nothing is rated: a thumbs-up stored as 3 must never be reread as a grade.
    """
    if "information_need" in data:
        session.information_need = _clean(data["information_need"])
    if "goal" in data:
        session.goal = _clean(data["goal"])
    if "discipline" in data:
        session.discipline = _discipline(data["discipline"], config)
    if "intent" in data and data["intent"] != session.intent:
        if data["intent"] not in INTENTS:
            raise SessionError(f"Unknown kind of search {data['intent']!r}.")
        if session.judgements:
            raise SessionError(
                "The kind of search sets how records are rated, so it can't change "
                "once something is rated."
            )
        session.intent = data["intent"]
        session.rating_mode = rating_mode_for(data["intent"])
        score_session(db, session, config)
    db.flush()
    return session


def execute_run(db, session, env_name, params, adapters, config):
    """Retrieve one ranking and store it, or store why it failed.

    A failed run is kept rather than discarded, so the page can say that devapi
    rejected the token instead of silently showing nothing.
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


def add_variant(db, session, data, adapters, config):
    """Run a tweak against the session's pool: the tuning step."""
    env = data.get("env") or config["DEFAULT_VARIANT_ENVIRONMENT"]
    if env not in adapters:
        raise SessionError(f"Unknown environment {env!r}.")
    params = normalize_params({key: data.get(key) for key in ("qf", "boost")}, config["QF_FIELDS"])
    digest = config_hash(params)
    for run in session.runs:
        if run.status == "ok" and run.environment == env and run.boost_config.hash == digest:
            label = "the baseline" if run is session.runs[0] else f"tweak {run.id}"
            raise SessionError(f"That is the same search as {label}.")
    run = execute_run(db, session, env, params, adapters, config)
    score_session(db, session, config)
    return run


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


def _clean(value):
    return (value or "").strip() or None


def _discipline(value, config):
    value = _clean(value)
    if value is None:
        return None
    allowed = {v for v, _ in config["DISCIPLINES"]}
    if value not in allowed:
        raise SessionError(f"Unknown discipline {value!r}.")
    return value


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


def ok_runs(session):
    return [r for r in session.runs if r.status == "ok"]


def rating_pool(session, depth):
    """The records to rate: the union of every run's top `depth`, deduplicated,
    in an order that reveals nothing about which ranking returned them.

    The order is a shuffle seeded by the session id, so it is stable across
    reloads but owes nothing to either system's ranking (synthesis R3).
    """
    runs = ok_runs(session)
    canonical_of = canonical_map(runs)
    pool = {}
    for run in runs:
        for result in run.results[:depth]:
            pool.setdefault(canonical_of[result.bibcode], result)
    records = sorted(pool.values(), key=lambda r: r.bibcode)
    random.Random(session.id).shuffle(records)
    return records


def save_judgement(db, session, data, config):
    """Store one rating as soon as it is made, then rescore.

    Saving per record means a closed tab loses nothing. `rating` None clears a
    rating back to unrated.
    """
    rater = _clean(data.get("rater"))
    if rater is None:
        raise SessionError("Say who is rating first.")
    if not session.information_need:
        raise SessionError("Describe what you were looking for before rating.")
    bibcode = data.get("bibcode") or ""
    identifiers = {r.bibcode: r.identifiers for run in session.runs for r in run.results}
    # Only this session's own records can be rated. Anything else would sit in
    # the pool unseen, change IDCG, and never appear on a page.
    if bibcode not in identifiers:
        raise SessionError(f"{bibcode!r} is not one of this session's records.")

    existing = next((j for j in session.judgements if j.bibcode == bibcode), None)
    raw = data.get("rating")
    if raw is None:
        if existing is not None:
            session.judgements.remove(existing)
            db.delete(existing)
    else:
        values = RATING_VALUES[session.rating_mode]
        if raw not in values:
            raise SessionError(f"{raw!r} is not a rating in {session.rating_mode} mode.")
        if existing is None:
            existing = Judgement(
                bibcode=bibcode,
                identifiers=identifiers[bibcode],
                rating_mode=session.rating_mode,
                rubric_version=session.rubric_version,
            )
            session.judgements.append(existing)
            db.add(existing)
        existing.rating = values[raw]
        existing.rater = rater
        if "note" in data:
            existing.note = _clean(data.get("note"))
    db.flush()
    rebuild_ideal_ranking(db, session)
    score_session(db, session, config)
    return existing


# --- the ideal ranking ------------------------------------------------------


def rebuild_ideal_ranking(db, session):
    """Regroup rated records into grade buckets, keeping any order the rater
    already gave within a bucket.

    A record whose grade changed joins the end of its new bucket. A bucket the
    rater has ordered stays ordered; the others stay tied.
    """
    previous = [(row.bibcode, row.tie_group) for row in session.ideal_ranking]
    position_of = {b: i for i, (b, _) in enumerate(previous)}
    grade_of = dict(previous)
    ordered_grades = {row.tie_group for row in session.ideal_ranking if row.ordered}
    rated = [j for j in session.judgements if j.rating is not None]

    def key(j):
        kept = grade_of.get(j.bibcode) == j.rating
        return (-j.rating, not kept, position_of[j.bibcode] if kept else 0, j.bibcode)

    _write_ideal(db, session, sorted(rated, key=key), ordered_grades)


def set_ideal_order(db, session, order):
    """Store the rater's order of the rated records.

    The order must hold every rated record once, and may only reorder records
    within a grade: putting a lower grade above a higher one would contradict
    the ratings (synthesis R1), so it is refused and the grade must change
    instead. Buckets whose order changed are marked as ordered.
    """
    rated = {j.bibcode: j for j in session.judgements if j.rating is not None}
    if len(order) != len(set(order)) or set(order) != set(rated):
        raise SessionError("The order must list every rated record exactly once.")
    for above, below in zip(order, order[1:]):
        if rated[above].rating < rated[below].rating:
            raise SessionError(
                "A record can't go above one with a higher rating. "
                "Change its rating to move it to another group."
            )
    before = [row.bibcode for row in session.ideal_ranking]
    ordered_grades = {row.tie_group for row in session.ideal_ranking if row.ordered}
    for grade in {j.rating for j in rated.values()}:
        old = [b for b in before if b in rated and rated[b].rating == grade]
        new = [b for b in order if rated[b].rating == grade]
        if old != new:
            ordered_grades.add(grade)
    _write_ideal(db, session, [rated[b] for b in order], ordered_grades)


def _write_ideal(db, session, judgements, ordered_grades):
    # Delete and flush before inserting, so the (session, position) unique
    # constraint never sees the old and new rows at once.
    for row in list(session.ideal_ranking):
        db.delete(row)
    db.flush()
    db.expire(session, ["ideal_ranking"])
    for position, judgement in enumerate(judgements, start=1):
        session.ideal_ranking.append(
            IdealRanking(
                position=position,
                bibcode=judgement.bibcode,
                identifiers=judgement.identifiers,
                tie_group=judgement.rating,
                ordered=judgement.rating in ordered_grades,
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
    per-run difference meaningful (synthesis convergence 3). The baseline is
    the session's first run.
    """
    runs = ok_runs(session)
    if not runs:
        return
    baseline = session.runs[0] if session.runs[0].status == "ok" else None
    canonical_of = canonical_map(runs)
    pool = judged_pool(session, canonical_of)
    baseline_ranking = (
        [canonical_of[r.bibcode] for r in baseline.results] if baseline is not None else None
    )
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
            other_ranking=baseline_ranking if run is not baseline else None,
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


def get_session(db, session_id, lock=False):
    """Load a session. `lock` takes a row lock until the transaction ends, so
    two writes to one session (ratings sent in quick succession) run one after
    the other instead of rebuilding the ideal ranking at the same time."""
    session = db.get(RatingSession, session_id, with_for_update=lock or None)
    if session is None:
        raise NotFound(session_id)
    return session


def recent_sessions(db, limit=20):
    return (
        db.execute(select(RatingSession).order_by(RatingSession.id.desc()).limit(limit))
        .scalars()
        .all()
    )
