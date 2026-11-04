# @agentpickup/core

The pickup-pass format behind [agentPickup](https://github.com/Tokenise-au/agentpickup): the signed QR a
customer shows at the counter after a person or an AI agent pays online.

A pass is a compact JWS signed with Ed25519, carrying `{v, oid, pid, exp}`. Items, names and amounts stay
on the shop's server. Anyone with the shop's public keys (`/.well-known/collect-keys.json`) can check a
pass offline.

```ts
import { generateSigningKeyPem, loadSigningKey, signPass, verifyPass, toJwks } from "@agentpickup/core";

const key = loadSigningKey(generateSigningKeyPem());
const token = signPass({ v: 1, oid: "ord_123", pid: "pas_456", exp: Math.floor(Date.now() / 1000) + 7200 }, key);
const result = verifyPass(token, [key]);   // { ok: true, claims } or { ok: false, reason: "bad_signature" | "expired" | … }
const jwks = toJwks([key]);                // publish at /.well-known/collect-keys.json
```

Node 22.13 or later. No dependencies. Apache-2.0.

For the full server (x402, MPP, UCP, ACP and card checkout, emails, the staff scanner), see
[`@agentpickup/server`](https://www.npmjs.com/package/@agentpickup/server).
