#!/usr/bin/env python3
"""Extract literal owned personal-site profile/publication links; no network."""
import hashlib
import html
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "outputs/fall-2026/founder-personal-site-discovery/discovery.json"


def sha(value):
    return hashlib.sha256(value).hexdigest()


class Elements(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source, self.stack, self.nodes = source, [], []
        self.lines = [0]
        for line in source.splitlines(keepends=True):
            self.lines.append(self.lines[-1] + len(line))

    def absolute_offset(self):
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs), "start": self.absolute_offset(), "end": None, "ancestors": self.stack.copy()}
        self.nodes.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                end = self.source.find(">", self.absolute_offset()) + 1
                self.stack[index]["end"] = end
                self.stack = self.stack[:index]
                break

    def outer(self, node):
        return self.source[node["start"]:node["end"]] if node.get("end") else None


def visible(value):
    value = re.sub(r"<(?:script|style)\b[\s\S]*?</(?:script|style)>", "", value or "", flags=re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", " ", value))).strip()


data_bytes = (ROOT / SOURCE).read_bytes()
discovery = json.loads(data_bytes)
records, targets, holds = [], [], []
for index, record in enumerate(discovery["records"]):
    if record["status"] != "public_html_saved":
        continue
    source_ref = record["physicalHomepage"]
    raw = (ROOT / source_ref["path"]).read_bytes()
    if sha(raw) != source_ref["sha256"]:
        raise ValueError("Physical personal-site HTML changed")
    source = raw.decode("utf-8", errors="replace")
    parser = Elements(source)
    parser.feed(source)
    titles = [visible(parser.outer(node)) for node in parser.nodes if node["tag"] == "title"]
    headings = [visible(parser.outer(node)) for node in parser.nodes if node["tag"] == "h1"]
    owner_name = record["founderName"]
    exact_title = any(owner_name in value for value in titles)
    same_named_header = any(owner_name in value or all(part.lower() in value.lower() for part in owner_name.split()) for value in headings)
    first_person = bool(re.search(r"\b(?:I am|I'm|I’m|my entrepreneurial|my own company)\b", visible(source)))
    ownership = exact_title and same_named_header and first_person
    own = {"founderName": owner_name, "founderId": record["founderId"], "companySlug": record["companySlug"], "officialRosterSource": record["officialRosterSource"], "nativeOfficialProfileSource": record["nativeProfileSource"], "nativeOfficialProfileWebsiteAnchor": record["literalWebsiteProfileAnchor"], "personalWebsiteUrl": record["finalUrl"], "homepageSource": source_ref, "title": titles, "h1": headings, "exactTitleName": exact_title, "sameNamedHeader": same_named_header, "firstPersonBiographyPresent": first_person, "identityStatus": "official_native_profile_label_and_matching_self_biography" if ownership else "identity_held"}
    records.append(own)
    for node in parser.nodes:
        href = node["attrs"].get("href", "")
        if node["tag"] != "a" or not href.startswith("https://") or not node["end"]:
            continue
        url = urlsplit(href)
        host = (url.hostname or "").lower().removeprefix("www.")
        platform = "instagram" if host == "instagram.com" else "threads" if host in {"threads.net", "threads.com"} else "tiktok" if host == "tiktok.com" else "youtube" if host in {"youtube.com", "youtu.be"} else "substack" if host.endswith(".substack.com") else "google_scholar" if host == "scholar.google.com" else "github" if host == "github.com" else "x" if host in {"twitter.com", "x.com"} else None
        if not platform:
            continue
        anchor = parser.outer(node)
        text = visible(anchor)
        ancestors = [ancestor for ancestor in reversed(node["ancestors"]) if parser.outer(ancestor)]
        containing = next((ancestor for ancestor in ancestors if ancestor["tag"] in {"footer", "header", "nav"} and owner_name in visible(parser.outer(ancestor))), None)
        if containing is None:
            containing = next((ancestor for ancestor in ancestors if ancestor["tag"] not in {"html", "body"} and any(heading in visible(parser.outer(ancestor)) for heading in headings if heading)), None)
        ancestor = parser.outer(containing) if containing else None
        account_like = platform in {"google_scholar", "github", "x", "instagram", "threads", "tiktok"} or platform == "substack" and url.path in {"", "/"} or platform == "youtube" and (url.path.startswith("/@") or url.path.startswith("/channel/"))
        label_is_profile = text.lower() in {"x", "x / twitter", "@choyrb", "github", "google scholar", "substack", "twitter", "instagram", "youtube", "tiktok", "threads"}
        accepted = ownership and account_like and label_is_profile and ancestor is not None
        target = {"companySlug": record["companySlug"], "founderId": record["founderId"], "founderName": owner_name, "platform": platform, "observedUrl": href, "anchorText": text, "literalAnchorHtml": anchor, "containingAncestorHtml": ancestor, "containingAncestorTag": containing["tag"] if containing else None, "source": {**source_ref, "startOffsetCodePoints": node["start"], "endOffsetCodePoints": node["end"]}, "ownerProofSource": {"path": SOURCE, "sha256": sha(data_bytes), "jsonPointer": f"/records/{index}"}, "status": "owned_personal_site_outbound_native_verification_pending" if accepted else "external_context_or_unsupported_ownership_held", "nativeAccountRequested": False, "canonicalAdmission": False}
        if platform == "x" and host == "twitter.com":
            target["holdReason"] = "Legacy personal-site Twitter alias differs from official roster handle; no X requests or alias promotion"
            accepted = False
            target["status"] = "legacy_alias_candidate_held"
        (targets if accepted else holds).append(target)

output = {"source": "physical_owned_founder_personal_site_social_publication_discovery_v1", "networkRequestsMadeByThisAudit": 0, "publicHomepageRequestsInDiscovery": discovery["requestsMade"], "xOrLinkedInRequestsMade": 0, "canonicalWritesMade": 0, "accountsVerifiedNatively": 0, "founders": records, "ownedOutboundCandidates": targets, "heldExternalContext": holds, "inputSource": {"path": SOURCE, "sha256": sha(data_bytes)}, "note": "Literal profile website labels were normalized to HTTPS roots directly; saved t.co links were never requested or claimed resolved. Exact self-biography/page identity supplies independent confirmation. An outbound publication/media link never makes its native author the founder automatically."}
path = ROOT / "outputs/fall-2026/founder-personal-site-owned-targets.json"
path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"path": str(path.relative_to(ROOT)), "sha256": sha(path.read_bytes()), "verifiedPersonalSites": sum(row["identityStatus"] != "identity_held" for row in records), "candidates": [{"founderName": row["founderName"], "platform": row["platform"], "url": row["observedUrl"]} for row in targets], "held": len(holds)}, indent=2))
