/**
 * Verifies identity tokens from Sign in with Apple and Google Sign-In (iOS).
 * Keys come from the providers' public JWKS and are cached for an hour.
 *
 *   APPLE_AUDIENCES   comma-separated: your iOS bundle id (and Services ID if used)
 *   GOOGLE_AUDIENCES  comma-separated: Google OAuth client IDs (iOS + web)
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const PROVIDERS = {
	apple: {
		jwks: "https://appleid.apple.com/auth/keys",
		issuers: ["https://appleid.apple.com"],
		audiences: () => (process.env.APPLE_AUDIENCES || process.env.APNS_BUNDLE_ID || "").split(",").map(s => s.trim()).filter(Boolean),
	},
	google: {
		jwks: "https://www.googleapis.com/oauth2/v3/certs",
		issuers: ["https://accounts.google.com", "accounts.google.com"],
		audiences: () => (process.env.GOOGLE_AUDIENCES || process.env.GOOGLE_CLIENT_ID || "").split(",").map(s => s.trim()).filter(Boolean),
	},
};

const cache = {};
const keysFor = async provider => {
	const c = cache[provider];
	if (c && Date.now() - c.at < 60 * 60 * 1000) return c.keys;
	const res = await fetch(PROVIDERS[provider].jwks);
	if (!res.ok) throw new Error(`Could not load ${provider} keys`);
	const { keys = [] } = await res.json();
	cache[provider] = { keys, at: Date.now() };
	return keys;
};

/**
 * @returns {Promise<{ email: string, providerId: string, emailVerified: boolean, name?: string, picture?: string }>}
 */
export async function verifyIdToken(provider, idToken) {
	const p = PROVIDERS[provider];
	if (!p) throw new Error("Unsupported provider");
	const audiences = p.audiences();
	if (!audiences.length) throw new Error(`${provider} sign-in is not configured`);
	const decoded = jwt.decode(idToken, { complete: true });
	if (!decoded?.header?.kid) throw new Error("Malformed identity token");
	let jwk = (await keysFor(provider)).find(k => k.kid === decoded.header.kid);
	if (!jwk) {
		delete cache[provider]; // keys rotated
		jwk = (await keysFor(provider)).find(k => k.kid === decoded.header.kid);
	}
	if (!jwk) throw new Error("Unknown signing key");
	const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
	const claims = jwt.verify(idToken, key, { algorithms: ["RS256"], issuer: p.issuers, audience: audiences });
	const emailVerified = claims.email_verified === true || claims.email_verified === "true";
	if (!claims.email) throw new Error("Identity token has no email");
	if (!emailVerified) throw new Error("Email not verified with provider");
	return { email: String(claims.email).toLowerCase(), providerId: String(claims.sub), emailVerified, name: claims.name, picture: claims.picture };
}
