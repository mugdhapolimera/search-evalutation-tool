"""Data model, following the RFC's Technical Design section 2.

Types are SQLAlchemy's generic ones, so the same model runs on Postgres in
production and on SQLite in unit tests. Queries elsewhere use the 2.0 style
(`select()`, `text()`) on SQLAlchemy 1.4, which is what adsmutils pins, so a
move to 2.x is a version bump.

Terms: a *rating* is one rater's grade of one record; a *ranking* is an order of
records; a *metric* is a number computed from a run. The UI never says "score".
"""

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

INTENTS = ("topical", "author", "known_item")
RATING_MODES = ("graded", "binary")


def utcnow():
    return datetime.now(timezone.utc)


def rating_mode_for(intent):
    """Author queries are rated thumbs up or down; everything else on 0-3."""
    return "binary" if intent == "author" else "graded"


class RatingSession(Base):
    """The judgement key. A query string alone is not enough: "Triton" can be a
    moon, a GPU language or a tumour, so the information need, goal and
    discipline travel with it."""

    __tablename__ = "session"

    id = Column(Integer, primary_key=True)
    # Who ran the search. Optional: searching never asks for a name. Each
    # judgement carries its own rater.
    rater = Column(String(255))
    query = Column(Text, nullable=False)
    # Required before the first rating, not before searching.
    information_need = Column(Text)
    goal = Column(Text)
    discipline = Column(String(255))
    intent = Column(String(32), nullable=False, default="topical")
    rating_mode = Column(String(16), nullable=False, default="graded")
    rubric_version = Column(String(64), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    runs = relationship("Run", back_populates="session", order_by="Run.id")
    judgements = relationship("Judgement", back_populates="session")
    ideal_ranking = relationship(
        "IdealRanking", back_populates="session", order_by="IdealRanking.position"
    )

    __table_args__ = (
        CheckConstraint(f"intent IN {INTENTS}", name="ck_session_intent"),
        CheckConstraint(f"rating_mode IN {RATING_MODES}", name="ck_session_rating_mode"),
    )


class BoostConfig(Base):
    """Solr parameters exactly as passed, hashed so two runs with identical
    settings compare directly."""

    __tablename__ = "boost_config"

    id = Column(Integer, primary_key=True)
    params = Column(JSON, nullable=False)
    hash = Column(String(64), nullable=False, unique=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)


class Run(Base):
    """One retrieval from one environment. Reproducible because the config,
    endpoint and release are stored with it."""

    __tablename__ = "run"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("session.id", ondelete="CASCADE"), nullable=False)
    environment = Column(String(64), nullable=False)
    base_url = Column(String(255), nullable=False)
    release = Column(String(128))
    freeze_ref = Column(String(128))
    record_set_version = Column(String(32))
    rows = Column(Integer, nullable=False)
    boost_config_id = Column(Integer, ForeignKey("boost_config.id"), nullable=False)
    num_found = Column(Integer)
    qtime_ms = Column(Integer)
    status = Column(String(16), nullable=False, default="ok")
    error = Column(Text)
    executed_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    session = relationship("RatingSession", back_populates="runs")
    boost_config = relationship("BoostConfig")
    results = relationship(
        "RunResult", back_populates="run", order_by="RunResult.rank", cascade="all, delete-orphan"
    )
    metrics = relationship("Metric", back_populates="run", cascade="all, delete-orphan")


class RunResult(Base):
    """One record at one rank of one run: the ranking a metric is computed on."""

    __tablename__ = "run_result"

    id = Column(Integer, primary_key=True)
    run_id = Column(Integer, ForeignKey("run.id", ondelete="CASCADE"), nullable=False)
    rank = Column(Integer, nullable=False)
    bibcode = Column(String(64), nullable=False)
    identifiers = Column(JSON, nullable=False, default=list)
    title = Column(Text)
    authors = Column(JSON, nullable=False, default=list)
    year = Column(String(8))
    pub = Column(Text)
    abstract = Column(Text)
    entry_date = Column(String(32))
    doctype = Column(String(64))

    run = relationship("Run", back_populates="results")

    __table_args__ = (UniqueConstraint("run_id", "rank", name="uq_run_result_rank"),)


class Judgement(Base):
    """One rater's rating of one record in one session.

    `rating` is an integer 0-3, or NULL when skipped: a skip is unjudged and is
    never scored as 0. Binary sessions store thumbs up as 3 and down as 0. Every
    identifier of the record travels with it, so the judgement still matches
    after a preprint is merged into its publisher record."""

    __tablename__ = "judgement"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("session.id", ondelete="CASCADE"), nullable=False)
    bibcode = Column(String(64), nullable=False)
    identifiers = Column(JSON, nullable=False, default=list)
    rating = Column(Integer)
    rating_mode = Column(String(16), nullable=False)
    rubric_version = Column(String(64), nullable=False)
    note = Column(Text)
    rater = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)

    session = relationship("RatingSession", back_populates="judgements")

    __table_args__ = (
        UniqueConstraint("session_id", "bibcode", name="uq_judgement_session_record"),
        CheckConstraint(
            "rating IS NULL OR (rating >= 0 AND rating <= 3)", name="ck_judgement_rating"
        ),
        CheckConstraint(f"rating_mode IN {RATING_MODES}", name="ck_judgement_rating_mode"),
    )


class IdealRanking(Base):
    """The rater's gold-standard order, one row per position.

    `tie_group` is the grade bucket: records in one bucket are tied. Within a
    bucket, `position` may carry the rater's own order, but it can never put a
    lower grade above a higher one (synthesis R1)."""

    __tablename__ = "ideal_ranking"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("session.id", ondelete="CASCADE"), nullable=False)
    position = Column(Integer, nullable=False)
    bibcode = Column(String(64), nullable=False)
    identifiers = Column(JSON, nullable=False, default=list)
    tie_group = Column(Integer, nullable=False)
    # True when the rater put this grade bucket in an order of their own. When
    # False, records in the bucket are tied and `position` is only storage order.
    ordered = Column(Boolean, nullable=False, default=False)

    session = relationship("RatingSession", back_populates="ideal_ranking")

    __table_args__ = (UniqueConstraint("session_id", "position", name="uq_ideal_position"),)


class Metric(Base):
    """A number computed from a run, with the parameters that produced it.

    Rows are appended rather than replaced: IDCG grows as more records in the
    session are judged, so an older value is a fact about an older pool."""

    __tablename__ = "metric"

    id = Column(Integer, primary_key=True)
    run_id = Column(Integer, ForeignKey("run.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(64), nullable=False)
    k = Column(Integer)
    value = Column(Float)
    params = Column(JSON, nullable=False, default=dict)
    computed_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    run = relationship("Run", back_populates="metrics")


class RecordSet(Base):
    """Not used in v0.1. The versioned set of records a regression run replays."""

    __tablename__ = "record_set"

    id = Column(Integer, primary_key=True)
    query = Column(Text, nullable=False)
    version = Column(String(32), nullable=False)
    records = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (UniqueConstraint("query", "version", name="uq_record_set_version"),)


class GoldSet(Base):
    """Not used in v0.1. Sessions promoted for automated regression."""

    __tablename__ = "gold_set"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("session.id", ondelete="CASCADE"), nullable=False)
    added_by = Column(String(255), nullable=False)
    added_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
