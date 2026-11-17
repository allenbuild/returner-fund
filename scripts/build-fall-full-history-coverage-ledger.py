#!/usr/bin/env python3
"""Offline reconciliation of physical Fall 2026 history-coverage receipts.

Counts describe saved evidence, never substitute for a native history frontier.
This script reads existing artifacts and writes only its own coverage outputs.
"""

import hashlib
import json
import re
import argparse
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
CLI = argparse.ArgumentParser(description=__doc__)
CLI.add_argument("--checkpoint", type=int, default=26, help="Immutable accepted-evidence checkpoint used only for identity/count metadata")
CHECKPOINT = CLI.parse_args().checkpoint
if CHECKPOINT < 1:
    raise ValueError("Checkpoint must be positive")
OUT = "outputs/fall-2026/full-history-coverage-ledger.json"
PLATFORMS = ["linkedin", "x", "instagram", "facebook", "tiktok", "threads", "youtube", "github", "website", "reddit", "substack"]
SOURCES = {}
ACCOUNTS = {}
ENTITIES = {}
UNMAPPED = []


def read(path, optional=False):
    if path in SOURCES:
        return SOURCES[path]["data"]
    physical = ROOT / path
    if optional and not physical.is_file():
        return None
    blob = physical.read_bytes()
    data = json.loads(blob)
    SOURCES[path] = {"path": path, "absolutePath": str(physical), "sha256": hashlib.sha256(blob).hexdigest(), "bytes": len(blob), "data": data}
    return data


def ref(path, pointer=""):
    return {"path": path, "sha256": SOURCES[path]["sha256"], "jsonPointer": pointer}


def slug(value):
    # Matches the existing graph/importer convention, including accented names.
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")


def founder_entity(company_slug, founder_id):
    for entity in ENTITIES.values():
        if entity["entityType"] == "founder" and entity["companySlug"] == company_slug and entity["rosterId"] == str(founder_id):
            return entity["entityId"]
    return None


def account_key(platform, url):
    if not url:
        return None
    parsed = urlsplit(url if "://" in url else "https://" + url)
    host = (parsed.hostname or "").lower().removeprefix("www.")
    path = unquote(parsed.path).rstrip("/") or "/"
    if platform == "linkedin":
        host = "linkedin.com"  # Regional hosts identify the same exact literal path.
    if platform == "x":
        host = "x.com"
    if platform == "threads":
        host = "threads.com"
    return f"{platform}:{host}{path.lower()}"


def account(platform, url, entity_id=None, provenance=None, ownership="identity_unresolved"):
    key = account_key(platform, url)
    if not key:
        return None
    row = ACCOUNTS.setdefault(key, {"accountId": key, "platform": platform, "url": url, "observedUrls": [], "owners": [], "observations": []})
    if url not in row["observedUrls"]:
        row["observedUrls"].append(url)
    if entity_id and entity_id in ENTITIES:
        item = {"entityId": entity_id, "ownershipStatus": ownership, "source": provenance}
        if item not in row["owners"]:
            row["owners"].append(item)
    return row


def observe(row, path, pointer, status, scope, counts=None, end=False, claim=False, gaps=None, extra=None):
    if row is None:
        UNMAPPED.append({"source": ref(path, pointer), "reason": "No exact native/official account URL available"})
        return
    record = {"source": ref(path, pointer), "state": status, "surfaceScope": scope, "availableSurfaceEndObserved": bool(end), "sourceClaimsScopedHistoryComplete": bool(claim), "allAccountSurfacesComplete": False, "counts": counts or {}, "unreconciledGaps": gaps or []}
    if extra:
        record.update(extra)
    row["observations"].append(record)


def count_value(value):
    return len(value) if isinstance(value, (list, dict)) else value


def compact_fields(data, keys):
    return {key: count_value(data[key]) for key in keys if key in data}


def archive_refs(value):
    """Retain declared parent lineage without presenting it as a fresh rehash."""
    found = []
    def walk(node, pointer=""):
        if isinstance(node, dict):
            if isinstance(node.get("path"), str) and re.fullmatch(r"[a-f0-9]{64}", str(node.get("sha256", ""))):
                found.append({"path": node["path"], "sha256": node["sha256"], "declaredAtJsonPointer": pointer, "validation": "hash_declared_in_physical_coverage_source"})
            if isinstance(node.get("sourcePath"), str) and node.get("sourceSha256"):
                found.append({"path": node["sourcePath"], "sha256": node["sourceSha256"], "declaredAtJsonPointer": pointer, "validation": "hash_declared_in_physical_coverage_source"})
            for key, child in node.items():
                if not any(part in key.lower() for part in ["html", "caption", "body", "text"]):
                    walk(child, pointer + "/" + key)
        elif isinstance(node, list):
            for index, child in enumerate(node):
                walk(child, pointer + "/" + str(index))
    walk(value)
    return found


def roster():
    path = "src/lib/yc/fall-2026-companies.json"
    data = read(path)
    for index, company in enumerate(data["companies"]):
        company_id = "company-" + company["slug"]
        ENTITIES[company_id] = {"entityId": company_id, "entityType": "company", "rosterId": str(company["id"]), "companySlug": company["slug"], "name": company["name"], "ycProfileUrl": company["ycProfileUrl"], "rosterSource": ref(path, f"/companies/{index}")}
        if company.get("websiteUrl"):
            account("website", company["websiteUrl"], company_id, ref(path, f"/companies/{index}/websiteUrl"), "official_yc_link")
        for fi, founder in enumerate(company["founders"]):
            founder_id = f"founder-{company['slug']}-{slug(founder['name'])}-{founder['id']}"
            ENTITIES[founder_id] = {"entityId": founder_id, "entityType": "founder", "rosterId": str(founder["id"]), "companySlug": company["slug"], "name": founder["name"], "ycProfileUrl": founder.get("ycProfileUrl"), "rosterSource": ref(path, f"/companies/{index}/founders/{fi}")}
    path = "outputs/fall-2026/official-social-targets.json"
    for index, target in enumerate(read(path)["targets"]):
        entity_id = "company-" + target["companySlug"] if target["entityType"] == "company" else founder_entity(target["companySlug"], target["entityId"])
        account(target["platform"], target["url"], entity_id, ref(path, f"/targets/{index}"), "official_yc_link")


def linkedin():
    path = "outputs/fall-2026/linkedin-official-founder-history-queue.json"
    for index, target in enumerate(read(path)["founders"]):
        row = account("linkedin", target["profileUrl"], target["entityId"], ref(path, f"/founders/{index}"), "official_yc_link")
        observe(row, path, f"/founders/{index}", "discovery_only", "Official founder account queue; company collaboration receipts do not exhaust founder history", {"previouslyVerifiedOriginals": target["alreadyVerifiedOriginalCount"]})
    for path in ["outputs/fall-2026/linkedin-browser-checkpoint.json", "outputs/fall-2026/browser-checkpoints/linkedin-ui-current.json", "outputs/fall-2026/browser-checkpoints/linkedin-ui-lane2.json"]:
        for index, profile in enumerate(read(path)["profiles"]):
            url = profile.get("officialProfileUrl") or profile.get("accountUrl")
            complete = profile.get("historyComplete") is True
            auth = profile.get("status") == "partial_stopped_on_authentication_failure"
            row = account("linkedin", url, "company-" + profile["companySlug"], ref(path, f"/profiles/{index}"), "official_yc_link")
            counts = compact_fields(profile, ["originalRows", "rows", "homeRows", "allObservedCards", "refreshedObservedCards", "pendingNativePermalinks", "nativeEmbedReview"])
            observe(row, path, f"/profiles/{index}", "authentication_required" if auth else "scoped_available_history_complete" if complete else "partial_history", "Available original company Posts; excludes plain repost authorship and unsupported identity cards", counts, end=complete, claim=complete, gaps=[] if complete else [profile.get("coverageNote") or "Available original account history not proven exhausted"], extra={"nativeStatus": profile.get("status"), "observedAt": profile.get("observedAt"), "endProofJsonPointer": f"/profiles/{index}/historyEndProof" if profile.get("historyEndProof") else None})
    path = "outputs/fall-2026/browser-checkpoints/linkedin-founder-root-profile-coverage.json"
    for index, profile in enumerate(read(path)["profiles"]):
        entity_id = founder_entity(profile["companySlug"], profile["founderId"])
        complete = profile.get("availableAuthoredPostsComplete") is True
        url = profile.get("profileUrl") or profile.get("officialProfileUrl")
        row = account("linkedin", url, entity_id, ref(path, f"/profiles/{index}"), "official_or_native_verified_founder_identity")
        if profile.get("officialProfileUrl") and account_key("linkedin", profile["officialProfileUrl"]) != row["accountId"]:
            row["officialAliasAccountId"] = account_key("linkedin", profile["officialProfileUrl"])
        observe(row, path, f"/profiles/{index}", "scoped_available_history_complete" if complete else "native_profile_unavailable", profile.get("scope", "Exact official profile availability"), profile.get("counts", {}), end=complete, claim=complete, gaps=[] if complete else [profile.get("reason", "No complete native history")], extra={"observedAt": profile.get("observedAt"), "plainRepostNativeIdCoverageComplete": profile.get("plainRepostNativeIdCoverageComplete"), "parentArchives": archive_refs(profile)})
    path = "outputs/fall-2026/browser-checkpoints/linkedin-founder-emre-history-assembled-175.json"
    profile = read(path)
    row = account("linkedin", profile["profileUrl"], profile["entityId"], ref(path), "native_verified_founder_identity")
    row["officialAliasAccountId"] = account_key("linkedin", profile["officialProfileUrl"])
    observe(row, path, "", "listing_end_observed_details_incomplete", "Available founder All activity listing; listing completion does not prove immutable permalink/body receipt completion", profile["counts"], end=profile.get("historyComplete"), gaps=["Physical native identity verification remains partial; older cards expose disabled Embed or Report-only menus", "LinkedIn collection paused after authentication failure"], extra={"parentArchives": archive_refs({key: value for key, value in profile.items() if key != "cards"}), "observedAt": profile.get("observedAt")})


def instagram():
    path = f"outputs/fall-2026/collection/checkpoint-{CHECKPOINT}/instagram-identity-proofs.json"
    data = read(path)
    for ci, group in enumerate(data["companies"]):
        for ai, proof in enumerate(group["accounts"]):
            entity_id = "company-" + group["companySlug"] if proof["entityType"] == "company" else founder_entity(group["companySlug"], proof.get("founderId"))
            row = account("instagram", proof["profileUrl"], entity_id, ref(path, f"/companies/{ci}/accounts/{ai}"), "verified_native_and_official_identity")
            if not entity_id:
                UNMAPPED.append({"source": ref(path, f"/companies/{ci}/accounts/{ai}"), "reason": "Founder ID not in roster", "url": proof["profileUrl"]})
            observe(row, path, f"/companies/{ci}/accounts/{ai}", "identity_only", "Native account identity; no history completion inferred", extra={"observedAt": proof.get("observedAt") or group.get("recordedAt")})
    path = "outputs/fall-2026/instagram-company-posts-reels-coverage-queue.json"
    company_queue = read(path)
    for index, lead in enumerate(company_queue["excludedWebsiteLinks"]):
        if lead["companySlug"] == "quippy" and lead["reason"] == "native_identity_pending_no_founder_inference":
            row = account("instagram", lead["observedUrl"], "company-quippy", ref(path, f"/excludedWebsiteLinks/{index}"), "official_site_account_candidate_native_identity_unavailable")
            observe(row, path, f"/excludedWebsiteLinks/{index}", "native_profile_unavailable", "Official-site literal account candidate; native identity unavailable; not an admitted owned account", gaps=[lead["reason"]])
    for index, target in enumerate(company_queue["queue"]):
        row = account("instagram", target["profileUrl"])
        snapshot = target.get("postsSnapshot") or {}
        observe(row, path, f"/queue/{index}", "private_profile" if target["status"] == "private_profile" or target["handle"] == "caladhtech" else "posts_grid_only_reels_unproven", "Saved company Posts grid and approved own-primary native receipts; separate Reels coverage may be superseded by newer receipts", {"headerPosts": target.get("headerPostCount"), "listedPosts": snapshot.get("listedUniqueCount"), "approvedOwnOriginalsAtSourceCheckpoint": target.get("approvedOwnCount")}, gaps=[target.get("note", "Separate Reels and full history must be reconciled")], extra={"observedAt": snapshot.get("observedAt"), "sourceSnapshotIsHistorical": True})
    # Profile snapshots add observations only. Unverified similar-looking profiles
    # remain unmapped; listing membership never changes primary authorship.
    path = "outputs/fall-2026/browser-checkpoints/instagram-all-ui-current.json"
    native_base = read(path)
    for index, profile in enumerate(native_base["verifiedProfiles"]):
        key = account_key("instagram", profile["url"])
        if key not in ACCOUNTS:
            UNMAPPED.append({"source": ref(path, f"/verifiedProfiles/{index}"), "url": profile["url"], "reason": "Observed profile is not a verified roster account in the identity registry; no name inference"})
            continue
        private = "private" in str(profile.get("identity", "")).lower()
        observe(ACCOUNTS[key], path, f"/verifiedProfiles/{index}", "private_profile" if private else "posts_grid_only_reels_unproven", "One saved Posts-grid snapshot", {"listedRows": len(profile.get("posts", []))}, gaps=["Private history not accessed" if private else "One grid/header count does not establish full account history"], extra={"observedAt": profile.get("observedAt")})
    for index, snapshot in enumerate(native_base.get("gridHistorySnapshots", [])):
        row = account("instagram", snapshot["profileUrl"])
        observe(row, path, f"/gridHistorySnapshots/{index}", "posts_grid_only_reels_unproven", "Scrolled Posts-grid inventory; separate Reels/account surfaces not established by this record", {"listedUniqueRows": snapshot["uniqueRows"], "stableChecks": snapshot["stableChecks"], "viewportSnapshots": len(snapshot["snapshots"])}, gaps=["Stable Posts-grid end is not separate Reels or full account history proof"])
    grid_urls = {"vexo": "https://www.instagram.com/tryvexoai/", "haris": "https://www.instagram.com/realharismalik/", "kiani": "https://www.instagram.com/kiani_build/"}
    for key, entries in native_base.get("grids", {}).items():
        row = account("instagram", grid_urls[key])
        observe(row, path, "/grids/" + key, "posts_grid_only_reels_unproven", "Initial saved Posts-grid rows; exact known account mapping comes from verified identity registry", {"listedRows": len(entries)}, gaps=["No separate Reels exhaustion proof in this initial grid"])
    for physical in sorted((ROOT / "outputs/fall-2026/browser-checkpoints").glob("instagram-*-history-coverage.json")):
        path = str(physical.relative_to(ROOT))
        data = read(path)
        src = data.get("source") if isinstance(data.get("source"), dict) else {}
        url = data.get("profileUrl") or src.get("profileUrl")
        if not url:
            UNMAPPED.append({"source": ref(path), "reason": "Coverage source has no explicit account URL"})
            continue
        row = account("instagram", url)
        gap = data.get("unreconciledHeaderGap", data.get("unreconciledHeaderCountDifference", data.get("headerDifference", 0))) or 0
        missing = data.get("missingNativeDetailIds", data.get("missingIds", data.get("missingVisibleIds", data.get("missingNativeIds", []))))
        missing_count = count_value(missing) or 0
        end = any(data.get(key) is True for key in ["nativeFrontiersExhausted", "availableHistoryComplete", "availableOriginalPostHistoryComplete", "availablePostsAndReelsUnionComplete", "availablePostsAndReelsCaptured", "postsAndReelsNativeBottomsObserved"])
        claim = any(data.get(key) is True for key in ["availableHistoryComplete", "availableOriginalPostHistoryComplete"]) and not gap and not missing_count
        status = "surface_end_with_unreconciled_gap" if end and gap else "scoped_available_history_complete" if claim else "available_surface_end_full_history_uncertain" if end else "partial_history"
        keys = ["headerPostCount", "nativeHeaderPosts", "postsListed", "reelsListed", "unionUnique", "currentVisibleUnique", "visibleUnionCount", "postsGridCount", "reelsGridCount", "nativeDetailIds", "capturedNativeIds", "listedPostCount", "capturedListedPostCount", "nativeNextAtOldest", "captionlessOwnCount", "freshNativeDetailsNeeded", "freshNativeDetails", "newNativeIdsVersusBaseline", "newOwnPosts"]
        counts = compact_fields(data, keys)
        counts.update(data.get("counts", {}))
        counts.update({"unreconciledHeaderDifference": gap, "missingVisibleNativeIds": missing_count})
        gaps = []
        if gap:
            gaps.append(data.get("unreconciledHeaderGapReason") or data.get("headerDifferenceReason") or f"Native header and available unique listing differ by {gap}; cause unproven")
        if missing_count:
            gaps.append(f"{missing_count} visible native IDs lack detail coverage")
        if not claim:
            gaps.append("Available Posts/Reels surface exhaustion does not establish all historical/account surfaces; unavailable/deleted/index gaps unknown")
        observe(row, path, "", status, "Available native Posts and separately inspected Reels union; collaborator appearances retain their true primary owner", counts, end, claim, gaps, {"observedAt": src.get("exportedAt") or src.get("observedAt") or data.get("generatedAt"), "parentArchives": archive_refs(data), "explicitSourceCaveats": {key: data[key] for key in ["fullHistoryComplete", "fullAccountHistoryGuarantee", "fullHistoryGuarantee", "globalBatchHistoryComplete", "countsAsExhaustiveAccountAcrossOtherSurfaces", "reelOnlyAttributionStatus", "attributionNote", "plainRepostsScope"] if key in data}})
    path = "outputs/fall-2026/browser-checkpoints/instagram-kosta-pavlovic-identity-ui-current.json"
    data = read(path)
    row = account("instagram", "https://www.instagram.com/kosta.pavlovic/")
    observe(row, path, "/profile", "private_profile", "Verified native identity with private history unavailable; no follow/access action", {"nativeHeaderPosts": 44}, gaps=["Private account history unavailable; zero captured posts is not zero historical posts"], extra={"privateHistoryUnavailable": data.get("privateHistoryUnavailable"), "accessActions": data.get("accessActions")})


def x_platform():
    path = "outputs/source-hunt/2026-11-15-fall-2026-x-native-family-audit.json"
    data = read(path)
    for index, target in enumerate(data["accounts"]):
        row = account("x", target["accountUrl"])
        for mapping in target["officialRosterMappings"]:
            account("x", target["accountUrl"], mapping["entityId"], ref(path, f"/accounts/{index}/officialRosterMappings"), "official_yc_link")
        families = target["nativeFamilyFrontierReceipts"]
        frontier_counts = {key: len(value) for key, value in families.items()}
        observe(row, path, f"/accounts/{index}", "partial_native_family_history" if any(frontier_counts.values()) else "discovery_search_only", "Native exact-account search plus explicitly observed Posts/Replies/Reposts/Articles families and bounded date windows", {"ownNativeIds": target["ownNativeIds"], "fullOwnCaptions": target["fullOwnCaptions"], "captionlessNativeIds": target["captionlessNativeIds"], "headerPosts": target.get("nativeHeaderPostCount"), "boundedSearchWindows": len(target["boundedDateSearchWindows"]), "nativeFamilyFrontierReceipts": frontier_counts, "collapsedOwnBodies": len(target["collapsedOwnBodyUrls"])}, gaps=[target["remainingScope"], "Initial discovery search is not account-history exhaustion"], extra={"observedAt": data["source"].get("observedAt"), "actualProfileHeaderArchived": target["actualProfileHeaderArchived"], "threeCoreNativeFamiliesObserved": target["threeCoreNativeFamiliesObserved"], "sourceHistoryComplete": target["historyComplete"], "oldestOwnPublishedAt": target.get("oldestOwnPublishedAt")})
    # Explicit paused native cursor is retained separately from past discovery.
    cursor = data.get("activePausedCursor", {})
    if cursor.get("handle"):
        observe(account("x", "https://x.com/" + cursor["handle"]), path, "/activePausedCursor", "client_loading_error_paused", "Active native Replies timeline", {"bufferedNativeIds": len(cursor.get("postIds", [])), "viewportReads": cursor.get("viewportReads"), "bottomStableBatches": cursor.get("bottomStableBatches")}, gaps=[data.get("quietWindow", {}).get("trigger", "Native client error"), "History incomplete; no repeated recovery requests"], extra={"pausedCursor": {key: value for key, value in cursor.items() if key != "postIds"}})
    read("outputs/source-hunt/2026-11-15-fall-2026-x-ui-resume-ledger.json")
    read("outputs/source-hunt/2026-11-15-fall-2026-x-ui-native-search-coverage.json")
    path = "outputs/source-hunt/2026-11-15-fall-2026-x-ui-identity-aliases.json"
    for index, alias in enumerate(read(path)["aliases"]):
        row = account("x", alias["currentAccountUrl"], "company-" + alias["companySlug"], ref(path, f"/aliases/{index}"), "native_identity_chain_candidate_pending_alias_registration")
        observe(row, path, f"/aliases/{index}", "partial_native_identity_chain_candidate", "Native current-brand identity chain candidate; pending canonical alias registration, not an automatic ownership promotion", {"savedNativePostCandidates": len(alias.get("posts", []))}, gaps=["Native history incomplete; candidate identity status retained unchanged"], extra={"nativeStatus": alias["status"], "observedAt": SOURCES[path]["data"]["source"].get("observedAt")})


def other_platforms():
    path = "outputs/source-hunt/2026-11-15-fall-2026-other-platform-official-outbound-inventory.json"
    for index, target in enumerate(read(path)["ownedTargets"]):
        account(target["platform"], target["sourceUrl"], "company-" + target["companySlug"], ref(path, f"/ownedTargets/{index}"), "official_site_explicit_company_target")
    for path in ["outputs/fall-2026/browser-checkpoints/other-platform-ui-current.json", "outputs/fall-2026/browser-checkpoints/other-platform-ui-delta-2.json", "outputs/fall-2026/browser-checkpoints/facebook-ui-current.json", "outputs/fall-2026/browser-checkpoints/facebook-ui-delta-2.json"]:
        data = read(path)
        for index, profile in enumerate(data["profiles"]):
            platform = profile.get("platform", "facebook" if "facebook-" in path else None)
            if not platform:
                UNMAPPED.append({"source": ref(path, f"/profiles/{index}"), "reason": "Missing platform"})
                continue
            gate = profile.get("publicHistoryGate") or {}
            row = account(platform, profile.get("url") or gate.get("url"))
            if gate:
                observe(row, path, f"/profiles/{index}/publicHistoryGate", "authentication_required", "Public Facebook history ended at native login gate; user scope prohibits further authentication", gaps=[gate.get("nativeText", "See more on Facebook login gate")], extra={"observedAt": gate.get("observedAt")})
                continue
            coverage = profile.get("coverage", {})
            empty = profile.get("explicitNoPostsAvailable") is True
            count = len(profile.get("articles", profile.get("postLinks", [])))
            counts = {"visibleCardOrListingRows": count, **compact_fields(coverage, ["profileListedUnique", "capturedUnique", "capturedNativeIds", "latestNativeIds", "oldestNativeIds"])}
            end = platform == "tiktok" and (profile.get("endObservation", {}).get("nextCount") == 0 or coverage.get("nextCount") == 0)
            reason = coverage.get("reason") or "Public available cards captured; no proof of complete account history"
            observe(row, path, f"/profiles/{index}", "public_posts_empty_observed" if empty else "available_surface_end_full_history_uncertain" if end else "public_surface_partial", "Public-only native profile Posts/listing; no login/account creation", counts, end=end or empty, gaps=[reason], extra={"observedAt": profile.get("observedAt"), "sourceHistoryComplete": coverage.get("historyComplete"), "frontierCheckCount": len(profile.get("frontierChecks", coverage.get("scrollFrontierChecks", [])))})
    path = "outputs/fall-2026/facebook-kairos-public-identity-and-coverage.json"
    data = read(path)
    row = account("facebook", data["profileUrl"], "company-kairos-health", ref(path), "official_site_and_native_profile_identity")
    observe(row, path, "/coverage", "public_posts_empty_observed", "Public selected Posts tab only; No posts available", {"availablePublicPosts": 0}, end=True, gaps=["Public empty surface does not establish full account history; Facebook scope remains public-only"], extra={"observedAt": data["coverage"]["observedAt"], "parentArchives": archive_refs(data)})
    path = "outputs/fall-2026/browser-checkpoints/threads-sirsho-ui-current.json"
    data = read(path)
    row = account("threads", data["source"]["profileUrl"], founder_entity("antimattr", "3675155"), ref(path, "/source"), "verified_native_instagram_profile_outbound_identity")
    observe(row, path, "/coverage", "authentication_required", "Available public Threads cards before login gate", {"nativePublicCards": len(data["nativePosts"])}, gaps=[data["coverage"]["frontier"]], extra={"observedAt": data["source"].get("observedAt")})


def websites_github_youtube():
    path = "outputs/source-hunt/2026-11-15-fall-2026-public-history-coverage.json"
    for index, company in enumerate(read(path)["companies"]):
        url = company.get("officialWebsite")
        if not url:
            UNMAPPED.append({"source": ref(path, f"/companies/{index}"), "companySlug": company["companySlug"], "reason": "No official company website recorded; not evidence no website exists"})
            continue
        row = account("website", url, "company-" + company["companySlug"], ref(path, f"/companies/{index}"), "official_yc_link")
        observe(row, path, f"/companies/{index}", "literal_discovery_frontier_exhausted_history_uncertain", "Official site literal-link/feed/archive discovery; not complete historical publication enumeration", {"httpAttempts": company["httpAttempts"], "nativeArticleContexts": company["nativeArticleContexts"], "requestFailures": len(company.get("requestFailures", [])), "unresolvedPagination": len(company.get("unresolvedPagination", []))}, gaps=[company["historyCoverage"], "No complete platform history/pagination exhaustion proof"], extra={"nativeStatus": company["status"], "sourceHistoryComplete": company["historyComplete"], "paginationExhaustionProven": company["paginationExhaustionProven"], "unresolvedPagination": company.get("unresolvedPagination", []), "requestFailures": company.get("requestFailures", [])})
    path = "src/lib/social/github-traction-fall-2026.json"
    for index, target in enumerate(read(path)["accounts"]):
        row = account("github", target["githubUrl"], target.get("entityId"), ref(path, f"/accounts/{index}"), "official_snapshot_identity")
        observe(row, path, f"/accounts/{index}", "repository_snapshot_only", "Owned GitHub account/repository snapshot; release histories tracked separately", {"snapshotRepositories": len(target.get("repos", []))}, gaps=["Repository/account snapshot is not full issue, pull request, discussion, commit or release history"], extra={"repositoryPagination": target.get("repositoryPagination"), "fetched": target.get("fetched")})
    path = "outputs/source-hunt/2026-11-15-fall-2026-github-release-coverage.json"
    for index, repo in enumerate(read(path)["repositories"]):
        row = account("github", "https://github.com/" + repo["repositoryFullName"])
        for owner in repo["owners"]:
            account("github", "https://github.com/" + repo["repositoryFullName"], owner["ownerSnapshot"]["entityId"], ref(path, f"/repositories/{index}/owners"), "snapshot_repository_ownership")
        end = repo.get("historyComplete") is True and repo.get("paginationExhaustionProven") is True
        observe(row, path, f"/repositories/{index}", "scoped_available_history_complete" if end else "partial_history", repo["coverageScope"], {"publishedNativeReleaseRows": repo["nativeReleaseRows"], "acceptedContextRows": repo["acceptedContextRows"], "pages": len(repo["pages"])}, end=end, claim=end, gaps=["Completion covers published releases in this snapshot repository only; other account repositories/surfaces and inaccessible drafts remain outside scope"], extra={"paginationExhaustionProven": repo.get("paginationExhaustionProven"), "parentArchives": archive_refs(repo["pages"]), "nativeStatus": repo["status"]})
    path = "outputs/source-hunt/2026-11-15-fall-2026-web-youtube-channel-discovery.json"
    for index, channel in enumerate(read(path)["channels"]):
        row = account("youtube", channel["sourceUrl"])
        for company in channel["companyRefs"]:
            # Launch-embed association alone does not verify personal channel ownership.
            account("youtube", channel["sourceUrl"], "company-" + company["companySlug"], ref(path, f"/channels/{index}/companyRefs"), "company_brand_channel_candidate" if channel.get("channelBrandMatchesCompany") else "official_launch_video_association_only")
        observe(row, path, f"/channels/{index}", "native_first_page_only" if channel["status"] == "fetched" else "client_fetch_error", "Launch-associated public channel first video page; associated personal channels are not presumed company owned", {"listedVideos": len(channel.get("videos", [])), "additionalCandidates": len(channel.get("videoCandidates", [])), "pagesFetched": channel.get("pagesFetched")}, gaps=["Channel continuation and full history not proven", "Additional candidate watch fetches failed with HTTP429; no unverified videos admitted"], extra={"observedAt": channel.get("observedAt"), "channelBrandMatchesCompany": channel.get("channelBrandMatchesCompany"), "paginationComplete": channel.get("paginationComplete"), "continuationSignalSeen": channel.get("continuationSignalSeen")})
    read("outputs/source-hunt/2026-11-15-fall-2026-web-youtube-history-observations.json")
    read("outputs/source-hunt/2026-11-15-fall-2026-web-coverage.json")
    path = "outputs/fall-2026/youtube-owned-site-channel-queue.json"
    for index, target in enumerate(read(path)["targets"]):
        row = account("youtube", target["observedUrl"], "company-" + target["companySlug"], ref(path, f"/targets/{index}"), "official_site_explicit_company_target")
        observe(row, path, f"/targets/{index}", "identity_only", "Literal official-owned website footer channel anchor; native history is separately verified", gaps=["Owned footer discovery alone does not establish native channel history coverage"], extra={"parentArchives": archive_refs(target["physicalSource"])})
    audit_path = "outputs/fall-2026/youtube-native-dom-full-visible-audit.json"
    audit = read(audit_path)
    for index, coverage_audit in enumerate(audit["coverageAudits"]):
        path = coverage_audit["source"]["path"]
        coverage = read(path)
        if SOURCES[path]["sha256"] != coverage_audit["source"]["sha256"]:
            raise ValueError(f"YouTube coverage changed since strict receipt audit: {path}")
        rows = [row for row in audit["rows"] if row["companySlug"] == coverage["companySlug"]]
        complete = coverage_audit["allListedIdsAudited"] is True and coverage_audit["allNativeReceiptsAccepted"] is True and len(rows) == coverage["nativeDetails"] and all(row["ok"] for row in rows)
        row = account("youtube", coverage["channelUrl"], "company-" + coverage["companySlug"], ref(audit_path, f"/coverageAudits/{index}"), "verified_native_and_official_identity")
        observe(row, path, "", "scoped_available_history_complete" if complete else "surface_end_with_unreconciled_gap", coverage["nativeHistoryEndScope"], {"headerVideos": coverage["nativeHeaderVideos"], "listedVideos": coverage["videos"], "listedShorts": coverage.get("shorts"), "visibleListingUnion": coverage["visibleListingUnion"], "strictNativeDetailsAccepted": sum(row["ok"] for row in rows), "explicitDescriptionNormalizations": sum(row.get("descriptionNormalization") is not None for row in rows)}, end=True, claim=complete, gaps=["Scope covers only the observed native Videos/Shorts tabs and visible inventory; private, deleted, unlisted or unobserved surfaces remain unknown"], extra={"nativeReceiptAudit": ref(audit_path, f"/coverageAudits/{index}"), "parentArchives": archive_refs(coverage), "sourceFullHistoryComplete": False})
    path = "outputs/fall-2026/browser-checkpoints/youtube-native-history-coverage.json"
    coverage = read(path, optional=True)
    if coverage:
        audit_path = coverage["strictNativeReceiptAudit"]["path"]
        audit = read(audit_path)
        if SOURCES[audit_path]["sha256"] != coverage["strictNativeReceiptAudit"]["sha256"] or audit["accepted"] != coverage["nativeDetails"] or audit["held"]:
            raise ValueError("Native selected YouTube detail audit/coverage mismatch")
        error_path = coverage["pause"]["nativeErrorSource"]["path"]
        error = read(error_path)
        if SOURCES[error_path]["sha256"] != coverage["pause"]["nativeErrorSource"]["sha256"] or sorted(error["remainingTargets"]) != sorted(coverage["pendingTargets"]):
            raise ValueError("Native YouTube pending/error frontier mismatch")
        row = account("youtube", coverage["channelUrl"], "company-native", ref(path, "/ownershipProof"), "verified_native_and_official_identity")
        observe(row, path, "", "surface_end_with_unreconciled_gap", coverage["nativeHistoryEndScope"], {"headerVideosObserved": coverage["nativeHeaderVideoCountsObserved"], "listedVideos": coverage["videos"], "listedShorts": coverage["shorts"], "visibleListingUnion": coverage["visibleListingUnion"], "strictNativeDetailsAccepted": coverage["nativeDetails"], "pendingVisibleNativeIds": len(coverage["nativeDetailsMissing"]), "unknownDateUnscoredOriginals": coverage["unknownDateUnscoredOriginals"], "existingCanonicalNativeIdDuplicates": coverage["exactExistingCanonicalNativeIdDuplicates"]}, end=coverage["nativeListingFrontiersExhausted"], claim=False, gaps=["7 listed native Shorts remain pending after a generic error; full native description history is incomplete", "Header41/42 semantics differ across observations; no account-history inference", "Private, deleted, unlisted and unobserved surfaces remain unknown"], extra={"nativeReceiptAudit": ref(audit_path), "nativeErrorReceipt": ref(error_path, "/observation"), "nativeStatus": coverage["pause"]["state"], "pendingTargets": coverage["pendingTargets"], "sourceFullHistoryComplete": False, "parentArchives": archive_refs(coverage)})


def finish():
    # Keep the pinned merger summary as evidence counts, never as coverage proof.
    merge_path = f"outputs/fall-2026/collection/checkpoint-{CHECKPOINT}/merge-summary.json"
    merged = read(merge_path)
    context_reconciliation = merged.get("contextReconciliation")
    if context_reconciliation:
        reconciliation = read(context_reconciliation["path"])
        if (reconciliation["afterTargetSha256"] != context_reconciliation["finalCanonicalSha256"]
                or reconciliation["beforeTargetSha256"] != context_reconciliation["previousNativeSha256"]
                or reconciliation["after"] != merged["after"]
                or reconciliation["existingRowsByteEquivalent"] is not True
                or reconciliation["earlierCohortsUnchanged"] is not True
                or reconciliation["accepted"] != context_reconciliation["accepted"]
                or reconciliation["nativeSocialPostsAdded"] != 0):
            raise ValueError("Founder publication append audit/canonical count lineage mismatch")
    for row in ACCOUNTS.values():
        observations = row["observations"]
        actual = [o for o in observations if o["state"] not in ["discovery_only", "identity_only", "discovery_search_only"]]
        positive = [o for o in observations if o["sourceClaimsScopedHistoryComplete"]]
        gap = [o for o in observations if o["state"] == "surface_end_with_unreconciled_gap"]
        if any(o["state"] == "authentication_required" for o in actual):
            state = "authentication_required"
        elif any(o["state"] == "client_loading_error_paused" for o in actual):
            state = "client_loading_error_paused"
        elif any(o["state"] == "private_profile" for o in actual):
            state = "private_profile"
        elif gap:
            state = "available_surface_end_with_unreconciled_gap"
        elif positive:
            state = "scoped_available_history_complete"
        elif any(o["availableSurfaceEndObserved"] for o in actual):
            state = "available_surface_end_full_history_uncertain"
        elif actual:
            state = "partial_history"
        else:
            state = "discovery_only"
        row["coverage"] = {"state": state, "availableSurfaceEndObserved": any(o["availableSurfaceEndObserved"] for o in observations), "scopedCompletionSourceCount": len(positive), "allAccountSurfacesComplete": False, "unobservedSurfacesRemainUnknown": True}
    verified_status = {"official_yc_link", "verified_native_and_official_identity", "official_site_and_native_profile_identity", "native_verified_founder_identity", "official_or_native_verified_founder_identity", "official_site_explicit_company_target", "verified_native_instagram_profile_outbound_identity", "official_snapshot_identity", "snapshot_repository_ownership"}
    for entity in ENTITIES.values():
        entity_accounts = [row for row in ACCOUNTS.values() if any(owner["entityId"] == entity["entityId"] for owner in row["owners"])]
        entity["accountIds"] = sorted(row["accountId"] for row in entity_accounts)
        entity["platformDiscovery"] = []
        for platform in PLATFORMS:
            targets = [row for row in entity_accounts if row["platform"] == platform]
            known = [row for row in targets if any(owner["entityId"] == entity["entityId"] and owner["ownershipStatus"] in verified_status for owner in row["owners"])]
            entity["platformDiscovery"].append({"platform": platform, "state": "known_account_targets" if known else "associated_candidates_only" if targets else "no_account_discovered", "accountIds": sorted(row["accountId"] for row in targets), "knownIdentityCount": len(known), "accountCoverageStates": dict(sorted(Counter(row["coverage"]["state"] for row in targets).items())), "ownedAccountHistoryCollectionStarted": any(row["coverage"]["state"] != "discovery_only" for row in known), "associatedOrOwnedSurfaceObserved": any(row["coverage"]["state"] != "discovery_only" for row in targets), "accountExistenceProvenAbsent": False, "fullHistoryComplete": False})
        known_targets = [row for row in entity_accounts if any(owner["entityId"] == entity["entityId"] and owner["ownershipStatus"] in verified_status for owner in row["owners"])]
        started = [row for row in known_targets if row["coverage"]["state"] != "discovery_only"]
        entity["observedAccountSurfaceCount"] = len(started)
        entity["collectionStatus"] = "partial_observed_owned_account_surfaces" if started else "unstarted_known_account_histories" if known_targets else "associated_candidates_only_owned_history_unstarted" if entity_accounts else "no_account_discovered"
        entity["historyStatus"] = "incomplete_or_unstarted_across_requested_platforms"
        entity["fullHistoryComplete"] = False
    counts = Counter(row["coverage"]["state"] for row in ACCOUNTS.values())
    platforms = {}
    for platform in PLATFORMS:
        rows = [row for row in ACCOUNTS.values() if row["platform"] == platform]
        platforms[platform] = {"accountOrRepositoryTargets": len(rows), "byCoverageState": dict(sorted(Counter(row["coverage"]["state"] for row in rows).items())), "entitiesWithKnownOrAssociatedTargets": len({owner["entityId"] for row in rows for owner in row["owners"]}), "allAccountHistoriesComplete": False}
    policy = [
        {"platform": "linkedin", "state": "user_reported_account_restriction_all_authenticated_collection_paused", "scope": "All authenticated LinkedIn collection, including replacement accounts", "instructionProvenance": "User shared screenshot showing prior account temporarily restricted with government-ID requirement. Parent instruction: do not shift bulk collection to replacement account or request another login.", "userReportedRestriction": {"sourceType": "user_screenshot_reported_in_active_session", "restriction": "temporarily restricted; government-ID verification requested", "physicalAttachmentPathAvailableToThisBuilder": False}, "replacementAccount": {"reportedProfile": "testopencli-test-20a263450", "usedForIngestion": False, "collectionAuthorizedToResume": False}, "priorNativeAuthenticationFailure": ref("outputs/fall-2026/browser-checkpoints/linkedin-ui-lane2.json", "/profiles/27/authenticationFailureProof")},
        {"platform": "x", "state": "client_loading_error_paused", "scope": "Native X lane", "nativeReceipt": ref("outputs/source-hunt/2026-11-15-fall-2026-x-native-family-audit.json", "/quietWindow"), "reason": "Something went wrong; latest warning is a client error, not asserted to be a native429. Earlier429 receipts are preserved in resume ledger."},
        {"platform": "facebook", "state": "public_only_user_scope", "scope": "Publicly available posts only", "instructionProvenance": "User declined login; no further login asks, account creation or non-dismissable gate bypass", "nativeReceipt": ref("outputs/fall-2026/facebook-kairos-public-identity-and-coverage.json", "/coverage")},
    ]
    native_youtube_error = "outputs/fall-2026/browser-checkpoints/youtube-native-error-frontier-001.json"
    if native_youtube_error in SOURCES:
        policy.append({"platform": "youtube", "state": "native_generic_error_pause_cause_unspecified", "scope": "Native YouTube lane paused after a visible Oops/Something went wrong page", "nativeReceipt": ref(native_youtube_error, "/observation"), "confirmedRateLimit": False, "confirmedAuthOrSecurityCause": False, "retryOrReloadAttempted": False, "parentQuietWindowMinutes": 30, "parentReviewRequiredBeforeFurtherRequests": True, "unavailablePendingNativeShorts": len(SOURCES[native_youtube_error]["data"]["remainingTargets"])})
    ledger = {"schemaVersion": 1, "batchSlug": "F26", "generatedAt": datetime.now(timezone.utc).isoformat(), "scope": "Full available authored account history for all 235 companies and 457 founders; platform/surface limits remain explicit", "networkRequestsMade": 0, "canonicalWritesMade": 0, "globalFullHistoryComplete": False, "definitions": {"no_account_discovered": "No verified target in reconciled sources; never means no account exists", "scoped_available_history_complete": "A source explicitly proves completion only for the stated available native collection/surface", "available_surface_end": "A rendered native frontier was exhausted; hidden/deleted/private or other account surfaces remain unknown", "counts": "Saved native observations or pinned accepted evidence, never a proxy for history completion", "sourceHashes": "Primary source manifest hashes are physical bytes read by this builder; parentArchives retain the originating source's declared hashes without claiming fresh revalidation", "ownership": "Official/verified account identity is distinct from company-grid appearances, launch embeds, third-party context and candidate channel associations"}, "policyStops": policy, "summary": {"rosterCompanies": sum(e["entityType"] == "company" for e in ENTITIES.values()), "rosterFounders": sum(e["entityType"] == "founder" for e in ENTITIES.values()), "entities": len(ENTITIES), "accountOrRepositoryTargets": len(ACCOUNTS), "accountTargetsByCoverageState": dict(sorted(counts.items())), "platforms": platforms, "unmappedObservations": len(UNMAPPED), "globalFullHistoryComplete": False, "pinnedAcceptedEvidenceCounts": {"source": ref(merge_path), "checkpoint": 26, "fallEvidence": merged["fallEvidence"], "nativePosts": merged["nativePosts"], "byPlatform": merged["byPlatform"], "notUsedAsHistoryProof": True}}, "entities": sorted(ENTITIES.values(), key=lambda e: (e["companySlug"], e["entityType"], e["entityId"])), "accounts": sorted(ACCOUNTS.values(), key=lambda a: a["accountId"]), "discoveryHolds": {"source": ref("outputs/fall-2026/instagram-company-posts-reels-coverage-queue.json", "/excludedWebsiteLinks"), "records": SOURCES["outputs/fall-2026/instagram-company-posts-reels-coverage-queue.json"]["data"]["excludedWebsiteLinks"], "note": "Customer/testimonial, generic platform and unavailable identity links remain unpromoted"}, "unmappedObservations": UNMAPPED, "sourceManifest": [{key: value for key, value in record.items() if key != "data"} for _, record in sorted(SOURCES.items())]}
    assert ledger["summary"]["rosterCompanies"] == 235
    assert ledger["summary"]["rosterFounders"] == 457
    assert len({entity["entityId"] for entity in ledger["entities"]}) == 692
    assert all(not entity["fullHistoryComplete"] for entity in ledger["entities"])
    assert all(not row["coverage"]["allAccountSurfacesComplete"] for row in ledger["accounts"])
    assert len(ledger["sourceManifest"]) == len(SOURCES)
    assert all(len(entity["platformDiscovery"]) == len(PLATFORMS) for entity in ledger["entities"])
    ledger["summary"]["pinnedAcceptedEvidenceCounts"]["checkpoint"] = CHECKPOINT
    ledger["summary"]["pinnedAcceptedEvidenceCounts"]["nativePostsScope"] = "Legacy nativePosts count covers X/LinkedIn/Instagram/TikTok/Facebook/Threads; nativeYouTubePosts is reported separately"
    ledger["summary"]["pinnedAcceptedEvidenceCounts"]["nativeYouTubePosts"] = merged.get("nativeYouTubePosts")
    ledger["summary"]["pinnedAcceptedEvidenceCounts"]["totalEvidenceIncludingEarlierCohorts"] = merged["after"]
    ledger["summary"]["pinnedAcceptedEvidenceCounts"]["founderPublicationContexts"] = merged.get("founderPublicationContexts", 0)
    if context_reconciliation:
        ledger["summary"]["pinnedAcceptedEvidenceCounts"]["canonicalAppendAudit"] = ref(context_reconciliation["path"])
        ledger["summary"]["pinnedAcceptedEvidenceCounts"]["finalCanonicalSha256"] = context_reconciliation["finalCanonicalSha256"]
    ledger["summary"]["entityCollectionStates"] = dict(sorted(Counter(entity["collectionStatus"] for entity in ledger["entities"]).items()))
    ledger["summary"]["entitiesByTypeAndCollectionState"] = {kind: dict(sorted(Counter(entity["collectionStatus"] for entity in ledger["entities"] if entity["entityType"] == kind).items())) for kind in ["company", "founder"]}
    output = ROOT / OUT
    output.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n")
    summary = ["Fall 2026 full-history coverage ledger", f"Snapshot: {ledger['generatedAt']}", "235 companies; 457 founders; 692 roster entities.", f"{len(ACCOUNTS)} account/repository targets; {len(SOURCES)} physically hashed source files.", "Full batch history remains incomplete. No roster entity is marked globally complete.", "All authenticated LinkedIn collection paused after user-reported temporary account restriction; replacement account unused for ingestion.", "X paused on native client loading error; Facebook is public-only.", "Native YouTube paused after a generic Oops error with cause unspecified; Native42listed/35details/7pending, no retry or rate-limit assertion." if native_youtube_error in SOURCES else "", ""]
    for platform, value in platforms.items():
        summary.append(f"{platform}: {value['accountOrRepositoryTargets']} targets; " + "; ".join(f"{state}={count}" for state, count in value["byCoverageState"].items()))
    summary += ["", f"Canonical checkpoint {CHECKPOINT} counts are retained only as evidence volume, not coverage proof.", "No-account-discovered means unknown/unstarted, never proven account absence.", "Parent archive hashes are retained as declared lineage; primary source hashes are freshly computed.", f"Unmapped observations retained for review: {len(UNMAPPED)}", f"Machine ledger: {OUT}"]
    (ROOT / OUT.replace(".json", "-summary.txt")).write_text("\n".join(summary) + "\n")
    print(json.dumps({"path": OUT, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "bytes": output.stat().st_size, "summary": ledger["summary"]}, indent=2))


if __name__ == "__main__":
    roster()
    linkedin()
    instagram()
    x_platform()
    other_platforms()
    websites_github_youtube()
    finish()
