#!/usr/bin/env python3
"""Read-only audit of saved native outer-card identities and owned-site links.

No network or canonical writes. Caption translation share IDs are deliberately
not converted to activity IDs or constructed permalinks. Quoted source links
are held separately from the outer account's original post identity.
"""

import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = "outputs/fall-2026/linkedin-saved-public-identity-audit.json"
MANIFEST = {}


def load(path):
    blob = (ROOT / path).read_bytes()
    MANIFEST[path] = {"path": path, "sha256": hashlib.sha256(blob).hexdigest(), "bytes": len(blob)}
    return json.loads(blob)


def source(path, pointer=""):
    return {**MANIFEST[path], "jsonPointer": pointer}


def text_of(html):
    return unescape(re.sub(r"<[^>]*>", " ", html)).strip()


URN = re.compile(r"urn:li:(activity|ugcPost|share):([0-9]+)")
POST = re.compile(r"linkedin\.com/(?:posts/|embed/|feed/update)")
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class Node:
    def __init__(self, tag, attrs, start, parent=None):
        self.tag, self.attrs, self.start, self.parent = tag, dict(attrs), start, parent
        self.end = start


class LiteralHTML(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=False)
        self.html = html
        self.offsets = [0]
        for match in re.finditer("\n", html):
            self.offsets.append(match.end())
        self.stack, self.nodes = [], []
        self.feed(html)
        self.close()
        for node in self.stack:
            node.end = len(html)

    def absolute_position(self):
        line, column = self.getpos()
        return self.offsets[line - 1] + column

    def handle_starttag(self, tag, attrs):
        start = self.absolute_position()
        node = Node(tag, attrs, start, self.stack[-1] if self.stack else None)
        node.end = start + len(self.get_starttag_text())
        self.nodes.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.stack.pop()

    def handle_endtag(self, tag):
        end = self.html.find(">", self.absolute_position()) + 1
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i].tag == tag:
                for node in self.stack[i:]:
                    node.end = end
                self.stack = self.stack[:i]
                break

    def fragment(self, node):
        return self.html[node.start:node.end]


def native_card_audit():
    path = "outputs/fall-2026/browser-checkpoints/linkedin-founder-emre-history-assembled-175.json"
    data = load(path)
    progress_path = "outputs/fall-2026/browser-checkpoints/linkedin-founder-emre-native-receipt-progress.json"
    progress = load(progress_path)
    carousel_path = "outputs/fall-2026/browser-checkpoints/linkedin-founder-emre-carousel-reuse-keys.json"
    carousels = load(carousel_path)
    verified_keys = {item["key"] for item in carousels}
    verified_ids = set()
    for item in carousels:
        for url in item["matches"]:
            verified_ids.update(match.group(2) for match in URN.finditer(url))
    part_manifest = []
    for physical in sorted((ROOT / "outputs/fall-2026/browser-checkpoints").glob("linkedin-founder-emre-native-*-*.json")):
        if not re.search(r"(?:native-part|native-detail-part)-[0-9]+\.json$", physical.name):
            continue
        receipt_path = str(physical.relative_to(ROOT))
        receipts = load(receipt_path)
        for item in receipts.get("receipts", []):
            if item.get("sourceCardKey"):
                verified_keys.add(item["sourceCardKey"])
        part_manifest.append(source(receipt_path))
    rows, literal_examples, translations = [], [], Counter()
    for index, card in enumerate(data["cards"]):
        html = card["ownCardHtml"]
        parsed = LiteralHTML(html)
        caption = card.get("captionNodes", [{}])[0] if card.get("captionNodes") else {}
        identities = []
        for node in parsed.nodes:
            for attr in ["href", "src", "data-urn", "data-entity-urn", "data-id", "id"]:
                value = node.attrs.get(attr, "")
                for match in URN.finditer(value):
                    item = {"tag": node.tag, "attribute": attr, "literalValue": value, "namespace": match.group(1), "nativeId": match.group(2), "literalElementHtml": parsed.fragment(node)}
                    # A nested linked-card excerpt is never the outer quote's ID.
                    if len(card.get("captionNodes", [])) > 1:
                        item["binding"] = "nested_quoted_or_live_source_not_outer_original"
                    elif match.group(1) == "activity" and node.tag == "a":
                        item["binding"] = "outer_native_poll_link_already_receipted" if card["componentKey"] in verified_keys else "outer_native_link_candidate_requires_independent_body_actor_gate"
                    else:
                        item["binding"] = "unresolved_native_content_namespace_not_outer_activity"
                    identities.append(item)
        ids = []
        for node in parsed.nodes:
            element_id = node.attrs.get("id", "")
            if element_id.startswith("translatable-commentary-"):
                for kind, value in re.findall(r"(shareId|ugcPostId|activityId)=([0-9]+)", element_id):
                    record = {"kind": kind, "value": value, "literalAttribute": element_id, "binding": "caption_translation_content_identity_only", "notAUsableOuterPermalink": True}
                    if record not in ids:
                        ids.append(record)
                        translations[kind] += 1
        row = {"cardIndex": index, "sourceCardKey": card["componentKey"], "source": source(path, f"/cards/{index}"), "ownCardHtmlSha256": hashlib.sha256(html.encode()).hexdigest(), "sourceCaptionSha256": hashlib.sha256(caption.get("text", "").encode()).hexdigest(), "primaryAuthorMenu": card.get("menuLabel"), "primaryAuthorLinks": card.get("authorHeader", {}).get("links", []), "captionNodeCount": len(card.get("captionNodes", [])), "captionRemainingControlCount": len(caption.get("remainingSeeMoreControls", [])), "captionControlCaveat": "Saved hidden/decorative More controls do not by themselves prove caption truncation or completeness", "alreadyHasIndependentNativeIdentityReceipt": card["componentKey"] in verified_keys, "literalNativeIdentities": identities, "translationContentIdentifiers": ids, "novelStrictAdmissibleOriginal": False}
        rows.append(row)
        if identities:
            literal_examples.append({"cardIndex": index, "sourceCardKey": card["componentKey"], "bindings": [item["binding"] for item in identities]})
    review = []
    for index, item in enumerate(progress.get("nativeReview", [])):
        urls = [iframe["src"] for iframe in item.get("dialog", {}).get("iframes", []) if iframe.get("src")]
        review.append({"source": source(progress_path, f"/nativeReview/{index}"), "sourceCardKey": item["sourceCardKey"], "literalNativeIframeUrls": urls, "reason": "Actual native modal retained literal iframe target, but loaded preview actor/body/metric proof is absent; no activity alias inferred", "status": "held_pending_native_preview_proof", "alreadyHasIndependentNativeIdentityReceipt": item["sourceCardKey"] in verified_keys})
    return {"source": source(path), "entityId": data["entityId"], "counts": {"savedOuterCards": len(rows), "uniqueKeysWithIndependentNativeReceipt": len(verified_keys), "cardsContainingLiteralNativeUrns": len(literal_examples), "cardsWithoutIndependentNativeIdentityReceipt": sum(not row["alreadyHasIndependentNativeIdentityReceipt"] for row in rows), "captionTranslationContentIdentifiers": dict(translations), "failedEmbedModalTargetsRetained": len(review), "novelStrictAdmissibleOriginals": 0}, "sourceReceiptProgressCounts": progress["counts"], "progressCountsCaveat": "Source counters and overlap are retained; unique physical card keys above are counted independently", "literalExamples": literal_examples, "nativeReview": review, "receiptParts": part_manifest, "cards": rows}


def cached_official_sites():
    inventory_path = "outputs/fall-2026/owned-site-social-anchor-candidate-queue.json"
    inventory = load(inventory_path)
    roster_path = "src/lib/yc/fall-2026-companies.json"
    roster = {company["slug"]: company for company in load(roster_path)["companies"]}
    coverage_path = "outputs/fall-2026/full-history-coverage-ledger.json"
    coverage = load(coverage_path)
    entity_states = {entity["entityId"]: entity["collectionStatus"] for entity in coverage["entities"]}
    files, rows, errors = [], [], []
    for entry in inventory["physicalSourceManifest"]:
        if not entry["hostOwned"]:
            continue
        path = entry["path"]
        blob = (ROOT / path).read_bytes()
        actual_sha = hashlib.sha256(blob).hexdigest()
        if actual_sha != entry["sha256"]:
            errors.append({"path": path, "expectedSha256": entry["sha256"], "actualSha256": actual_sha})
            continue
        html = blob.decode(errors="replace")
        if not POST.search(html):
            continue
        MANIFEST[path] = {"path": path, "sha256": actual_sha, "bytes": len(blob)}
        files.append(source(path))
        parsed = LiteralHTML(html)
        for node in parsed.nodes:
            for attr in ["href", "src"]:
                value = node.attrs.get(attr, "")
                if not POST.search(value):
                    continue
                if node.tag not in ["a", "iframe", "blockquote"]:
                    continue
                nearest = node.parent
                choices = []
                while nearest:
                    fragment = parsed.fragment(nearest)
                    if nearest.tag in ["div", "section", "article", "p", "blockquote"] and 80 < len(text_of(fragment)) < 2500 and len(fragment) < 30000:
                        choices.append(nearest)
                    nearest = nearest.parent
                ancestor = choices[0] if choices else node.parent or node
                fragment = parsed.fragment(ancestor)
                actor_match = re.search(r"linkedin\.com/posts/([^_/?]+)_", value)
                actor_slug = unquote(actor_match.group(1)).lower() if actor_match else None
                founder_matches = []
                for founder in roster[entry["companySlug"]]["founders"]:
                    profile = founder.get("socialLinks", {}).get("linkedin", "")
                    profile_slug = unquote(urlsplit(profile).path).rstrip("/").split("/")[-1].lower() if profile else None
                    if actor_slug and actor_slug == profile_slug:
                        entity_id = f"founder-{entry['companySlug']}-{re.sub(r'[^a-z0-9]+', '-', founder['name'].lower()).strip('-')}-{founder['id']}"
                        founder_matches.append({"entityId": entity_id, "founderId": founder["id"], "founderName": founder["name"], "officialProfileUrl": profile, "literalPostActorSlug": actor_slug, "priorCollectionStatus": entity_states[entity_id], "identityCaveat": "Exact official profile slug matches literal Posts permalink actor segment; native primary-author proof still required"})
                ids = [{"namespace": match.group(1), "nativeId": match.group(2)} for match in URN.finditer(value)]
                if not ids:
                    ids = [{"namespace": "activity", "nativeId": match.group(1)} for match in re.finditer(r"-activity-([0-9]+)", value)]
                rows.append({"companySlug": entry["companySlug"], "source": source(path), "sourceUrl": entry["finalUrl"], "ownershipLineage": {"requestedUrl": entry["requestedUrl"], "finalUrl": entry["finalUrl"], "hostOwned": entry["hostOwned"], "lineageInventorySource": source(inventory_path, "/physicalSourceManifest")}, "nativeLiteralUrl": value, "tag": node.tag, "attribute": attr, "nativeLiteralIds": ids, "literalElementHtml": parsed.fragment(node), "containingAncestorHtml": fragment, "containingAncestorText": re.sub(r"\s+", " ", text_of(fragment)), "rosterFounderProfileSlugMatches": founder_matches, "status": "founder_post_permalink_candidate_missing_native_body_proof" if founder_matches else "company_or_third_party_link_not_native_authorship_proof", "nativePrimaryAuthorProven": False, "fullNativeCaptionProven": False, "nativePublicationDateProven": False, "nativeScopedMetricsProven": False, "promoted": False, "holdReason": "Company-hosted link/demo/syndicated excerpt is not verified full native LinkedIn content; no account request or derived permalink made"})
    unique = {(row["companySlug"], row["nativeLiteralUrl"]): row for row in rows}
    return {"source": source(inventory_path), "ownedHtmlFilesScanned": sum(entry["hostOwned"] for entry in inventory["physicalSourceManifest"]), "physicalHashFailures": errors, "filesWithLiteralPostLinks": len(files), "literalLinkOccurrences": len(rows), "uniqueLinkedPostUrls": len(unique), "literalIframeEmbedOccurrences": sum(row["tag"] == "iframe" for row in rows), "founderCandidatePostUrls": len({row["nativeLiteralUrl"] for row in rows if row["rosterFounderProfileSlugMatches"]}), "newStrictAdmissibleOriginals": 0, "candidates": list(unique.values()), "physicalHtmlSources": files}


if __name__ == "__main__":
    native = native_card_audit()
    websites = cached_official_sites()
    output = {"schemaVersion": 1, "batchSlug": "F26", "generatedAt": datetime.now(timezone.utc).isoformat(), "scope": "Saved Emre native outer-card HTML and previously archived official-owned company HTML only", "networkRequestsMade": 0, "authenticatedRequestsMade": 0, "canonicalWritesMade": 0, "replacementLinkedInAccountUsed": False, "allAuthenticatedLinkedInCollectionPaused": True, "emreNativeOuterCardAudit": native, "cachedOfficialSites": websites, "conclusion": "No additional strictly admissible LinkedIn original is proven by these cached sources. Keep literal founder post candidates and failed modal targets for later safe review; translation content IDs and nested quote identities never become outer activity aliases.", "sourceManifest": list(MANIFEST.values())}
    assert len(native["cards"]) == 175
    assert not websites["physicalHashFailures"]
    blob = (json.dumps(output, ensure_ascii=False, indent=2) + "\n").encode()
    (ROOT / OUTPUT).write_bytes(blob)
    print(json.dumps({"path": OUTPUT, "sha256": hashlib.sha256(blob).hexdigest(), "bytes": len(blob), "nativeCounts": native["counts"], "websiteCounts": {key: value for key, value in websites.items() if key not in ["candidates", "physicalHtmlSources", "source"]}}, indent=2))
