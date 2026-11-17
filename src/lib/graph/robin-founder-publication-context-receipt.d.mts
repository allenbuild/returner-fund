export const ROBIN_FOUNDER_PUBLICATION_SOURCE: string;
export const ROBIN_FOUNDER_PUBLICATION_VALIDATION: string;
export function robinPublicationSha256(value: string | Uint8Array): string;
export function robinPublicationNativeFields(row: unknown): Record<string, unknown>;
export function robinFounderPublicationContextReasons(row: unknown, entity: unknown): string[];
export function isVerifiedRobinFounderPublicationContext(row: unknown, entity: unknown): boolean;
