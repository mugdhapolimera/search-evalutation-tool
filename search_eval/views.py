"""Server-rendered pages: start a session, rate, see results, try a variant.

The environments stay hidden on the rating page and are revealed on the
results page, after the ratings are in (synthesis R3: unblinded columns invite
confirmation bias).
"""

from flask import Blueprint, abort, current_app, redirect, render_template, request, url_for
from sqlalchemy import select

from . import service
from .boost import InvalidParams, describe
from .models import RatingSession
from .rubric import rubric_for
from .scoring.metrics import GAIN_SHORT, metric_name

bp = Blueprint("search_eval", __name__)

INTENT_LABELS = {
    "topical": "Topic search (rate 0-3)",
    "author": "Author search (right person / wrong person)",
    "known_item": "Known item (looking for one specific paper)",
}


def _adapters():
    return current_app.extensions["search_adapters"]


def _environments():
    return {name: env["label"] for name, env in current_app.config["ENVIRONMENTS"].items()}


@bp.route("/", methods=["GET"])
def index():
    with current_app.session_scope() as db:
        recent = (
            db.execute(select(RatingSession).order_by(RatingSession.id.desc()).limit(20))
            .scalars()
            .all()
        )
        return render_template(
            "index.html",
            recent=recent,
            form={},
            error=None,
            environments=_environments(),
            intents=INTENT_LABELS,
            config=current_app.config,
        )


@bp.route("/sessions", methods=["POST"])
def create_session():
    form = request.form.to_dict()
    with current_app.session_scope() as db:
        try:
            session = service.create_session(db, form, _adapters(), current_app.config)
        except (service.SessionError, InvalidParams) as exc:
            db.rollback()
            return (
                render_template(
                    "index.html",
                    recent=[],
                    form=form,
                    error=str(exc),
                    environments=_environments(),
                    intents=INTENT_LABELS,
                    config=current_app.config,
                ),
                400,
            )
        session_id = session.id
    return redirect(url_for("search_eval.rate", session_id=session_id))


@bp.route("/sessions/<int:session_id>/rate", methods=["GET"])
def rate(session_id):
    with current_app.session_scope() as db:
        session = _session_or_404(db, session_id)
        pool = service.rating_pool(session, current_app.config["RATE_DEPTH"])
        judgements = {j.bibcode: j for j in session.judgements}
        failed = [r for r in session.runs if r.status != "ok"]
        # A skip has a judgement row, so it counts as handled, not as unrated.
        unrated = sum(1 for r in pool if r.bibcode not in judgements)
        return render_template(
            "rate.html",
            session=session,
            pool=pool,
            judgements=judgements,
            options=rubric_for(session.rubric_version, session.rating_mode),
            unrated=unrated,
            new_records=request.args.get("new", type=int),
            failed=failed,
            error=None,
        )


@bp.route("/sessions/<int:session_id>/rate", methods=["POST"])
def submit_ratings(session_id):
    with current_app.session_scope() as db:
        session = _session_or_404(db, session_id)
        try:
            service.save_ratings(db, session, request.form.to_dict(), current_app.config)
        except service.SessionError as exc:
            db.rollback()
            abort(400, str(exc))
    return redirect(url_for("search_eval.results", session_id=session_id))


@bp.route("/sessions/<int:session_id>", methods=["GET"])
def results(session_id):
    with current_app.session_scope() as db:
        session = _session_or_404(db, session_id)
        view = results_view(session, current_app.config)
        return render_template(
            "results.html",
            session=session,
            view=view,
            environments=_environments(),
            error=request.args.get("error"),
        )


@bp.route("/sessions/<int:session_id>/variants", methods=["POST"])
def add_variant(session_id):
    with current_app.session_scope() as db:
        session = _session_or_404(db, session_id)
        try:
            run = service.add_variant(
                db, session, request.form.to_dict(), _adapters(), current_app.config
            )
        except (service.SessionError, InvalidParams) as exc:
            db.rollback()
            return redirect(url_for("search_eval.results", session_id=session_id, error=str(exc)))
        rated = {j.bibcode for j in session.judgements}
        depth = current_app.config["RATE_DEPTH"]
        canonical_of = service.canonical_map([r for r in session.runs if r.status == "ok"])
        rated = {canonical_of.get(b, b) for b in rated}
        new = [
            r for r in run.results[:depth] if canonical_of.get(r.bibcode, r.bibcode) not in rated
        ]
    if new:
        return redirect(url_for("search_eval.rate", session_id=session_id, new=len(new)))
    return redirect(url_for("search_eval.results", session_id=session_id))


def _session_or_404(db, session_id):
    session = service.get_session(db, session_id)
    if session is None:
        abort(404)
    return session


def results_view(session, config):
    """Everything the results page shows, computed from stored rows only."""
    k = config["SCORE_K"]
    gain = config["NDCG_GAIN"]
    names = {
        "ndcg": metric_name("ndcg", k=k, gain=gain),
        "judged": metric_name("judged", k=k),
        "precision": metric_name("p", k=k, rel=2),
        "success": metric_name("success", k=k, rel=2),
        "overlap": metric_name("overlap", k=k),
        "rbo": metric_name("rbo_ext", k=k, p=0.9),
    }
    ok_runs = [r for r in session.runs if r.status == "ok"]
    canonical_of = service.canonical_map(ok_runs)
    grades = {canonical_of.get(j.bibcode, j.bibcode): j.rating for j in session.judgements}
    baseline = session.runs[0] if session.runs else None
    baseline_ranks = {}
    if baseline is not None and baseline.status == "ok":
        baseline_ranks = {canonical_of[r.bibcode]: r.rank for r in baseline.results[:k]}

    headline = {"topical": "ndcg", "author": "precision", "known_item": "success"}[session.intent]
    baseline_value = None
    columns = []
    for index, run in enumerate(session.runs):
        values, params = service.latest_metrics(run)
        rows = []
        for result in run.results[:k]:
            key = canonical_of.get(result.bibcode, result.bibcode)
            rows.append(
                {
                    "rank": result.rank,
                    "bibcode": result.bibcode,
                    "title": result.title,
                    "year": result.year,
                    "grade": grades.get(key, "unjudged"),
                    "baseline_rank": baseline_ranks.get(key),
                }
            )
        value = values.get(names[headline])
        if index == 0:
            baseline_value = value
        columns.append(
            {
                "run": run,
                "is_baseline": index == 0,
                "environment": run.environment,
                "config": describe(run.boost_config.params),
                "rows": rows,
                "headline_name": names[headline],
                "headline": value,
                "delta": (
                    None
                    if index == 0 or value is None or baseline_value is None
                    else value - baseline_value
                ),
                "figures": {key: values.get(name) for key, name in names.items()},
                "params": params,
            }
        )
    return {
        "columns": columns,
        "k": k,
        "gain_label": GAIN_SHORT[gain],
        "headline": headline,
        "rated": sum(1 for j in session.judgements if j.rating is not None),
        "skipped": sum(1 for j in session.judgements if j.rating is None),
        "has_ratings": any(j.rating is not None for j in session.judgements),
    }
