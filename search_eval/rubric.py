"""The rating rubric, versioned.

Every judgement stores the rubric version it was made under, so changing the
wording here never silently changes what an old rating meant. To change the
rubric, add a new version and point RUBRIC_VERSION in config.py at it.

Labels follow the 4 Nov 2026 decision. Definitions are the literature default
(lit review lens L3) for AK and JB to adjust; this version is a draft.
"""

RUBRICS = {
    "draft-2026-11-04": {
        "graded": [
            {
                "value": "3",
                "label": "Highly relevant",
                "definition": "Directly answers the need. You'd read or cite it first; "
                "missing it from the top 10 would be a failure. For a known-item "
                "search, this is the target.",
            },
            {
                "value": "2",
                "label": "Relevant",
                "definition": "Substantial, usable information for the need, but partial "
                "or one step removed: a review, a model, or a closely related measurement.",
            },
            {
                "value": "1",
                "label": "Somewhat relevant",
                "definition": "On topic or shares the terms, but wouldn't help with this "
                "need. Counts as not relevant in binary metrics.",
            },
            {
                "value": "0",
                "label": "Not relevant",
                "definition": "Wrong topic, or the wrong sense of the term.",
            },
        ],
        "binary": [
            {
                "value": "up",
                "label": "Right person",
                "definition": "The paper is by the intended person, and in the year range "
                "if one was given.",
            },
            {
                "value": "down",
                "label": "Wrong person",
                "definition": "A different person with the same name, out of the year "
                "range, or the person isn't an author.",
            },
        ],
        "skip": {
            "value": "skip",
            "label": "Can't judge",
            "definition": "Outside your expertise, not decidable from the abstract, or "
            "the record is broken. Skipped records are never scored; say why in the note.",
        },
    },
}


def rubric_for(version, rating_mode):
    """The options a rater sees, in order, skip last."""
    rubric = RUBRICS[version]
    return [*rubric[rating_mode], rubric["skip"]]
