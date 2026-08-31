import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface VercelConfiguration {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
}

describe('hosted security policy', () => {
  it('keeps account challenges compatible with the production CSP', () => {
    const configuration = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as VercelConfiguration;
    const policy = configuration.headers
      ?.flatMap((route) => route.headers)
      .find((header) => header.key.toLowerCase() === 'content-security-policy')
      ?.value;

    expect(policy).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(policy).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });

  it('does not publish the development-only visual audit route', () => {
    const configuration = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as VercelConfiguration & { rewrites?: Array<{ source: string }> };
    expect(configuration.rewrites?.map((rewrite) => rewrite.source)).not.toContain('/__visual-audit');
  });
});
