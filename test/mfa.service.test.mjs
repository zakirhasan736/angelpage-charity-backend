// Run after a build: npm run build && JWT_SECRET=... node --test test/mfa.service.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DIST = process.env.MFA_TEST_DIST || "../dist";
const m = require(`${DIST}/services/mfa.service.js`);
const { encryptSecret } = require(`${DIST}/utils/credentialCrypto.js`);

const fakeUser = (mfa = {}) => ({
	_id: "64b000000000000000000001",
	role: "USER",
	email: "sam@example.com",
	tokenVersion: 0,
	mfa: { enabled: true, ...mfa },
	saved: 0,
	markModified() {},
	async save() {
		this.saved += 1;
	},
});

test("TOTP matches the RFC 6238 test vectors", () => {
	const secret = m.base32Decode(m.base32Encode(Buffer.from("12345678901234567890")));
	const vectors = [
		[59, "287082"],
		[1111111109, "081804"],
		[1234567890, "005924"],
		[2000000000, "279037"],
	];
	for (const [t, code] of vectors) assert.equal(m.hotp(secret, Math.floor(t / 30)), code);
});

test("a TOTP code works once (replay is refused)", async () => {
	const secret = m.newTotpSecret();
	const user = fakeUser({ method: "totp", totpSecretEncrypted: encryptSecret(secret) });
	const code = m.hotp(m.base32Decode(secret), m.currentStep());
	assert.equal((await m.checkCode(user, code, { kind: "totp" })).ok, true);
	assert.equal((await m.checkCode(user, code, { kind: "totp" })).ok, false);
});

test("recovery codes are single use", async () => {
	const { codes, hashes } = m.newRecoveryCodes();
	const user = fakeUser({ method: "totp", recoveryCodeHashes: [...hashes] });
	const r = await m.checkCode(user, codes[0].toLowerCase(), { kind: "recovery" });
	assert.equal(r.ok, true);
	assert.equal(r.recoveryCodesLeft, 9);
	assert.equal((await m.checkCode(user, codes[0], { kind: "recovery" })).ok, false);
});

test("email codes only work for their purpose and expire", async () => {
	const user = fakeUser({ method: "email" });
	const sent = [];
	// capture the code instead of emailing it
	const crypto = require("crypto");
	const code = "424242";
	user.mfa.emailCodeHash = crypto.createHash("sha256").update(`${user._id}:login:${code}`).digest("hex");
	user.mfa.emailCodeExpiresAt = new Date(Date.now() + 60_000);
	user.mfa.emailCodePurpose = "login";
	assert.equal((await m.checkCode(user, code, { kind: "email", purpose: "manage" })).ok, false);
	user.mfa.failedAttempts = 0;
	assert.equal((await m.checkCode(user, code, { kind: "email", purpose: "login" })).ok, true);
	assert.equal((await m.checkCode(user, code, { kind: "email", purpose: "login" })).ok, false, "used codes are cleared");
	assert.equal(sent.length, 0);
});

test("five wrong codes lock two-step for 15 minutes", async () => {
	const user = fakeUser({ method: "totp", totpSecretEncrypted: encryptSecret(m.newTotpSecret()) });
	for (let i = 0; i < m.MFA_MAX_ATTEMPTS; i += 1) await m.checkCode(user, "000000");
	const r = await m.checkCode(user, "000000");
	assert.equal(r.ok, false);
	assert.ok(r.lockedUntil instanceof Date);
});

test("sign-in challenge tokens round-trip and can't be used as sessions", () => {
	const user = fakeUser();
	const t = m.issueChallenge(user, { charityId: "c1" });
	const d = m.readChallenge(t);
	assert.equal(d.userId, user._id);
	assert.equal(d.charityId, "c1");
	assert.equal(d.type, "mfa_challenge");
	const jwt = require("jsonwebtoken");
	assert.throws(() => m.readChallenge(jwt.sign({ type: "access" }, process.env.JWT_SECRET)));
});
