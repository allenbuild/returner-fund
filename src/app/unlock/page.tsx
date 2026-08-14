import type { Metadata } from "next";
import { isSiteAccessConfigured } from "@/lib/site-access";
import { UnlockForm } from "./unlock-form";
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

      <section className={styles.card} aria-labelledby="access-title">
        <h1 id="access-title">Password required</h1>

        {configurationPending ? (
          <p className={styles.status} role="status">
            Private access is being configured. Please check back shortly.
          </p>
        ) : (
          <UnlockForm invalidPassword={invalidPassword} returnTo={returnTo} />
        )}
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
