"""The experiment loop end to end, through the Flask test client.

Expected metric values are written out from the definition, not copied from
a run, so these tests check the arithmetic and not just that it is stable.
"""

from math import log2

from sqlalchemy import select

from search_eval.models import IdealRanking, Judgement, Metric, RatingSession, Run

TOL = 1e-9

# Baseline (default) top 5: A B C D E.  Variant (qf=title^2) top 5: C A F D G.
RATINGS = {"A": "3", "B": "0", "C": "2", "D": "1", "E": "skip", "F": "3", "G": "0"}


def rate(client, session_id, ratings, **notes):
    form = {f"rating:{b}": v for b, v in ratings.items()}
    form.update({f"note:{b}": n for b, n in notes.items()})
    return client.post(f"/sessions/{session_id}/rate", data=form)


def latest(app, run_id, name):
    with app.app_context(), app.session_scope() as db:
        rows = (
            db.execute(
                select(Metric)
                .where(Metric.run_id == run_id, Metric.name == name)
                .order_by(Metric.id)
            )
            .scalars()
            .all()
        )
        return rows[-1].value, rows[-1].params


def runs_of(app, session_id):
    with app.app_context(), app.session_scope() as db:
        return [
            (r.id, r.status, r.error)
            for r in db.execute(select(Run).where(Run.session_id == session_id).order_by(Run.id))
            .scalars()
            .all()
        ]


# --- health -----------------------------------------------------------------


def test_health_check_actually_checks_the_database(client):
    """The MVP's health check reported the database unhealthy under SQLAlchemy
    2.x, so any readiness probe built on it failed. adsmutils' runs SELECT 1."""
    resp = client.get("/ready")
    assert resp.status_code == 200 and resp.get_json() == {"ready": True}
    assert client.get("/alive").get_json() == {"alive": True}


# --- starting a session ------------------------------------------------------


def test_start_runs_both_columns_and_goes_to_rating(client, new_session, adapters, app):
    resp = new_session()
    assert resp.status_code == 302 and resp.headers["Location"].endswith("/sessions/1/rate")
    calls = adapters["prod"].calls
    assert [c[2] for c in calls] == [{}, {"qf": "title^2"}]
    assert all(c[1] == 5 for c in calls), "ROWS_RETRIEVED is passed as rows"
    assert [status for _, status, _ in runs_of(app, 1)] == ["ok", "ok"]


def test_identical_columns_are_refused(client, new_session, app):
    resp = new_session(b_qf="")
    assert resp.status_code == 400
    assert b"same environment with the same parameters" in resp.data
    with app.app_context(), app.session_scope() as db:
        assert db.execute(select(RatingSession)).first() is None


def test_bad_qf_is_refused_and_nothing_is_stored(client, new_session, app, adapters):
    resp = new_session(b_qf="body^2")
    assert resp.status_code == 400 and b"not in QF_FIELDS" in resp.data
    assert adapters["prod"].calls == []
    with app.app_context(), app.session_scope() as db:
        assert db.execute(select(RatingSession)).first() is None


def test_a_failed_side_is_kept_and_explained(client, new_session, adapters, app):
    adapters["dev"].fail_with = (
        "dev: HTTP 401 — The access token provided is expired, revoked, malformed, or invalid"
    )
    new_session(env_b="dev", b_qf="")
    statuses = runs_of(app, 1)
    assert [s for _, s, _ in statuses] == ["ok", "error"]
    assert "HTTP 401" in statuses[1][2]
    page = client.get("/sessions/1/rate").get_data(as_text=True)
    assert "One side did not run" in page and "HTTP 401" in page


# --- rating -----------------------------------------------------------------


def test_rating_pool_is_the_merged_union_and_hides_the_environments(client, new_session):
    new_session()
    page = client.get("/sessions/1/rate").get_data(as_text=True)
    for bibcode in "ABCDEFG":
        assert f"Title of {bibcode}" in page
    assert page.count("data-bibcode=") == 7, "A, C and D appear in both runs but are rated once"
    assert "Production" not in page and "Baseline" not in page and "Variant" not in page


def test_pool_order_is_stable_and_owes_nothing_to_either_ranking(client, new_session):
    new_session()
    first = client.get("/sessions/1/rate").get_data(as_text=True)
    second = client.get("/sessions/1/rate").get_data(as_text=True)

    def order(page):
        return sorted("ABCDEFG", key=lambda b: page.index(f"Title of {b}"))

    assert order(first) == order(second)
    assert order(first) != list("ABCDEFG"), "not the baseline's order"
    assert order(first) != list("CAFDGBE"), "not the variant's order either"


def test_ratings_store_integers_skips_as_null_and_build_grade_buckets(client, new_session, app):
    new_session()
    resp = rate(client, 1, RATINGS, E="outside my field")
    assert resp.status_code == 302 and resp.headers["Location"].endswith("/sessions/1")
    with app.app_context(), app.session_scope() as db:
        stored = {j.bibcode: (j.rating, j.note) for j in db.execute(select(Judgement)).scalars()}
        ideal = db.execute(select(IdealRanking).order_by(IdealRanking.position)).scalars().all()
        assert stored["A"] == (3, None) and stored["B"] == (0, None)
        assert stored["E"] == (None, "outside my field"), "a skip is unjudged, not a 0"
        assert [r.tie_group for r in ideal] == [3, 3, 2, 1, 0, 0]
        assert "E" not in {r.bibcode for r in ideal}


# --- results ----------------------------------------------------------------


def test_metrics_are_computed_against_one_shared_pool(client, new_session, app):
    new_session()
    rate(client, 1, RATINGS)
    (baseline_id, _, _), (variant_id, _, _) = runs_of(app, 1)

    # Pool {A:3, F:3, C:2, D:1, B:0, G:0}; E is skipped. IDCG@5 from grades 3,3,2,1,0.
    idcg = 3 / log2(2) + 3 / log2(3) + 2 / log2(4) + 1 / log2(5)
    baseline_ndcg = (3 / log2(2) + 2 / log2(4) + 1 / log2(5)) / idcg  # A B C D E
    variant_ndcg = (2 / log2(2) + 3 / log2(3) + 3 / log2(4) + 1 / log2(5)) / idcg  # C A F D G

    got_baseline, params = latest(app, baseline_id, "ndcg_lin@5")
    got_variant, _ = latest(app, variant_id, "ndcg_lin@5")
    assert abs(got_baseline - baseline_ndcg) < TOL
    assert abs(got_variant - variant_ndcg) < TOL
    assert abs(params["idcg"] - idcg) < TOL and params["pool_size"] == 6

    judged, params = latest(app, baseline_id, "judged@5")
    assert judged == 0.8 and params["unrated_docs"] == ["E"]
    overlap, _ = latest(app, variant_id, "overlap@5")
    assert overlap == 0.6, "A, C and D are shared out of five"


def test_results_page_reveals_the_environments_and_shows_the_difference(client, new_session):
    new_session()
    rate(client, 1, RATINGS)
    page = client.get("/sessions/1").get_data(as_text=True)
    assert "Baseline" in page and "Production" in page and "qf=title^2" in page
    assert "ndcg_lin@5" in page and "+0.220" in page


def test_results_before_rating_say_there_is_nothing_to_measure(client, new_session):
    new_session()
    page = client.get("/sessions/1").get_data(as_text=True)
    assert "Nothing is rated yet" in page


# --- the tuning loop --------------------------------------------------------


def test_a_variant_that_brings_in_unrated_records_goes_to_rating_first(client, new_session, app):
    new_session()
    rate(client, 1, RATINGS)
    resp = client.post("/sessions/1/variants", data={"env": "prod", "qf": "abstract^3"})
    assert resp.status_code == 302 and resp.headers["Location"].endswith("/sessions/1/rate?new=1")
    page = client.get("/sessions/1/rate?new=1").get_data(as_text=True)
    assert "brought in 1 record nobody has rated yet" in " ".join(page.split())

    rate(client, 1, {"H": "2"})
    _, _, (third_id, status, _) = runs_of(app, 1)
    assert status == "ok"
    judged, _ = latest(app, third_id, "judged@5")
    assert judged == 1.0, "H B C A D are all rated now"
    assert client.get("/sessions/1").get_data(as_text=True).count('class="column') == 3


def test_a_variant_with_nothing_new_goes_straight_to_results(client, new_session, adapters):
    adapters["prod"].rankings["keyword^2"] = ["A", "C", "B", "D", "E"]
    new_session()
    rate(client, 1, RATINGS)
    resp = client.post("/sessions/1/variants", data={"env": "prod", "qf": "keyword^2"})
    assert resp.headers["Location"].endswith("/sessions/1")


def test_a_bad_variant_is_explained_on_the_results_page(client, new_session, app):
    new_session()
    resp = client.post("/sessions/1/variants", data={"env": "prod", "qf": "title^-1"})
    assert resp.status_code == 302 and "error=" in resp.headers["Location"]
    page = client.get(resp.headers["Location"]).get_data(as_text=True)
    assert "is not field or field^weight" in page
    assert len(runs_of(app, 1)) == 2, "no run was stored for the bad variant"


# --- rating modes and duplicates --------------------------------------------


def test_author_sessions_store_thumbs_as_three_and_zero(client, new_session, app):
    new_session(intent="author", query='author:"Elliot, J."')
    rate(client, 1, {"A": "up", "B": "down", "C": "skip"})
    with app.app_context(), app.session_scope() as db:
        session = db.execute(select(RatingSession)).scalar_one()
        stored = {j.bibcode: j.rating for j in db.execute(select(Judgement)).scalars()}
        assert session.rating_mode == "binary"
        assert stored == {"A": 3, "B": 0, "C": None}
    page = client.get("/sessions/1").get_data(as_text=True)
    assert "p@5_rel2" in page, "author queries lead with precision, not NDCG"


def test_ratings_for_records_outside_the_session_are_refused(client, new_session, app):
    """A client that sends an HTML-escaped or invented bibcode must fail loudly:
    a judgement for a record no run returned would change IDCG invisibly."""
    new_session()
    resp = rate(client, 1, {"A": "3", "2024A&amp;A...682L..24S": "3"})
    assert resp.status_code == 400
    with app.app_context(), app.session_scope() as db:
        assert db.execute(select(Judgement)).first() is None, "nothing from that form is kept"


def test_graded_values_are_refused_in_binary_mode(client, new_session):
    new_session(intent="author")
    assert rate(client, 1, {"A": "3"}).status_code == 400


def test_a_preprint_and_its_published_version_are_rated_once(client, new_session, adapters):
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
    new_session()
    page = client.get("/sessions/1/rate").get_data(as_text=True)
    assert page.count("data-bibcode=") == 5, "the shared DOI makes them one record"
