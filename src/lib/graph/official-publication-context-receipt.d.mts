export const OFFICIAL_PUBLICATION_CONTEXT_SOURCE: string;
export const OFFICIAL_PUBLICATION_CONTEXT_VALIDATION: string;
export function publicationContextSha256(value: string | Uint8Array): string;
export function officialPublicationReceipt(row: unknown): Record<string, unknown> | null;
export function officialPublicationNativeFields(row: unknown): Record<string, unknown>;
export function officialPublicationArticleContextReasons(row: unknown, company: unknown): string[];
export function isVerifiedOfficialPublicationArticleContext(row: unknown, company: unknown): boolean;
