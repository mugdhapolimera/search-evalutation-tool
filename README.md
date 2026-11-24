# search-evalutation-tool

Tool to evaluate any changes made to search results and compare, rate, rank result sets.

Run one query in two configurations, rate the records they return without seeing which
side returned what, and see how each ranking measures up. Then change `qf` or `boost` and
see the effect straight away, against the same ratings. Every number is computed on the
server and stored with the run, the exact parameters sent, and how it was computed.

Design: the RFC *Design and Plan for new Search Evaluation Tool* (Jira PT-23).

## Status: v0.1

Works today:

- **Search first.** Type a query as you would on SciX. Production's default ranking runs at
  once and is always the baseline, so there is nothing to set up.
- **Tweak from the results.** Field weights start at production's own values. Change one,
  add a boost or pick another environment, and the tweak appears next to production with
  what changed, which records moved, which are new and which dropped out.
- **Rate and rank in one step, on the same screen.** Each record is read once, in a blind,
  shuffled "To sort" list with no rank or column, and dragged into a rating group (or sent
  with a number key, or 👎 to the bottom). Its group is its rating and its place in the
  group is its rank, so the ranking can never contradict the ratings. The whole board saves
  on every move. Author searches have two groups, right and wrong person. A skip is stored
  as unjudged and never scored as 0.
- **The comparison is inferred, not asked for.** Once nothing is left to sort, production
  and the tweak appear side by side as compact rows carrying the grades already given, with
  rank moves and what dropped out. Verdicts stay hidden while records remain to sort.
- **Metrics stored per run:** NDCG@10 against one shared pool, how many of the top 10 are
  rated, the range NDCG could still take, P@10, success@10 for known items, overlap and RBO.
  The comparison leads with a verdict (better, worse, no change) and the reason.
- **Looks like SciX.** The frontend is React and Chakra UI with SciX's own theme, nav bar,
  discipline choices and result layout, copied from
  [nectar](https://github.com/adsabs/nectar) (see `frontend/src/scix/`).

Not yet:

- Login through SciX accounts with a dedicated scope. Until then the rater's name is asked
  once and kept in the browser.
- The BeeHive image and manifests, to be modelled on ADSScanExplorerService. The image
  needs a Node build stage for the frontend.
- Affiliations and ORCID for judging author searches.
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

Needs Python 3.12, Node 22 and Postgres.

```bash
docker compose up -d db            # or any Postgres you already run
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
export ADS_TOKEN_PROD=...          # your SciX/ADS API token
export SQLALCHEMY_DATABASE_URI=postgresql+psycopg2://search_eval:search_eval@localhost:5432/search_eval
alembic upgrade head
python wsgi.py                     # the API, on http://localhost:8181

cd frontend && npm ci
npm run dev                        # the page, on http://localhost:5173 (proxies /api to 8181)
```

`npm run build` writes the frontend into `search_eval/frontend_dist/`, after which Flask
serves the page and the API together on port 8181, as the deployed image will.

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
| `BASELINE_ENVIRONMENT` | prod | Where the baseline (production's default ranking) runs for every search |
| `DISCIPLINES` | SciX's six | Discipline choices, with SciX's values and labels |
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
cd frontend && npm test                    # the page: comparison wording, rating saves
```

The scoring module is stdlib only, so the image carries no numpy or scipy. `ir_measures`
is a test-time oracle, not a runtime dependency. One test sends ratings concurrently and
only runs on Postgres, because it needs row locks.

## Layout

```
config.py                 defaults; overridden by environment variables
wsgi.py                   gunicorn entry point (wsgi:application)
alembic/                  migrations
search_eval/
  app.py                  ADSFlask app factory; serves the built frontend
  api.py                  JSON API under /api
  presenters.py           stored rows turned into what the screens show
  service.py              the experiment loop
  adapters.py             one adapter per environment, same interface
  boost.py                qf/boost validation, canonical form, config hash
  models.py               sessions, runs, judgements, ideal ranking, metrics
  scoring/metrics.py      NDCG, bounds, compatibility, RBO, P@k, success@k
  rubric.py               rating rubric, versioned
  tests/
frontend/
  src/scix/               SciX's theme, select, colours and logo, copied from nectar
  src/components/         search bar, tweak rail, compare, rate, order
  src/pages/              home and the per-search workspace
```

Built on [adsmutils](https://github.com/adsabs/ADSMicroserviceUtils), which pins
SQLAlchemy below 2.0. Queries are written in the 2.0 style, and the test suite runs with
2.0 deprecations as errors, so moving to SQLAlchemy 2.x is a version bump.
