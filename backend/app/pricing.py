import json
from .db import now
from .storage import uid, canonical


def rule_for(db):
    return db.one(
        "SELECT * FROM pricing_rules WHERE active=1 AND provider='elevenlabs' AND model='scribe_v2' AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1",
        (now(),),
        required=False,
    )


def estimate_chunk(duration_ms, settings, rule):
    count = len(settings.get("keyterms", []))
    billable = duration_ms
    features = {
        "keyterm_count": count,
        "diarization": settings.get("diarize", False),
        "audio_events": settings.get("tag_audio_events", False),
    }
    if rule is None:
        return {
            "estimated_cost": None,
            "currency": None,
            "billable_ms": billable,
            "features": features,
            "feature_basis_points": None,
        }
    feature = json.loads(rule["feature_rules"])
    if count > 100:
        billable = max(billable, feature["many_keyterms_min_ms"])
    basis = feature["keyterms_basis_points"] if count else 0
    cost = (
        billable * rule["base_micros_per_hour"] * (10000 + basis) + 3600000 * 10000 - 1
    ) // (3600000 * 10000)
    return {
        "estimated_cost": cost,
        "currency": rule["currency"],
        "billable_ms": billable,
        "features": features,
        "feature_basis_points": basis,
    }


def totals(db):
    return db.all(
        "SELECT currency, charge_status, count(*) AS attempts, sum(audio_duration_ms) AS audio_duration_ms, sum(estimated_cost) AS estimated_cost, count(*)-count(estimated_cost) AS unknown_estimates FROM usage_ledger WHERE substr(created_at,1,7)=? GROUP BY currency,charge_status",
        (now()[:7],),
    )


def save_rule(db, price):
    rule_id = uid()
    with db.tx() as con:
        con.execute(
            "INSERT INTO pricing_rules VALUES(?,?,?,?,?,?,?,?,?)",
            (
                rule_id,
                "elevenlabs",
                "scribe_v2",
                price.effective_from,
                price.currency,
                price.base_micros_per_hour,
                canonical(
                    {
                        "keyterms_basis_points": price.keyterms_basis_points,
                        "many_keyterms_min_ms": price.many_keyterms_min_ms,
                    }
                ),
                price.source_note,
                1,
            ),
        )
    return rule_id
