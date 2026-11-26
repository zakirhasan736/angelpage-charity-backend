import mongoose from "mongoose";

/**
 * Shared security fields for every account collection (User, Charity,
 * CharityStaff, Admin):
 *   - mfa: two-step sign-in (authenticator app or email code) + recovery codes
 *   - tokenVersion: bumped on password reset / "sign out everywhere"; refresh
 *     tokens carrying an older version stop working
 *   - verificationAttempts: caps guesses at the 6-digit email verification code
 * Also strips secrets from every JSON response (res.json uses toJSON).
 */
const mfaSchema = new mongoose.Schema(
	{
		enabled: { type: Boolean, default: false },
		method: { type: String, enum: ["totp", "email"], default: undefined },
		enabledAt: { type: Date },
		totpSecretEncrypted: { type: String, select: false },
		pendingTotpSecretEncrypted: { type: String, select: false },
		lastTotpStep: { type: Number, select: false },
		recoveryCodeHashes: { type: [String], select: false, default: undefined },
		// one-time email code (login challenge, enabling email MFA, or step-up)
		emailCodeHash: { type: String, select: false },
		emailCodeExpiresAt: { type: Date, select: false },
		emailCodePurpose: { type: String, select: false },
		// wrong guesses for the current challenge (any method)
		failedAttempts: { type: Number, default: 0, select: false },
		lockedUntil: { type: Date, select: false },
	},
	{ _id: false },
);

const SECRET_KEYS = ["password", "verificationCode", "verificationExpiry", "verificationAttempts", "resetToken", "resetTokenExpiry"];

export function accountSecurityPlugin(schema) {
	schema.add({
		mfa: { type: mfaSchema, default: () => ({}) },
		tokenVersion: { type: Number, default: 0 },
		verificationAttempts: { type: Number, default: 0, select: false },
	});

	const strip = (_doc, ret) => {
		SECRET_KEYS.forEach((k) => delete ret[k]);
		if (ret.mfa) {
			ret.mfa = { enabled: Boolean(ret.mfa.enabled), method: ret.mfa.enabled ? ret.mfa.method : undefined, enabledAt: ret.mfa.enabledAt };
		}
		delete ret.tokenVersion;
		return ret;
	};
	const prev = schema.get("toJSON") || {};
	schema.set("toJSON", {
		...prev,
		transform: (doc, ret, opts) => {
			const out = typeof prev.transform === "function" ? prev.transform(doc, ret, opts) || ret : ret;
			return strip(doc, out);
		},
	});
}

/** Safe copy of an account for API responses. */
export function publicAccount(doc) {
	if (!doc) return doc;
	const obj = typeof doc.toJSON === "function" ? doc.toJSON() : { ...doc };
	SECRET_KEYS.forEach((k) => delete obj[k]);
	if (obj.mfa) obj.mfa = { enabled: Boolean(obj.mfa.enabled), method: obj.mfa.enabled ? obj.mfa.method : undefined, enabledAt: obj.mfa.enabledAt };
	delete obj.tokenVersion;
	return obj;
}
