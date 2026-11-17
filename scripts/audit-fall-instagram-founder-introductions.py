#!/usr/bin/env python3
"""Offline review queue for explicit founder introductions in native IG archives."""
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = {}


def load(path):
    blob = (ROOT / path).read_bytes()
    MANIFEST[path] = {"path": path, "sha256": hashlib.sha256(blob).hexdigest(), "bytes": len(blob)}
    return json.loads(blob)


def profile_handle(url):
    try:
        value = urlsplit(url if "://" in url else "https://www.instagram.com" + url)
        if value.hostname not in {"www.instagram.com", "instagram.com"}:
            return None
        path = value.path.strip("/").split("/")
        return path[0].lower() if len(path) == 1 and path[0] not in {"p", "reel", "reels", "stories", "explore"} else None
    except ValueError:
        return None


roster_path = "src/lib/yc/fall-2026-companies.json"
roster = load(roster_path)
founders = [{"companySlug": company["slug"], "companyName": company["name"], "founderId": str(founder["id"]), "name": founder["name"], "rosterSource": {**MANIFEST[roster_path], "jsonPointer": f"/companies/{ci}/founders/{fi}"}} for ci, company in enumerate(roster["companies"]) for fi, founder in enumerate(company["founders"])]
identity_path = "outputs/fall-2026/collection/checkpoint-28/instagram-identity-proofs.json"
identity = load(identity_path)
companies = {account["handle"].lower(): group["companySlug"] for group in identity["companies"] for account in group["accounts"] if account.get("entityType") == "company" and account.get("review_state") == "verified"}
known_founders = {account["founderName"].casefold() for group in identity["companies"] for account in group["accounts"] if account.get("entityType") == "founder" and account.get("review_state") == "verified" and account.get("founderName")}
excluded_controls = {"jacob shen", "slavko kovačević", "kosta pavlović"}
role = re.compile(r"\b(?:co[- ]?founders?|founders?|CEO|CTO|CSO)\b|meet our team|my name is", re.I)
unique, scanned, matched_observations = {}, 0, 0


def consider(row, source, pointer):
    global scanned, matched_observations
    caption = row.get("caption")
    url = row.get("url") or row.get("postUrl") or ""
    post_id = re.search(r"/(?:p|reel|reels)/([^/?#]+)", url) if "instagram.com/" in url else None
    if not isinstance(caption, str) or not caption or not post_id:
        return
    scanned += 1
    names = [founder for founder in founders if re.search(r"(?<!\w)" + re.escape(founder["name"].casefold()) + r"(?!\w)", caption.casefold())]
    if not names and not role.search(caption):
        return
    matched_observations += 1
    header = row.get("nativeAuthorHeader") or {}
    links = header.get("links", []) if isinstance(header, dict) else []
    actual_header_links = [link for link in links if isinstance(link, dict) and profile_handle(link.get("href", "")) and link.get("html") and link["html"] in header.get("html", "")]
    author = header.get("handle") or (row.get("nativeCaptionReceipt") or {}).get("authorName")
    permalink_actor = re.match(r"https://(?:www\.)?instagram\.com/([^/]+)/(?:p|reel|reels)/", url)
    primary = author.lower() if isinstance(author, str) else permalink_actor[1].lower() if permalink_actor else None
    associated = sorted({companies[handle] for handle in [primary] + [profile_handle(link["href"]) for link in actual_header_links] if handle in companies} | {founder["companySlug"] for founder in names})
    noncompany = sorted({profile_handle(link["href"]) for link in actual_header_links if profile_handle(link["href"]) not in companies})
    source_ref = {**MANIFEST[source], "jsonPointer": pointer}
    item = {"nativePostId": post_id[1], "nativeUrl": url, "associatedCompanySlugs": associated, "exactOfficialRosterNameMatches": names, "fullCaption": caption, "captionSha256": hashlib.sha256(caption.encode()).hexdigest(), "roleOrIntroductionLanguage": bool(role.search(caption)), "nativePrimaryActorObserved": primary, "nativePrimaryActorIsVerifiedCompany": primary in companies, "nativePrimaryCompanySlug": companies.get(primary), "actualHeaderProfileLinks": actual_header_links, "soleNonCompanyHeaderAccount": noncompany[0] if len(noncompany) == 1 else None, "nonCompanyHeaderAccountCount": len(noncompany), "nativeHeader": header, "nativeCaptionReceipt": row.get("nativeCaptionReceipt"), "captionConfirmedVisible": row.get("captionConfirmedVisible"), "nativeHeaderTextHintBeforeCaption": str(row.get("nativeText", "")).split(caption)[0][:500], "source": source_ref, "allPhysicalObservationSources": [source_ref], "observedAt": row.get("observedAt"), "nativeProfileRequestedByThisAudit": False, "identityPromoted": False}
    key = (post_id[1], item["captionSha256"])
    if key in unique:
        previous = unique[key]
        receipts = previous["allPhysicalObservationSources"] + [source_ref]
        score = lambda record: len(record["actualHeaderProfileLinks"]) * 10 + bool(record["nativeCaptionReceipt"])
        if score(item) > score(previous):
            unique[key] = item
        unique[key]["allPhysicalObservationSources"] = receipts
    else:
        unique[key] = item


def walk(value, source, pointer=""):
    if isinstance(value, dict):
        consider(value, source, pointer)
        for key, child in value.items():
            walk(child, source, pointer + "/" + key.replace("~", "~0").replace("/", "~1"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            walk(child, source, pointer + "/" + str(index))


for path in sorted((ROOT / "outputs/fall-2026/browser-checkpoints").glob("instagram*.json")):
    relative = str(path.relative_to(ROOT))
    walk(load(relative), relative)

queue, held, controls = [], [], []
for item in unique.values():
    matches = item["exactOfficialRosterNameMatches"]
    names = {founder["name"].casefold() for founder in matches}
    hold = []
    if not matches:
        hold.append("No exact full official-roster founder name; first names, unrostered people and generic founder advice cannot bind an identity")
    if not item["nativePrimaryActorIsVerifiedCompany"]:
        hold.append("Primary native actor is external/personal or unproven; interview, guest and collaborator appearances do not establish company introduction ownership")
    if not item["roleOrIntroductionLanguage"]:
        hold.append("No explicit formal founder/team introduction language")
    if item["nonCompanyHeaderAccountCount"] != 1:
        hold.append("No unique actual non-company header profile anchor; bare native text or multi-coauthor groups cannot identify a founder account")
    if not item["nativeCaptionReceipt"]:
        hold.append("This saved observation lacks a scoped full-caption DOM receipt; no placeholder or partial body is promoted")
    if names and names.issubset(known_founders):
        hold.append("Matched founder identity already exists in the verified registry; this is not a new account discovery")
    if names and item["nativePrimaryCompanySlug"] and any(founder["companySlug"] != item["nativePrimaryCompanySlug"] for founder in matches):
        hold.append("Exact roster name belongs to a company other than the observed native primary company")
    item["holdReasons"] = hold
    item["ownershipConfidence"] = "formal_company_intro_with_literal_sole_noncompany_header_anchor_profile_review_required" if not hold else "held_no_new_verified_account"
    if names and names.issubset(excluded_controls):
        item["status"] = "known_requested_exclusion_positive_or_external_control"
        controls.append(item)
    elif not hold:
        item["status"] = "candidate_native_profile_identity_review_required"
        queue.append(item)
    else:
        item["status"] = "held_no_identity_promotion"
        held.append(item)

output = {"source": "offline_native_instagram_explicit_founder_introduction_audit_v1", "scope": "Saved physical IG captions and own-header anchors only, matched against exact235-company457-founder roster. Jacob/Slavko/Kosta remain positive/external controls. No collaborator-name-only ownership inference.", "networkRequestsMade": 0, "canonicalWritesMade": 0, "identityPromotions": 0, "nativeProfileRequests": 0, "summary": {"physicalInstagramJsonFiles": len(MANIFEST) - 2, "savedCaptionObservationsScanned": scanned, "roleOrNameMatchedObservations": matched_observations, "uniqueRoleOrNameMatchedCaptions": len(unique), "newFormalIntroCandidates": len(queue), "heldUniqueCaptions": len(held), "knownRequestedControls": len(controls), "heldReasons": dict(Counter(reason for row in held for reason in row["holdReasons"]))}, "candidateQueue": queue, "heldCaptionEvidence": held, "knownRequestedControls": controls, "sourceManifest": list(MANIFEST.values()), "fullBatchFounderIdentityDiscoveryComplete": False}
path = ROOT / "outputs/fall-2026/instagram-explicit-founder-introduction-candidate-queue.json"
path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "summary": output["summary"]}, indent=2))
