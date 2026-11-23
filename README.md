# search-evalutation-tool

Tool to evaluate any changes made to search results and compare, rate, rank result sets.

Run one query in two configurations, rate the records they return without seeing which
side returned what, and see how each ranking measures up. Then change `qf` or `boost` and
see the effect straight away, against the same ratings. Every number is computed on the
server and stored with the run, the exact parameters sent, and how it was computed.

Design: the RFC *Design and Plan for new Search Evaluation Tool* (Jira PT-23).

## Status: v0.1 scaffold

Works today:

- Two-column sessions on any configured environment, through each environment's full API
  stack, never raw Solr.
- A blinded, merged, deduplicated rating pool. A preprint and its published version are
  rated once.
- 0–3 ratings for topical and known-item searches, right/wrong person for author searches,
  and Skip. A skip is stored as unjudged and never scored as 0.
- Metrics stored per run: NDCG@10 against one shared pool, judged@10, the range NDCG
  could still take given the unrated records, P@10, success@10 for known items, overlap@10
  and RBO between runs.
- The tuning loop: add a variant, rate only what it newly brought in, compare.

Not yet:

- Login through SciX accounts with a dedicated scope.
- The BeeHive image and manifests, to be modelled on ADSScanExplorerService.
- An order within a grade bucket (drag to rank).
- Google Scholar.
- Frozen regression sets.

## Two things the API does that every experiment depends on

Both were measured against production on 23 Nov 2026, using `debugQuery=true`.

**`qf` replaces the fields searched; it doesn't reweight production's.** `qf=title^2`
searches titles only. On "triton atmosphere" it matches 157 records instead of 1,127, and
`title^1` matches the same 157. To change one weight, start from production's own field
weights, read from the parsed query and stored as `PRODUCTION_DEFAULT_QF` in `config.py`:

```
abstract^0.7 ack^0.8 author^0.85 bibstem^0.8 first_author^0.9 identifier^0.8 keyword^0.8 title^0.8 year^0.8
```

Passed as `qf`, that reproduces the default top 30 exactly on four test queries (one an
author query), though `numFound` runs 1–2% higher.

**A `boost` you pass is applied twice, and `cite_read_boost` stays in.** Production
scores by `boost(sum(float(cite_read_boost), const(0.5)))`. A passed boost wraps the query
on both sides of that:

```
FSQ( FSQ( FSQ( <fields>, boost=X ), boost=cite_read_boost+0.5 ), boost=X )
```

So the effective multiplier is X² · (cite_read_boost + 0.5), and `pow(citation_count,0.1)`
acts like an exponent of 0.2. There is currently no way to *replace* `cite_read_boost`
through this parameter. This is open with the API owners.

## Running it locally

Needs Python 3.12 and Postgres.

```bash
docker compose up -d db            # or any Postgres you already run
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
export ADS_TOKEN_PROD=...          # your SciX/ADS API token
export SQLALCHEMY_DATABASE_URI=postgresql+psycopg2://search_eval:search_eval@localhost:5432/search_eval
alembic upgrade head
python wsgi.py                     # http://localhost:8181
```

The development API rejects production tokens, so the dev environment needs its own
`ADS_TOKEN_DEV`. Until you have one, run both columns on production and put the change
you want to test in the variant.

Configuration comes from `config.py`, and any key can be overridden by an environment
variable of the same name. Secrets belong in the environment only; `local_config.py` and
`.env` files are git-ignored.

## Configuration worth knowing

| Key | Default | What it decides |
| --- | --- | --- |
| `ENVIRONMENTS` | prod, dev | Each environment's API base URL and the config key holding its token |
| `ROWS_RETRIEVED` | 30 | Records retrieved per run |
| `SCORE_K` | 10 | Depth metrics are computed at |
| `RATE_DEPTH` | 10 | How deep into each run the rating pool reaches |
| `NDCG_GAIN` | `linear` | Linear (trec_eval, every IR library) or `exp` (Quepid). The choice is in the metric name |
| `INCOMPLETE_BY` | `judged_count` | Whether a run is flagged by its judged count or by how wide its NDCG range is |
| `QF_FIELDS` | 25 fields | Fields a `qf` term may weight. Anything else is refused, never silently dropped |
| `RUBRIC_VERSION` | `draft-2026-11-04` | Stored with every rating, so changing the rubric never changes old ratings |

`NDCG_GAIN`, `INCOMPLETE_BY` and `RATE_DEPTH` are open questions (D1, D3 and D5 in the
literature review), so they are configuration rather than code.

## Tests

```bash
pytest                                     # SQLite, no setup
TEST_DATABASE_URI=postgresql+psycopg2://... pytest   # against Postgres, as CI does
pip install -e '.[oracle]' && pytest       # also checks NDCG against ir_measures
```

The scoring module is stdlib only, so the image carries no numpy or scipy. `ir_measures`
is a test-time oracle, not a runtime dependency.

## Layout

```
config.py                 defaults; overridden by environment variables
wsgi.py                   gunicorn entry point (wsgi:application)
alembic/                  migrations
search_eval/
  app.py                  ADSFlask app factory
  adapters.py             one adapter per environment, same interface
  boost.py                qf/boost validation, canonical form, config hash
  models.py               sessions, runs, judgements, ideal ranking, metrics
  service.py              the experiment loop
  scoring/metrics.py      NDCG, bounds, compatibility, RBO, P@k, success@k
  rubric.py               rating rubric, versioned
  views.py, templates/    server-rendered pages
  tests/
```

Built on [adsmutils](https://github.com/adsabs/ADSMicroserviceUtils), which pins
SQLAlchemy below 2.0. Queries are written in the 2.0 style, and the test suite runs with
2.0 deprecations as errors, so moving to SQLAlchemy 2.x is a version bump.
