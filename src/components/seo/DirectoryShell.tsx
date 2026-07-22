import type { ReactNode } from "react";
import { DirectoryBreadcrumbs, type DirectoryBreadcrumbItem } from "./DirectoryBreadcrumbs";
import { DirectoryLink } from "./DirectoryLink";

export { DirectoryLink };

interface DirectoryShellProps {
  eyebrow: string;
  title: string;
  description: string;
  breadcrumbs: DirectoryBreadcrumbItem[];
  stats?: { label: string; value: string | number }[];
  children: ReactNode;
}

export function DirectoryShell({
  eyebrow,
  title,
  description,
  breadcrumbs,
  stats = [],
  children
}: DirectoryShellProps) {
  return (
    <div className="rf-directory-page">
      <header className="rf-directory-header">
        <DirectoryLink className="rf-directory-brand" href="/" ariaLabel="Returner home">
          <span aria-hidden="true">R</span>
          Returner
        </DirectoryLink>
        <nav className="rf-directory-nav" aria-label="Public directory">
          <DirectoryLink href="/yc-network-map">YC map</DirectoryLink>
          <DirectoryLink href="/a16z-network-map">a16z map</DirectoryLink>
          <DirectoryLink href="/yc-social-traction">YC traction</DirectoryLink>
          <DirectoryLink href="/a16z-social-traction">a16z traction</DirectoryLink>
          <DirectoryLink href="/cohorts">Cohorts</DirectoryLink>
          <DirectoryLink href="/industries">Industries</DirectoryLink>
          <DirectoryLink href="/platforms">Platforms</DirectoryLink>
          <DirectoryLink href="/rankings">Rankings</DirectoryLink>
          <DirectoryLink href="/search">Search</DirectoryLink>
        </nav>
      </header>

      <main className="rf-directory-main">
        <DirectoryBreadcrumbs items={breadcrumbs} />
        <section className="rf-directory-hero">
          <p className="rf-directory-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="rf-directory-deck">{description}</p>
          {stats.length > 0 ? (
            <dl className="rf-directory-stats">
              {stats.map((stat) => (
                <div key={stat.label}>
                  <dt>{stat.label}</dt>
                  <dd>{stat.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </section>
        {children}
      </main>

      <footer className="rf-directory-footer">
        <div>
          <strong>Returner</strong>
          <span>Public startup traction intelligence</span>
        </div>
        <nav aria-label="Trust and information">
          <DirectoryLink href="/about">About</DirectoryLink>
          <DirectoryLink href="/methodology">Methodology</DirectoryLink>
          <DirectoryLink href="/data-sources">Data sources</DirectoryLink>
          <DirectoryLink href="/faq">FAQ</DirectoryLink>
          <DirectoryLink href="/corrections">Corrections</DirectoryLink>
        </nav>
      </footer>
      <style>{DIRECTORY_STYLES}</style>
    </div>
  );
}

const DIRECTORY_STYLES = `
  .rf-directory-page {
    min-height: 100vh;
    background: #f7f7f5;
    color: #171717;
  }
  .rf-directory-header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    min-height: 64px;
    padding: 0 max(24px, calc((100vw - 1120px) / 2));
    border-bottom: 1px solid #deded9;
    background: rgba(255, 255, 255, 0.96);
  }
  .rf-directory-brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    color: #171717;
    font-size: 1rem;
    font-weight: 800;
    text-decoration: none;
  }
  .rf-directory-brand span {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border-radius: 7px;
    background: #ff6600;
    color: #ffffff;
    font-size: 0.9rem;
  }
  .rf-directory-nav,
  .rf-directory-footer nav {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 20px;
  }
  .rf-directory-nav a,
  .rf-directory-footer a {
    color: #4a4a45;
    font-size: 0.82rem;
    font-weight: 700;
    text-decoration: none;
  }
  .rf-directory-nav a:hover,
  .rf-directory-footer a:hover,
  .rf-directory-breadcrumbs a:hover,
  .rf-directory-card h2 a:hover,
  .rf-company-name:hover,
  .rf-inline-links a:hover {
    color: #b83f00;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .rf-directory-main {
    width: min(1120px, calc(100% - 48px));
    margin: 0 auto;
    padding: 24px 0 72px;
  }
  .rf-directory-breadcrumbs ol {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin: 0;
    padding: 0;
    color: #6c6c66;
    font-size: 0.76rem;
    list-style: none;
  }
  .rf-directory-breadcrumbs li:not(:last-child)::after {
    margin-left: 7px;
    color: #a2a29b;
    content: "/";
  }
  .rf-directory-breadcrumbs a {
    color: inherit;
    text-decoration: none;
  }
  .rf-directory-hero {
    padding: 60px 0 42px;
    border-bottom: 1px solid #deded9;
  }
  .rf-directory-eyebrow {
    margin: 0 0 12px;
    color: #b83f00;
    font-size: 0.72rem;
    font-weight: 800;
    text-transform: uppercase;
  }
  .rf-directory-hero h1 {
    max-width: 850px;
    margin: 0;
    color: #171717;
    font-size: clamp(2rem, 4vw, 3.5rem);
    line-height: 1.08;
    letter-spacing: 0;
  }
  .rf-directory-deck {
    max-width: 760px;
    margin: 18px 0 0;
    color: #55554f;
    font-size: 1.05rem;
    line-height: 1.75;
  }
  .rf-directory-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 28px 0 0;
  }
  .rf-directory-stats div {
    min-width: 142px;
    padding: 12px 14px;
    border: 1px solid #deded9;
    border-radius: 8px;
    background: #ffffff;
  }
  .rf-directory-stats dt {
    color: #73736c;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
  }
  .rf-directory-stats dd {
    margin: 3px 0 0;
    color: #171717;
    font-size: 1.25rem;
    font-weight: 800;
  }
  .rf-directory-section {
    padding: 42px 0 0;
  }
  .rf-directory-section-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 18px;
  }
  .rf-directory-section h2,
  .rf-prose h2 {
    margin: 0;
    color: #20201e;
    font-size: 1.35rem;
    line-height: 1.3;
  }
  .rf-directory-section-header p,
  .rf-directory-note,
  .rf-prose p,
  .rf-prose li {
    color: #5f5f59;
    line-height: 1.7;
  }
  .rf-directory-section-header p {
    max-width: 580px;
    margin: 0;
    font-size: 0.85rem;
    text-align: right;
  }
  .rf-directory-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }
  .rf-directory-card {
    min-width: 0;
    padding: 20px;
    border: 1px solid #deded9;
    border-radius: 8px;
    background: #ffffff;
  }
  .rf-directory-card h2 {
    margin: 0;
    font-size: 1rem;
    line-height: 1.4;
  }
  .rf-directory-card h2 a {
    color: #20201e;
    text-decoration: none;
  }
  .rf-directory-card p {
    margin: 8px 0 0;
    color: #666660;
    font-size: 0.82rem;
    line-height: 1.6;
  }
  .rf-directory-card-meta,
  .rf-company-meta,
  .rf-inline-links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    margin-top: 14px;
    color: #777770;
    font-size: 0.72rem;
    font-weight: 700;
  }
  .rf-directory-card-meta span + span::before,
  .rf-company-meta span + span::before {
    margin-right: 12px;
    color: #c3c3bd;
    content: "|";
  }
  .rf-directory-table {
    overflow: hidden;
    border: 1px solid #d9d9d4;
    border-radius: 8px;
    background: #ffffff;
  }
  .rf-company-row {
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr) 100px;
    gap: 16px;
    align-items: center;
    min-height: 88px;
    padding: 14px 18px;
    border-bottom: 1px solid #e8e8e4;
  }
  .rf-company-row:last-child {
    border-bottom: 0;
  }
  .rf-company-rank {
    color: #92928b;
    font-size: 0.78rem;
    font-weight: 800;
  }
  .rf-company-copy {
    min-width: 0;
  }
  .rf-company-name {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
    color: #20201e;
    font-size: 0.98rem;
    font-weight: 800;
    text-decoration: none;
  }
  .rf-company-tagline {
    margin: 4px 0 0;
    color: #666660;
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .rf-company-meta a,
  .rf-inline-links a {
    color: #365e8d;
    text-decoration: none;
  }
  .rf-company-score {
    text-align: right;
  }
  .rf-company-score strong {
    display: block;
    font-size: 1.3rem;
  }
  .rf-company-score span {
    color: #777770;
    font-size: 0.66rem;
    font-weight: 700;
    text-transform: uppercase;
  }
  .rf-directory-note {
    padding: 16px 18px;
    border-left: 3px solid #ff6600;
    background: #fff8f2;
    font-size: 0.82rem;
  }
  .rf-prose {
    max-width: 820px;
  }
  .rf-prose section {
    padding: 36px 0;
    border-bottom: 1px solid #deded9;
  }
  .rf-prose h2 {
    margin-bottom: 12px;
  }
  .rf-prose p,
  .rf-prose ul,
  .rf-prose ol {
    margin-top: 10px;
    margin-bottom: 0;
  }
  .rf-prose a {
    color: #365e8d;
    font-weight: 700;
    text-underline-offset: 3px;
  }
  .rf-search-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    max-width: 720px;
  }
  .rf-search-form input {
    width: 100%;
    min-height: 46px;
    padding: 0 14px;
    border: 1px solid #bcbcb5;
    border-radius: 8px;
    background: #ffffff;
    color: #171717;
  }
  .rf-search-form button {
    min-height: 46px;
    padding: 0 20px;
    border: 0;
    border-radius: 8px;
    background: #ff6600;
    color: #ffffff;
    font-weight: 800;
    cursor: pointer;
  }
  .rf-directory-footer {
    display: flex;
    justify-content: space-between;
    gap: 32px;
    padding: 32px max(24px, calc((100vw - 1120px) / 2));
    border-top: 1px solid #deded9;
    background: #ffffff;
  }
  .rf-directory-footer > div {
    display: grid;
    gap: 4px;
  }
  .rf-directory-footer span {
    color: #73736c;
    font-size: 0.72rem;
  }
  @media (max-width: 820px) {
    .rf-directory-header {
      position: static;
      align-items: flex-start;
      flex-direction: column;
      padding-top: 16px;
      padding-bottom: 16px;
    }
    .rf-directory-main {
      width: min(100% - 32px, 1120px);
    }
    .rf-directory-hero {
      padding: 42px 0 32px;
    }
    .rf-directory-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .rf-directory-section-header,
    .rf-directory-footer {
      align-items: flex-start;
      flex-direction: column;
    }
    .rf-directory-section-header p {
      text-align: left;
    }
  }
  @media (max-width: 560px) {
    .rf-directory-nav {
      gap: 8px 14px;
    }
    .rf-directory-grid {
      grid-template-columns: 1fr;
    }
    .rf-company-row {
      grid-template-columns: 30px minmax(0, 1fr) 58px;
      gap: 10px;
      padding: 12px;
    }
    .rf-company-tagline {
      display: none;
    }
    .rf-search-form {
      grid-template-columns: 1fr;
    }
  }
`;
