export const NATIVE_THREADS_SOURCE: "authorized_native_threads_dom_v1";
export const NATIVE_THREADS_VALIDATION: "fall_2026_native_threads_ingestion_v1";
export function nativeThreadsIdentity(value: unknown): { handle: string; postId: string | null } | null;
export function nativeThreadsCaption(article: unknown): string | null;
export function verifiedNativeThreadsReasons(row: unknown): string[];
export function isVerifiedNativeThreadsReceipt(row: unknown): boolean;
