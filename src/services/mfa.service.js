/**
 * Two-step sign-in for every account type.
 *
 *   totp   authenticator app (Google Authenticator, Microsoft Authenticator,
 *          1Password, Authy...): RFC 6238, SHA-1, 6 digits, 30 s, ±1 step,
 *          a used step can't be replayed
 *   email  a 6-digit code emailed for each sign-in (10 minutes)
 *   recovery  10 single-use codes shown once when two-step is turned on
 *
 * After 5 wrong codes the account's two-step check locks for 15 minutes.
 * No third-party dependency: only node:crypto.
 */
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/jwtSecret.js";
import { encryptSecret, decryptSecret } from "../utils/credentialCrypto.js";
import { sendEmail } from "../utils/email";

export const MFA_MAX_ATTEMPTS = 5;
export const MFA_LOCK_MS = 15 * 60 * 1000;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL = "10m";
const ISSUER = () => process.env.MFA_ISSUER || "Angelpage";

/* ---------------- base32 (RFC 4648, no padding) ---------------- */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(str) {
	const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
	let bits = 0;
	let value = 0;
	const out = [];
	for (const ch of clean) {
		value = (value << 5) | B32.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/* ---------------- TOTP ---------------- */

export function hotp(secretBuf, counter, digits = 6) {
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const h = crypto.createHmac("sha1", secretBuf).update(msg).digest();
	const off = h[h.length - 1] & 0xf;
	const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
	return String(bin % 10 ** digits).padStart(digits, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / 30);

/** Returns the matching time step, or null. Accepts the previous, current and next step. */
export function verifyTotp(secretB32, code, { now = Date.now(), lastStep } = {}) {
	const c = String(code || "").replace(/\s/g, "");
	if (!/^\d{6}$/.test(c)) return null;
	const secret = base32Decode(secretB32);
	const step = currentStep(now);
	for (const s of [step - 1, step, step + 1]) {
		if (lastStep != null && s <= lastStep) continue; // replay
		const expected = hotp(secret, s);
		if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
	}
	return null;
}

export function newTotpSecret() {
	return base32Encode(crypto.randomBytes(20)); // 160 bits, as RFC 4226 recommends
}

export function otpauthUrl(secretB32, accountLabel) {
	const label = encodeURIComponent(`${ISSUER()}:${accountLabel}`);
	const q = new URLSearchParams({ secret: secretB32, issuer: ISSUER(), algorithm: "SHA1", digits: "6", period: "30" });
	return `otpauth://totp/${label}?${q}`;
}

/* ---------------- codes ---------------- */

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const safeEqualHex = (a, b) => {
	if (!a || !b || a.length !== b.length) return false;
	return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
};

export const sixDigits = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/** 10 codes like "7KQ4-M2XD", returned in clear once; only hashes are stored. */
export function newRecoveryCodes(n = 10) {
	const codes = Array.from({ length: n }, () => {
		const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
		return `${raw.slice(0, 4)}-${raw.slice(4)}`;
	});
	return { codes, hashes: codes.map((c) => sha256(c.replace("-", ""))) };
}

/* ---------------- account helpers (the doc must be loaded with the +mfa.* fields) ---------------- */

export const MFA_SELECT =
	"+mfa.totpSecretEncrypted +mfa.pendingTotpSecretEncrypted +mfa.lastTotpStep +mfa.recoveryCodeHashes +mfa.emailCodeHash +mfa.emailCodeExpiresAt +mfa.emailCodePurpose +mfa.failedAttempts +mfa.lockedUntil";

export function lockState(user) {
	const until = user.mfa?.lockedUntil;
	return until && until.getTime() > Date.now() ? until : null;
}

async function recordFailure(user) {
	user.mfa.failedAttempts = (user.mfa.failedAttempts || 0) + 1;
	if (user.mfa.failedAttempts >= MFA_MAX_ATTEMPTS) {
		user.mfa.lockedUntil = new Date(Date.now() + MFA_LOCK_MS);
		user.mfa.failedAttempts = 0;
	}
	user.markModified("mfa");
	await user.save();
}

async function recordSuccess(user) {
	user.mfa.failedAttempts = 0;
	user.mfa.lockedUntil = undefined;
	user.markModified("mfa");
}

/** Email a fresh 6-digit code. purpose: "login" | "enable" | "manage" */
export async function sendEmailCode(user, purpose) {
	const code = sixDigits();
	user.mfa = user.mfa || {};
	user.mfa.emailCodeHash = sha256(`${user._id}:${purpose}:${code}`);
	user.mfa.emailCodeExpiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS);
	user.mfa.emailCodePurpose = purpose;
	user.markModified("mfa");
	await user.save();
	const first = user.firstName || user.charityName || "there";
	await sendEmail({
		to: user.email,
		subject: `${code} is your Angelpage security code`,
		text: `Hello ${first},\n\nYour Angelpage security code is ${code}. It expires in 10 minutes.\n\nIf you didn't try to sign in or change your security settings, change your password now.`,
		html: `<p>Hello ${first},</p><p>Your Angelpage security code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p><p>It expires in 10 minutes.</p><p style="color:#6b686e">If you didn't try to sign in or change your security settings, change your password now.</p>`,
	});
	return true;
}

/**
 * Check a code against the account. kind: "totp" | "email" | "recovery" | "any".
 * "any" tries the account's method, then recovery codes.
 * Returns { ok, used, error?, lockedUntil? }. Saves the account.
 */
export async function checkCode(user, code, { kind = "any", purpose = "login", secretOverride } = {}) {
	const locked = lockState(user);
	if (locked) return { ok: false, error: "Too many wrong codes. Try again in 15 minutes.", lockedUntil: locked };
	const raw = String(code || "").trim();
	const tryTotp = (kind === "totp" || kind === "any") && (secretOverride || user.mfa?.totpSecretEncrypted);
	const tryEmail = (kind === "email" || kind === "any") && user.mfa?.emailCodeHash;
	const tryRecovery = (kind === "recovery" || kind === "any") && user.mfa?.recoveryCodeHashes?.length;

	if (tryTotp && /^\d{6}$/.test(raw.replace(/\s/g, ""))) {
		const secret = secretOverride || decryptSecret(user.mfa.totpSecretEncrypted);
		const step = verifyTotp(secret, raw, { lastStep: user.mfa.lastTotpStep });
		if (step != null) {
			user.mfa.lastTotpStep = step;
			await recordSuccess(user);
			await user.save();
			return { ok: true, used: "totp" };
		}
	}
	if (tryEmail && /^\d{6}$/.test(raw)) {
		const fresh = user.mfa.emailCodeExpiresAt && user.mfa.emailCodeExpiresAt.getTime() > Date.now();
		if (fresh && user.mfa.emailCodePurpose === purpose && safeEqualHex(user.mfa.emailCodeHash, sha256(`${user._id}:${purpose}:${raw}`))) {
			user.mfa.emailCodeHash = undefined;
			user.mfa.emailCodeExpiresAt = undefined;
			user.mfa.emailCodePurpose = undefined;
			await recordSuccess(user);
			await user.save();
			return { ok: true, used: "email" };
		}
	}
	if (tryRecovery) {
		const h = sha256(raw.toUpperCase().replace(/[^A-Z2-7]/g, ""));
		const idx = user.mfa.recoveryCodeHashes.findIndex((x) => safeEqualHex(x, h));
		if (idx >= 0) {
			user.mfa.recoveryCodeHashes.splice(idx, 1);
			await recordSuccess(user);
			await user.save();
			return { ok: true, used: "recovery", recoveryCodesLeft: user.mfa.recoveryCodeHashes.length };
		}
	}
	await recordFailure(user);
	return { ok: false, error: "That code isn't right. Check it and try again." };
}

/* ---------------- sign-in challenge ---------------- */

/** Short-lived token proving the password step passed; exchanged for real tokens with a code. */
export function issueChallenge(user, { charityId } = {}) {
	return jwt.sign(
		{ type: "mfa_challenge", userId: String(user._id), role: user.role, tv: user.tokenVersion || 0, ...(charityId ? { charityId } : {}) },
		JWT_SECRET,
		{ expiresIn: CHALLENGE_TTL },
	);
}

export function readChallenge(token) {
	const d = jwt.verify(String(token || ""), JWT_SECRET);
	if (d.type !== "mfa_challenge") throw new Error("Not a sign-in challenge.");
	return d;
}

export const maskEmail = (email = "") => {
	const [u, d] = String(email).split("@");
	if (!d) return "";
	return `${u.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}`;
};

export { encryptSecret, decryptSecret };
