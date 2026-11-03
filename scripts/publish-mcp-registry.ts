// Publishes packages/mcp/server.json to the official MCP Registry as io.github.dav3trad3r/agentpickup.
// Signs in the way mcp-publisher does: GitHub's device flow with the registry's own OAuth app (read:org
// and read:user only), then trades the GitHub token for a short-lived registry token. Prints neither.
// Bump "version" in server.json (and publish that npm version first); the registry refuses repeats.
//   npx tsx scripts/publish-mcp-registry.ts [--go]
import { readFileSync } from "node:fs";

const REGISTRY = "https://registry.modelcontextprotocol.io";
const go = process.argv.includes("--go");
const raw = readFileSync(new URL("../packages/mcp/server.json", import.meta.url), "utf8");
const server = JSON.parse(raw) as { name: string; version: string; packages?: { identifier: string; version: string }[] };

console.log(`${server.name} ${server.version} → ${REGISTRY}`);
for (const pkg of server.packages ?? []) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.identifier}/${pkg.version}`);
  const meta = (await res.json().catch(() => ({}))) as { mcpName?: string };
  if (!res.ok) throw new Error(`${pkg.identifier}@${pkg.version} isn't on npm yet`);
  if (meta.mcpName !== server.name) throw new Error(`${pkg.identifier}@${pkg.version} has mcpName ${meta.mcpName}, not ${server.name}`);
  console.log(`npm ${pkg.identifier}@${pkg.version}: mcpName matches`);
}
if (!go) {
  console.log("Dry run. Add --go to sign in with GitHub and publish.");
  process.exit(0);
}

const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const { github_client_id: clientId } = (await (await fetch(`${REGISTRY}/v0/health`)).json()) as { github_client_id: string };
const device = (await (await fetch("https://github.com/login/device/code", form({ client_id: clientId, scope: "read:org read:user" }))).json()) as {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
  expires_in: number;
};
console.log(`\nOpen ${device.verification_uri} and enter the code ${device.user_code}`);
console.log("Waiting for you to approve in GitHub…");

let interval = device.interval ?? 5;
const deadline = Date.now() + device.expires_in * 1000;
let githubToken = "";
while (!githubToken) {
  if (Date.now() > deadline) throw new Error("The code expired. Run it again.");
  await new Promise((r) => setTimeout(r, interval * 1000));
  const poll = (await (
    await fetch(
      "https://github.com/login/oauth/access_token",
      form({ client_id: clientId, device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    )
  ).json()) as { access_token?: string; error?: string };
  if (poll.access_token) githubToken = poll.access_token;
  else if (poll.error === "slow_down") interval = Math.min(interval + 5, 60);
  else if (poll.error !== "authorization_pending") throw new Error(`GitHub sign-in failed: ${poll.error}`);
}
console.log("Signed in to GitHub.");

const login = await fetch(`${REGISTRY}/v0.1/auth/github-at`, form({ github_token: githubToken }));
const token = (await login.json()) as { registry_token?: string; detail?: string };
if (!login.ok || !token.registry_token) throw new Error(`registry login failed (${login.status}): ${token.detail ?? ""}`);

const res = await fetch(`${REGISTRY}/v0.1/publish`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.registry_token}` },
  body: raw,
});
const body = await res.text();
if (!res.ok) throw new Error(`publish failed (${res.status}): ${body}`);
console.log(`Published: ${body.slice(0, 400)}`);
