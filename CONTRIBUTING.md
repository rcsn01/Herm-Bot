# Contributing

Hermes Mobile is maintained separately from the Hermes Agent backend. Keep
backend behavior changes in the Hermes Agent repository and update the mobile
contract only when the gateway wire contract requires it.

## Local checks

```bash
cd client
npm ci
npm run typecheck
npm test
npm run build

cd ../web-push-relay
npm ci
npm test
```

Browser tests require a production build and Playwright browsers:

```bash
cd client
npx playwright install chromium webkit
npm run test:e2e
```

The optional native push plugin tests need a Hermes Agent checkout. Set
`HERMES_AGENT_ROOT` and add that checkout to `PYTHONPATH` before running them:

```bash
HERMES_AGENT_ROOT=/path/to/hermes-agent \
PYTHONPATH=/path/to/hermes-agent \
python3 -m unittest discover -s push-notification -p 'test_*.py'
```

Do not commit `.env`, generated builds, Xcode output, Web Push keys, gateway
tokens, or production deployment files containing secrets. Preserve the
Capacitor bundle ID, `hermes://` links, PWA origin, and Web Push volume unless a
migration plan explicitly covers them.
