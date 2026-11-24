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

# The rating groups a board may hold, top first. Author searches are right or
# wrong person, stored as 3 and 0 so both modes share one integer column. A
# skip is unjudged (NULL), never 0.
GRADES = {"graded": (3, 2, 1, 0), "binary": (3, 0)}


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


def save_board(db, session, data, config):
    """Store the rater's board: ratings and ranking in one step.

    The board is the rating groups, top grade first, each holding records in
    the rater's order, plus the records the rater can't judge. A record's group
    is its rating and its place in the group is its rank, so the ranking can
    never contradict the ratings (synthesis R1). Records on no group are
    unrated. The whole board is sent on every move, so a closed tab loses
    nothing and a rating and its rank are never saved apart.

    `data`: {"rater", "groups": [{"grade", "ordered", "bibcodes"}],
    "skipped": [{"bibcode", "note"}]}. `ordered` says the rater put that group
    in an order of their own; otherwise its records are tied.
    """
    rater = _clean(data.get("rater"))
    if rater is None:
        raise SessionError("Say who is rating first.")
    if not session.information_need:
        raise SessionError("Describe what you were looking for before rating.")
    identifiers = {r.bibcode: r.identifiers for run in session.runs for r in run.results}
    allowed = GRADES[session.rating_mode]
    placed, notes, order, ordered_grades = {}, {}, [], set()

    def place(bibcode, rating):
        # Only this session's own records can be rated. Anything else would
        # sit in the pool unseen, change IDCG, and never appear on a page.
        if bibcode not in identifiers:
            raise SessionError(f"{bibcode!r} is not one of this session's records.")
        if bibcode in placed:
            raise SessionError(f"{bibcode!r} is in two places on the board.")
        placed[bibcode] = rating

    groups = sorted(data.get("groups") or [], key=lambda g: -_grade(g.get("grade"), allowed))
    if len({g["grade"] for g in groups}) != len(groups):
        raise SessionError("Each rating group can appear once.")
    for group in groups:
        for bibcode in group.get("bibcodes") or []:
            place(bibcode, group["grade"])
            order.append(bibcode)
        if group.get("ordered"):
            ordered_grades.add(group["grade"])
    for item in data.get("skipped") or []:
        place(item.get("bibcode"), None)
        notes[item["bibcode"]] = _clean(item.get("note"))

    existing = {j.bibcode: j for j in session.judgements}
    for bibcode, judgement in existing.items():
        if bibcode not in placed:
            session.judgements.remove(judgement)
            db.delete(judgement)
    for bibcode, rating in placed.items():
        judgement = existing.get(bibcode)
        if judgement is None:
            judgement = Judgement(
                bibcode=bibcode,
                identifiers=identifiers[bibcode],
                rating_mode=session.rating_mode,
                rubric_version=session.rubric_version,
                rating=rating,
                rater=rater,
            )
            session.judgements.append(judgement)
            db.add(judgement)
        elif judgement.rating != rating:
            # The rater is whoever last changed the rating, not whoever last
            # moved the record within its group.
            judgement.rating = rating
            judgement.rater = rater
        if bibcode in notes:
            judgement.note = notes[bibcode]
    db.flush()
    _write_ideal(db, session, [(b, placed[b]) for b in order], ordered_grades)
    score_session(db, session, config)
    return session


def _grade(value, allowed):
    if value not in allowed:
        raise SessionError(f"{value!r} is not a rating group here; use one of {list(allowed)}.")
    return value


def _write_ideal(db, session, placed, ordered_grades):
    """Replace the session's ideal ranking with `placed`, a list of
    (bibcode, grade) in rank order."""
    # Delete and flush before inserting, so the (session, position) unique
    # constraint never sees the old and new rows at once.
    for row in list(session.ideal_ranking):
        db.delete(row)
    db.flush()
    db.expire(session, ["ideal_ranking"])
    identifiers = {j.bibcode: j.identifiers for j in session.judgements}
    for position, (bibcode, grade) in enumerate(placed, start=1):
        session.ideal_ranking.append(
            IdealRanking(
                position=position,
                bibcode=bibcode,
                identifiers=identifiers[bibcode],
                tie_group=grade,
                ordered=grade in ordered_grades,
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
