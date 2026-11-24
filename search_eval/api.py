"""JSON API for the frontend.

Errors come back as {"error": message}, with a message written for the person
using the page, never a stack trace.
"""

from flask import Blueprint, current_app, jsonify, request

from . import presenters, service
from .boost import InvalidParams

bp = Blueprint("api", __name__, url_prefix="/api")


def _adapters():
    return current_app.extensions["search_adapters"]


def _body():
    return request.get_json(silent=True) or {}


@bp.errorhandler(service.SessionError)
@bp.errorhandler(InvalidParams)
def _bad_request(exc):
    return jsonify(error=str(exc)), 400


@bp.errorhandler(service.NotFound)
def _not_found(exc):
    return jsonify(error=f"There is no session {exc}."), 404


@bp.get("/config")
def get_config():
    return jsonify(presenters.config_payload(current_app.config))


@bp.get("/sessions")
def list_sessions():
    limit = min(request.args.get("limit", 20, type=int), 100)
    with current_app.session_scope() as db:
        return jsonify([presenters.session_summary(s) for s in service.recent_sessions(db, limit)])


@bp.post("/sessions")
def create_session():
    """A search: creates the session and runs production's default ranking."""
    with current_app.session_scope() as db:
        session = service.create_session(db, _body(), _adapters(), current_app.config)
        return jsonify(presenters.session_payload(session, current_app.config)), 201


@bp.get("/sessions/<int:session_id>")
def get_session(session_id):
    with current_app.session_scope() as db:
        session = service.get_session(db, session_id)
        return jsonify(presenters.session_payload(session, current_app.config))


@bp.patch("/sessions/<int:session_id>")
def update_session(session_id):
    with current_app.session_scope() as db:
        session = service.get_session(db, session_id, lock=True)
        service.update_session(db, session, _body(), current_app.config)
        return jsonify(presenters.session_payload(session, current_app.config))


@bp.post("/sessions/<int:session_id>/runs")
def add_run(session_id):
    """A tweak: runs qf, boost or another environment against the same pool."""
    with current_app.session_scope() as db:
        session = service.get_session(db, session_id, lock=True)
        service.add_variant(db, session, _body(), _adapters(), current_app.config)
        return jsonify(presenters.session_payload(session, current_app.config)), 201


@bp.get("/sessions/<int:session_id>/pool")
def get_pool(session_id):
    with current_app.session_scope() as db:
        session = service.get_session(db, session_id)
        return jsonify(presenters.pool_payload(session, current_app.config))


@bp.put("/sessions/<int:session_id>/judgements")
def put_judgement(session_id):
    """One rating, saved as soon as it is made. {"bibcode", "rating", "note",
    "rater"}; a null rating clears it."""
    with current_app.session_scope() as db:
        session = service.get_session(db, session_id, lock=True)
        service.save_judgement(db, session, _body(), current_app.config)
        return jsonify(presenters.session_payload(session, current_app.config))


@bp.get("/sessions/<int:session_id>/ideal")
def get_ideal(session_id):
    with current_app.session_scope() as db:
        session = service.get_session(db, session_id)
        return jsonify(presenters.ideal_payload(session))


@bp.put("/sessions/<int:session_id>/ideal")
def put_ideal(session_id):
    """The rater's order of rated records: {"order": [bibcode, ...]}."""
    order = _body().get("order")
    if not isinstance(order, list) or not all(isinstance(b, str) for b in order):
        raise service.SessionError("order must be a list of bibcodes.")
    with current_app.session_scope() as db:
        session = service.get_session(db, session_id, lock=True)
        service.set_ideal_order(db, session, order)
        return jsonify(presenters.ideal_payload(session))
