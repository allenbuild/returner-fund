import type { Metadata } from "next";
import { LockKeyhole, Sparkles } from "lucide-react";
import { isSiteAccessConfigured } from "@/lib/site-access";
import styles from "./unlock.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Private access"
};

interface UnlockPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UnlockPage({ searchParams }: UnlockPageProps) {
  const params = (await searchParams) ?? {};
  const configured = isSiteAccessConfigured();
  const returnTo = safeReturnTo(singleQueryValue(params.returnTo));
  const invalidPassword = singleQueryValue(params.invalid) === "1";
  const configurationPending = !configured;

  return (
    <main className={styles.screen}>
      <div className={styles.grain} aria-hidden="true" />
      <div className={styles.orbOne} aria-hidden="true" />
      <div className={styles.orbTwo} aria-hidden="true" />

      <section className={styles.card} aria-labelledby="access-title">
        <div className={styles.brand}>
          <span className={styles.brandMark}><Sparkles size={15} strokeWidth={2.4} aria-hidden="true" /></span>
          returner.fund
        </div>

        <div className={styles.lockMark} aria-hidden="true">
          <LockKeyhole size={27} strokeWidth={2.3} />
        </div>

        <p className={styles.eyebrow}>Private intelligence</p>
        <h1 id="access-title">Enter password</h1>
        <p className={styles.intro}>
          This workspace is password protected.
        </p>

        {configurationPending ? (
          <p className={styles.status} role="status">
            Private access is being configured. Please check back shortly.
          </p>
        ) : (
          <form action="/api/access/unlock" method="post" className={styles.form}>
            <input type="hidden" name="returnTo" value={returnTo} />
            <label htmlFor="site-password">Password</label>
            <input
              autoComplete="current-password"
              autoFocus
              id="site-password"
              name="password"
              required
              type="password"
            />
            {invalidPassword ? (
              <p className={styles.error} role="alert">That password didn’t match. Please try again.</p>
            ) : null}
            <button type="submit">Continue <span aria-hidden="true">→</span></button>
          </form>
        )}

        <p className={styles.footer}>Returner Fund</p>
      </section>
    </main>
  );
}

function singleQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  return value;
}
