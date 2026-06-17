/**
 * Input validation helpers for API routes.
 * These prevent 500 errors from bad user input by returning
 * structured error responses instead of throwing.
 */

export interface ValidationError {
  error: string;
  message: string;
  field?: string;
}

export type ValidationResult<T> = 
  | { success: true; value: T }
  | { success: false; error: ValidationError };

/**
 * Safely parse JSON from a query parameter.
 * Returns undefined if the input is empty/undefined.
 * Returns a validation error if JSON is malformed.
 */
export function parseJsonParam<T = unknown>(
  value: string | undefined,
  fieldName: string
): ValidationResult<T | undefined> {
  if (!value || value.trim() === '') {
    return { success: true, value: undefined };
  }

  try {
    const parsed = JSON.parse(value) as T;
    return { success: true, value: parsed };
  } catch (e) {
    return {
      success: false,
      error: {
        error: 'Invalid JSON',
        message: `The '${fieldName}' parameter contains invalid JSON: ${(e as Error).message}`,
        field: fieldName,
      },
    };
  }
}

/**
 * Parse an integer query parameter with bounds checking.
 * Returns the default value if input is empty/undefined.
 */
export function parseIntParam(
  value: string | undefined,
  fieldName: string,
  options: {
    defaultValue: number;
    min?: number;
    max?: number;
  }
): ValidationResult<number> {
  if (!value || value.trim() === '') {
    return { success: true, value: options.defaultValue };
  }

  const parsed = parseInt(value, 10);
  
  if (isNaN(parsed)) {
    return {
      success: false,
      error: {
        error: 'Invalid integer',
        message: `The '${fieldName}' parameter must be a valid integer`,
        field: fieldName,
      },
    };
  }

  if (options.min !== undefined && parsed < options.min) {
    return {
      success: false,
      error: {
        error: 'Value too small',
        message: `The '${fieldName}' parameter must be at least ${options.min}`,
        field: fieldName,
      },
    };
  }

  if (options.max !== undefined && parsed > options.max) {
    return {
      success: false,
      error: {
        error: 'Value too large',
        message: `The '${fieldName}' parameter must be at most ${options.max}`,
        field: fieldName,
      },
    };
  }

  return { success: true, value: parsed };
}

/**
 * Validate a date string in YYYY-MM-DD format.
 */
export function parseDateParam(
  value: string | undefined,
  fieldName: string,
  options: { required: boolean }
): ValidationResult<string | undefined> {
  if (!value || value.trim() === '') {
    if (options.required) {
      return {
        success: false,
        error: {
          error: 'Missing required parameter',
          message: `The '${fieldName}' parameter is required (format: YYYY-MM-DD)`,
          field: fieldName,
        },
      };
    }
    return { success: true, value: undefined };
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(value)) {
    return {
      success: false,
      error: {
        error: 'Invalid date format',
        message: `The '${fieldName}' parameter must be in YYYY-MM-DD format`,
        field: fieldName,
      },
    };
  }

  // Validate it's an actual date
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return {
      success: false,
      error: {
        error: 'Invalid date',
        message: `The '${fieldName}' parameter is not a valid date`,
        field: fieldName,
      },
    };
  }

  return { success: true, value };
}

/**
 * Parse a comma-separated list of strings.
 * Returns undefined if input is empty.
 */
export function parseCommaSeparatedList(
  value: string | undefined,
  fieldName: string,
  options?: { minLength?: number; maxLength?: number }
): ValidationResult<string[] | undefined> {
  if (!value || value.trim() === '') {
    return { success: true, value: undefined };
  }

  const items = value.split(',').map(t => t.trim()).filter(t => t.length > 0);
  
  if (items.length === 0) {
    return { success: true, value: undefined };
  }

  if (options?.minLength !== undefined && items.length < options.minLength) {
    return {
      success: false,
      error: {
        error: 'Too few items',
        message: `The '${fieldName}' parameter must contain at least ${options.minLength} item(s)`,
        field: fieldName,
      },
    };
  }

  if (options?.maxLength !== undefined && items.length > options.maxLength) {
    return {
      success: false,
      error: {
        error: 'Too many items',
        message: `The '${fieldName}' parameter must contain at most ${options.maxLength} item(s)`,
        field: fieldName,
      },
    };
  }

  return { success: true, value: items };
}

/**
 * Validate a Solana public key (base58, 32-44 characters).
 */
export function parseSolanaAddress(
  value: string | undefined,
  fieldName: string
): ValidationResult<string> {
  if (!value || value.trim() === '') {
    return {
      success: false,
      error: {
        error: 'Missing required parameter',
        message: `The '${fieldName}' parameter is required`,
        field: fieldName,
      },
    };
  }

  // Base58 character set (no 0, O, I, l)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  
  if (!base58Regex.test(value)) {
    return {
      success: false,
      error: {
        error: 'Invalid Solana address',
        message: 'The provided address is not a valid Solana public key (must be 32-44 base58 characters)',
        field: fieldName,
      },
    };
  }

  return { success: true, value };
}

/**
 * Validate a required string parameter.
 */
export function parseRequiredString(
  value: string | undefined,
  fieldName: string,
  options?: { minLength?: number; maxLength?: number; pattern?: RegExp }
): ValidationResult<string> {
  if (!value || value.trim() === '') {
    return {
      success: false,
      error: {
        error: 'Missing required parameter',
        message: `The '${fieldName}' parameter is required`,
        field: fieldName,
      },
    };
  }

  const trimmed = value.trim();

  if (options?.minLength !== undefined && trimmed.length < options.minLength) {
    return {
      success: false,
      error: {
        error: 'Value too short',
        message: `The '${fieldName}' parameter must be at least ${options.minLength} characters`,
        field: fieldName,
      },
    };
  }

  if (options?.maxLength !== undefined && trimmed.length > options.maxLength) {
    return {
      success: false,
      error: {
        error: 'Value too long',
        message: `The '${fieldName}' parameter must be at most ${options.maxLength} characters`,
        field: fieldName,
      },
    };
  }

  if (options?.pattern && !options.pattern.test(trimmed)) {
    return {
      success: false,
      error: {
        error: 'Invalid format',
        message: `The '${fieldName}' parameter has an invalid format`,
        field: fieldName,
      },
    };
  }

  return { success: true, value: trimmed };
}

/**
 * Parse a date string ensuring UTC interpretation.
 * Handles YYYY-MM-DD (interpreted as UTC midnight) and ISO 8601 with timezone.
 * Returns a Date object in UTC.
 */
export function parseDateAsUTC(
  value: string | undefined,
  fieldName: string,
  options?: { required?: boolean }
): ValidationResult<Date | undefined> {
  if (!value || value.trim() === '') {
    if (options?.required) {
      return {
        success: false,
        error: {
          error: 'Missing required parameter',
          message: `The '${fieldName}' parameter is required`,
          field: fieldName,
        },
      };
    }
    return { success: true, value: undefined };
  }

  const trimmed = value.trim();
  
  // YYYY-MM-DD format - treat as UTC midnight
  const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (dateOnlyRegex.test(trimmed)) {
    const parts = trimmed.split('-').map(Number);
    const year = parts[0]!;
    const month = parts[1]!;
    const day = parts[2]!;
    const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    
    if (isNaN(date.getTime()) || date.getUTCFullYear() !== year || 
        date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return {
        success: false,
        error: {
          error: 'Invalid date',
          message: `The '${fieldName}' parameter is not a valid date`,
          field: fieldName,
        },
      };
    }
    return { success: true, value: date };
  }

  // ISO 8601 with time/timezone
  const isoWithTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
  if (isoWithTimeRegex.test(trimmed)) {
    // If no timezone specified, append Z to treat as UTC
    const normalized = trimmed.match(/Z|[+-]\d{2}:?\d{2}$/) ? trimmed : trimmed + 'Z';
    const date = new Date(normalized);
    
    if (isNaN(date.getTime())) {
      return {
        success: false,
        error: {
          error: 'Invalid date',
          message: `The '${fieldName}' parameter is not a valid ISO 8601 date`,
          field: fieldName,
        },
      };
    }
    return { success: true, value: date };
  }

  return {
    success: false,
    error: {
      error: 'Invalid date format',
      message: `The '${fieldName}' parameter must be YYYY-MM-DD or ISO 8601 format`,
      field: fieldName,
    },
  };
}

/**
 * Normalize a Date to UTC midnight (start of day in UTC).
 */
export function toUTCMidnight(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0
  ));
}

/**
 * Get the current date as a YYYY-MM-DD string in UTC.
 */
export function getUTCDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0] as string;
}

/**
 * Validate that a timestamp string is valid and normalize to UTC.
 * Used for parsing timestamps from external data sources.
 */
export function parseTimestampAsUTC(
  value: string | undefined,
  fieldName: string
): ValidationResult<Date | undefined> {
  if (!value || value.trim() === '') {
    return { success: true, value: undefined };
  }

  const trimmed = value.trim();
  
  // Handle external timestamps which may have inconsistent formats
  // e.g., "2024-01-15T10:20:00" or "2024-01-15 10:20:00"
  const normalized = trimmed.replace(' ', 'T');
  
  // Ensure UTC interpretation if no timezone
  const withTz = normalized.match(/Z|[+-]\d{2}:?\d{2}$/) ? normalized : normalized + 'Z';
  
  const date = new Date(withTz);
  
  if (isNaN(date.getTime())) {
    return {
      success: false,
      error: {
        error: 'Invalid timestamp',
        message: `The '${fieldName}' contains an invalid timestamp: ${value}`,
        field: fieldName,
      },
    };
  }

  return { success: true, value: date };
}
