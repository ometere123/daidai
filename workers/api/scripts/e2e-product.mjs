import assert from 'node:assert/strict';

export async function exerciseProduct({ browser, base, invitations, check, serviceSecret }) {
  let calls = 0;
  const createContext = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.exposeFunction('__recordProductWalletCall', () => { calls++; });
    await ctx.addInitScript(() => {
      window.ethereum = { async request() { await window.__recordProductWalletCall(); throw Error('No wallet in product test'); } };
    });
    return ctx;
  };
  const merchant = await createContext(), payer = await createContext();
  const m = await merchant.newPage(), p = await payer.newPage();
  const login = async (page, code) => {
    await page.goto(base + '/login');
    await page.getByLabel('Invitation code').fill(code);
    await Promise.all([page.waitForURL('**/invoices'), page.locator('button[type=submit]').click()]);
  };
  const body = page => page.locator('body').innerText();
  const submit = async (page, label) => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/product') && r.request().method() === 'POST');
    await page.getByRole('button', { name: label, exact: true }).click();
    const res = await response;
    await page.waitForLoadState();
    return res;
  };
  try {
    await login(m, invitations['demo-viewer'][2]);
    await m.goto(base + '/merchant');
    check('P11 merchant arrives at an empty isolated workspace', /No invoices yet/.test(await body(m)));
    await m.getByLabel('Exact recipient amount (cNGN)').fill('1500');
    await m.getByLabel('Maximum all-in debit (USDt)').fill('1.20');
    await m.getByLabel('Recipient wallet').fill('0x' + '12'.repeat(20));
    await m.getByLabel('Invoice approver wallet').fill('0x' + '34'.repeat(20));
    const created = await submit(m, 'Create draft');
    assert.equal(created.status(), 303, 'create draft must redirect');
    const location = await created.headerValue('location');
    assert(location && /^\/merchant\/[a-f0-9]{32}$/.test(location), 'create draft must return the invoice detail location');
    const invoice = new URL(location, base);
    await m.waitForURL(invoice.href);
    check('P11 persistent draft created with exact cNGN target', await m.getByText('1500 cNGN', { exact: true }).isVisible());

    await m.getByLabel('Maximum all-in debit (USDt)').fill('1.10');
    await submit(m, 'Save new revision');
    await m.getByText(/Revision 2 · draft/).waitFor();
    const committed = await submit(m, 'Commit invoice terms');
    await m.getByText('Committed · awaiting approvals').waitFor();
    check('P11 commitment appends an immutable third revision', committed.status() === 303 &&
      /Revision 3 · committed/.test(await body(m)) && /Revision 1 · draft/.test(await body(m)));

    const badOrigin = await merchant.request.post(base + '/api/product', {
      headers: { origin: 'https://example.invalid' }, form: { kind: 'cancel' }, maxRedirects: 0,
    });
    check('P11 cross-origin browser mutation denied', badOrigin.status() === 403);
    await submit(m, 'Generate payment link');
    const shared = m.getByRole('link', { name: 'Open payer review' });
    await shared.waitFor();
    const href = await shared.getAttribute('href');
    assert(href && /^\/pay#[A-Za-z0-9_-]{43}$/.test(href), 'share link must keep capability in the fragment');
    await login(p, invitations['viewer-b'][0]);
    const denied = await p.goto(invoice.href);
    check('P11 payer cannot read foreign merchant history', denied?.status() === 404 && !(await body(p)).includes('1500 cNGN'));

    await p.goto(new URL(href, base).href);
    const opened = await submit(p, 'Review shared invoice');
    await p.getByRole('heading', { name: 'Committed invoice' }).waitFor();
    const payerBody = await body(p);
    check('P11 payer sees the scoped commitment and simulated all-in debit', opened.status() === 303 &&
      /1500 cNGN/.test(payerBody) && /1\.001 USDt/.test(payerBody) && /missing verified authorization/.test(payerBody));
    const payerResponse = await p.reload();
    check('P11 mobile review fits without horizontal overflow', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check('P11 review is private and browser HTML omits service and share keys',
      /no-store|private/.test(payerResponse?.headers()['cache-control'] ?? '') &&
      !(await p.content()).includes(serviceSecret) && !(await p.content()).includes(href.split('#')[1]));

    await p.getByRole('link', { name: 'View a simulated unknown payout' }).click();
    await p.getByText('Simulation · Needs reconciliation', { exact: true }).waitFor();
    check('P11 unknown evidence keeps payout separate and exposes no retry or settled state', /separate exact cNGN/.test(await body(p)) &&
      !(await p.getByRole('button', { name: /retry|settled/i }).count()) && !(await body(p)).includes('Payment complete'));
    await submit(m, 'Revoke payment links');
    await p.reload();
    await p.getByText(/These payment instructions are unavailable/).waitFor();
    check('P11 revoked capability immediately loses access', !(await p.getByRole('heading', { name: 'Committed invoice' }).count()));

    await submit(m, 'Cancel invoice');
    await m.getByRole('heading', { name: 'Cancelled' }).waitFor();
    check('P11 cancellation retains committed revision history', /Revision 3 · committed/.test(await body(m)) && /Revision 4 · cancelled/.test(await body(m)));
    check('P11 merchant and payer flows make zero wallet-provider calls', calls === 0);
  } finally {
    await merchant.close();
    await payer.close();
  }
}
