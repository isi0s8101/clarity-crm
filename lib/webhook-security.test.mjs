import assert from "node:assert/strict";

import {
  WebhookResponseTooLargeError,
  hostMatchesAllowedWebhookHosts,
  isPublicIpAddress,
  readLimitedResponseText,
  validateWebhookTargetUrl,
} from "./webhook-security.js";

assert.equal(isPublicIpAddress("8.8.8.8"), true);
assert.equal(isPublicIpAddress("1.1.1.1"), true);
assert.equal(isPublicIpAddress("127.0.0.1"), false);
assert.equal(isPublicIpAddress("10.0.0.1"), false);
assert.equal(isPublicIpAddress("172.16.0.1"), false);
assert.equal(isPublicIpAddress("192.168.1.10"), false);
assert.equal(isPublicIpAddress("169.254.10.20"), false);
assert.equal(isPublicIpAddress("224.0.0.1"), false);
assert.equal(isPublicIpAddress("198.51.100.10"), false);

assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
assert.equal(isPublicIpAddress("::1"), false);
assert.equal(isPublicIpAddress("fd00::1"), false);
assert.equal(isPublicIpAddress("fe80::1"), false);
assert.equal(isPublicIpAddress("ff02::1"), false);
assert.equal(isPublicIpAddress("2001:db8::1"), false);
assert.equal(isPublicIpAddress("::ffff:127.0.0.1"), false);
assert.equal(isPublicIpAddress("::ffff:8.8.8.8"), true);

assert.equal(hostMatchesAllowedWebhookHosts("hooks.example.com", "hooks.example.com"), true);
assert.equal(hostMatchesAllowedWebhookHosts("a.example.com", "*.example.com"), true);
assert.equal(hostMatchesAllowedWebhookHosts("example.com", "*.example.com"), false);
assert.equal(hostMatchesAllowedWebhookHosts("evil.test", "hooks.example.com,*.example.com"), false);

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const privateResolver = async () => [{ address: "10.0.0.4", family: 4 }];
const ipv6PrivateResolver = async () => [{ address: "fd00::10", family: 6 }];

assert.equal((await validateWebhookTargetUrl("https://public.example/hook", { resolveHost: publicResolver })).ok, true);
assert.equal((await validateWebhookTargetUrl("http://public.example/hook", { resolveHost: publicResolver })).ok, false);
assert.equal((await validateWebhookTargetUrl("https://localhost/hook", { resolveHost: publicResolver })).ok, false);
assert.equal((await validateWebhookTargetUrl("https://127.0.0.1/hook", { resolveHost: publicResolver })).ok, false);
assert.equal((await validateWebhookTargetUrl("https://[::1]/hook", { resolveHost: publicResolver })).ok, false);
assert.equal((await validateWebhookTargetUrl("https://public.example/hook", { resolveHost: privateResolver })).ok, false);
assert.equal((await validateWebhookTargetUrl("https://public.example/hook", { resolveHost: ipv6PrivateResolver })).ok, false);
assert.equal((await validateWebhookTargetUrl("https://public.example/hook", {
  allowedHosts: "hooks.example.com",
  resolveHost: publicResolver,
})).ok, false);
assert.equal((await validateWebhookTargetUrl("http://127.0.0.1:9999/hook", {
  allowPrivate: true,
  resolveHost: privateResolver,
})).ok, true);

assert.equal(await readLimitedResponseText(new Response("OK"), 4), "OK");
await assert.rejects(
  () => readLimitedResponseText(new Response("x".repeat(5000)), 4096),
  WebhookResponseTooLargeError,
);

console.log("webhook security tests: ok");
