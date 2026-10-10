import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const SITE = 'http://127.0.0.1:8791';
let counter = 0;
/** Unique per call so parallel tests never share the API's cache (the fixture ignores the query string). */
const fresh = (path: string) => `${path}?t=${Date.now()}-${process.pid}-${counter++}`;
const submit = async (page: Page, path: string, opts: { unique?: boolean } = {}) => {
  await page
    .getByLabel('Page address')
    .fill(`${SITE}${opts.unique === false ? path : fresh(path)}`);
  await page.getByRole('button', { name: 'Summarize' }).click();
};
/** The quick single-pass summary (Medium, Bullets) instead of the detailed brief that is the default. */
const quick = async (page: Page) => {
  await page.getByRole('button', { name: 'Quick' }).click();
};
const audit = async (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

test.describe('core flow', () => {
  test('summarizes a page: Loading, then a result whose evidence can be checked in place', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Summaries that show their evidence',
    );
    await quick(page);
    await submit(page, '/article');

    await expect(page.locator('.verify')).toContainText(
      '5 of 5 cited passages found in the page text',
    );
    await expect(
      page.getByRole('heading', { level: 2, name: 'How Responsible Scrapers Work' }),
    ).toBeFocused();
    await expect(page.locator('.site')).toHaveText('Example Engineering Blog');
    await expect(page.locator('.meta')).toContainText('Ada Lovelace');
    await expect(page.locator('.point')).toHaveCount(5);
    await expect(page.locator('.sheet__banner')).toHaveCount(0); // the sample is gone

    // Evidence expands in place with the cited passage highlighted.
    await page.locator('.evidence__btn').first().click();
    await expect(page.locator('.context mark')).toBeVisible();
    await expect(page.locator('.evidence__btn').first()).toHaveAttribute('aria-expanded', 'true');

    // Full page text and the API request are one click away.
    await page.getByRole('button', { name: 'Show page text' }).click();
    await expect(page.locator('.source mark').first()).toBeVisible();
    await page.getByRole('button', { name: 'Use the API' }).click();
    await expect(page.locator('.code')).toContainText('curl -X POST');
    await expect(page.locator('.code')).toContainText('/article?t=');

    // The address bar is shareable and re-fills the form (without running it).
    expect(page.url()).toContain('url=');
    await page.reload();
    expect(await page.getByLabel('Page address').inputValue()).toContain(`${SITE}/article?t=`);
    await expect(page.locator('.sheet__banner')).toBeVisible();
  });

  test('detailed (default): reads the page, then shows a structured brief with evidence on demand', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Detailed', pressed: true })).toBeVisible();
    await submit(page, '/article');

    await expect(page.locator('.verify')).toBeVisible();
    const headings = await page.getByRole('heading', { level: 3 }).allTextContents();
    expect(headings).toEqual(['Overview', 'Key takeaways', 'Section by section']);
    await expect(page.locator('.understood')).toContainText('Read in full');
    // Section lines are named; takeaways are numbered; nothing is open until asked for.
    await expect(page.locator('.point__heading').first()).toBeVisible();
    await expect(page.locator('.brief__takeaway .point__n').first()).toHaveText('1');
    await expect(page.locator('.evidence')).toHaveCount(0);
    await page.locator('.brief__takeaway .evidence__btn').first().click();
    await expect(page.locator('.context mark')).toBeVisible();

    await page.getByRole('button', { name: 'Copy summary' }).click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('KEY TAKEAWAYS');
    expect(text).toContain('SECTION BY SECTION');
  });

  test('respects length and format options', async ({ page }) => {
    await page.goto('/');
    await quick(page);
    await page.getByRole('button', { name: 'Short' }).click();
    await page.getByRole('button', { name: 'Paragraph' }).click();
    await submit(page, '/article');
    await expect(page.locator('.point')).toHaveCount(1);
  });

  test('the same page again is served from cache', async ({ page }) => {
    await page.goto('/');
    const path = fresh('/article');
    await submit(page, path, { unique: false });
    await expect(page.locator('.stats small')).not.toContainText('cache');
    await submit(page, path, { unique: false });
    await expect(page.locator('.stats small')).toContainText('served from cache');
  });

  test('copy puts the summary, with its evidence, on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await submit(page, '/article');
    await page.getByRole('button', { name: 'Copy summary' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('How Responsible Scrapers Work');
    expect(text).toContain('Passage:');
  });

  test('truncated long pages say so', async ({ page }) => {
    await page.goto('/');
    await submit(page, '/huge');
    await expect(page.locator('.notice')).toContainText('This page is long');
  });
});

test.describe('failures are specific and recoverable', () => {
  const cases: Array<[string, string, string]> = [
    ['/spa', 'This page needs JavaScript', 'js_rendered'],
    ['/tiny', 'Not enough text to summarize', 'insufficient_content'],
    ['/pdf', 'Not a web page', 'unsupported_content_type'],
    ['/missing', 'Page not found', 'not_found'],
  ];
  for (const [path, title, code] of cases) {
    test(`${code}`, async ({ page }) => {
      await page.goto('/');
      await submit(page, path);
      const slip = page.getByRole('alert');
      await expect(slip.getByRole('heading')).toHaveText(title);
      await slip.getByText('Details for support').click();
      await expect(slip).toContainText(code);
      await slip.getByRole('button', { name: 'Try another link' }).click();
      await expect(page.getByLabel('Page address')).toBeFocused();
    });
  }

  test('private addresses are blocked end to end', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Page address').fill('http://169.254.169.254/latest/meta-data/');
    await page.getByRole('button', { name: 'Summarize' }).click();
    await expect(page.getByRole('alert').getByRole('heading')).toHaveText('Address not allowed');
  });

  test('invalid input is caught in the form without a request', async ({ page }) => {
    let apiCalls = 0;
    page.on('request', (r) => r.url().includes('/api/summarize') && apiCalls++);
    await page.goto('/');
    await page.getByLabel('Page address').fill('definitely not a url');
    await page.getByRole('button', { name: 'Summarize' }).click();
    await expect(page.locator('.field-error')).toContainText("doesn't look like a web address");
    expect(apiCalls).toBe(0);
  });
});

test.describe('keyboard and working state', () => {
  test('keyboard only: slash, type, Enter, Escape to cancel', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('/');
    await expect(page.getByLabel('Page address')).toBeFocused();
    await page.keyboard.type(`${SITE}/slow`);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Loading…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet__banner')).toContainText('cancelled');
    await expect(page.getByRole('button', { name: 'Summarize' })).toBeVisible();
  });

  test('Tab order reaches every control in a logical order', async ({ page }) => {
    await page.goto('/');
    const order: string[] = [];
    for (let i = 0; i < 18; i++) {
      await page.keyboard.press('Tab');
      order.push(
        await page.evaluate(() =>
          (
            document.activeElement?.getAttribute('aria-label') ??
            document.activeElement?.textContent ??
            document.activeElement?.tagName ??
            ''
          )
            .trim()
            .slice(0, 30),
        ),
      );
    }
    expect(order[0]).toMatch(/skip to the result/i);
    expect(order.some((o) => /summarize/i.test(o))).toBe(true);
    expect(order.indexOf(order.find((o) => /switch to/i.test(o)) ?? '')).toBeGreaterThan(0);
  });
});

test.describe('accessibility (axe, WCAG 2.2 AA)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });
      test('first screen', async ({ page }) => {
        await page.goto('/');
        expect((await audit(page)).violations).toEqual([]);
      });
      test('result with evidence and every panel open', async ({ page }) => {
        await page.goto('/');
        await submit(page, '/article');
        await expect(page.locator('.verify')).toBeVisible();
        await page.locator('.evidence__btn').first().click();
        await page.getByRole('button', { name: 'Show page text' }).click();
        await page.getByRole('button', { name: 'Use the API' }).click();
        expect((await audit(page)).violations).toEqual([]);
      });
      test('error state', async ({ page }) => {
        await page.goto('/');
        await submit(page, '/spa');
        await expect(page.getByRole('alert')).toBeVisible();
        expect((await audit(page)).violations).toEqual([]);
      });
    });
  }
});

test.describe('worst-case data and small screens', () => {
  test('a huge unbroken title never breaks the layout', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/');
    await submit(page, '/long-title');
    await expect(page.locator('.title')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  for (const width of [320, 390, 768, 1280]) {
    test(`no horizontal scroll at ${width}px (first screen and result)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await submit(page, '/article');
      await expect(page.locator('.verify')).toBeVisible();
      await page.getByRole('button', { name: 'Use the API' }).click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    });
  }

  test('reduced motion removes movement', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await submit(page, '/article');
    await expect(page.locator('.verify')).toBeVisible();
    const animated = await page.evaluate(
      () =>
        [...document.querySelectorAll('.point, .tldr, .context')].filter(
          (el) =>
            getComputedStyle(el).animationName !== 'none' &&
            parseFloat(getComputedStyle(el).animationDuration) > 0.001,
        ).length,
    );
    expect(animated).toBe(0);
  });

  test('theme switch applies to the whole page and persists across reload', async ({ page }) => {
    await page.goto('/');
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const before = await bg();
    await page.getByRole('button', { name: /switch to (dark|light) theme/i }).click();
    await expect.poll(bg).not.toBe(before);
    const after = await bg();
    await page.reload();
    expect(await bg()).toBe(after);
  });
});

test.describe('production security headers', () => {
  test('the page works under the strict Content-Security-Policy with zero violations', async ({
    page,
  }) => {
    const violations: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (window as unknown as { __csp: string[] }).__csp ??= [];
        (window as unknown as { __csp: string[] }).__csp.push(
          `${e.violatedDirective} ${e.blockedURI}`,
        );
      });
    });
    page.on('console', (m) => {
      if (/content security policy/i.test(m.text())) violations.push(m.text());
    });
    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    await submit(page, '/article');
    await expect(page.locator('.verify')).toBeVisible();
    await page.locator('.evidence__btn').first().click();
    await page.getByRole('button', { name: 'Show page text' }).click();
    await page.getByRole('button', { name: 'Use the API' }).click();
    await page.getByRole('button', { name: /switch to (dark|light) theme/i }).click();
    const fromDom = await page.evaluate(
      () => (window as unknown as { __csp?: string[] }).__csp ?? [],
    );
    expect([...violations, ...fromDom]).toEqual([]);
  });
});
