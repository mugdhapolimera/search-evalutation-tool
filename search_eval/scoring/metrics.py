"""Scoring core for the search evaluation tool, v0.1.

Stdlib only, so it runs on `base-microimage` with no wheels to vendor.

This replaces the MVP's metric code rather than porting it (synthesis convergence 8:
the MVP's RBO never ran, its "Jaccard" compared characters, its cosine always
returned 0, and its boost NDCG scored a perfect [3,2,1,0] at 0.620).

What is settled, and therefore enforced here
--------------------------------------------
R1  Rating buckets ARE the grades. The ideal ranking comes from grades; a rater's
    within-bucket order is a separate position that can never contradict a grade.
    `ideal_from_pool` raises on a cross-grade ordering instead of silently
    producing NDCG > 1.
R2  Unjudged is never a 0 that pretends to be a judgement. Every NDCG row carries
    `judged_at_k` and `unrated_docs`; `ndcg_bounds` says how much the unjudged
    records could move the number.
R3  One canonical record earns gain once (`dedupe_canonical`).
R4  Default metric per intent: topical NDCG@10, author P@10 over judged,
    known-item success@k plus the target's rank (`default_metric_for_intent`).
R10 Compatibility (Clarke, Vtyurina & Smucker, TOIS 2021) as the secondary that
    does read a rater's ordering.
C7  Every metric row stores its own parameters and a version, so a stored number
    can be recomputed.

What is still open, and therefore a parameter here, not a default
----------------------------------------------------------------
D1  Gain: `gain="linear"` or `"exp"`. The choice lands in the metric name
    (`ndcg_lin@10` / `ndcg_exp@10`), so both can coexist in one table.
D3  The "incomplete" gate: `incomplete_by` takes "judged_count" or
    "interval_width". Both are computed; neither is privileged.
D7  Tie band for win/tie/loss: `tie_band` is an argument with no default blessed.
D2  Library choice is a deployment question, not a semantics question. These
    functions are the oracle either way: `test_metrics.py` checks them against
    `ir_measures` / `pytrec_eval` when those are installed.
"""

from __future__ import annotations

from itertools import product
from math import log2

CODE_VERSION = "scoring/0.1.0"

GRADES = (0, 1, 2, 3)

GAIN = {
    "linear": lambda g: float(g),
    "exp": lambda g: float(2**g - 1),
}

GAIN_SHORT = {"linear": "lin", "exp": "exp"}


class CrossGradeOrdering(ValueError):
    """A rater's within-bucket order contradicts the grades.

    Raised instead of returning a score, because the naive answer is an ideal
    DCG below the true maximum, and therefore an NDCG above 1 (the synthesis
    measured 1.159). The fix belongs upstream: to move a record above a 3,
    regrade it.
    """


# --- gains ------------------------------------------------------------------


def dcg(grades, k, gain="linear"):
    """Discounted cumulative gain over an already-ordered list of grades."""
    f = GAIN[gain]
    return sum(f(g) / log2(i + 2) for i, g in enumerate(grades[:k]))


def ideal_from_pool(pool, within_order=None):
    """The ideal ranking for a session: the judged pool, grade-descending.

    `pool` maps record id -> grade (0..3). Only judged records appear; an
    unjudged record has no entry, and never a 0.

    `within_order`, when given, is the rater's own ordering of records. It is
    applied *inside* each grade bucket only. If it places a lower-graded record
    above a higher-graded one, that is a contradiction, not a preference, and
    raises `CrossGradeOrdering`.
    """
    if within_order is not None:
        seen = [r for r in within_order if r in pool]
        for earlier_i, earlier in enumerate(seen):
            for later in seen[earlier_i + 1 :]:
                if pool[later] > pool[earlier]:
                    raise CrossGradeOrdering(
                        f"{later!r} (grade {pool[later]}) is ordered above "
                        f"{earlier!r} (grade {pool[earlier]}); regrade instead"
                    )
        rank_in_order = {r: i for i, r in enumerate(within_order)}
        tiebreak = lambda r: rank_in_order.get(r, len(within_order))  # noqa: E731
    else:
        tiebreak = lambda r: 0  # noqa: E731

    return sorted(pool, key=lambda r: (-pool[r], tiebreak(r), str(r)))


def idcg_from_pool(pool, k, gain="linear", within_order=None):
    """IDCG@k from the session's shared judged pool.

    Never from the run's own list: re-sorting a run of all-1s against itself
    scores 1.0, which is the MVP's Similarity Tests bug. A shared IDCG is also
    what makes per-query ΔNDCG carry the same sign as ΔDCG.
    """
    ideal = ideal_from_pool(pool, within_order)
    return dcg([pool[r] for r in ideal], k, gain)


# --- the metrics -------------------------------------------------------------


def ndcg(ranking, pool, k=10, gain="linear", within_order=None, condensed=False):
    """NDCG@k against a pool-derived IDCG.

    Unjudged records in `ranking` contribute no gain, which is a statement about
    this run, not a judgement about those records; read it with `judged_at_k`
    and `ndcg_bounds`. `condensed=True` drops unjudged records first (Sakai
    2007) and shortens the list, which trades one bias for another.
    """
    if condensed:
        ranking = [r for r in ranking if r in pool]
    run_grades = [pool.get(r, 0) for r in ranking]
    denom = idcg_from_pool(pool, k, gain, within_order)
    return dcg(run_grades, k, gain) / denom if denom else 0.0


def judged_at_k(ranking, pool, k=10):
    """Share of the top k that has been judged at all (ES `unrated_docs` inverted)."""
    top = ranking[:k]
    return sum(r in pool for r in top) / len(top) if top else 0.0


def unrated_docs(ranking, pool, k=10):
    """The unjudged record ids in the top k, so the UI can ask for exactly those."""
    return [r for r in ranking[:k] if r not in pool]


def precision(ranking, pool, k=10, rel=2, judged_only=True):
    """P@k. `rel=2` binarises the 0-3 scale at "relevant" (synthesis R8).

    `judged_only=True` divides by the judged records in the top k, which is the
    author-disambiguation number: of the records we looked at, how many were the
    intended person. With `judged_only=False` the denominator is k, so unjudged
    records count against the run.
    """
    top = ranking[:k]
    hits = sum(pool.get(r, -1) >= rel for r in top)
    denom = sum(r in pool for r in top) if judged_only else len(top)
    return hits / denom if denom else 0.0


def success_at_k(ranking, pool, k=10, rel=2):
    """Known-item: did the target appear in the top k at all."""
    return 1.0 if any(pool.get(r, -1) >= rel for r in ranking[:k]) else 0.0


def target_rank(ranking, pool, rel=2):
    """Known-item: 1-based rank of the first qualifying record, or None."""
    for i, r in enumerate(ranking):
        if pool.get(r, -1) >= rel:
            return i + 1
    return None


def reciprocal_rank(ranking, pool, rel=2):
    rank = target_rank(ranking, pool, rel)
    return 1.0 / rank if rank else 0.0


def overlap_at_k(a, b, k=10):
    """Share of the top k the two runs share, ignoring order. The change strip's
    first number: when this is 1.0, any Δ is pure reordering."""
    top_a, top_b = a[:k], b[:k]
    denom = max(len(top_a), len(top_b))
    return len(set(top_a) & set(top_b)) / denom if denom else 1.0


def rbo(a, b, p=0.9, k=None, ext=True):
    """Rank-biased overlap (Webber, Moffat & Zobel 2010).

    `ext=True` is RBO_ext (eq. 32), the point estimate to report. `ext=False` is
    the truncated lower bound, which is what the `rbo` package's plain `rbo()`
    returns and is not comparable to published RBO figures.
    """
    if k is not None:
        a, b = a[:k], b[:k]
    depth = min(len(a), len(b))
    if depth == 0:
        return 0.0
    seen_a, seen_b = set(), set()
    agree = 0
    acc = 0.0
    for d in range(1, depth + 1):
        x, y = a[d - 1], b[d - 1]
        agree += (x == y) + (x in seen_b) + (y in seen_a)
        seen_a.add(x)
        seen_b.add(y)
        acc += (agree / d) * p**d
    if not ext:
        return (1 - p) / p * acc
    return (agree / depth) * p**depth + (1 - p) / p * acc


def compatibility(ranking, pool, p=0.95, within_order=None):
    """Compatibility (Clarke, Vtyurina & Smucker, TOIS 2021 / CIKM 2020).

    RBO against the ideal ranking, normalised by the ideal's own score. This is
    the published metric that reads a rater's within-bucket ordering: with
    grades alone it tracks NDCG@10 at about tau 0.91, and it gains sensitivity
    once a within-bucket order exists. `ir_measures` ships it as `Compat`.
    """
    ideal = [r for r in ideal_from_pool(pool, within_order) if pool[r] > 0]
    if not ideal:
        return 0.0
    depth = max(len(ranking), len(ideal))

    def rbo_against_ideal(run):
        seen_run, seen_ideal = set(), set()
        acc = weight_sum = 0.0
        weight = 1.0
        for i in range(depth):
            if i < len(run):
                seen_run.add(run[i])
            if i < len(ideal):
                seen_ideal.add(ideal[i])
            acc += weight * len(seen_run & seen_ideal) / (i + 1)
            weight_sum += weight
            weight *= p
        return acc / weight_sum

    best = rbo_against_ideal(ideal)
    return rbo_against_ideal(ranking) / best if best else 0.0


# --- what the unjudged records could do to the number ------------------------


def ndcg_bounds(ranking, pool, k=10, gain="linear", max_unjudged=8):
    """(min, max) NDCG@k over every grade assignment to the unjudged top-k records.

    The bounds are not monotone in the assigned grade: grading an unjudged
    record 3 raises the run's DCG *and* the pool's IDCG, so "assume all
    unjudged are 3" is not the optimistic bound. The assignments are therefore
    enumerated.

    Scope: the unjudged records retrieved in this run's top k. Unjudged records
    elsewhere in the corpus could only raise IDCG, which bounds the score from
    above and is a different question.

    Returns (lo, hi, n_unjudged, exhaustive). With more than `max_unjudged`
    holes the enumeration is skipped, `exhaustive` is False and the run should
    simply be reported as too thin to score.
    """
    holes = unrated_docs(ranking, pool, k)
    if not holes:
        point = ndcg(ranking, pool, k, gain)
        return point, point, 0, True
    if len(holes) > max_unjudged:
        return 0.0, 1.0, len(holes), False

    lo, hi = None, None
    for assignment in product(GRADES, repeat=len(holes)):
        filled = dict(pool)
        filled.update(dict(zip(holes, assignment)))
        score = ndcg(ranking, filled, k, gain)
        lo = score if lo is None else min(lo, score)
        hi = score if hi is None else max(hi, score)
    return lo, hi, len(holes), True


# --- canonicalisation --------------------------------------------------------


def dedupe_canonical(ranking, canonical_of=None):
    """Collapse a run to canonical records, keeping the first copy's position.

    Only the first copy earns gain: Bernstein & Zobel (2005) found 16.6% of
    relevant documents were redundant, and a preprint sitting beside its
    published version would otherwise be paid for twice.
    """
    canonical_of = canonical_of or {}
    out, seen = [], set()
    for r in ranking:
        c = canonical_of.get(r, r)
        if c in seen:
            continue
        seen.add(c)
        out.append(c)
    return out


# --- rows ready to store -----------------------------------------------------


def metric_name(base, k=None, gain=None, p=None, rel=None, condensed=False):
    """A stored name that says how the number was produced: `ndcg_lin@10`,
    `rbo_ext_p0.9@30`, `p@10_rel2`."""
    name = base
    if gain:
        name += "_" + GAIN_SHORT[gain]
    if p is not None:
        name += f"_p{p:g}"
    if k is not None:
        name += f"@{k}"
    if rel is not None:
        name += f"_rel{rel}"
    if condensed:
        name += "_cond"
    return name


DEFAULT_METRIC_BY_INTENT = {
    "topical": "ndcg",
    "author": "precision",
    "known_item": "success",
}


def default_metric_for_intent(intent):
    """R4. Author queries get P@k over judged, because NDCG is trivially 1 when
    every result is by the right person; known-item gets success@k plus the
    target's rank. Graded and thumbs sessions are never averaged together."""
    try:
        return DEFAULT_METRIC_BY_INTENT[intent]
    except KeyError:
        raise ValueError(
            f"unknown intent {intent!r}; expected one of " f"{sorted(DEFAULT_METRIC_BY_INTENT)}"
        ) from None


def score_run(
    ranking,
    pool,
    k=10,
    gain="linear",
    intent="topical",
    within_order=None,
    rel=2,
    rbo_p=0.9,
    compat_p=0.95,
    incomplete_by="judged_count",
    min_judged=0.8,
    max_interval=0.10,
    canonical_of=None,
    other_ranking=None,
):
    """Score one run and return rows that carry their own parameters.

    `incomplete_by` picks which open gate rule (D3) to apply: "judged_count"
    marks a run incomplete below `min_judged` judged in the top k, while
    "interval_width" marks it incomplete when the NDCG interval is wider than
    `max_interval` or a hole sits at rank 1 or 2. Both numbers are returned
    either way, so the choice changes the flag and nothing else.
    """
    ranking = dedupe_canonical(ranking, canonical_of)
    rows = {}

    lo, hi, n_holes, exhaustive = ndcg_bounds(ranking, pool, k, gain)
    rows[metric_name("ndcg", k=k, gain=gain)] = ndcg(ranking, pool, k, gain, within_order)
    rows[metric_name("ndcg", k=k, gain=gain, condensed=True)] = ndcg(
        ranking, pool, k, gain, within_order, condensed=True
    )
    rows[metric_name("judged", k=k)] = judged_at_k(ranking, pool, k)
    rows[metric_name("p", k=k, rel=rel)] = precision(ranking, pool, k, rel)
    rows[metric_name("compat", p=compat_p)] = compatibility(ranking, pool, compat_p, within_order)

    if intent == "known_item":
        rows[metric_name("success", k=k, rel=rel)] = success_at_k(ranking, pool, k, rel)
        rows["rr"] = reciprocal_rank(ranking, pool, rel)

    if other_ranking is not None:
        other = dedupe_canonical(other_ranking, canonical_of)
        rows[metric_name("overlap", k=k)] = overlap_at_k(ranking, other, k)
        rows[metric_name("rbo_ext", k=k, p=rbo_p)] = rbo(ranking, other, rbo_p, k=k, ext=True)

    holes_at_top = any(r not in pool for r in ranking[:2])
    if incomplete_by == "judged_count":
        incomplete = rows[metric_name("judged", k=k)] < min_judged
    elif incomplete_by == "interval_width":
        incomplete = (not exhaustive) or (hi - lo) > max_interval or holes_at_top
    else:
        raise ValueError(
            f"unknown gate {incomplete_by!r}; expected 'judged_count' or " "'interval_width'"
        )

    return {
        "metrics": rows,
        "params": {
            "k": k,
            "gain": gain,
            "intent": intent,
            "rel": rel,
            "rbo_p": rbo_p,
            "compat_p": compat_p,
            "default_metric": default_metric_for_intent(intent),
            "idcg": idcg_from_pool(pool, k, gain, within_order),
            "pool_size": len(pool),
            "judged_in_top_k": sum(r in pool for r in ranking[:k]),
            "unrated_docs": unrated_docs(ranking, pool, k),
            "ndcg_lo": lo,
            "ndcg_hi": hi,
            "ndcg_interval_exhaustive": exhaustive,
            "has_within_order": within_order is not None,
            "gate": incomplete_by,
            "incomplete": incomplete,
            "code_version": CODE_VERSION,
        },
    }


def win_tie_loss(deltas, tie_band):
    """Per-query win/tie/loss counts. `tie_band` has no blessed default: D7 put
    0.05 and 0.01 against each other and neither is calibrated, so measure
    re-rating variance before fixing it."""
    wins = sum(d > tie_band for d in deltas)
    losses = sum(d < -tie_band for d in deltas)
    return {
        "win": wins,
        "tie": len(deltas) - wins - losses,
        "loss": losses,
        "tie_band": tie_band,
        "worst_loss": min(deltas) if deltas else 0.0,
    }
