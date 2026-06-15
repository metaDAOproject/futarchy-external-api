import { config } from '../config.js';
import { logger } from './logger.js';

const WEBHOOK_URL = config.alerts.webhookUrl;
const WEBHOOK_SECRET = config.alerts.webhookSecret;

// Rate limiting: don't spam the same alert more than once per cooldown period
const alertCooldowns = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Send an alert to the Telegram webhook relay via the /logs endpoint.
 * The worker forwards error-level logs to the TOPIC_LOGS thread.
 */
export async function sendAlert(
  message: string,
  options?: { cooldownKey?: string; cooldownMs?: number },
): Promise<void> {
  // Never fire real webhooks from the test runner (bun test sets NODE_ENV=test):
  // the default WEBHOOK_URL points at the production Telegram relay.
  if (process.env.NODE_ENV === 'test') return;
  if (!WEBHOOK_URL) return;

  const cooldownKey = options?.cooldownKey;
  const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  if (cooldownKey) {
    const lastSent = alertCooldowns.get(cooldownKey);
    if (lastSent && Date.now() - lastSent < cooldownMs) {
      return;
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (WEBHOOK_SECRET) {
    headers['X-Northflank-Notification-Integration-Token'] = WEBHOOK_SECRET;
  }

  const logsUrl = `${WEBHOOK_URL.replace(/\/+$/, '')}/logs`;

  try {
    const response = await fetch(logsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        service: 'futarchy-coingecko-api',
        level: 'error',
        msg: message,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error(`[Alert] Webhook error ${response.status}: ${body}`);
      return;
    }

    if (cooldownKey) {
      alertCooldowns.set(cooldownKey, Date.now());
    }

    logger.info('[Alert] Alert sent via webhook');
  } catch (error: any) {
    logger.error('[Alert] Failed to send alert:', error);
  }
}
