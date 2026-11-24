"""The experiment loop end to end, through the JSON API.

Expected metric values are written out from the definition, not copied from
a run, so these tests check the arithmetic and not just that it is stable.
"""

import os
from concurrent.futures import ThreadPoolExecutor
from math import log2

import pytest
from sqlalchemy import select

from search_eval import app as app_module
from search_eval.models import IdealRanking, Judgement, RatingSession, Run

TOL = 1e-9

# Baseline (production default) top 5: A B C D E.  Tweak qf=title^2: C A F D G.
# The rater's board: each group is a rating, in the rater's order. E can't be judged.
BOARD = {3: ["A", "F"], 2: ["C"], 1: ["D"], 0: ["B", "G"]}
NEED = "Measurements of Triton's surface pressure"
PROD_WITH_TITLE_2 = (
    "abstract^0.7 ack^0.8 author^0.85 bibstem^0.8 first_author^0.9 "
    "identifier^0.8 keyword^0.8 title^2 year^0.8"
)


def ready_to_rate(api, session_id=1):
    status, _ = api.patch(f"/sessions/{session_id}", {"information_need": NEED})
    assert status == 200


def board_body(groups, skipped=(), ordered=(), rater="Tester"):
    return {
        "rater": rater,
        "groups": [
            {"grade": g, "bibcodes": list(b), "ordered": g in ordered} for g, b in groups.items()
        ],
        "skipped": [{"bibcode": b, "note": n} for b, n in (skipped.items() if skipped else [])],
    }


def put_board(api, groups, skipped=None, ordered=(), session_id=1, expect=200, **kw):
    status, payload = api.put(
        f"/sessions/{session_id}/board", board_body(groups, skipped, ordered, **kw)
    )
    assert status == expect, payload
    return payload


def column(payload, index):
    return payload["columns"][index]


@pytest.fixture
def rated_session(api, search):
    search()
    api.post("/sessions/1/runs", {"qf": "title^2"})
    ready_to_rate(api)
    return put_board(api, BOARD, {"E": "outside my field"})["session"]


def groups_of(board):
    return {g["grade"]: [r["bibcode"] for r in g["records"]] for g in board["groups"]}


# --- health and config ------------------------------------------------------


def test_health_check_actually_checks_the_database(client):
    """The MVP's health check reported the database unhealthy under SQLAlchemy
    2.x, so any readiness probe built on it failed. adsmutils' runs SELECT 1."""
    resp = client.get("/ready")
    assert resp.status_code == 200 and resp.get_json() == {"ready": True}
    assert client.get("/alive").get_json() == {"alive": True}


def test_config_gives_scix_disciplines_and_production_weights(api):
    status, config = api.get("/config")
    assert status == 200
    assert [d["label"] for d in config["disciplines"]] == [
        "No preferred discipline",
        "Astrophysics",
        "Heliophysics",
        "Planetary Science",
        "Earth Science",
        "Biological & Physical Science",
    ]
    weights = {w["field"]: w["weight"] for w in config["production_weights"]}
    assert weights["title"] == 0.8 and weights["first_author"] == 0.9 and len(weights) == 9


# --- searching --------------------------------------------------------------


def test_a_search_needs_only_a_query_and_runs_production_as_the_baseline(search, adapters, app):
    status, payload = search()
    assert status == 201
    assert adapters["prod"].calls == [("triton atmosphere", 5, {})], "no qf, no boost"
    (baseline,) = payload["columns"]
    assert baseline["is_baseline"] and baseline["environment"] == "prod"
    assert [r["bibcode"] for r in baseline["results"]] == list("ABCDE")
    with app.app_context(), app.session_scope() as db:
        session = db.execute(select(RatingSession)).scalar_one()
        assert session.rater is None and session.information_need is None


def test_recent_searches_are_listed_newest_first(search, api):
    search(query="first")
    search(query="second")
    api.post("/sessions/1/runs", {"qf": "title^2"})
    status, recent = api.get("/sessions")
    assert status == 200
    assert [(s["query"], s["tweaks"]) for s in recent] == [("second", 0), ("first", 1)]


def test_an_empty_search_is_refused(search):
    status, payload = search(query="  ")
    assert status == 400 and payload["error"] == "Type a search first."


def test_discipline_must_be_one_of_scix_choices(search):
    assert search(discipline="planetary science")[0] == 400
    status, payload = search(discipline="planetary")
    assert status == 201 and payload["discipline"] == "planetary"


def test_a_failed_baseline_is_kept_and_explained(search, adapters):
    adapters["prod"].fail_with = "prod: HTTP 401 — The access token provided is invalid"
    status, payload = search()
    assert status == 201
    baseline = column(payload, 0)
    assert baseline["status"] == "error" and "HTTP 401" in baseline["error"]
    assert baseline["metrics"] is None


# --- tweaking ---------------------------------------------------------------


def test_a_tweak_is_described_as_its_difference_from_production(search, api, adapters):
    adapters["prod"].rankings[PROD_WITH_TITLE_2] = ["C", "A", "F", "D", "G"]
    search()
    status, payload = api.post("/sessions/1/runs", {"qf": PROD_WITH_TITLE_2})
    assert status == 201
    tweak = column(payload, 1)
    assert tweak["changes"] == ["title 0.8 → 2"] and tweak["warnings"] == []


def test_a_qf_that_drops_fields_says_so(search, api):
    search()
    _, payload = api.post("/sessions/1/runs", {"qf": "title^2"})
    tweak = column(payload, 1)
    assert "title 0.8 → 2" in tweak["changes"] and "no abstract" in tweak["changes"]
    assert tweak["warnings"][0].startswith("Searches 1 of production's 9 fields")


def test_a_boost_carries_the_applied_twice_warning(search, api, adapters):
    adapters["prod"].rankings["pow(citation_count,0.1)"] = list("ABCDE")
    search()
    _, payload = api.post("/sessions/1/runs", {"boost": "pow(citation_count,0.1)"})
    assert column(payload, 1)["changes"] == ["boost pow(citation_count,0.1)"]
    assert "Applied twice" in column(payload, 1)["warnings"][0]


def test_before_anything_is_rated_there_is_no_verdict(search, api):
    search()
    _, payload = api.post("/sessions/1/runs", {"qf": "title^2"})
    metrics = column(payload, 1)["metrics"]
    assert metrics["headline"] is None and metrics["delta"] is None and metrics["verdict"] is None


def test_repeating_a_search_is_refused(search, api):
    search()
    status, payload = api.post("/sessions/1/runs", {})
    assert status == 400 and payload["error"] == "That is the same search as the baseline."
    api.post("/sessions/1/runs", {"qf": "title^2"})
    status, payload = api.post("/sessions/1/runs", {"qf": "title^2.0"})
    assert status == 400 and "same search as tweak" in payload["error"]


def test_a_bad_qf_is_refused_and_nothing_is_stored(search, api, app):
    search()
    status, payload = api.post("/sessions/1/runs", {"qf": "body^2"})
    assert status == 400 and "not in QF_FIELDS" in payload["error"]
    with app.app_context(), app.session_scope() as db:
        assert len(db.execute(select(Run)).scalars().all()) == 1


def test_a_failed_tweak_is_kept_and_explained(search, api, adapters):
    adapters["dev"].fail_with = "dev: HTTP 401 — The access token provided is invalid"
    search()
    status, payload = api.post("/sessions/1/runs", {"env": "dev"})
    assert status == 201
    tweak = column(payload, 1)
    assert tweak["status"] == "error" and tweak["changes"] == ["Development"]


# --- rating -----------------------------------------------------------------


def test_the_board_starts_with_the_merged_pool_unsorted_and_blind(search, api):
    search()
    api.post("/sessions/1/runs", {"qf": "title^2"})
    _, board = api.get("/sessions/1/board")
    unsorted = [r["bibcode"] for r in board["unsorted"]]
    assert sorted(unsorted) == list("ABCDEFG"), "A, C and D are in both rankings, rated once"
    assert not {"rank", "environment", "move"} & set(board["unsorted"][0])
    assert unsorted != list("ABCDEFG") and unsorted != list("CAFDGBE"), "neither order"
    assert unsorted == [r["bibcode"] for r in api.get("/sessions/1/board")[1]["unsorted"]]
    assert [g["label"] for g in board["groups"]] == [
        "Highly relevant",
        "Relevant",
        "Somewhat relevant",
        "Not relevant",
    ]
    assert all(g["definition"] for g in board["groups"]), "the rubric travels with the board"


def test_rating_needs_the_information_need_and_a_rater(search, api):
    search()
    payload = put_board(api, {3: ["A"]}, expect=400)
    assert "what you were looking for" in payload["error"]
    ready_to_rate(api)
    payload = put_board(api, {3: ["A"]}, rater=" ", expect=400)
    assert "who is rating" in payload["error"]
    put_board(api, {3: ["A"]})


def test_one_save_stores_ratings_and_ranking_together(rated_session, api, app):
    with app.app_context(), app.session_scope() as db:
        stored = {j.bibcode: (j.rating, j.note) for j in db.execute(select(Judgement)).scalars()}
        rows = db.execute(select(IdealRanking).order_by(IdealRanking.position)).scalars()
        ideal = [(r.bibcode, r.tie_group) for r in rows]
    assert stored["A"] == (3, None) and stored["B"] == (0, None)
    assert stored["E"] == (None, "outside my field"), "a skip is unjudged, not a 0"
    assert ideal == [("A", 3), ("F", 3), ("C", 2), ("D", 1), ("B", 0), ("G", 0)]
    assert rated_session["counts"] == {"pool": 7, "rated": 6, "skipped": 1, "unrated": 0}


def test_a_record_taken_off_the_board_is_unrated_again(rated_session, api):
    payload = put_board(api, {3: ["F"], 2: ["C"], 1: ["D"], 0: ["B", "G"]}, {"E": None})
    assert payload["session"]["counts"]["unrated"] == 1
    assert [r["bibcode"] for r in payload["board"]["unsorted"]] == ["A"]


@pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URI"), reason="row locks need Postgres, as in CI"
)
def test_boards_sent_at_the_same_time_are_all_saved(search, api, app):
    """Each save rewrites the ideal ranking. Without a lock on the session,
    two at once collided on its unique positions and answered 500."""
    search()
    api.post("/sessions/1/runs", {"qf": "title^2"})
    ready_to_rate(api)
    boards = [{3: list("ABCDEFG")[: n + 1]} for n in range(7)]

    def put(groups):
        with app.test_client() as client:
            return client.put("/api/sessions/1/board", json=board_body(groups)).status_code

    with ThreadPoolExecutor(max_workers=7) as pool:
        statuses = list(pool.map(put, boards))
    assert statuses == [200] * 7


def test_records_outside_the_session_are_refused(search, api, app):
    """A judgement for a record no run returned would change IDCG invisibly."""
    search()
    ready_to_rate(api)
    put_board(api, {3: ["A", "2024A&amp;A...682L..24S"]}, expect=400)
    with app.app_context(), app.session_scope() as db:
        assert db.execute(select(Judgement)).first() is None, "nothing from that board is kept"


def test_a_record_cannot_be_in_two_groups(search, api):
    search()
    ready_to_rate(api)
    payload = put_board(api, {3: ["A"], 0: ["A"]}, expect=400)
    assert "two places" in payload["error"]


# --- comparing --------------------------------------------------------------


def test_metrics_are_computed_against_one_shared_pool(rated_session):
    baseline, tweak = rated_session["columns"]
    # Pool {A:3, F:3, C:2, D:1, B:0, G:0}; E is skipped. IDCG@5 from 3,3,2,1,0.
    idcg = 3 / log2(2) + 3 / log2(3) + 2 / log2(4) + 1 / log2(5)
    baseline_ndcg = (3 / log2(2) + 2 / log2(4) + 1 / log2(5)) / idcg  # A B C D E
    tweak_ndcg = (2 / log2(2) + 3 / log2(3) + 3 / log2(4) + 1 / log2(5)) / idcg  # C A F D G

    assert abs(baseline["metrics"]["headline"] - baseline_ndcg) < TOL
    assert abs(tweak["metrics"]["headline"] - tweak_ndcg) < TOL
    assert abs(tweak["metrics"]["delta"] - (tweak_ndcg - baseline_ndcg)) < TOL
    assert tweak["metrics"]["verdict"] == "better"
    assert baseline["metrics"]["headline_label"] == "NDCG@5"
    assert baseline["metrics"]["rated_in_top_k"] == 4 and tweak["metrics"]["rated_in_top_k"] == 5
    assert tweak["metrics"]["details"]["pool_size"] == 6


def test_the_comparison_says_what_moved_what_is_new_and_what_dropped(rated_session):
    tweak = column(rated_session, 1)
    moves = {r["bibcode"]: r["move"] for r in tweak["results"]}
    assert moves == {"C": 2, "A": -1, "F": "new", "D": 0, "G": "new"}
    assert [(d["bibcode"], d["was"], d["grade"]) for d in tweak["dropped"]] == [
        ("B", 2, 0),
        ("E", 5, "skip"),
    ]
    assert tweak["metrics"]["same_as_baseline"] == 3
    assert tweak["metrics"]["relevant_in_top_k"] == 3 and tweak["metrics"]["relevant_change"] == 1


def test_a_tweak_after_rating_counts_its_unrated_records(rated_session, api):
    _, payload = api.post("/sessions/1/runs", {"qf": "abstract^3"})
    assert payload["counts"]["unrated"] == 1, "H is new"
    assert column(payload, 2)["metrics"]["rated_in_top_k"] == 4


# --- rating modes and duplicates --------------------------------------------


def test_author_searches_have_two_groups_stored_as_three_and_zero(search, api, app):
    search(intent="author", query='author:"Elliot, J."')
    ready_to_rate(api)
    _, board = api.get("/sessions/1/board")
    assert [(g["grade"], g["label"]) for g in board["groups"]] == [
        (3, "Right person"),
        (0, "Wrong person"),
    ]
    assert "not a rating group" in put_board(api, {2: ["D"]}, expect=400)["error"]
    payload = put_board(api, {3: ["A"], 0: ["B"]}, {"C": None})
    with app.app_context(), app.session_scope() as db:
        stored = {j.bibcode: j.rating for j in db.execute(select(Judgement)).scalars()}
    assert stored == {"A": 3, "B": 0, "C": None}
    assert column(payload["session"], 0)["metrics"]["headline_label"] == "Precision@5"


def test_the_kind_of_search_is_fixed_once_something_is_rated(search, api):
    search()
    status, payload = api.patch("/sessions/1", {"intent": "author"})
    assert status == 200 and payload["rating_mode"] == "binary"
    api.patch("/sessions/1", {"intent": "topical", "information_need": NEED})
    put_board(api, {3: ["A"]})
    status, payload = api.patch("/sessions/1", {"intent": "author"})
    assert status == 400 and "can't change" in payload["error"]


def test_a_preprint_and_its_published_version_are_rated_once(search, api, adapters):
    adapters["prod"].rankings["default"] = [
        {"bibcode": "2024arXiv0001P", "identifiers": ["2024arXiv0001P", "10.1/x"]},
        "B",
        "C",
        "D",
        "E",
    ]
    adapters["prod"].rankings["title^2"] = [
        {"bibcode": "2024ApJ...1..1Q", "identifiers": ["2024ApJ...1..1Q", "10.1/x"]},
        "B",
        "C",
        "D",
        "E",
    ]
    search()
    api.post("/sessions/1/runs", {"qf": "title^2"})
    assert len(api.get("/sessions/1/board")[1]["unsorted"]) == 5, "the shared DOI makes them one"


def test_titles_keep_sub_and_superscripts_and_lose_everything_else(search, api, adapters):
    adapters["prod"].rankings["default"] = [
        {"bibcode": "A", "title": "N<SUB>2</SUB> ice<script>alert(1)</script> <A href='x'>l</A>"},
    ]
    search()
    title = api.get("/sessions/1/board")[1]["unsorted"][0]["title"]
    assert title == "N<sub>2</sub> ice l"


# --- the ideal order --------------------------------------------------------


def test_groups_are_tied_until_the_rater_orders_them(rated_session, api):
    _, board = api.get("/sessions/1/board")
    assert groups_of(board) == BOARD
    assert [g["ordered"] for g in board["groups"]] == [False] * 4
    assert [(r["bibcode"], r["note"]) for r in board["skipped"]] == [("E", "outside my field")]


def test_reordering_within_a_group_is_kept_and_marks_that_group(rated_session, api):
    board = put_board(api, {**BOARD, 3: ["F", "A"]}, {"E": "outside my field"}, ordered={3})[
        "board"
    ]
    assert groups_of(board)[3] == ["F", "A"]
    assert [g["ordered"] for g in board["groups"]] == [True, False, False, False]


def test_moving_a_record_to_another_group_changes_its_rating(rated_session, api, app):
    payload = put_board(api, {3: ["A", "F", "G"], 2: ["C"], 1: ["D"], 0: ["B"]})
    with app.app_context(), app.session_scope() as db:
        g = db.execute(select(Judgement).where(Judgement.bibcode == "G")).scalar_one()
        assert g.rating == 3
    assert column(payload["session"], 1)["metrics"]["relevant_in_top_k"] == 4


def test_groups_are_stored_top_grade_first_whatever_order_they_arrive_in(rated_session, api, app):
    put_board(api, {0: ["B", "G"], 1: ["D"], 2: ["C"], 3: ["A", "F"]})
    with app.app_context(), app.session_scope() as db:
        rows = db.execute(select(IdealRanking).order_by(IdealRanking.position)).scalars()
        assert [r.tie_group for r in rows] == [3, 3, 2, 1, 0, 0]


# --- serving the frontend ---------------------------------------------------


def test_the_frontend_is_served_for_any_page_path(client, tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<div id=root></div>")
    monkeypatch.setattr(app_module, "FRONTEND_DIST", str(tmp_path))
    with client.get("/sessions/3") as resp:
        assert resp.get_data(as_text=True) == "<div id=root></div>"
    resp = client.get("/api/nope")
    assert resp.status_code == 404 and resp.get_json() == {"error": "No such API endpoint."}
