import { isAdminRole } from "../../constants/adminRoles.js";
import { modelForRole, issueSession } from "./auth.controller.js";
import {
	MFA_SELECT,
	checkCode,
	decryptSecret,
	encryptSecret,
	lockState,
	maskEmail,
	newRecoveryCodes,
	newTotpSecret,
	otpauthUrl,
	readChallenge,
	sendEmailCode,
} from "../../services/mfa.service.js";

const loadAccount = async (role, id) => {
	const Model = modelForRole(role);
	return Model ? Model.findById(id).select(MFA_SELECT) : null;
};

const me = (req) => loadAccount(req.user.role, req.user.userId);

const status = (user) => ({
	enabled: Boolean(user.mfa?.enabled),
	method: user.mfa?.enabled ? user.mfa.method : null,
	enabledAt: user.mfa?.enabledAt || null,
	recoveryCodesLeft: user.mfa?.recoveryCodeHashes?.length || 0,
	email: maskEmail(user.email),
	required: adminMustUseMfa(user.role),
});

export const adminMustUseMfa = (role) => process.env.ADMIN_MFA_REQUIRED === "true" && isAdminRole(role);

/* ---------------- sign-in (no session yet) ---------------- */

/** POST /auth/mfa/verify { mfaToken, code, method?: "totp"|"email"|"recovery" } → session */
export const verifyChallenge = async (req, res) => {
	try {
		const { mfaToken, code, method } = req.body || {};
		let ch;
		try {
			ch = readChallenge(mfaToken);
		} catch {
			return res.status(401).json({ message: "That sign-in has expired. Please sign in again." });
		}
		const user = await loadAccount(ch.role, ch.userId);
		if (!user || (user.tokenVersion || 0) !== (ch.tv || 0) || !user.mfa?.enabled) {
			return res.status(401).json({ message: "Please sign in again." });
		}
		if (ch.role === "CHARITY_STAFF" && user.active === false) {
			return res.status(403).json({ message: "This staff account is turned off." });
		}
		const kind = method === "recovery" ? "recovery" : method === "email" || method === "totp" ? method : "any";
		const r = await checkCode(user, code, { kind, purpose: "login" });
		if (!r.ok) return res.status(r.lockedUntil ? 429 : 400).json({ message: r.error });
		return res.status(200).json({
			message: "Login successful",
			...issueSession(user, ch.charityId, { mfa: true }),
			...(r.used === "recovery" ? { recoveryCodesLeft: r.recoveryCodesLeft } : {}),
		});
	} catch (e) {
		console.error("mfa verify:", e.message);
		res.status(500).json({ message: "Could not check the code." });
	}
};

/** POST /auth/mfa/resend { mfaToken } → emails a new login code (email method only) */
export const resendChallengeEmail = async (req, res) => {
	try {
		const ch = readChallenge(req.body?.mfaToken);
		const user = await loadAccount(ch.role, ch.userId);
		if (!user?.mfa?.enabled || user.mfa.method !== "email") return res.status(400).json({ message: "Use your authenticator app or a recovery code." });
		if (lockState(user)) return res.status(429).json({ message: "Too many wrong codes. Try again in 15 minutes." });
		await sendEmailCode(user, "login");
		res.json({ message: `We sent a new code to ${maskEmail(user.email)}.` });
	} catch {
		res.status(401).json({ message: "That sign-in has expired. Please sign in again." });
	}
};

/* ---------------- managing two-step (signed in) ---------------- */

/** GET /auth/mfa */
export const getMfaStatus = async (req, res) => {
	const user = await me(req);
	if (!user) return res.status(404).json({ message: "Account not found." });
	res.json(status(user));
};

/** POST /auth/mfa/totp/setup → { secret, otpauthUrl } (not active until confirmed) */
export const startTotpSetup = async (req, res) => {
	const user = await me(req);
	if (!user) return res.status(404).json({ message: "Account not found." });
	if (user.mfa?.enabled) return res.status(400).json({ message: "Turn off two-step first to switch method." });
	const secret = newTotpSecret();
	user.mfa.pendingTotpSecretEncrypted = encryptSecret(secret);
	user.markModified("mfa");
	await user.save();
	res.json({ secret: secret.replace(/(.{4})/g, "$1 ").trim(), otpauthUrl: otpauthUrl(secret, user.email) });
};

const turnOn = async (user, method) => {
	const { codes, hashes } = newRecoveryCodes();
	user.mfa.enabled = true;
	user.mfa.method = method;
	user.mfa.enabledAt = new Date();
	user.mfa.recoveryCodeHashes = hashes;
	user.markModified("mfa");
	await user.save();
	return codes;
};

/** POST /auth/mfa/totp/enable { code } → { recoveryCodes } */
export const confirmTotpSetup = async (req, res) => {
	const user = await me(req);
	if (!user?.mfa?.pendingTotpSecretEncrypted) return res.status(400).json({ message: "Start the set-up again." });
	const pending = decryptSecret(user.mfa.pendingTotpSecretEncrypted);
	const r = await checkCode(user, req.body?.code, { kind: "totp", secretOverride: pending });
	if (!r.ok) return res.status(r.lockedUntil ? 429 : 400).json({ message: r.error });
	user.mfa.totpSecretEncrypted = user.mfa.pendingTotpSecretEncrypted;
	user.mfa.pendingTotpSecretEncrypted = undefined;
	const codes = await turnOn(user, "totp");
	res.json({ message: "Two-step sign-in is on.", recoveryCodes: codes, ...status(user), session: issueSession(user, req.user.charityId, { mfa: true }) });
};

/** POST /auth/mfa/email/send { purpose: "enable" | "manage" } → emails a code */
export const sendManageEmailCode = async (req, res) => {
	const user = await me(req);
	if (!user) return res.status(404).json({ message: "Account not found." });
	if (lockState(user)) return res.status(429).json({ message: "Too many wrong codes. Try again in 15 minutes." });
	const purpose = req.body?.purpose === "enable" ? "enable" : "manage";
	if (purpose === "enable" && user.mfa?.enabled) return res.status(400).json({ message: "Two-step is already on." });
	await sendEmailCode(user, purpose);
	res.json({ message: `We sent a 6-digit code to ${maskEmail(user.email)}.` });
};

/** POST /auth/mfa/email/enable { code } → { recoveryCodes } */
export const confirmEmailSetup = async (req, res) => {
	const user = await me(req);
	if (!user) return res.status(404).json({ message: "Account not found." });
	if (user.mfa?.enabled) return res.status(400).json({ message: "Two-step is already on." });
	const r = await checkCode(user, req.body?.code, { kind: "email", purpose: "enable" });
	if (!r.ok) return res.status(r.lockedUntil ? 429 : 400).json({ message: r.error });
	const codes = await turnOn(user, "email");
	res.json({ message: "Two-step sign-in is on.", recoveryCodes: codes, ...status(user), session: issueSession(user, req.user.charityId, { mfa: true }) });
};

/** Prove it's you: authenticator code, emailed "manage" code, or a recovery code. */
const stepUp = (user, code) => checkCode(user, code, { kind: "any", purpose: "manage" });

/** POST /auth/mfa/disable { code } */
export const disableMfa = async (req, res) => {
	const user = await me(req);
	if (!user?.mfa?.enabled) return res.status(400).json({ message: "Two-step isn't on." });
	if (adminMustUseMfa(user.role)) return res.status(403).json({ message: "Admins must keep two-step sign-in on." });
	const r = await stepUp(user, req.body?.code);
	if (!r.ok) return res.status(r.lockedUntil ? 429 : 400).json({ message: r.error });
	user.mfa = { enabled: false };
	user.markModified("mfa");
	await user.save();
	res.json({ message: "Two-step sign-in is off.", ...status(user) });
};

/** POST /auth/mfa/recovery-codes { code } → new codes (old ones stop working) */
export const regenerateRecoveryCodes = async (req, res) => {
	const user = await me(req);
	if (!user?.mfa?.enabled) return res.status(400).json({ message: "Two-step isn't on." });
	const r = await stepUp(user, req.body?.code);
	if (!r.ok) return res.status(r.lockedUntil ? 429 : 400).json({ message: r.error });
	const { codes, hashes } = newRecoveryCodes();
	user.mfa.recoveryCodeHashes = hashes;
	user.markModified("mfa");
	await user.save();
	res.json({ recoveryCodes: codes, ...status(user) });
};

/** POST /auth/sessions/revoke — sign out every other device (bumps tokenVersion) */
export const revokeOtherSessions = async (req, res) => {
	const user = await me(req);
	if (!user) return res.status(404).json({ message: "Account not found." });
	user.tokenVersion = (user.tokenVersion || 0) + 1;
	await user.save();
	res.json({ message: "Signed out on every other device.", ...issueSession(user, req.user.charityId, { mfa: Boolean(req.user.mfa) }) });
};

