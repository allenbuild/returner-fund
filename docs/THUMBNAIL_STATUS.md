# Thumbnail Coverage

Generated at: 2026-06-30T15:40:34.209Z

## Summary

- Evidence rows: 3053
- Rows with thumbnails: 3053
- Rows with real thumbnails: 3045
- Rows with fallback thumbnails: 8
- Rows missing thumbnails: 0

## Platform Coverage

- github: 209/209 real thumbnails, 0 fallback, 0 missing, sources {"github":209}.
- hacker_news: 11/11 real thumbnails, 0 fallback, 0 missing, sources {"link-preview-og-image":5,"link-preview-page-image":4,"link-preview-favicon":1,"link-preview-favicon-blocked":1}.
- instagram: 86/86 real thumbnails, 0 fallback, 0 missing, sources {"opencli-screenshot":5,"instagram-media":80,"opencli-instagram-profile-screenshot":1}.
- rss: 20/20 real thumbnails, 0 fallback, 0 missing, sources {"link-preview-og-image":20}.
- web: 753/761 real thumbnails, 8 fallback, 0 missing, sources {"link-preview-og-image":459,"link-preview-site-icon-blocked":8,"link-preview-page-image-relaxed":4,"link-preview-article-image":171,"link-preview-page-image":17,"link-preview-favicon":22,"link-preview-favicon-blocked":54,"link-preview-og-image-relaxed":7,"web-media":2,"link-preview-video-poster":9,"link-preview-article-image-relaxed":2,"link-preview-jsonld-image":2,"jina-reader-blocked-image":1,"link-preview-twitter-image":1,"link-preview-jsonld-image-relaxed":2}.
- x: 1892/1892 real thumbnails, 0 fallback, 0 missing, sources {"x-embed-screenshot":996,"x-media":781,"opencli-x-screenshot":66,"local-cache":27,"opencli-x-profile-screenshot":22}.
- youtube: 74/74 real thumbnails, 0 fallback, 0 missing, sources {"youtube":74}.

## Missing Examples


## Fallback Examples

- web 9 Mothers: link-preview-site-icon-blocked https://www.weaving.news/news/019ea1f6-8175-7de2-bfc6-fc660365b1c5
- web Advanced Metal Research: link-preview-site-icon-blocked https://pitchbook.com/profiles/company/1396520-29
- web Drafted: link-preview-site-icon-blocked https://www.weaving.news/news/019ecc3c-0abc-74df-a81f-f58001a6403f
- web Elyra: link-preview-site-icon-blocked https://pitchbook.com/profiles/company/1156318-75
- web OpenProse: link-preview-site-icon-blocked https://pitchbook.com/profiles/company/1396102-60
- web Plena Health: link-preview-site-icon-blocked https://pitchbook.com/profiles/company/1232689-33
- web Ploy: link-preview-site-icon-blocked https://www.startupresearcher.com/news/ploy-launches-ai-growth-platform-with-usd27-million-seed-round
- web ValCtrl: link-preview-site-icon-blocked https://pitchbook.com/profiles/company/1153669-87

## Resume Commands

- `npm run thumbnails:backfill -- --platform=instagram --cache-instagram --force --limit=200 --delay-ms=1200`
- `npm run thumbnails:backfill -- --platform=x --cache-x --validate-x --force --limit=200 --delay-ms=600`
- `npm run thumbnails:links -- --limit=200 --max-rows=200 --checkpoint-rows=25`
- `npm run debug:thumbnails`
