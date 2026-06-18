import { createHash, timingSafeEqual } from 'crypto';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}
