export const NATIVE_X_CAPTION_ABSENCE_SOURCE: string;
export function nativeXCaptionlessIdentity(value: unknown): { handle: string; postId: string | null; mediaKind: string | null; mediaIndex: string | null } | null;
export function nativeXCaptionlessMetrics(labels: unknown): Record<string, number> | null;
export function nativeXCaptionlessPostReasons(row: unknown): string[];
export function isVerifiedNativeXCaptionlessPost(row: unknown): boolean;
