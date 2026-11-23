"""Golden fixtures for the v0.1 scoring core.

Runs two ways:
    python3 test_metrics.py     (no dependencies)
    pytest test_metrics.py

Expected values are written as explicit arithmetic rather than copied from a
run of the code under test, so the fixtures are an independent check and not a
recording of current behaviour. The parity checks against `ir_measures` and
`pytrec_eval` are skipped when those are not installed, which is the normal
case on `base-microimage`.
"""

from math import log2

from search_eval.scoring.metrics import (
    CrossGradeOrdering,
    compatibility,
    dedupe_canonical,
    default_metric_for_intent,
    ideal_from_pool,
    judged_at_k,
    metric_name,
    ndcg,
    ndcg_bounds,
    overlap_at_k,
    precision,
    rbo,
    reciprocal_rank,
    score_run,
    success_at_k,
    target_rank,
    unrated_docs,
    win_tie_loss,
)

TOL = 1e-12
L2, L3, L4 = log2(2), log2(3), log2(4)


def close(a, b, tol=TOL):
    assert abs(a - b) < tol, f"{a!r} != {b!r} (tol {tol})"


# --- regressions against the three MVP bugs the audit executed ---------------


def test_perfect_ranking_scores_one():
    """The MVP's boost NDCG scored a perfect [3,2,1,0] at 0.620 (synthesis 8)."""
    pool = {"a": 3, "b": 2, "c": 1, "d": 0}
    close(ndcg(["a", "b", "c", "d"], pool, k=10), 1.0)


def test_pool_idcg_not_local_ideal():
    """A run of all 1s re-sorted against itself scores 1.0 — the MVP's
    Similarity Tests bug. Against the session pool it must not."""
    pool = {"a": 3, "b": 1, "c": 1}
    got = ndcg(["b", "c"], pool, k=10)
    expected = (1 / L2 + 1 / L3) / (3 / L2 + 1 / L3 + 1 / L4)
    close(got, expected)
    assert got < 1.0


def test_cross_grade_drag_is_refused():
    """A 2 dragged above a 3 pushes the 'ideal' DCG below the true maximum, and
    NDCG above 1 (the synthesis measured 1.159). Refuse instead of scoring."""
    pool = {"a": 3, "b": 2}
    try:
        ideal_from_pool(pool, within_order=["b", "a"])
    except CrossGradeOrdering:
        pass
    else:
        raise AssertionError("cross-grade ordering was accepted")

    # What the naive version would have produced, for the record.
    naive = (3 / L2 + 2 / L3) / (2 / L2 + 3 / L3)
    assert naive > 1.0


# --- R1: grades drive NDCG, a within-bucket order drives compatibility -------


def test_within_bucket_order_is_invisible_to_ndcg():
    pool = {"c": 3, "a": 2, "b": 2}
    order = ["c", "b", "a"]
    close(
        ndcg(["c", "a", "b"], pool, k=10, within_order=order),
        ndcg(["c", "b", "a"], pool, k=10, within_order=order),
    )


def test_within_bucket_order_is_visible_to_compatibility():
    pool = {"c": 3, "a": 2, "b": 2}
    order = ["c", "b", "a"]
    agrees = compatibility(["c", "b", "a"], pool, within_order=order)
    disagrees = compatibility(["c", "a", "b"], pool, within_order=order)
    close(agrees, 1.0)
    assert disagrees < agrees


def test_ideal_is_grade_descending():
    pool = {"a": 1, "b": 3, "c": 0, "d": 2}
    assert [pool[r] for r in ideal_from_pool(pool)] == [3, 2, 1, 0]


# --- R2: unjudged records are a reported quantity, not a zero ----------------


def test_judged_at_k_and_holes():
    pool = {"a": 3, "c": 1}
    ranking = ["a", "b", "c", "d"]
    close(judged_at_k(ranking, pool, k=4), 0.5)
    assert unrated_docs(ranking, pool, k=4) == ["b", "d"]


def test_bounds_are_not_monotone_in_the_assigned_grade():
    """Grading a hole 3 raises the run's DCG and the pool's IDCG, so the
    optimistic bound is not 'assume every unjudged record is a 3'."""
    pool = {"a": 1, "b": 1}
    ranking = ["a", "b", "u"]

    as_zero = ndcg(ranking, {**pool, "u": 0}, k=3)
    as_three = ndcg(ranking, {**pool, "u": 3}, k=3)
    close(as_zero, 1.0)
    close(as_three, (1 / L2 + 1 / L3 + 3 / L4) / (3 / L2 + 1 / L3 + 1 / L4))
    assert as_three < as_zero, "the 3-everywhere assumption is not the upper bound"

    lo, hi, n_holes, exhaustive = ndcg_bounds(ranking, pool, k=3)
    assert (n_holes, exhaustive) == (1, True)
    close(hi, as_zero)
    close(lo, as_three)


def test_bounds_collapse_when_nothing_is_unjudged():
    pool = {"a": 3, "b": 1}
    lo, hi, n_holes, exhaustive = ndcg_bounds(["a", "b"], pool, k=2)
    close(lo, hi)
    assert (n_holes, exhaustive) == (0, True)


def test_too_many_holes_is_not_enumerated():
    pool = {"a": 3}
    ranking = ["a"] + [f"u{i}" for i in range(9)]
    lo, hi, n_holes, exhaustive = ndcg_bounds(ranking, pool, k=10, max_unjudged=8)
    assert (lo, hi, n_holes, exhaustive) == (0.0, 1.0, 9, False)


# --- R4: the default metric per intent ---------------------------------------


def test_author_precision_counts_only_judged():
    """Of the records we looked at, how many were the intended person."""
    pool = {"a": 3, "b": 0}
    ranking = ["a", "b", "unjudged"]
    close(precision(ranking, pool, k=3, rel=2, judged_only=True), 0.5)
    close(precision(ranking, pool, k=3, rel=2, judged_only=False), 1 / 3)


def test_known_item_success_and_rank():
    pool = {"x": 0, "y": 3}
    ranking = ["x", "y", "z"]
    close(success_at_k(ranking, pool, k=2), 1.0)
    close(success_at_k(ranking, pool, k=1), 0.0)
    assert target_rank(ranking, pool) == 2
    close(reciprocal_rank(ranking, pool), 0.5)


def test_intent_defaults():
    assert default_metric_for_intent("topical") == "ndcg"
    assert default_metric_for_intent("author") == "precision"
    assert default_metric_for_intent("known_item") == "success"
    try:
        default_metric_for_intent("vibes")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown intent was accepted")


# --- the change strip --------------------------------------------------------


def test_overlap_and_rbo_on_identical_runs():
    run = ["a", "b", "c"]
    close(overlap_at_k(run, run, k=3), 1.0)
    close(rbo(run, run, p=0.9, ext=True), 1.0)


def test_rbo_ext_exceeds_the_truncated_lower_bound():
    a, b = ["a", "b", "c"], ["a", "c", "b"]
    assert rbo(a, b, p=0.9, ext=True) > rbo(a, b, p=0.9, ext=False)


def test_rbo_matches_the_closed_form_on_one_swap():
    """Top-1 agrees, ranks 2-3 are swapped, so agreement is 1/1, 1/2, 3/3."""
    a, b = ["a", "b", "c"], ["a", "c", "b"]
    p = 0.9
    acc = (1 / 1) * p + (1 / 2) * p**2 + (3 / 3) * p**3
    close(rbo(a, b, p=p, ext=True), (3 / 3) * p**3 + (1 - p) / p * acc)


def test_disjoint_runs_score_zero_overlap():
    close(overlap_at_k(["a", "b"], ["c", "d"], k=2), 0.0)
    close(rbo(["a", "b"], ["c", "d"], p=0.9, ext=True), 0.0)


# --- R3: one canonical record earns gain once --------------------------------


def test_dedupe_keeps_the_first_copy():
    ranking = ["preprint", "x", "published", "y"]
    canonical = {"preprint": "paper", "published": "paper"}
    assert dedupe_canonical(ranking, canonical) == ["paper", "x", "y"]


def test_dedupe_stops_a_duplicate_earning_gain_twice():
    pool = {"paper": 3, "x": 0}
    raw = ["preprint", "published", "x"]
    canonical = {"preprint": "paper", "published": "paper"}
    deduped = dedupe_canonical(raw, canonical)
    paid_twice = ndcg(["paper", "paper", "x"], pool, k=3)
    paid_once = ndcg(deduped, pool, k=3)
    assert paid_twice > paid_once
    close(paid_once, 1.0)


# --- stored rows -------------------------------------------------------------


def test_metric_names_carry_their_parameters():
    assert metric_name("ndcg", k=10, gain="linear") == "ndcg_lin@10"
    assert metric_name("ndcg", k=10, gain="exp") == "ndcg_exp@10"
    assert metric_name("rbo_ext", k=30, p=0.9) == "rbo_ext_p0.9@30"
    assert metric_name("p", k=10, rel=2) == "p@10_rel2"
    assert metric_name("judged", k=10) == "judged@10"


def test_score_run_stores_what_is_needed_to_recompute():
    pool = {"a": 3, "b": 2, "c": 1}
    row = score_run(["a", "b", "hole"], pool, k=3, gain="linear")
    p = row["params"]
    assert p["pool_size"] == 3
    assert p["judged_in_top_k"] == 2
    assert p["unrated_docs"] == ["hole"]
    assert p["code_version"].startswith("scoring/")
    close(p["idcg"], 3 / L2 + 2 / L3 + 1 / L4)
    assert "ndcg_lin@10" not in row["metrics"]
    assert "ndcg_lin@3" in row["metrics"]


def test_both_gain_functions_are_available_and_named_apart():
    pool = {"a": 3, "b": 1}
    lin = score_run(["b", "a"], pool, k=2, gain="linear")["metrics"]["ndcg_lin@2"]
    exp = score_run(["b", "a"], pool, k=2, gain="exp")["metrics"]["ndcg_exp@2"]
    close(lin, (1 / L2 + 3 / L3) / (3 / L2 + 1 / L3))
    close(exp, (1 / L2 + 7 / L3) / (7 / L2 + 1 / L3))
    assert exp < lin, "exponential gain punishes the misplaced 3 harder"


def test_the_two_open_gate_rules_can_disagree():
    """D3 is unsettled, so both gates are computed and neither is privileged.

    One hole at rank 10 of a thin pool: 9 of 10 judged clears any sane count
    bar, while that single hole still moves NDCG by 0.21, because grading it 3
    raises IDCG as well.
    """
    pool = {"a": 3, **{f"z{i}": 0 for i in range(8)}}
    ranking = ["a"] + [f"z{i}" for i in range(8)] + ["hole"]

    counted = score_run(ranking, pool, k=10, incomplete_by="judged_count", min_judged=0.8)
    by_count = counted["params"]
    by_width = score_run(ranking, pool, k=10, incomplete_by="interval_width", max_interval=0.10)[
        "params"
    ]

    close(counted["metrics"]["judged@10"], 0.9)
    assert by_count["incomplete"] is False, "9 of 10 judged clears a 0.8 bar"
    assert by_width["incomplete"] is True, "the interval is wider than 0.10"

    close(by_width["ndcg_hi"], 1.0)
    close(by_width["ndcg_lo"], (3 / L2 + 3 / log2(11)) / (3 / L2 + 3 / L3))
    assert by_width["ndcg_hi"] - by_width["ndcg_lo"] > 0.20


def test_unknown_gate_is_refused():
    try:
        score_run(["a"], {"a": 3}, incomplete_by="feelings")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown gate was accepted")


def test_win_tie_loss_reports_its_band_and_worst_loss():
    deltas = [0.12, -0.03, 0.0, -0.20]
    wide = win_tie_loss(deltas, tie_band=0.05)
    narrow = win_tie_loss(deltas, tie_band=0.01)
    assert (wide["win"], wide["tie"], wide["loss"]) == (1, 2, 1)
    assert (narrow["win"], narrow["tie"], narrow["loss"]) == (1, 1, 2)
    close(wide["worst_loss"], -0.20)


# --- parity against the libraries, when they are installed -------------------


def test_parity_with_ir_measures():
    """`ir_measures`' nDCG is LINEAR gain (the trec_eval convention).

    Measured here, not assumed: this is the evidence behind D1's "every library
    defaults to linear". Quepid's exponential default is the outlier, so if AK
    and JB choose exponential, no library will reproduce the stored number and
    the name has to say `ndcg_exp@10`. Do not "fix" the code to match the
    library in that case.
    """
    try:
        import ir_measures
        from ir_measures import nDCG
    except ImportError:
        print("  (skipped: ir_measures not installed)")
        return
    pool = {"a": 3, "b": 2, "c": 1, "d": 0}
    ranking = ["c", "a", "d", "b"]
    qrels = {"q": dict(pool)}
    run = {"q": {d: float(len(ranking) - i) for i, d in enumerate(ranking)}}
    theirs = ir_measures.calc_aggregate([nDCG @ 10], qrels, run)[nDCG @ 10]

    close(ndcg(ranking, pool, k=10, gain="linear"), theirs, tol=1e-9)
    assert abs(ndcg(ranking, pool, k=10, gain="exp") - theirs) > 0.05


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  pass  {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
