import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { dedupeEvidenceForScoring } from "@/lib/graph/dedupe";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import {
  aggregateBalancedTractionScore,
  computeEvidenceRawEngagement,
  normalizeEvidenceScores
} from "@/lib/graph/traction-scoring";
import { TRACTION_SCORING_CONFIG } from "@/lib/graph/traction-scoring-config";
import type { EvidenceItem, Platform } from "@/lib/graph/types";
import {
  isVerifiedOfficialYcCompanyPageYouTubeEmbed,
  ycSpring2026GraphDataset
} from "@/lib/graph/yc-spring-2026-dataset";

const targetedEvidenceSnapshot = JSON.parse(
  readFileSync(join(process.cwd(), "src/lib/social/targeted-evidence-current.json"), "utf8")
) as {
  evidence: EvidenceItem[];
  needsReview: Array<{
    entityId: string;
    platformPostId?: string | null;
    review_state: string;
    quarantineReasons?: string[];
  }>;
};

describe("YC traction scoring regressions", () => {
  it("scores Eden from verified founder posts while quarantining the cohort roundup", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const eden = graph.nodes.find((node) => node.entityType === "company" && node.entityId === "company-eden-robotics");

    expect(eden).toBeTruthy();
    expect(eden?.score).toBeGreaterThan(0);
    expect(["linkedin", "x"]).toContain(eden?.topPlatform);

    const evidence = selectedNodeEvidence(graph, eden!);
    expect(postIds(evidence)).toEqual(
      expect.arrayContaining([
        "7473766659829223424",
        "2059649954520736030",
        "hjkTYmDQqtQ",
        "oKlgnHUq0jo"
      ])
    );
    expect(postIds(evidence)).not.toContain("7471229920451629056");
    expect(evidence.some((item) => item.contributionScore > 0)).toBe(true);
    expect(
      evidence.find((item) => item.platformPostId === "Gk15eqoQZ-I")
    ).toEqual(
      expect.objectContaining({
        review_state: "needs_review",
        contributionScore: 0
      })
    );
    expect(new Set(evidence.map((item) => `${item.platform}:${item.platformPostId}`)).size).toBe(evidence.length);

    expect(
      targetedEvidenceSnapshot.needsReview.find(
        (item) =>
          item.platformPostId === "7471229920451629056" &&
          item.entityId === "company-eden-robotics"
      )
    ).toEqual(
      expect.objectContaining({
        review_state: "needs_review",
        quarantineReasons: expect.arrayContaining(["third_party_cohort_roundup_list_entry_only"])
      })
    );

    const founderAccounts = eden!.founders.flatMap((founder) => founder.socialAccounts);
    expect(founderAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "x", handle: "cybermetheus", review_state: "verified" }),
        expect.objectContaining({
          platform: "linkedin",
          handle: "stamatis-floratos-535b19244",
          review_state: "verified"
        })
      ])
    );
    expect(founderAccounts.some((account) => /StamatisTWIY/i.test(account.url))).toBe(false);

    const insiderGraph = buildGraphResponse(
      { batchSlug: "S2026", topVoices: "insiders" },
      ycSpring2026GraphDataset
    );
    expect(insiderGraph.evidence.some((item) => item.platformPostId === "7471229920451629056")).toBe(false);
  });

  it("trusts only complete official YC company-page YouTube embed receipts", () => {
    const edenYouTube = targetedEvidenceSnapshot.evidence.find(
      (item) =>
        item.entityId === "company-eden-robotics" &&
        item.platform === "youtube" &&
        item.platformPostId === "hjkTYmDQqtQ"
    );
    expect(edenYouTube).toBeTruthy();
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed(edenYouTube)).toBe(true);

    const receipt = JSON.parse(edenYouTube!.rawVisibleText ?? "{}");
    const withReceipt = (nextReceipt: unknown) => ({
      ...edenYouTube,
      rawVisibleText: JSON.stringify(nextReceipt)
    });
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed({ ...edenYouTube, entityType: "founder" })).toBe(false);
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed({ ...edenYouTube, review_state: "needs_review" })).toBe(false);
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed({ ...edenYouTube, attributionStatus: "unverified" })).toBe(false);
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed({ ...edenYouTube, attributionSignals: [] })).toBe(false);
    expect(
      isVerifiedOfficialYcCompanyPageYouTubeEmbed(withReceipt({ ...receipt, source: "untrusted_source" }))
    ).toBe(false);
    expect(
      isVerifiedOfficialYcCompanyPageYouTubeEmbed(withReceipt({
        ...receipt,
        company: { ...receipt.company, entityId: "company-not-eden" }
      }))
    ).toBe(false);
    expect(
      isVerifiedOfficialYcCompanyPageYouTubeEmbed(withReceipt({
        ...receipt,
        officialYcProfileUrl: "https://www.ycombinator.com/companies/not-eden"
      }))
    ).toBe(false);
    expect(
      isVerifiedOfficialYcCompanyPageYouTubeEmbed(withReceipt({
        ...receipt,
        post: { ...receipt.post, platformPostId: "DifferentVideo" }
      }))
    ).toBe(false);
    expect(
      isVerifiedOfficialYcCompanyPageYouTubeEmbed({
        ...edenYouTube,
        sourceUrl: "https://youtube.com/watch?v=DifferentVideo"
      })
    ).toBe(false);
    expect(
      isVerifiedOfficialYcCompanyPageYouTubeEmbed({
        ...edenYouTube,
        sourceUrl: "https://youtube.com.evil.example/watch?v=hjkTYmDQqtQ"
      })
    ).toBe(false);

    const manuallyAdjudicated = targetedEvidenceSnapshot.evidence.find(
      (item) =>
        item.entityId === "company-jo" &&
        item.platform === "youtube" &&
        item.platformPostId === "7u6vxYF44rI"
    );
    expect(manuallyAdjudicated).toBeTruthy();
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed(manuallyAdjudicated)).toBe(true);
    expect(
      isVerifiedOfficialYcCompanyPageYouTubeEmbed({
        ...manuallyAdjudicated,
        attributionProvenance: "untrusted_manual_review"
      })
    ).toBe(false);
    expect(
      isVerifiedOfficialYcCompanyPageYouTubeEmbed({
        ...manuallyAdjudicated,
        matchReason: "Receipt verification no longer matches the adjudication."
      })
    ).toBe(false);
  });

  it("reports platform coverage for the selected YC batch", () => {
    const springGraph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const summerGraph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const springLinkedIn = springGraph.platformStatus.find((status) => status.platform === "linkedin");
    const summerLinkedIn = summerGraph.platformStatus.find((status) => status.platform === "linkedin");

    expect(springLinkedIn?.notes).toContain("Spring 2026");
    expect(springLinkedIn?.notes).not.toContain("Summer 2026");
    expect(summerLinkedIn?.notes).toContain("Summer 2026");
    expect(summerLinkedIn?.notes).not.toContain("Spring rows are currently available");
    expect(springLinkedIn?.authMethod).toContain("authenticated browser session");
    expect(summerLinkedIn?.authMethod.toLowerCase()).toContain("public unauthenticated");
    expect(summerLinkedIn?.authMethod.toLowerCase()).not.toContain("authenticated browser session");

    const springInstagram = springGraph.platformStatus.find((status) => status.platform === "instagram");
    const summerInstagram = summerGraph.platformStatus.find((status) => status.platform === "instagram");
    expect(springInstagram?.status).toBe("working");
    expect(summerInstagram?.status).toBe("working");
    expect(springInstagram?.authMethod).toContain("authenticated browser session");
    expect(summerInstagram?.authMethod).toContain("authenticated browser session");
  });

  it("does not carry old Spring evidence into Conifer's selected company feed", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const conifer = graph.nodes.find((node) => node.entityType === "company" && node.label === "Conifer");

    expect(conifer).toBeTruthy();
    expect(graph.evidence.some((item) => item.attachedCompanyName === "HeyClicky")).toBe(false);
    expect(graph.evidence.some((item) => item.attachedCompanyName === "InsForge")).toBe(false);

    const selectedEvidence = selectedNodeEvidence(graph, conifer!);
    const allowedEntityIds = new Set([conifer!.entityId, ...conifer!.relatedEntityIds]);

    expect(selectedEvidence.every((item) => allowedEntityIds.has(item.entityId))).toBe(true);
    expect(selectedEvidence.every((item) => item.attachedCompanyName === "Conifer")).toBe(true);
  });

  it("scores Conifer's GitHub traction above Mireye's GitHub traction", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const conifer = graph.nodes.find((node) => node.entityType === "company" && node.label === "Conifer");
    const mireye = graph.nodes.find((node) => node.entityType === "company" && node.label === "Mireye");

    expect(conifer?.platformScores.github).toBeGreaterThan(mireye?.platformScores.github ?? 0);
    expect(conifer?.score).toBeGreaterThan(0);
    expect(mireye?.score).toBeGreaterThan(0);
  });

  it("surfaces newly verified first-party posts from the source snapshot", () => {
    const springGraph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const summerGraph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);

    expect(postIds(springGraph.evidence)).toEqual(
      expect.arrayContaining([
        "2067679362057675151",
        "2075967468145906159",
        "2077150574827753494",
        "7467704423683837953"
      ])
    );
    expect(postIds(summerGraph.evidence)).toEqual(
      expect.arrayContaining([
        "2072025943397564912",
        "2073250618014044531",
        "7475947824581529600"
      ])
    );
  });

  it("surfaces late-added top voice posts in filtered graph mode", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, ycSpring2026GraphDataset);

    const jaredPloy = graph.evidence.find((item) => item.platformPostId === "2068173500079325363");
    const greyPops = graph.evidence.find((item) => item.platformPostId === "2057161978976915751");

    expect(jaredPloy?.topVoice?.displayName).toBe("Jared Friedman");
    expect(jaredPloy?.attachedCompanyName).toBe("Ploy");
    expect(greyPops?.topVoice?.displayName).toBe("Grey Baker");
    expect(greyPops?.attachedCompanyName).toBe("Pops");
  });

  it("rejects the Parker Conrad reply that targeted someone other than the Context.dev founder", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", topVoices: "insiders" }, ycSpring2026GraphDataset);

    expect(graph.evidence.some(
      (item) => item.sourceUrl === "https://x.com/parkerconrad/status/2069810389022343466"
    )).toBe(false);
    expect(graph.evidence.some((item) => item.platformPostId === "2069810389022343466")).toBe(false);
  });

  it("surfaces source-hunt top voice rows across Spring and Summer filtered modes", () => {
    const springPartners = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, ycSpring2026GraphDataset);
    const springInsiders = buildGraphResponse({ batchSlug: "S2026", topVoices: "insiders" }, ycSpring2026GraphDataset);
    const summerPartners = buildGraphResponse({ batchSlug: "S26", topVoices: "yc_partners" }, ycSpring2026GraphDataset);

    expectTopVoiceEvidence(springPartners.evidence, "2040179321441271966", "Garry Tan", "Armature");
    expectTopVoiceEvidence(springPartners.evidence, "2073858886180942200", "Garry Tan", "Ploy");
    expectTopVoiceEvidence(springPartners.evidence, "2061568169354129640", "Garry Tan", "Lightsprint");
    expectTopVoiceEvidence(springPartners.evidence, "2044855844379255082", "David Lieb", "Datost");
    expectTopVoiceEvidence(springPartners.evidence, "2061499660901253613", "Tom Blomfield", "Apollo Atomics, Inc.");
    expectTopVoiceEvidence(springPartners.evidence, "2061500802896949515", "Tom Blomfield", "Apollo Atomics, Inc.");
    expectTopVoiceEvidence(springPartners.evidence, "2053896017481965682", "David Lieb", "Hyper");
    expectTopVoiceEvidence(springPartners.evidence, "2067101655934591154", "Garry Tan", "9 Mothers");
    expectTopVoiceEvidence(springPartners.evidence, "2037230367598666221", "Aaron Epstein", "Sazabi");
    expectTopVoiceEvidence(springPartners.evidence, "2054035382795370914", "Aaron Epstein", "Interfaze");
    expectTopVoiceEvidence(springPartners.evidence, "2055345726067187880", "David Lieb", "Keyframe Labs");
    expectTopVoiceEvidence(springPartners.evidence, "2051399396944961822", "David Lieb", "Kuli");
    expectTopVoiceEvidence(springPartners.evidence, "2067276082529882563", "Aaron Epstein", "Result");
    expectTopVoiceEvidence(springPartners.evidence, "2066992416578785574", "Aaron Epstein", "HeyClicky");
    expectTopVoiceEvidence(springPartners.evidence, "2066279367509188904", "Aaron Epstein", "Standout");
    expectTopVoiceEvidence(springPartners.evidence, "2066278602321379593", "Aaron Epstein", "Standout");
    expectTopVoiceEvidence(springPartners.evidence, "2062211036942643588", "Aaron Epstein", "Sazabi");
    expectTopVoiceEvidence(springPartners.evidence, "2061593320770650309", "Aaron Epstein", "Parrot");
    expectTopVoiceEvidence(springPartners.evidence, "2060395527322406924", "Aaron Epstein", "Drafted");
    expectTopVoiceEvidence(springPartners.evidence, "2059523990964805976", "Aaron Epstein", "Twolabs");
    expectTopVoiceEvidence(springPartners.evidence, "2057901345508835799", "Aaron Epstein", "Amboras");
    expectTopVoiceEvidence(springPartners.evidence, "2056858519635374466", "Aaron Epstein", "Panacea");
    expectTopVoiceEvidence(springInsiders.evidence, "2077409287211811191", "Sarah Guo", "HeyClicky");
    expectTopVoiceEvidence(springInsiders.evidence, "2039737176259514763", "Mathilde Collin", "Kinro");
    expectTopVoiceEvidence(summerPartners.evidence, "2075013475424952797", "Tyler Bosmeny", "83 Sciences");
    expectTopVoiceEvidence(summerPartners.evidence, "2075342772392067278", "Tyler Bosmeny", "Inkbox");
    expectTopVoiceEvidence(summerPartners.evidence, "2072753766701625532", "Tyler Bosmeny", "Bloomy");
    expectTopVoiceEvidence(summerPartners.evidence, "2077125864006062268", "Ankit Gupta", "Instance");
    expectTopVoiceEvidence(summerPartners.evidence, "2077424054966088137", "Ankit Gupta", "Prized");
    expectTopVoiceEvidence(summerPartners.evidence, "2076783005025124492", "Ankit Gupta", "Instance");
    expectTopVoiceEvidence(summerPartners.evidence, "2076459852113858684", "Tyler Bosmeny", "Inkbox");
    expect(
      springPartners.evidence.some(
        (item) => item.id === "linkedin-topvoice-seventh-pass-s2026-company-insforge-andrew-miklas-7462200339899846656"
      )
    ).toBe(false);
  });

  it("surfaces tenth-pass regular LinkedIn rows in the Spring graph", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026", platforms: ["linkedin"] }, ycSpring2026GraphDataset);

    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/sujaysriv_we-got-into-y-combinator-a-few-months-ago-activity-7445675707990519808-0Pxn",
      "Lab0",
      "linkedin"
    );
    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/utksn15_excited-to-announce-that-my-new-company-mochatrade-activity-7454371499039293440-B6_R",
      "Mochatrade",
      "linkedin"
    );
    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/parthm1801_excited-to-share-that-were-backed-by-y-combinator-activity-7447133638141595648-KFd5",
      "Mochatrade",
      "linkedin"
    );
    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/imj-mcinnis_withai-yc-p26-is-joining-y-combinator-activity-7457828885729140736-2mKO",
      "WithAI",
      "linkedin"
    );
    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/ben-finch-3a82471b5_excited-to-officially-announce-that-withai-activity-7457867745402073088-T_4g",
      "WithAI",
      "linkedin"
    );
    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/oscar-levy_for-2-years-antonin-and-i-wrote-trading-activity-7465112255437844481-gdEy",
      "River Markets",
      "linkedin"
    );
    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/antonin-parrot-a16625196_were-offering-a-11000-referral-fee-to-activity-7469575991892299776-jioE",
      "River Markets",
      "linkedin"
    );
    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/withsherpa_your-website-should-improve-itself-most-activity-7439700075905339393-49jE",
      "Sherpa",
      "linkedin"
    );
    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/ragavsachdeva_super-excited-to-finally-launch-something-activity-7460815540392075265-7_vO",
      "TakeCareOS",
      "linkedin"
    );
  });

  it("surfaces Sol Ultra first-party source-hunt rows in the Spring graph", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const imports: Array<[string, string, Platform]> = [
      ["https://www.linkedin.com/posts/gopalnisha_just-wrapped-y-combinator-p26-with-daniel-activity-7473820951579734016-mUfS", "AbInitio Bio", "linkedin"],
      ["https://www.linkedin.com/posts/gregoirechomette_today-aice-power-is-joining-y-combinator-activity-7444791109265920000-SHGi", "AICE", "linkedin"],
      ["https://youtube.com/watch?v=xnOjtP4qIgk", "ANORIA", "youtube"],
      ["https://www.linkedin.com/posts/aryaman-khanna-210a9121b_arden-yc-p26-is-backed-by-y-combinator-activity-7450643893903208448-OBBq", "Arden", "linkedin"],
      ["https://www.linkedin.com/posts/akira-tong_my-cofounder-phillip-li-said-something-smart-activity-7468336170469617664-VJtT", "Arga Labs", "linkedin"],
      ["https://www.linkedin.com/posts/ashton-daniel_auxos-yc-p26-recently-hosted-a-dinner-with-activity-7461103888213983232-8ltq", "Auxos", "linkedin"],
      ["https://www.linkedin.com/posts/ashton-daniel_what-the-start-of-our-week-looks-like-at-activity-7462553432420392960-U25e", "Auxos", "linkedin"],
      ["https://www.linkedin.com/posts/parth-patwa_excited-to-share-that-we-are-joining-y-combinator-activity-7457104305419046912-WjSP", "BioStack Platforms", "linkedin"],
      ["https://www.linkedin.com/posts/sruvis_when-i-started-a-phd-at-oxford-trying-to-activity-7447721926220750848-WCmT", "Deep Interactions", "linkedin"],
      ["https://www.youtube.com/watch?v=AuSnAHZP2lM", "Deep Interactions", "youtube"],
      ["https://www.linkedin.com/posts/namanyayg_ycombinator-activity-7456364381602365440-bW-i", "Gigacatalyst", "linkedin"],
      ["https://www.linkedin.com/posts/namanyayg_when-your-customers-start-cheering-you-on-activity-7459784869838020608--xcr", "Gigacatalyst", "linkedin"],
      ["https://www.linkedin.com/posts/namanyayg_1000-investors-me-and-gigacatalyst-yc-activity-7473415485594968068-GQrV", "Gigacatalyst", "linkedin"],
      ["https://www.youtube.com/watch?v=dWrp82VkDbA", "Incandor", "youtube"],
      ["https://www.linkedin.com/posts/kelai-capital_for-decades-systematic-hedge-funds-scaled-activity-7454912721357004800-UOkW", "KelAI", "linkedin"],
      ["https://www.linkedin.com/posts/alexdliu7_excited-to-finally-share-that-korso-yc-p26-activity-7445533826312921088-w7qI", "Korso", "linkedin"],
      ["https://www.youtube.com/watch?v=UDrqfnYWlLI", "Lab0", "youtube"],
      ["https://www.linkedin.com/posts/chasingjohnn_after-a-long-hard-but-incredibly-meaningful-activity-7437373153187901441-fiEP", "Light Anchor", "linkedin"],
      ["https://www.linkedin.com/posts/evanyeager_had-the-opportunity-to-demo-maquoketa-researchs-activity-7454329912750157824-1WGw", "Maquoketa Research", "linkedin"],
      ["https://www.linkedin.com/posts/ac-ai_from-the-outside-clinical-research-is-an-activity-7439367203184898049-TWPq", "Harbor", "linkedin"],
      ["https://www.linkedin.com/posts/runharbor_why-traditional-edcs-are-stuck-doing-2-3-activity-7437615294975672320-zJSl", "Harbor", "linkedin"],
      ["https://www.linkedin.com/posts/napkinmath_hey-were-jynnie-tang-claire-nord-and-activity-7448054220575907840-C7am", "Napkin Math", "linkedin"],
      ["https://www.linkedin.com/posts/samuel-ladroue_very-happy-to-share-that-we-got-into-the-activity-7462146861769003008-Yetq", "Netter", "linkedin"],
      ["https://www.linkedin.com/posts/andrew-e-kurtz_excited-to-final-share-more-details-about-activity-7463274368979243009-IBdJ", "Nine Fives", "linkedin"],
      ["https://www.linkedin.com/posts/geourg-kivijian_armen-and-i-are-joining-y-combinator-p26-activity-7452446287834300416-WgeL", "Ornadyne", "linkedin"],
      ["https://www.linkedin.com/posts/timzinkl_documenting-on-the-shop-floor-can-be-super-activity-7467254205846581248-pH3d", "Pairio", "linkedin"],
      ["https://www.linkedin.com/posts/phillip-baek_here-are-3-tips-from-y-combinator-that-anyone-activity-7472459888850280448-Lrzw", "Parrot", "linkedin"],
      ["https://www.linkedin.com/posts/seiji-yamamoto-a630897_im-thrilled-to-announce-perfectbit-our-activity-7460816338631180288-Lm7-", "PerfectBit, Inc.", "linkedin"],
      ["https://www.linkedin.com/posts/hamzawy998_we-made-13m-building-modding-tools-for-activity-7462946456786608128-opNZ", "Playabl.ai", "linkedin"],
      ["https://www.linkedin.com/posts/eyadabd_incredibly-proud-of-our-team-activity-7467304881113108481-fnHq", "Plena Health", "linkedin"],
      ["https://www.linkedin.com/posts/theokitsberg_proud-to-announce-weve-renamed-to-prism-activity-7451307304030945280-UGfy", "Prism", "linkedin"],
      ["https://www.linkedin.com/posts/theokitsberg_a-few-exciting-updates-1-we-now-have-concrete-activity-7458203719000653826-999F", "Prism", "linkedin"],
      ["https://www.linkedin.com/posts/revanth279_we-got-into-y-combinator-p26-for-years-activity-7442597593697902592-t6LX", "Prototyping.io", "linkedin"],
      ["https://www.linkedin.com/posts/kerim-taray_qomplement-yc-p26-started-with-a-jaguar-activity-7462536885119123456-QxAJ", "qomplement", "linkedin"],
      ["https://www.linkedin.com/posts/h4ss4nmostafa_48-hours-ago-we-launched-raspire-yc-p26-activity-7469104872290811904-ZB0p", "RASPIRE", "linkedin"],
      ["https://www.linkedin.com/posts/saaiarora_a-month-and-a-half-ago-i-dropped-out-of-waterloo-activity-7473781672547794944-DLcG", "Replicas", "linkedin"],
      ["https://www.linkedin.com/posts/connor-loi_this-past-tuesday-y-combinator-invited-us-activity-7460724368310960128-orge", "Replicas", "linkedin"],
      ["https://www.linkedin.com/posts/aaryan-kushwah_we-got-into-y-combinator-p26-as-some-of-the-activity-7461110619740487681-qQOY", "Result", "linkedin"],
      ["https://www.linkedin.com/posts/saviomartin_we-got-into-y-combinator-p26-after-scaling-activity-7461110736979857408-uzU7", "Result", "linkedin"],
      ["https://www.linkedin.com/posts/georgejeffers_we-dropped-out-of-uni-to-join-y-combinator-activity-7445563862327877632-twRo", "Revnu", "linkedin"],
      ["https://www.linkedin.com/posts/artfreebrey_anthropic-just-hit-30b-in-run-rate-revenue-activity-7447389595782082560-1ofd", "Revnu", "linkedin"],
      ["https://www.linkedin.com/posts/robertchondro_were-trying-something-new-over-the-next-activity-7460441658501791744-wd56", "Saffron", "linkedin"],
      ["https://www.linkedin.com/posts/ruhanponnada_today-were-launching-salesgraph-proactive-activity-7468384924497231872-roAW", "Salesgraph", "linkedin"],
      ["https://www.linkedin.com/posts/ruhanponnada_last-week-i-announced-that-ricardo-nunez-activity-7442246355319836673-J14c", "Salesgraph", "linkedin"],
      ["https://x.com/standoutwork/status/2067105160627917183", "Standout", "x"],
      ["https://www.linkedin.com/posts/cyruskelly_tdaycom-ai-that-turns-your-product-into-activity-7467130703483174913-Xs4P", "tday.com", "linkedin"],
      ["https://www.linkedin.com/posts/hugo-frisk_there-is-nothing-honorable-about-building-activity-7445735764451213312-x1xx", "Tenet Industries", "linkedin"],
      ["https://x.com/TesterArmy/status/2063043884759085112", "TesterArmy", "x"],
      ["https://x.com/TesterArmy/status/2074488134079770880", "TesterArmy", "x"],
      ["https://www.linkedin.com/posts/lodovico-benvenuti_at-last-me-and-jan-sahagun-joined-y-activity-7452485772315684864-MY97", "Trellis", "linkedin"],
      ["https://www.linkedin.com/posts/jan-sahagun-str_lodovico-and-i-decided-to-join-yc-for-an-activity-7452717948068294657-5-Ry", "Trellis", "linkedin"],
      ["https://www.linkedin.com/posts/karim-bouri-7a570824a_%F0%9D%97%AA%F0%9D%97%B2%F0%9D%97%BF%F0%9D%97%B2-%F0%9D%97%B2%F0%9D%98%85%F0%9D%97%B0%F0%9D%97%B6%F0%9D%98%81%F0%9D%97%B2%F0%9D%97%B1-%F0%9D%98%81%F0%9D%97%BC-%F0%9D%97%AE%F0%9D%97%BB%F0%9D%97%BB%F0%9D%97%BC%F0%9D%98%82%F0%9D%97%BB%F0%9D%97%B0%F0%9D%97%B2-activity-7440396722062872578-RsBs", "Wealor", "linkedin"],
      ["https://www.linkedin.com/posts/israbbani_hello-world-zac-policzer-and-i-are-launching-activity-7462539870989697024-dcFl", "Zibra Labs", "linkedin"],
      ["https://www.linkedin.com/posts/isabela-rodriguez-438785170_every-commercial-lender-ive-talked-to-has-activity-7444879457032577024-CnNv", "Zolvo", "linkedin"],
      ["https://www.linkedin.com/posts/isabela-rodriguez-438785170_zolvo-joined-international-factoring-association-activity-7455659217807491072-0iqx", "Zolvo", "linkedin"]
    ];

    for (const [sourceUrl, companyName, platform] of imports) {
      expectGraphEvidence(graph.evidence, sourceUrl, companyName, platform);
    }
  });

  it("surfaces non-X first-party rows from the source-hunt imports", () => {
    const springGraph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const summerGraph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);

    expectGraphEvidence(springGraph.evidence, "https://youtube.com/watch?v=7Bax5qz0IfM", "InsForge", "youtube");
    expectGraphEvidence(
      springGraph.evidence,
      "https://www.producthunt.com/products/insforge-alpha/launches/insforge-3",
      "InsForge",
      "product_hunt"
    );
    expectGraphEvidence(springGraph.evidence, "https://github.com/superset-sh/superset", "Superset", "github");
    expectGraphEvidence(springGraph.evidence, "https://github.com/MisoLabsAI/MisoTTS", "Miso Labs", "github");
    expectGraphEvidence(
      springGraph.evidence,
      "https://www.linkedin.com/posts/hetdave_johann-and-i-are-joining-y-combinator-we-activity-7443688674510360576-3-_z",
      "Andustry",
      "linkedin"
    );
    expectGraphEvidence(
      springGraph.evidence,
      "https://www.linkedin.com/posts/rihab-l-085182164_since-joining-y-combinator-yc-p26-we-2xd-activity-7465092563004346368-YZGH",
      "Asendia AI",
      "linkedin"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/parthajmera_life-updates-agnost-ai-yc-s26-is-joining-activity-7475915114043555840-felZ",
      "Agnost AI",
      "linkedin"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://linkedin.com/posts/risereforming_were-joining-y-combinators-s26-batch-thank-activity-7462887812569243649-BVMe",
      "Rise Reforming",
      "linkedin"
    );
    expectGraphEvidence(
      springGraph.evidence,
      "https://www.linkedin.com/posts/bryantchou_ai-is-making-marketers-lazy-so-we-made-activity-7473015352021397504-OGTC",
      "Ploy",
      "linkedin"
    );
    expectGraphEvidence(springGraph.evidence, "https://x.com/bryantchou/status/2067993561082008060", "Ploy", "x");
    expectGraphEvidence(springGraph.evidence, "https://x.com/bryantchou/status/2067246888231866803", "Ploy", "x");
    expectGraphEvidence(springGraph.evidence, "https://x.com/hanghuang_/status/2066621039728038083", "InsForge", "x");
    expectGraphEvidence(
      springGraph.evidence,
      "https://news.ycombinator.com/item?id=48236770",
      "Superset",
      "hacker_news"
    );
    expectGraphContextEvidence(
      springGraph.evidence,
      "https://www.producthunt.com/products/runtime",
      "Runtime",
      "product_hunt"
    );
    expectGraphEvidence(springGraph.evidence, "https://www.youtube.com/watch?v=vI8shNqqmRE", "Ontora", "youtube");
    expectGraphContextEvidence(
      springGraph.evidence,
      "https://github.com/Aradotso/ara-agent-integrations",
      "Ara",
      "github",
      "no_visible_metrics"
    );
    expectGraphEvidence(summerGraph.evidence, "https://x.com/ShubhamInTech/status/2063985390852419613", "Agnost AI", "x");
    expectGraphEvidence(summerGraph.evidence, "https://x.com/louis030195/status/2056360011631313167", "screenpipe", "x");
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/louis030195_screenpipe-yc-s26-at-the-top-of-y-combinator-activity-7482463529808207872-cDIu",
      "screenpipe",
      "linkedin"
    );
    expectGraphEvidence(summerGraph.evidence, "https://news.ycombinator.com/item?id=48922706", "Coasty", "hacker_news");
    expectGraphEvidence(summerGraph.evidence, "https://github.com/inkbox-ai/opencode-plugin", "Inkbox", "github");
    expectGraphEvidence(summerGraph.evidence, "https://github.com/coasty-ai/open-cowork", "Coasty", "github");
    expectGraphEvidence(summerGraph.evidence, "https://x.com/alexsouthmayd/status/2072350508526735698", "Bloomy", "x");
    expectGraphContextEvidence(
      summerGraph.evidence,
      "https://www.producthunt.com/products/context-dev",
      "Context.dev",
      "product_hunt"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/kimjihyun_zomma-yc-s26-is-backed-by-y-combinator-activity-7478287014090432512-ylbn",
      "Zomma",
      "linkedin"
    );
    expectGraphEvidence(springGraph.evidence, "https://www.youtube.com/watch?v=K_xNXWnlf98", "Klarify", "youtube");
    expectGraphEvidence(
      springGraph.evidence,
      "https://github.com/Aradotso/ara-mcp",
      "Ara",
      "github"
    );
    expectGraphEvidence(springGraph.evidence, "https://x.com/DraftedAI/status/2060402050635387083", "Drafted", "x");
    expectGraphEvidence(summerGraph.evidence, "https://x.com/archal_labs/status/2059499757400465804", "Archal", "x");
    expectGraphEvidence(
      summerGraph.evidence,
      "https://github.com/experientiallabs/world-model-harness",
      "Experiential Labs",
      "github"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/alexytung_leon-yao-and-i-are-launching-whitespace-activity-7475928359827492865-DCbJ",
      "Whitespace",
      "linkedin"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/barnabymalet_excited-to-share-that-ive-been-accepted-activity-7470031192965246977-D9a1",
      "machine0",
      "linkedin"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/ilia-bolgov-8683b0254_excited-to-share-that-together-with-roman-activity-7473063836632117248-vedj",
      "Touchmark",
      "linkedin"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/mojmir-horvath_we-got-into-y-combinatorand-today-were-activity-7475955975368101888-A-Jt",
      "Poth Labs",
      "linkedin"
    );
    expectGraphEvidence(
      springGraph.evidence,
      "https://www.linkedin.com/posts/marguerite-benoist_water-leaks-in-buildings-arent-detected-activity-7460731923880079361--vpc",
      "AquaShield",
      "linkedin"
    );
    expectGraphEvidence(
      springGraph.evidence,
      "https://www.linkedin.com/posts/surtr-defense-systems_defensetech-counteruas-airdefense-activity-7475246742599315456-fPTt",
      "Surtr Defense Systems",
      "linkedin"
    );
    expectGraphEvidence(springGraph.evidence, "https://x.com/RobKnight__/status/2053867901028110592", "Zenbu", "x");
    expectGraphEvidence(springGraph.evidence, "https://github.com/zenbu-labs/zenbu.js", "Zenbu", "github");
    expectGraphEvidence(springGraph.evidence, "https://github.com/DripYCx26/drip-sdk", "Drip", "github");
    expectGraphEvidence(
      springGraph.evidence,
      "https://www.youtube.com/watch?v=xr0VEaJPJow",
      "Amboras",
      "youtube"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/mzxzhou_i-got-into-y-combinator-s26-the-past-6-activity-7464365183025717248-QEeY",
      "Codag",
      "linkedin"
    );
    expectGraphContextEvidence(
      summerGraph.evidence,
      "https://www.producthunt.com/products/codag",
      "Codag",
      "product_hunt"
    );
    expectGraphEvidence(summerGraph.evidence, "https://github.com/codag-megalith/codag-visualizer", "Codag", "github");
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/zaky-hassan_super-excited-to-announce-that-molagri-is-activity-7475880498527891456-RDYY",
      "Molagri",
      "linkedin"
    );
    const operonPost = summerGraph.evidence.find(
      (item) => item.platformPostId === "7478586962652655616"
    );
    expect(operonPost).toEqual(
      expect.objectContaining({
        platform: "linkedin",
        attachedCompanyId: "company-operon"
      })
    );
    expect(operonPost?.contributionScore).toBeGreaterThan(0);
    const rexPost = summerGraph.evidence.find(
      (item) => item.platformPostId === "7475606763560632320"
    );
    expect(rexPost).toEqual(
      expect.objectContaining({
        platform: "linkedin",
        attachedCompanyId: "company-rex-inc"
      })
    );
    expect(rexPost?.contributionScore).toBeGreaterThan(0);
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/sudhish-swain_excited-to-officially-launch-petrarch-yc-activity-7482470659839950848-GeT7",
      "Petrarch",
      "linkedin"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/zander-schweitzer-1a0651205_alloovium-yc-s26-has-been-officially-backed-activity-7467337043484790785-ZdnO",
      "Alloovium",
      "linkedin"
    );
    expectGraphEvidence(
      summerGraph.evidence,
      "https://www.linkedin.com/posts/melvinchen_ycombinator-healthcareai-healthtech-activity-7470676175162482688-fBNx",
      "Care GP",
      "linkedin"
    );
    expectGraphEvidence(summerGraph.evidence, "https://x.com/jackbeecher23/status/2074887641623880138", "Denta", "x");
    expectGraphEvidence(summerGraph.evidence, "https://x.com/hursheybar2/status/2074530139606745589", "Edviro", "x");
    expectGraphContextEvidence(
      summerGraph.evidence,
      "https://github.com/Care-AI-Inc/careai-corina-service-releases",
      "Care GP",
      "github",
      "no_visible_metrics"
    );
    expectGraphEvidence(
      springGraph.evidence,
      "https://www.linkedin.com/posts/william--alexander_ycombinator-manufacturingai-industrialai-activity-7473418710851170304-ybad",
      "Arzana",
      "linkedin"
    );
  });

  it("surfaces Sol Ultra first-party source-hunt rows in the Summer graph", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);

    expectGraphEvidence(graph.evidence, "https://github.com/CarbonCopyInc/carboncopy-mcp", "Hoplite", "github");
    expectGraphEvidence(graph.evidence, "https://youtube.com/watch?v=DfSQ8L7d0BM", "Control Seat", "youtube");
    expectGraphEvidence(
      graph.evidence,
      "https://www.linkedin.com/posts/cosmic-robotics_solar-construction-constructiontech-activity-7358860398701260800-5Nwv",
      "Cosmic Robotics",
      "linkedin"
    );
    expectGraphEvidence(graph.evidence, "https://www.youtube.com/watch?v=EGZAe5N2aJ4", "Cosmic Robotics", "youtube");
    expectGraphEvidence(graph.evidence, "https://github.com/SpekoAI/python-sdk", "Speko", "github");
    expectGraphEvidence(graph.evidence, "https://github.com/SpekoAI/typescript-sdk", "Speko", "github");
  });

  it("does not score GitHub profile aggregates when repo-level evidence exists", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const conifer = graph.nodes.find((node) => node.entityType === "company" && node.label === "Conifer");
    const selectedEvidence = selectedNodeEvidence(graph, conifer!);
    const profileAggregate = selectedEvidence.find((item) => item.id === "evidence-github-profile-company-conifer");
    const repoEvidence = selectedEvidence.filter(
      (item) => item.platform === "github" && item.sourceUrl === "https://github.com/ConiferKit/sage"
    );

    expect(profileAggregate?.contributionScore ?? 0).toBe(0);
    expect(repoEvidence.some((item) => item.contributionScore > 0)).toBe(true);
  });

  it("does not inflate sparse one-platform GitHub evidence into a perfect company score", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const careGp = graph.nodes.find((node) => node.entityType === "company" && node.label === "Care GP");
    const screenpipe = graph.nodes.find((node) => node.entityType === "company" && node.label === "screenpipe");

    expect(careGp?.score).toBeLessThan(70);
    expect(screenpipe?.score).toBeGreaterThan(careGp?.score ?? 0);
    expect(careGp?.scoreBreakdown?.calibration.method).toBe("global_best_ratio");
    expect(careGp?.scoreBreakdown?.calibration.inputScore).toBe(careGp?.scoreBreakdown?.absoluteScore);
    expect(careGp?.scoreBreakdown?.calibration.benchmarkScope).toBe("all_supported_batches");
    expect(careGp?.scoreBreakdown?.calibration.benchmarkPopulation).toBe("current_company_snapshot");
    expect(careGp?.scoreBreakdown?.explanation).not.toContain("Evidence-depth factor");
    expect(careGp?.scoreBreakdown?.weightedPlatforms[0]?.evidenceCount).toBeGreaterThanOrEqual(1);
  });

  it("keeps screenpipe above one-platform Nori using actual fixed platform contributions", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const nori = graph.nodes.find((node) => node.entityType === "company" && node.label === "Nori");
    const screenpipe = graph.nodes.find(
      (node) => node.entityType === "company" && node.label === "screenpipe"
    );

    expect(nori).toBeTruthy();
    expect(screenpipe).toBeTruthy();
    expect(nori?.score).toBeGreaterThan(nori?.scoreBreakdown?.absoluteScore ?? 0);
    expect(screenpipe?.score).toBeGreaterThan(screenpipe?.scoreBreakdown?.absoluteScore ?? 0);
    expect(nori?.scoreBreakdown?.coverageFactor).toBe(0.21);
    expect(screenpipe?.scoreBreakdown?.coverageFactor).toBeGreaterThan(
      nori?.scoreBreakdown?.coverageFactor ?? 0
    );
    expect(screenpipe?.score).toBeGreaterThan(nori?.score ?? 0);

    for (const company of [nori!, screenpipe!]) {
      const fixedContributionTotal = company.scoreBreakdown!.weightedPlatforms.reduce(
        (sum, row) => sum + row.score * row.configuredWeight,
        0
      );
      expect(company.scoreBreakdown?.absoluteScore).toBe(Math.round(fixedContributionTotal));
      expect(company.score).toBe(
        Math.round(
          (company.scoreBreakdown!.absoluteScore /
            company.scoreBreakdown!.calibration.benchmarkScore!) *
            100
        )
      );
      expect(
        company.scoreBreakdown!.weightedPlatforms.every(
          (row) => row.appliedWeight === row.configuredWeight
        )
      ).toBe(true);
    }
  });

  it("uses one global current-company benchmark across S2026, S26, and A16Z", () => {
    const globalPositiveCompanies = ycSpring2026GraphDataset.companies.filter(
      (company) => (company.scoreBreakdown?.absoluteScore ?? 0) > 0
    );
    const globalBenchmarkScore = Math.max(
      ...globalPositiveCompanies.map((company) => company.scoreBreakdown!.absoluteScore)
    );
    const globalScaleFactor = 100 / globalBenchmarkScore;

    for (const batchSlug of ["S2026", "S26", "A16ZSR006"]) {
      const companies = ycSpring2026GraphDataset.companies.filter((company) => company.batchSlug === batchSlug);
      const positiveCompanies = companies.filter((company) => (company.scoreBreakdown?.absoluteScore ?? 0) > 0);
      const positiveScores = positiveCompanies.map((company) => company.totalScore);

      expect(positiveCompanies.length).toBeGreaterThan(0);
      expect(Math.min(...positiveScores)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...positiveScores)).toBeLessThanOrEqual(100);
      for (const company of positiveCompanies) {
        expect(company.totalScore).toBeGreaterThan(0);
        expect(company.totalScore).toBe(
          Math.round(company.scoreBreakdown!.absoluteScore * globalScaleFactor)
        );
        expect(company.scoreBreakdown?.calibration).toEqual(
          expect.objectContaining({
            method: "global_best_ratio",
            cohortSize: globalPositiveCompanies.length,
            percentile: null,
            inputScore: company.scoreBreakdown?.absoluteScore,
            benchmarkScore: globalBenchmarkScore,
            scaleFactor: globalScaleFactor,
            benchmarkScope: "all_supported_batches",
            benchmarkPopulation: "current_company_snapshot"
          })
        );
      }
    }

    expect(
      ycSpring2026GraphDataset.companies
        .filter((company) => (company.scoreBreakdown?.absoluteScore ?? 0) === 0)
        .every((company) => company.totalScore === 0)
    ).toBe(true);
  });

  it("dedupes physical posts across company and founder rollups before aggregation", () => {
    const arlo = ycSpring2026GraphDataset.companies.find(
      (company) => company.batchSlug === "S2026" && company.name === "Arlo Industries"
    );
    const rollupEntityIds = new Set([arlo?.id, ...(arlo?.founderIds ?? [])]);
    const scoredRollupEvidence = ycSpring2026GraphDataset.evidence.filter(
      (item) => rollupEntityIds.has(item.entityId) && item.contributionScore > 0
    );
    const uniquePhysicalPosts = dedupeEvidenceForScoring(scoredRollupEvidence);
    const aggregatedEvidenceCount =
      arlo?.scoreBreakdown?.weightedPlatforms.reduce((sum, platform) => sum + platform.evidenceCount, 0) ?? 0;

    expect(arlo).toBeTruthy();
    expect(scoredRollupEvidence).toHaveLength(uniquePhysicalPosts.length);
    expect(aggregatedEvidenceCount).toBe(uniquePhysicalPosts.length);
  });

  it("never scores LinkedIn profile activity fragments without a stable native post identity", () => {
    const fragments = ycSpring2026GraphDataset.evidence.filter(
      (item) => item.platform === "linkedin" && item.sourceUrl.includes("/recent-activity/all/#post-")
    );

    for (const fragment of fragments) {
      expect(fragment).toEqual(
        expect.objectContaining({
          contributionScore: 0,
          publishedAtPrecision: "unknown",
          observedAt: expect.any(String),
          metricsCheckedAt: expect.any(String),
          review_state: "verified"
        })
      );
      expect(fragment.why).toContain("Stored as context only");
      expect(fragment.why).toContain("stable native post identity");
    }
  });

  it("keeps LinkedIn comments out of regular company and founder score aggregation", () => {
    const commentContextIds = new Set([
      "linkedin-topvoice-company-rise-reforming-alexisohanian-activity-7345937006784356353-comment-george-rose",
      "linkedin-topvoice-seventh-pass-s2026-company-insforge-andrew-miklas-7462200339899846656",
      "linkedin-topvoices_people_only_third_sol_ultra-s2026-topvoice-insforge-amiklas-7462760262366842880"
    ]);
    const retiredCommentContextIds = new Set([
      "linkedin-topvoice-insider-sol-ultra-s2026-lumius-mathilde-collin-7444469004846510080",
      "linkedin-topvoice-insider-sol-ultra-s2026-atrisa-mathilde-collin-7471364906072686592",
      "linkedin-topvoice-insider-sol-ultra-s2026-9-mothers-corporation-taro-fukuyama-7445191769534676992",
      "linkedin-topvoices_people_only_third_sol_ultra-s26-topvoice-pango-petekoomen-7473616064967266304"
    ]);
    const contexts = ycSpring2026GraphDataset.evidence.filter((item) => commentContextIds.has(item.id));

    expect(contexts).toHaveLength(commentContextIds.size);
    expect(contexts.every((item) => item.platform === "linkedin" && item.contributionScore === 0)).toBe(true);
    expect(
      ycSpring2026GraphDataset.evidence.filter((item) => retiredCommentContextIds.has(item.id))
    ).toEqual([]);

    for (const companyId of new Set(contexts.map((item) => item.attachedCompanyId))) {
      const company = ycSpring2026GraphDataset.companies.find((candidate) => candidate.id === companyId);
      const rollupEntityIds = new Set([company?.id, ...(company?.founderIds ?? [])]);
      const rollupEvidence = ycSpring2026GraphDataset.evidence.filter((item) => rollupEntityIds.has(item.entityId));
      const scoreWithoutCommentContexts = aggregateBalancedTractionScore(
        rollupEvidence.filter((item) => !commentContextIds.has(item.id))
      );

      expect(company).toBeTruthy();
      expect(aggregateBalancedTractionScore(rollupEvidence).totalScore).toBe(scoreWithoutCommentContexts.totalScore);
      expect(company?.scoreBreakdown?.absoluteScore).toBe(scoreWithoutCommentContexts.totalScore);
    }
  });

  it("marks synthesized GitHub profile publication dates as unknown", () => {
    const profile = ycSpring2026GraphDataset.evidence.find(
      (item) => item.id === "evidence-github-profile-company-conifer"
    );

    expect(profile).toEqual(
      expect.objectContaining({
        publishedAtPrecision: "unknown",
        observedAt: expect.any(String),
        metricsCheckedAt: expect.any(String)
      })
    );
  });

  it("makes X views material after log scaling", () => {
    const lowView = evidence("low-x", "x", { views: 2_000, likes: 20, comments: 1 });
    const highView = evidence("high-x", "x", { views: 250_000, likes: 20, comments: 1 });
    const scored = normalizeEvidenceScores([lowView, highView]);

    expect(computeEvidenceRawEngagement("x", highView.metrics)).toBeGreaterThan(
      computeEvidenceRawEngagement("x", lowView.metrics) * 20
    );
    expect(scored.find((item) => item.id === "high-x")?.contributionScore).toBeGreaterThanOrEqual(
      (scored.find((item) => item.id === "low-x")?.contributionScore ?? 0) + 35
    );
  });

  it("keeps identical engagement score-neutral to publication age", () => {
    const oldPost = {
      ...evidence("old-instagram", "instagram", { views: 100_000, likes: 500, comments: 20 }),
      postedAt: "2025-06-01T00:00:00Z",
      observedAt: "2026-06-28T00:00:00Z",
      metricsCheckedAt: "2026-06-28T00:00:00Z"
    };
    const freshPost = {
      ...evidence("fresh-instagram", "instagram", { views: 100_000, likes: 500, comments: 20 }),
      postedAt: "2026-06-20T00:00:00Z",
      observedAt: "2026-06-28T00:00:00Z",
      metricsCheckedAt: "2026-06-28T00:00:00Z"
    };
    const scored = normalizeEvidenceScores([oldPost, freshPost]);

    const oldScore = scored.find((item) => item.id === "old-instagram");
    const freshScore = scored.find((item) => item.id === "fresh-instagram");
    expect(oldScore?.rawEngagement).toBe(freshScore?.rawEngagement);
    expect(oldScore?.normalizedScore).toBe(freshScore?.normalizedScore);
    expect(oldScore?.contributionScore).toBe(freshScore?.contributionScore);
    expect(freshScore?.why).not.toContain("recency");
  });

  it("keeps visible LinkedIn engagement ahead of freshness-only signals", () => {
    const freshLowerEngagement = {
      ...evidence("fresh-linkedin", "linkedin", { likes: 142, reactions: 142, comments: 18, reposts: 8 }),
      postedAt: "2026-06-23T19:21:44.963Z",
      last_checked_at: "2026-07-11T00:00:00.000Z"
    };
    const olderHighLikes = {
      ...evidence("older-high-likes", "linkedin", { likes: 481, reactions: 481, comments: 66 }),
      postedAt: "2026-02-03T17:30:08.673Z",
      last_checked_at: "2026-07-11T00:00:00.000Z"
    };
    const olderHighComments = {
      ...evidence("older-high-comments", "linkedin", { likes: 228, reactions: 228, comments: 213 }),
      postedAt: "2025-12-08T17:00:06.656Z",
      last_checked_at: "2026-07-11T00:00:00.000Z"
    };
    const scored = normalizeEvidenceScores([freshLowerEngagement, olderHighLikes, olderHighComments]).sort(
      (left, right) => right.contributionScore - left.contributionScore
    );

    expect(scored.map((item) => item.id)).toEqual(["older-high-comments", "older-high-likes", "fresh-linkedin"]);
    expect(scored[0]?.contributionScore).toBeGreaterThan(scored[2]?.contributionScore ?? 0);
  });

  it("uses only fixed platform contributions without a hidden diversity bonus", () => {
    const githubOnly = aggregateBalancedTractionScore([evidence("github-only", "github", {}, 100)]);
    const crossPlatform = aggregateBalancedTractionScore([
      evidence("x", "x", {}, 98),
      evidence("linkedin", "linkedin", {}, 98),
      evidence("instagram", "instagram", {}, 98),
      evidence("product-hunt", "product_hunt", {}, 98),
      evidence("youtube", "youtube", {}, 98)
    ]);

    expect(githubOnly.totalScore).toBe(
      Math.round(githubOnly.weightedPlatforms.reduce((sum, row) => sum + row.contribution, 0))
    );
    expect(crossPlatform.totalScore).toBe(
      Math.round(crossPlatform.weightedPlatforms.reduce((sum, row) => sum + row.contribution, 0))
    );
    expect(crossPlatform.totalScore).toBeLessThan(crossPlatform.weightedAvailableScore);
  });

  it("does not average away a viral view-heavy social post", () => {
    const score = aggregateBalancedTractionScore([
      evidence("viral-x", "x", {}, 100),
      evidence("tail-x-1", "x", {}, 20),
      evidence("tail-x-2", "x", {}, 15),
      evidence("tail-x-3", "x", {}, 10),
      evidence("tail-x-4", "x", {}, 10)
    ]);

    expect(score.platformScores.x).toBeGreaterThanOrEqual(80);
    expect(score.totalScore).toBe(
      Math.round(score.weightedPlatforms.reduce((sum, row) => sum + row.contribution, 0))
    );
    expect(score.totalScore).toBe(score.absoluteScore);
  });

  it("treats missing platforms as zero instead of renormalizing present platforms", () => {
    const onePlatform = aggregateBalancedTractionScore([evidence("x", "x", {}, 100)]);
    const allConfiguredPlatforms = aggregateBalancedTractionScore([
      evidence("x", "x", {}, 100),
      evidence("linkedin", "linkedin", {}, 100),
      evidence("instagram", "instagram", {}, 100),
      evidence("product-hunt", "product_hunt", {}, 100),
      evidence("github", "github", {}, 100),
      evidence("youtube", "youtube", {}, 100),
      evidence("hacker-news", "hacker_news", {}, 100),
      evidence("reddit", "reddit", {}, 100),
      evidence("bilibili", "bilibili", {}, 100)
    ]);

    expect(onePlatform.coverageFactor).toBe(0.21);
    expect(allConfiguredPlatforms.coverageFactor).toBe(1);
    expect(onePlatform.totalScore).toBe(17);
    expect(allConfiguredPlatforms.totalScore).toBe(82);
    expect(onePlatform.totalScore).toBeLessThan(allConfiguredPlatforms.totalScore);
  });

  it("orders score explanations by configured-weight contribution", () => {
    const score = aggregateBalancedTractionScore([
      evidence("github", "github", {}, 100),
      evidence("instagram", "instagram", {}, 80)
    ]);

    expect(score.weightedPlatforms[0]?.platform).toBe("instagram");
    expect(score.weightedPlatforms[0]?.contribution).toBeGreaterThan(score.weightedPlatforms[1]?.contribution ?? 0);
    expect(score.explanation).toContain("largest contribution");
  });

  it("lets a perfect social signal outrank a moderate GitHub signal", () => {
    const score = aggregateBalancedTractionScore([
      evidence("github", "github", {}, 60),
      evidence("instagram", "instagram", {}, 100)
    ]);

    expect(score.weightedPlatforms[0]?.platform).toBe("instagram");
    expect(score.weightedPlatforms[0]?.contribution).toBeGreaterThan(score.weightedPlatforms[1]?.contribution ?? 0);
  });

  it("uses the recommended long-run scoring config for live graph scoring", () => {
    expect(TRACTION_SCORING_CONFIG.name).toBe(
      "returner-traction-v4-absolute-fixed-platform-global-best"
    );
    expect(TRACTION_SCORING_CONFIG.platformWeights.github).toBe(0.15);
    expect(TRACTION_SCORING_CONFIG.platformWeights.x).toBe(0.21);
    expect(TRACTION_SCORING_CONFIG.platformWeights.linkedin).toBe(0.15);
    expect(TRACTION_SCORING_CONFIG.metricWeights.instagram?.views).toBe(0.04);
    expect(TRACTION_SCORING_CONFIG.metricWeights.x?.views).toBe(0.04);
    expect(TRACTION_SCORING_CONFIG.metricWeights.linkedin?.views).toBe(0.04);
    expect(TRACTION_SCORING_CONFIG.metricWeights.youtube?.views).toBe(0.025);
    expect(TRACTION_SCORING_CONFIG.metricWeights.x?.reposts).toBe(6);
    expect(TRACTION_SCORING_CONFIG.metricWeights.linkedin?.comments).toBe(4.5);
    expect(TRACTION_SCORING_CONFIG.metricWeights.github?.recent_commits_30d).toBeUndefined();
    expect(TRACTION_SCORING_CONFIG.absoluteEvidenceWeight).toBe(1);
    expect(TRACTION_SCORING_CONFIG.cohortPercentileWeight).toBe(0);
    expect(TRACTION_SCORING_CONFIG.batchCalibration).toEqual({
      absoluteScoreWeight: 1,
      cohortPercentileWeight: 0
    });
    expect(computeEvidenceRawEngagement("instagram", { views: 100_000, likes: 100, comments: 10 })).toBe(4155);
    expect(computeEvidenceRawEngagement("x", { views: 1_000_000, likes: 1_000, comments: 100, reposts: 100 })).toBe(42450);
    expect(computeEvidenceRawEngagement("linkedin", { views: 100_000, reactions: 100, comments: 20, reposts: 10 })).toBe(4290);
    expect(computeEvidenceRawEngagement("linkedin", { likes: 100, reactions: 100, comments: 10 })).toBe(185);
    expect(computeEvidenceRawEngagement("linkedin", { likes: 100, reactions: 140, comments: 10 })).toBe(241);
  });

  it("keeps GitHub freshness metadata out of traction scoring", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const githubRows = graph.evidence.filter((item) => item.platform === "github");

    expect(githubRows.some((item) => Boolean(item.postedAt && item.last_updated_at))).toBe(true);
    expect(
      computeEvidenceRawEngagement("github", { stars: 10, forks: 2, watchers: 1, recent_commits_30d: 8 })
    ).toBe(computeEvidenceRawEngagement("github", { stars: 10, forks: 2, watchers: 1, recent_commits_30d: 0 }));
  });
});

function evidence(
  id: string,
  platform: Platform,
  metrics: EvidenceItem["metrics"],
  contributionScore = 50
): EvidenceItem {
  const visibleMetrics = Object.keys(metrics).length ? metrics : scoreableFixtureMetrics(platform);
  return {
    id,
    entityType: "company",
    entityId: "company-test",
    platform,
    authorName: "Test",
    authorHandle: null,
    postedAt: "2026-06-01T00:00:00Z",
    text: id,
    mediaType: platform === "github" ? "repo" : "text",
    linkStatus: "verified",
    metrics: visibleMetrics,
    contributionScore,
    tractionStatus: "scored",
    sourceUrl: nativeEvidenceUrl(platform, id),
    why: "test",
    review_state: "verified"
  };
}

function scoreableFixtureMetrics(platform: Platform): EvidenceItem["metrics"] {
  if (platform === "github") return { stars: 1 };
  if (["product_hunt", "hacker_news", "reddit"].includes(platform)) return { upvotes: 1 };
  return { views: 1 };
}

function nativeEvidenceUrl(platform: Platform, id: string): string {
  const numericId = String([...id].reduce((sum, character) => sum + character.charCodeAt(0), 10)).padEnd(16, "0");

  if (platform === "x") return `https://x.com/test/status/${numericId}`;
  if (platform === "instagram") return `https://www.instagram.com/p/${id}/`;
  if (platform === "linkedin") return `https://www.linkedin.com/posts/test_${id}-activity-${numericId}-test`;
  if (platform === "youtube") return `https://www.youtube.com/watch?v=${id}`;
  if (platform === "reddit") return `https://www.reddit.com/r/test/comments/${id}/test/`;
  if (platform === "product_hunt") return `https://www.producthunt.com/posts/${id}`;
  if (platform === "hacker_news") return `https://news.ycombinator.com/item?id=${numericId}`;
  if (platform === "bilibili") return `https://www.bilibili.com/video/${id}`;
  if (platform === "github") return `https://github.com/test/${id}`;
  return `https://example.com/${id}`;
}

function postIds(items: EvidenceItem[]): string[] {
  return items.map((item) => item.platformPostId).filter((id): id is string => Boolean(id));
}

function expectTopVoiceEvidence(
  items: EvidenceItem[],
  platformPostId: string,
  topVoiceName: string,
  companyName: string
): void {
  const item = items.find(
    (candidate) =>
      candidate.platformPostId === platformPostId && candidate.attachedCompanyName === companyName
  );

  expect(item).toEqual(
    expect.objectContaining({
      platformPostId,
      attachedCompanyName: companyName,
      topVoice: expect.objectContaining({
        displayName: topVoiceName
      })
    })
  );
  expect(item?.contributionScore).toBeGreaterThan(0);
}

function expectGraphEvidence(
  items: EvidenceItem[],
  sourceUrl: string,
  companyName: string,
  platform: Platform
): void {
  const expectedSourceIdentity = canonicalSourceIdentity(sourceUrl);
  const item = items.find(
    (candidate) => canonicalSourceIdentity(candidate.sourceUrl) === expectedSourceIdentity
  );

  expect(item).toEqual(
    expect.objectContaining({
      platform,
      attachedCompanyName: companyName
    })
  );
  expect(canonicalSourceIdentity(item?.sourceUrl ?? "")).toBe(expectedSourceIdentity);
  expect(item?.contributionScore, sourceUrl).toBeGreaterThan(0);
}

function expectGraphContextEvidence(
  items: EvidenceItem[],
  sourceUrl: string,
  companyName: string,
  platform: Platform,
  exclusionReason = "not_native_evidence"
): void {
  const item = items.find((candidate) => candidate.sourceUrl === sourceUrl);

  expect(item).toEqual(
    expect.objectContaining({
      platform,
      attachedCompanyName: companyName,
      sourceUrl,
      contributionScore: 0
    })
  );
  expect(item?.why).toContain(exclusionReason);
}

function canonicalSourceIdentity(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    return url.toString();
  } catch {
    return rawUrl;
  }
}
