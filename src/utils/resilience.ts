/**
 * Resilience utilities for handling external API calls.
 * Provides timeout and retry mechanisms for Solana RPC and other external services.
 */

import { logger } from './logger.js';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in ms between retries (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Whether to add jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
  /** Function to determine if error is retryable (default: all errors) */
  isRetryable?: (error: unknown) => boolean;
  /** Callback for logging retry attempts */
  onRetry?: (attempt: number, error: unknown, nextDelayMs: number) => void;
}

export interface TimeoutOptions {
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Custom error message for timeout */
  timeoutMessage?: string;
}

export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: unknown
  ) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

/**
 * Wrap a promise with a timeout.
 * If the promise doesn't resolve within the timeout, rejects with TimeoutError.
 * 
 * @example
 * const result = await withTimeout(
 *   fetch('https://api.example.com/data'),
 *   { timeoutMs: 5000, timeoutMessage: 'API call timed out' }
 * );
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  options: TimeoutOptions
): Promise<T> {
  const { timeoutMs, timeoutMessage } = options;

  let timeoutId: Timer | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(
        timeoutMessage || `Operation timed out after ${timeoutMs}ms`,
        timeoutMs
      ));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Retry an async operation with exponential backoff.
 * 
 * @example
 * const result = await retry(
 *   () => fetch('https://api.example.com/data'),
 *   {
 *     maxRetries: 3,
 *     initialDelayMs: 1000,
 *     isRetryable: (err) => err instanceof Error && err.message.includes('rate limit'),
 *     onRetry: (attempt, err, delay) => console.log(`Retry ${attempt} after ${delay}ms`),
 *   }
 * );
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    jitter = true,
    isRetryable = () => true,
    onRetry,
  } = options;

  let lastError: unknown;
  let delayMs = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if we've exhausted attempts or error isn't retryable
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      // Calculate next delay with optional jitter
      let nextDelay = Math.min(delayMs, maxDelayMs);
      if (jitter) {
        // Add 0-25% random jitter
        nextDelay = nextDelay * (1 + Math.random() * 0.25);
      }

      if (onRetry) {
        onRetry(attempt + 1, error, nextDelay);
      }

      await sleep(nextDelay);
      delayMs *= backoffMultiplier;
    }
  }

  throw new RetryExhaustedError(
    `Operation failed after ${maxRetries + 1} attempts`,
    maxRetries + 1,
    lastError
  );
}

/**
 * Combine timeout and retry for external API calls.
 * Each individual attempt has its own timeout.
 * 
 * @example
 * const data = await withRetryAndTimeout(
 *   () => fetchExternalData(),
 *   {
 *     timeoutMs: 30000,
 *     maxRetries: 2,
 *     isRetryable: isTransientError,
 *     onRetry: (attempt, err, delay) => console.log(`Retry ${attempt}`),
 *   }
 * );
 */
export async function withRetryAndTimeout<T>(
  fn: () => Promise<T>,
  options: RetryOptions & TimeoutOptions
): Promise<T> {
  const { timeoutMs, timeoutMessage, ...retryOptions } = options;

  return retry(
    () => withTimeout(fn(), { timeoutMs, timeoutMessage }),
    {
      ...retryOptions,
      isRetryable: (error) => {
        // TimeoutErrors are retryable by default
        if (error instanceof TimeoutError) return true;
        // Use custom isRetryable if provided
        return retryOptions.isRetryable?.(error) ?? true;
      },
    }
  );
}

/**
 * Check if an error is likely transient and worth retrying.
 * Useful for network errors, rate limits, and temporary server issues.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    // Network errors
    if (message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('etimedout') ||
        message.includes('socket hang up') ||
        message.includes('network') ||
        message.includes('fetch failed')) {
      return true;
    }

    // Rate limiting
    if (message.includes('rate limit') ||
        message.includes('too many requests') ||
        message.includes('429')) {
      return true;
    }

    // Temporary server errors
    if (message.includes('502') ||
        message.includes('503') ||
        message.includes('504') ||
        message.includes('bad gateway') ||
        message.includes('service unavailable')) {
      return true;
    }
  }

  // Check for HTTP response status
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: number }).status;
    // Retry on 429, 502, 503, 504
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      return true;
    }
  }

  return false;
}

/**
 * Create a logger function for retry attempts.
 * @param prefix - Log prefix (e.g., '[ExternalDB]', '[Solana]')
 */
export function createRetryLogger(prefix: string) {
  return (attempt: number, error: unknown, nextDelayMs: number): void => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
      `${prefix} Retry attempt ${attempt} after ${Math.round(nextDelayMs)}ms: ${errorMessage}`
    );
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
