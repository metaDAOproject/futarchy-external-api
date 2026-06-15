/**
 * Scheduling utilities to prevent refresh pileup.
 *
 * Uses recursive setTimeout instead of setInterval to ensure
 * the next execution only starts after the current one completes.
 * This prevents overlapping executions when tasks take longer than expected.
 */

import { logger } from './logger.js';

export interface ScheduledTask {
  stop: () => void;
  isRunning: () => boolean;
  getLastRunTime: () => Date | null;
  getNextRunTime: () => Date | null;
}

export interface ScheduleOptions {
  name: string;
  intervalMs: number;
  immediate?: boolean;
  onError?: (error: Error) => void;
}

/**
 * Schedule a task to run at fixed intervals WITHOUT pileup.
 * Uses recursive setTimeout to ensure the next run only starts
 * after the current run completes + intervalMs.
 */
export function scheduleWithoutPileup(
  task: () => Promise<void>,
  options: ScheduleOptions
): ScheduledTask {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastRunTime: Date | null = null;
  let nextRunTime: Date | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;

    nextRunTime = new Date(Date.now() + options.intervalMs);
    timeoutId = setTimeout(runTask, options.intervalMs);
  };

  const runTask = async () => {
    if (stopped) return;
    running = true;
    lastRunTime = new Date();

    try {
      await task();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (options.onError) {
        options.onError(err);
      } else {
        logger.error(`[${options.name}] Task error:`, err);
      }
    } finally {
      running = false;
      scheduleNext();
    }
  };

  if (options.immediate) {
    runTask();
  } else {
    scheduleNext();
  }

  return {
    stop: () => {
      stopped = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      logger.info(`[${options.name}] Scheduled task stopped`);
    },
    isRunning: () => running,
    getLastRunTime: () => lastRunTime,
    getNextRunTime: () => nextRunTime,
  };
}
