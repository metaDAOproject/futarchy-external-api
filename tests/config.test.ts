import { describe, it, expect } from 'bun:test';

describe('Configuration parsing', () => {
  it('warns and falls back to normal when RESTRICTION_MODE is invalid', () => {
    // Given
    const env = {
      ...process.env,
      RESTRICTION_MODE: 'lockdwon',
    };

    // When
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '--eval',
        "await import('./src/config.ts');",
      ],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain('Invalid RESTRICTION_MODE');
  });
});
