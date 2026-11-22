# P08B.22 controlled registration outcome

The read-only preflight matched the approved fingerprint and budget. One registration session was armed. The browser showed BOOTSTRAP_MISSING, the session closed without a hash, and the durable ledger contained zero attempts. No wallet dispatch was recorded and there was no receipt to reconcile. Loops was untouched.

The missing credential is confirmed. The screenshot does not establish how it was lost. The previous page captured its fragment only at startup. A bare page followed by fragment-only navigation in the same tab could retain an empty credential. The shared browser helper now captures a fragment added before the user starts, strips it from the URL, and clears the in-memory copy on use. Server-side authentication and single-use controls are unchanged.

Strict TypeScript and 33 isolated Chromium tests passed, including the new same-tab regression. The revised code has not yet been exercised in the real MetaMask profile. No second registration session was armed.
