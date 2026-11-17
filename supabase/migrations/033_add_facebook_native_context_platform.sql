-- Platform identity only. Facebook native observations remain unscored.
alter table public.social_accounts
  drop constraint if exists social_accounts_platform_check;
alter table public.social_accounts
  add constraint social_accounts_platform_check check (
    platform in (
      'github', 'x', 'twitter', 'linkedin', 'instagram', 'facebook',
      'product_hunt', 'youtube', 'tiktok', 'bluesky', 'hacker_news', 'reddit',
      'rss', 'blog', 'news', 'web', 'bilibili', 'xiaohongshu', 'other'
    )
  );
alter table public.posts
  drop constraint if exists posts_platform_check;
alter table public.posts
  add constraint posts_platform_check check (
    platform in (
      'github', 'x', 'twitter', 'linkedin', 'instagram', 'facebook',
      'product_hunt', 'youtube', 'tiktok', 'bluesky', 'hacker_news', 'reddit',
      'rss', 'blog', 'news', 'web', 'bilibili', 'xiaohongshu', 'other'
    )
  );
comment on column public.posts.platform is
  'Native platform identity. Facebook, TikTok and Bluesky observations may be retained without a calibrated traction model.';
