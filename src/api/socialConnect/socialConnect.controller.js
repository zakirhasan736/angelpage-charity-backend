import crypto from "crypto";
import SocialConnection from "../../models/SocialConnection.model.js";
import { encryptSecret, decryptSecret } from "../../utils/credentialCrypto.js";
import { resolveCharityId, isCharityAccountRole } from "../../utils/charityAccess.js";
import { isAdminRole } from "../../constants/adminRoles.js";
import Product from "../../models/Product.model";
import {
	PROVIDERS,
	IMPORT_PROVIDERS,
	CAPABILITIES,
	isConfigured,
	authorizeUrl,
	exchangeCode,
	refreshToken,
	listVideos,
} from "../../services/socialVideoProviders.service.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const frontend = () => (process.env.FRONTEND_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

/** Same owner rules as the gallery: charity staff act for their charity, any admin role is ADMIN. */
export const ownerOf = (user) => {
	if (isCharityAccountRole(user.role)) return { ownerId: resolveCharityId(user), ownerRole: "CHARITY" };
	if (isAdminRole(user.role)) return { ownerId: user.userId, ownerRole: "ADMIN" };
	return { ownerId: user.userId, ownerRole: "USER" };
};

const safeReturnTo = (p) => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") ? p.slice(0, 300) : "/");

const withParam = (path, key, value) => `${frontend()}${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

const validProvider = (req, res) => {
	const p = req.params.provider;
	if (!PROVIDERS.includes(p)) {
		res.status(404).json({ message: "Unknown platform." });
		return null;
	}
	return p;
};

/** GET /social-connect — which platforms are set up on the server and which this account has linked. */
export const listConnections = async (req, res) => {
	try {
		const { ownerId, ownerRole } = ownerOf(req.user);
		const rows = await SocialConnection.find({ ownerId, ownerRole }).lean();
		res.json({
			providers: PROVIDERS.map((provider) => {
				const c = rows.find((r) => r.provider === provider);
				return {
					provider,
					capabilities: CAPABILITIES[provider],
					configured: isConfigured(provider),
					connected: Boolean(c),
					accountName: c?.accountName || "",
					accountAvatar: c?.accountAvatar || "",
					connectedAt: c?.createdAt || null,
				};
			}),
		});
	} catch (e) {
		res.status(500).json({ message: "Could not load connected accounts." });
	}
};

/** GET /social-connect/:provider/start?returnTo=/path — returns the platform sign-in URL. */
export const startConnect = async (req, res) => {
	const provider = validProvider(req, res);
	if (!provider) return;
	if (!isConfigured(provider)) {
		return res.status(503).json({ message: `${provider} isn't set up on Angelpage yet. Paste a link instead.` });
	}
	const { ownerId, ownerRole } = ownerOf(req.user);
	const verifier = crypto.randomBytes(32).toString("base64url");
	const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
	// encrypted, so the PKCE verifier and owner never appear in clear in the redirect
	const state = encryptSecret(
		JSON.stringify({
			o: String(ownerId),
			r: ownerRole,
			p: provider,
			v: verifier,
			t: safeReturnTo(req.query.returnTo),
			e: Date.now() + STATE_TTL_MS,
			n: crypto.randomBytes(8).toString("hex"),
		}),
	).replace(/:/g, ".");
	res.json({ url: authorizeUrl(provider, state, challenge) });
};

/** GET /social-connect/:provider/callback — platform redirects here; we store the link and bounce back to the dashboard. */
export const connectCallback = async (req, res) => {
	const provider = PROVIDERS.includes(req.params.provider) ? req.params.provider : null;
	let returnTo = "/";
	try {
		if (!provider) throw new Error("Unknown platform.");
		let st;
		try {
			st = JSON.parse(decryptSecret(String(req.query.state || "").replace(/\./g, ":")));
		} catch {
			throw new Error("That sign-in link has expired. Try connecting again.");
		}
		returnTo = st.t || "/";
		if (st.p !== provider || Date.now() > st.e) throw new Error("That sign-in link has expired. Try connecting again.");
		if (req.query.error) throw new Error(String(req.query.error_description || req.query.error_reason || "You cancelled the sign-in."));
		if (!req.query.code) throw new Error("No authorisation code was returned.");

		const t = await exchangeCode(provider, String(req.query.code).replace(/#_$/, ""), st.v);
		await SocialConnection.findOneAndUpdate(
			{ ownerId: st.o, ownerRole: st.r, provider },
			{
				ownerId: st.o,
				ownerRole: st.r,
				provider,
				accountId: t.accountId,
				accountName: t.accountName,
				accountAvatar: t.accountAvatar,
				accessTokenEncrypted: encryptSecret(t.accessToken),
				...(t.refreshToken ? { refreshTokenEncrypted: encryptSecret(t.refreshToken) } : {}),
				expiresAt: t.expiresIn ? new Date(Date.now() + Number(t.expiresIn) * 1000) : undefined,
				scopes: t.scopes,
				meta: t.meta || {},
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true },
		);
		res.redirect(withParam(returnTo, "connected", provider));
	} catch (e) {
		console.error("social connect callback:", provider, e.message);
		res.redirect(withParam(returnTo, "connect_error", e.message.slice(0, 160)));
	}
};

/** Fresh access token for a connection, refreshing it when it is close to expiry. */
export async function accessTokenFor(owner, provider) {
	const c = await SocialConnection.findOne({ ...owner, provider }).select("+accessTokenEncrypted +refreshTokenEncrypted");
	if (!c) {
		const err = new Error(`Connect your ${provider} account first.`);
		err.status = 400;
		throw err;
	}
	let access = decryptSecret(c.accessTokenEncrypted);
	const soon = c.expiresAt && c.expiresAt.getTime() - Date.now() < 5 * 60 * 1000;
	if (soon) {
		const refresh = decryptSecret(c.refreshTokenEncrypted);
		if (!refresh && provider !== "instagram") {
			const err = new Error(`Your ${provider} connection expired. Connect it again.`);
			err.status = 401;
			throw err;
		}
		const t = await refreshToken(provider, refresh, access);
		access = t.accessToken;
		c.accessTokenEncrypted = encryptSecret(t.accessToken);
		if (t.refreshToken) c.refreshTokenEncrypted = encryptSecret(t.refreshToken);
		if (t.expiresIn) c.expiresAt = new Date(Date.now() + Number(t.expiresIn) * 1000);
		await c.save();
	}
	return access;
}

/** GET /social-connect/:provider/videos?cursor= — the creator's own videos to pick from. */
export const listMyVideos = async (req, res) => {
	const provider = validProvider(req, res);
	if (!provider) return;
	if (!IMPORT_PROVIDERS.includes(provider)) return res.status(400).json({ message: "Videos can't be imported from this platform." });
	try {
		const token = await accessTokenFor(ownerOf(req.user), provider);
		res.json(await listVideos(provider, token, { cursor: req.query.cursor ? String(req.query.cursor) : undefined }));
	} catch (e) {
		res.status(e.status || 502).json({ message: e.message || `Could not load your ${provider} videos.` });
	}
};

/** DELETE /social-connect/:provider */
export const disconnect = async (req, res) => {
	const provider = validProvider(req, res);
	if (!provider) return;
	await SocialConnection.deleteOne({ ...ownerOf(req.user), provider });
	res.json({ success: true });
};

/** GET /social-connect/my-products?q= — listings this account can tag on a reel (admins: any live listing). */
export const listTaggableProducts = async (req, res) => {
	try {
		const { ownerId } = ownerOf(req.user);
		const q = String(req.query.q || "").trim().slice(0, 80);
		const filter = isAdminRole(req.user.role)
			? { status: "LIVE", isArchived: false }
			: { $or: [{ seller: ownerId }, { charity: ownerId }], isArchived: false, status: { $in: ["LIVE", "PENDING_REVIEW", "DRAFT"] } };
		if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
		const items = await Product.find(filter).select("name price images status slug").sort({ createdAt: -1 }).limit(60).lean();
		res.json({
			items: items.map((p) => ({ _id: p._id, name: p.name, price: p.price, status: p.status, slug: p.slug, image: p.images?.[0]?.url || "" })),
		});
	} catch (e) {
		res.status(500).json({ message: "Could not load your listings." });
	}
};

/**
 * GET /social-connect/media?u=<cloudinary url> — public pass-through so TikTok
 * can pull product photos from a domain verified in its developer portal.
 * Only our own Cloudinary assets are served.
 */
export const mediaProxy = async (req, res) => {
	try {
		const u = new URL(String(req.query.u || ""));
		const cloud = (process.env.CLOUDINARY_CLOUD_NAME || "").trim();
		const ok = u.protocol === "https:" && u.hostname === "res.cloudinary.com" && (!cloud || u.pathname.startsWith(`/${cloud}/`));
		if (!ok) return res.status(400).end();
		const r = await fetch(u.toString());
		if (!r.ok) return res.status(r.status).end();
		const type = r.headers.get("content-type") || "";
		if (!/^(image|video)\//.test(type)) return res.status(415).end();
		res.setHeader("Content-Type", type);
		res.setHeader("Cache-Control", "public, max-age=86400");
		res.send(Buffer.from(await r.arrayBuffer()));
	} catch {
		res.status(400).end();
	}
};
