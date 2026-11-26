/**
 * Cross-posts a creator's content to their OWN connected accounts:
 *   - a published, uploaded reel → TikTok, Instagram Reels, YouTube Shorts, Facebook Reels
 *   - a live product            → Facebook, Instagram, TikTok, LinkedIn, X
 * Runs as the "creator-social-post" job. Each platform is logged in SocialPostLog.
 */
import GalleryItem from "../models/GalleryItem.model.js";
import Product from "../models/Product.model";
import SocialConnection from "../models/SocialConnection.model.js";
import SocialPostLog from "../models/SocialPostLog.model.js";
import { CAPABILITIES } from "./socialVideoProviders.service.js";
import { publishReel, publishProduct } from "./socialPublish.service.js";
import { accessTokenFor } from "../api/socialConnect/socialConnect.controller.js";

const site = () => (process.env.FRONTEND_BASE_URL || "https://www.angelpage.com").replace(/\/$/, "");

export const REEL_TARGETS = ["tiktok", "instagram", "youtube", "facebook"];
export const PRODUCT_TARGETS = ["facebook", "instagram", "tiktok", "linkedin", "twitter"];

/** Normalise the per-item "post to my accounts" choices. Missing keys default to on. */
export function parseCrossPost(raw, targets) {
	let o = raw;
	if (typeof raw === "string") {
		try {
			o = JSON.parse(raw);
		} catch {
			o = {};
		}
	}
	o = o && typeof o === "object" ? o : {};
	return Object.fromEntries(targets.map((t) => [t, o[t] !== false && o[t] !== "false"]));
}

async function run({ owners, targets, cap, wanted, publish, log }) {
	const conns = await SocialConnection.find({ $or: owners }).lean();
	const results = [];
	for (const provider of targets) {
		if (!wanted[provider] || !CAPABILITIES[provider]?.[cap]) continue;
		const conn = conns.find((c) => c.provider === provider);
		if (!conn) continue; // not linked: nothing to do
		// retries must never double-post
		const { trigger: _t, ...same } = log;
		if (await SocialPostLog.exists({ ...same, platform: provider, target: "creator", status: "success" })) continue;
		const entry = await SocialPostLog.create({ ...log, ownerId: conn.ownerId, platform: provider, status: "pending", target: "creator", attempts: 1 });
		try {
			const token = await accessTokenFor({ ownerId: conn.ownerId, ownerRole: conn.ownerRole }, provider);
			const r = await publish(conn, token);
			entry.status = r.skipped ? "skipped" : "success";
			entry.response = r;
			entry.error = r.reason || "";
		} catch (e) {
			entry.status = "failed";
			entry.error = String(e.message || e).slice(0, 500);
		}
		await entry.save();
		results.push(entry);
	}
	return results;
}

export async function runCreatorSocialPostJob({ kind, id, trigger = "auto" }) {
	if (kind === "reel") {
		const item = await GalleryItem.findById(id);
		if (!item || item.status !== "published") return { skipped: true, reason: "Not published" };
		const isUpload = (item.media?.source || "upload") === "upload";
		const isVideo = ["reel", "video"].includes(item.media?.mediaType);
		if (!isUpload || !isVideo) return { skipped: true, reason: "Only uploaded videos can be cross-posted" };
		const link = item.productId ? `${site()}/product/${item.productId}` : `${site()}/reels?item=${item.slug}`;
		return run({
			owners: [{ ownerId: item.authorId, ownerRole: item.authorRole }],
			targets: REEL_TARGETS,
			cap: "postReels",
			wanted: parseCrossPost(item.crossPost, REEL_TARGETS),
			log: { galleryItemId: item._id, contentType: "gallery_item", trigger },
			publish: (conn, token) =>
				publishReel(conn, token, { videoUrl: item.media.url, thumbnailUrl: item.media.thumbnailUrl, title: item.title, caption: item.caption, link, tags: item.tags }),
		});
	}

	if (kind === "product") {
		const p = await Product.findById(id);
		if (!p || p.status !== "LIVE" || p.isArchived) return { skipped: true, reason: "Not live" };
		if (p.checkoutMode === "affiliate_redirect" || p.checkoutMode === "ebay_redirect") return { skipped: true, reason: "Affiliate listing" };
		// products store the creating account in `seller` (users and charities alike)
		const owners = [p.seller, p.charity].filter(Boolean).map((ownerId) => ({ ownerId, ownerRole: { $in: ["USER", "CHARITY"] } }));
		if (!owners.length) return { skipped: true, reason: "No owner" };
		const link = `${site()}/product/${p.slug || p._id}`;
		return run({
			owners,
			targets: PRODUCT_TARGETS,
			cap: "postProducts",
			wanted: parseCrossPost(p.crossPost, PRODUCT_TARGETS),
			log: { productId: p._id, contentType: "product", trigger },
			publish: (conn, token) =>
				publishProduct(conn, token, { title: p.name, price: p.price, link, description: p.description, imageUrls: (p.images || []).map((i) => i.url).filter(Boolean) }),
		});
	}
	throw new Error(`Unknown kind ${kind}`);
}

export async function queueCreatorSocialPost(kind, id, trigger = "auto") {
	const { enqueueJob } = await import("./jobQueue.service.js");
	await enqueueJob("creator-social-post", { kind, id: String(id), trigger });
}
