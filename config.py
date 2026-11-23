# Defaults for the search evaluation service.
#
# ADSFlask reads this file, then local_config.py, then overrides any key that is
# also set as an environment variable (plain, or prefixed with the app name).
# Secrets therefore stay out of the tree: set ADS_TOKEN_PROD, ADS_TOKEN_DEV and
# SQLALCHEMY_DATABASE_URI in the environment, never here.

LOG_STDOUT = True
LOGGING_LEVEL = "INFO"
ENV = "production"

SQLALCHEMY_DATABASE_URI = (
    "postgresql+psycopg2://search_eval:search_eval@localhost:5432/search_eval"
)
SQLALCHEMY_TRACK_MODIFICATIONS = False

# One entry per environment. Each goes through that environment's full API stack
# (RFC Technical Design, Objective 2), never raw Solr. `token_key` names the
# config key holding its token: tokens are per environment, because devapi
# rejects the production token.
ENVIRONMENTS = {
    "prod": {
        "label": "Production",
        "base_url": "https://api.adsabs.harvard.edu/v1",
        "token_key": "ADS_TOKEN_PROD",
    },
    "dev": {
        "label": "Development",
        "base_url": "https://devapi.adsabs.harvard.edu/v1",
        "token_key": "ADS_TOKEN_DEV",
    },
}
ADS_TOKEN_PROD = ""
ADS_TOKEN_DEV = ""
ADS_REQUEST_TIMEOUT = 30

# The two columns a new session compares. Until a devapi token exists, both
# point at production and the second one carries different qf or boost.
DEFAULT_ENVIRONMENT_A = "prod"
DEFAULT_ENVIRONMENT_B = "prod"

# Retrieve 20 to 30 per environment, score @10 (RFC, 4 Nov meeting).
ROWS_RETRIEVED = 30
SCORE_K = 10

# How deep into each run the rating pool reaches. The union of two top-10s is
# typically 12 to 16 records. Open question D5 weighs this against rating all
# 20 to 30, so it is configuration rather than code.
RATE_DEPTH = 10

# Fields a qf term may weight: the MVP's ADS field mapping, plus the four fields
# production's own query searches that the MVP's list lacked (ack, bibstem,
# first_author, identifier). Unlike the MVP, a term outside this list is
# rejected, not silently dropped, so the stored config always matches what Solr
# received.
QF_FIELDS = [
    "ack",
    "bibstem",
    "first_author",
    "identifier",
    "title",
    "author",
    "abstract",
    "year",
    "citation_count",
    "doctype",
    "property",
    "bibcode",
    "doi",
    "keyword",
    "pub",
    "volume",
    "page",
    "aff",
    "inst",
    "lang",
    "orcid",
    "read_count",
    "vizier",
    "database",
    "pubdate",
]

# Production's own field weights, read from debugQuery's parsed query on
# 23 Nov 2026. Passing qf REPLACES the set of fields searched rather than
# reweighting production's, so a reweighting experiment starts from this string
# and changes one weight. Checked on four queries (topical and author): it
# reproduces the default top 30 exactly, though numFound runs 1-2% higher.
# Production can change; re-derive it with debugQuery=true if results drift.
PRODUCTION_DEFAULT_QF = (
    "abstract^0.7 ack^0.8 author^0.85 bibstem^0.8 first_author^0.9 "
    "identifier^0.8 keyword^0.8 title^0.8 year^0.8"
)

# Gain function for NDCG. Open question D1: linear matches trec_eval and every
# IR library; exponential matches Quepid. The choice lands in the metric name.
NDCG_GAIN = "linear"

# How a run is marked incomplete. Open question D3: "judged_count" or
# "interval_width". Both numbers are stored either way.
INCOMPLETE_BY = "judged_count"
MIN_JUDGED_FRACTION = 0.8
MAX_NDCG_INTERVAL = 0.10

RUBRIC_VERSION = "draft-2026-11-04"
