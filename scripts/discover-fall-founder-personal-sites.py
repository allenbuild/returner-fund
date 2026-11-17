#!/usr/bin/env python3
"""Bounded personal-site discovery from literal saved official-profile website labels."""
import argparse
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs/fall-2026/founder-personal-site-discovery"
SEEDS = [("choyrb", "robinchoy.com"), ("orgho12", "orgho.ai"), ("utkarsh__saxena", "saxenautkarsh.com")]
PROFILE = "outputs/fall-2026/browser-checkpoints/x-ui-base-1794862008501.json"
ROSTER = "src/lib/yc/fall-2026-companies.json"


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def read(path):
    blob = (ROOT / path).read_bytes()
    return json.loads(blob), {"path": path, "sha256": sha(blob)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def allowed(url):
    value = urllib.parse.urlsplit(url)
    host = (value.hostname or "").lower().removeprefix("www.")
    forbidden = ["x.com", "twitter.com", "t.co", "linkedin.com", "instagram.com", "facebook.com", "tiktok.com", "threads.com", "youtube.com"]
    return value.scheme == "https" and not value.username and not value.password and all(host != item and not host.endswith("." + item) for item in forbidden)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch", action="store_true", help="Make at most one initial request per literal personal domain, with bounded normal redirects; never retry failures")
    args = parser.parse_args()
    if not args.fetch:
        raise SystemExit("Explicit --fetch required")
    if (OUT / "discovery.json").exists():
        raise SystemExit("A durable attempt ledger already exists. Use the offline link auditor; completed or failed public requests are not retried.")
    profiles, profile_ref = read(PROFILE)
    roster, roster_ref = read(ROSTER)
    OUT.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(NoRedirect())
    records, requests_made, stopped = [], 0, False
    for handle, label in SEEDS:
        profile = profiles["nativeProfileBounds"][handle]
        anchors = [link for link in profile["nativeProfileLinks"] if link["text"] == label and 'data-testid="UserUrl"' in link["anchorHtml"]]
        owners = [(ci, fi, company, founder) for ci, company in enumerate(roster["companies"]) for fi, founder in enumerate(company["founders"]) if urllib.parse.urlsplit(founder.get("socialLinks", {}).get("x", "")).path.strip("/").lower() == handle]
        if len(anchors) != 1 or len(owners) != 1:
            raise ValueError("Seed must match one literal official founder profile website label")
        ci, fi, company, founder = owners[0]
        record = {"companySlug": company["slug"], "founderId": founder["id"], "founderName": founder["name"], "officialRosterSource": {**roster_ref, "jsonPointer": f"/companies/{ci}/founders/{fi}"}, "nativeProfileSource": {**profile_ref, "jsonPointer": f"/nativeProfileBounds/{handle}"}, "nativeProfileUrl": profile["sourceUrl"], "literalWebsiteProfileAnchor": anchors[0], "requestedUrl": "https://" + label + "/", "urlConstruction": "HTTPS scheme and root slash applied to the exact fully visible website label; t.co target was not requested or claimed resolved", "requests": [], "identityStatus": "official_profile_website_label_candidate", "canonicalWritesMade": 0}
        if stopped:
            record["status"] = "unvisited_after_public_warning_stop"
            records.append(record)
            continue
        url = record["requestedUrl"]
        for _ in range(4):
            if not allowed(url):
                record["status"] = "redirect_to_excluded_platform_or_nonpublic_scheme_held"
                break
            if requests_made:
                time.sleep(2.1)
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html,application/xhtml+xml"})
            observed = datetime.now(timezone.utc).isoformat()
            try:
                response = opener.open(request, timeout=12)
            except urllib.error.HTTPError as error:
                response = error
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                requests_made += 1
                record["requests"].append({"url": url, "observedAt": observed, "error": str(error), "retried": False})
                record["status"] = "public_request_failed_no_retry"
                break
            requests_made += 1
            status = response.code
            blob = response.read(8 * 1024 * 1024)
            source = OUT / (label + "-" + sha(blob) + ".html")
            source.write_bytes(blob)
            receipt = {"url": url, "observedAt": observed, "status": status, "contentType": response.headers.get("Content-Type"), "location": response.headers.get("Location"), "bodySource": {"path": str(source.relative_to(ROOT)), "sha256": sha(blob), "bytes": len(blob)}}
            record["requests"].append(receipt)
            text = blob.decode("utf-8", errors="replace")
            if status in (401, 403, 429) or re.search(r"(?:verify you are human|checking your browser|captcha|rate limit exceeded|access denied)", re.sub(r"<[^>]+>", " ", text)[:10000], re.I):
                record["status"] = "public_auth_rate_or_challenge_warning_no_retry"
                stopped = True
                break
            if status in (301, 302, 303, 307, 308) and receipt["location"]:
                url = urllib.parse.urljoin(url, receipt["location"])
                continue
            record["status"] = "public_html_saved" if status == 200 and "html" in (receipt["contentType"] or "") else "unsupported_public_response_no_retry"
            record["finalUrl"] = url
            record["physicalHomepage"] = receipt["bodySource"]
            break
        records.append(record)
        checkpoint = {"source": "literal_official_profile_personal_site_discovery_v1", "generatedAt": datetime.now(timezone.utc).isoformat(), "requestsMade": requests_made, "maxInitialDomains": 3, "noAuthenticatedRequests": True, "xOrLinkedInRequestsMade": 0, "canonicalWritesMade": 0, "stoppedOnWarning": stopped, "records": records}
        output = OUT / "discovery.json"
        output.write_text(json.dumps(checkpoint, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"path": str(output.relative_to(ROOT)), "sha256": sha(output.read_bytes()), "requestsMade": requests_made, "records": [{"founderName": r["founderName"], "status": r["status"]} for r in records]}, indent=2))


if __name__ == "__main__":
    main()
