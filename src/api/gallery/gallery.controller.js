import fs from "fs";
import GalleryItem from "../../models/GalleryItem.model.js";
import Product from "../../models/Product.model";
import User from "../../models/User.model";
import Charity from "../../models/Charity.model";
import Admin from "../../models/Admin.model";
import cloudinary from "../../config/cloudinary";
import { isAdminRole } from "../../constants/adminRoles.js";
import { resolveCharityId, isCharityAccountRole } from "../../utils/charityAccess.js";
import { parseSocialPostingInput } from "../../services/socialPosting.service.js";
import {
	runGallerySocialPostJob,
	queueGallerySocialPost,
} from "../../services/gallerySocial.service.js";
import { enqueueJob } from "../../services/jobQueue.service.js";
import { resolveLink, listVideos, IMPORT_PROVIDERS } from "../../services/socialVideoProviders.service.js";
import { accessTokenFor, ownerOf } from "../socialConnect/socialConnect.controller.js";
import { queueCreatorSocialPost, parseCrossPost, REEL_TARGETS } from "../../services/creatorSocialPost.service.js";
import mongoose from "mongoose";

/** A product the poster is allowed to tag: their own listing (admins: any live listing). */
const assertTaggableProduct = async (productId, req, owner) => {
	if (!productId) return undefined;
	if (!mongoose.isValidObjectId(productId)) {
		const e = new Error("That product wasn't found.");
		e.status = 400;
		throw e;
	}
	const p = await Product.findById(productId).select("seller charity status");
	const mine = p && [p.seller, p.charity].some((x) => x && String(x) === String(owner.ownerId));
	if (!p || (!mine && !isAdminRole(req.user.role))) {
		const e = new Error("You can only tag your own listings.");
		e.status = 403;
		throw e;
	}
	return p._id;
};

const slugify = (text) =>
	text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_-]+/g, "-")
		.replace(/^-+|-+$/g, "");

const getAuthorProfile = async (authorId, authorRole) => {
	switch (authorRole) {
		case "USER":
			return User.findById(authorId).select("firstName lastName profileImage");
		case "CHARITY":
			return Charity.findById(authorId).select(
				"charityName profileImage firstName lastName",
			);
		case "ADMIN":
			return Admin.findById(authorId).select("firstName lastName profileImage");
		default:
			return null;
	}
};

const authorDisplayName = (profile, role) => {
	if (!profile) return "Angelpage";
	if (role === "CHARITY") return profile.charityName || profile.firstName || "Charity";
	return `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || "Creator";
};

const parseKind = (kind, mimeType) => {
	if (kind === "reel" || kind === "document" || kind === "photo") return kind;
	if (mimeType?.startsWith("video/")) return "reel";
	if (mimeType === "application/pdf") return "document";
	return "photo";
};

const uploadMedia = async (file, kindHint) => {
	const isVideo =
		file.mimetype?.startsWith("video/") || kindHint === "reel";
	const folder = isVideo ? "gallery/reels" : "gallery/images";

	const options = isVideo
		? {
				folder,
				resource_type: "video",
				eager: [{ width: 640, height: 360, crop: "fill", format: "jpg" }],
			}
		: { folder };

	const result = await cloudinary.uploader.upload(file.path, options);
	const thumbnailUrl =
		isVideo && result.eager?.[0]?.secure_url
			? result.eager[0].secure_url
			: result.secure_url;

	return {
		url: result.secure_url,
		publicId: result.public_id,
		mediaType: isVideo ? "reel" : kindHint === "document" ? "document" : "image",
		mimeType: file.mimetype,
		thumbnailUrl,
		durationSec: result.duration || undefined,
	};
};

const cleanupFile = (file) => {
	if (file?.path) {
		fs.unlink(file.path, () => {});
	}
};

const parseTags = (raw) => {
	if (!raw) return [];
	if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
		} catch {
			/* comma-separated fallback */
		}
		return raw
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);
	}
	return [];
};

export const getPublishedGallery = async (req, res) => {
	try {
		const { kind, tag, charityId, limit = 24, page = 1 } = req.query;
		const query = { status: "published" };
		if (kind) query.kind = kind;
		if (charityId) query.charityId = charityId;
		if (tag) query.tags = tag;

		const items = await GalleryItem.find(query)
			.sort({ publishedAt: -1, createdAt: -1 })
			.limit(Number(limit))
			.skip((Number(page) - 1) * Number(limit))
			.lean();

		const productIds = [
			...new Set(items.map((item) => String(item.productId || "")).filter(Boolean)),
		];
		const charityIds = [
			...new Set(items.map((item) => String(item.charityId || "")).filter(Boolean)),
		];

		const [products, charities] = await Promise.all([
			productIds.length
				? Product.find({ _id: { $in: productIds } }).select("_id slug").lean()
				: [],
			charityIds.length
				? Charity.find({ _id: { $in: charityIds } })
						.select("_id charityName profileImage")
						.lean()
				: [],
		]);

		const slugById = new Map(
			products.map((product) => [String(product._id), product.slug]),
		);
		const charityById = new Map(
			charities.map((charity) => [String(charity._id), charity]),
		);

		const enriched = items.map((item) => {
			const charity = item.charityId
				? charityById.get(String(item.charityId))
				: null;
			return {
				...item,
				productSlug: item.productId
					? slugById.get(String(item.productId)) || null
					: null,
				charityName: charity?.charityName || null,
				charityProfileImage: charity?.profileImage || null,
			};
		});

		const total = await GalleryItem.countDocuments(query);
		res.json({ items: enriched, total, page: Number(page) });
	} catch (error) {
		res.status(500).json({ message: "Failed to fetch gallery." });
	}
};

export const getGalleryBySlug = async (req, res) => {
	try {
		const item = await GalleryItem.findOne({
			slug: req.params.slug,
			status: "published",
		});
		if (!item) return res.status(404).json({ message: "Not found." });
		item.viewCount += 1;
		await item.save();
		res.json({ item });
	} catch (error) {
		res.status(500).json({ message: "Failed to fetch item." });
	}
};

export const getMyGallery = async (req, res) => {
	try {
		const { userId, role } = req.user;
		const authorId = isCharityAccountRole(role)
			? resolveCharityId(req.user)
			: userId;
		const authorRole = isCharityAccountRole(role) ? "CHARITY" : role;

		const items = await GalleryItem.find({ authorId, authorRole }).sort({
			updatedAt: -1,
		});
		res.json({ items });
	} catch (error) {
		res.status(500).json({ message: "Failed to fetch your gallery." });
	}
};

export const getAdminGallery = async (req, res) => {
	try {
		const { status } = req.query;
		const query = status ? { status } : {};
		const items = await GalleryItem.find(query).sort({ updatedAt: -1 });
		res.json({ items });
	} catch (error) {
		res.status(500).json({ message: "Failed to fetch gallery queue." });
	}
};

export const createGalleryItem = async (req, res) => {
	try {
		const { userId, role } = req.user;
		const { title, caption, kind, tags, productId, socialPosting, crossPost, publishNow } =
			req.body;

		if (!title?.trim()) {
			return res.status(400).json({ message: "Title is required." });
		}
		if (!req.file?.path) {
			return res.status(400).json({ message: "Media file is required." });
		}

		const authorId = isCharityAccountRole(role)
			? resolveCharityId(req.user)
			: userId;
		const authorRole = isCharityAccountRole(role) ? "CHARITY" : role;
		const profile = await getAuthorProfile(authorId, authorRole);

		const media = await uploadMedia(req.file, kind);
		cleanupFile(req.file);

		let slug = slugify(title);
		if (await GalleryItem.findOne({ slug })) {
			slug = `${slug}-${Date.now()}`;
		}

		const parsedKind = parseKind(kind, req.file.mimetype);
		let status = "pending_review";
		if (isAdminRole(role)) {
			status =
				publishNow === "true" || publishNow === true ? "published" : "pending_review";
		}

		const item = await GalleryItem.create({
			title: title.trim(),
			slug,
			caption: caption || "",
			media,
			kind: parsedKind,
			tags: parseTags(tags),
			productId: await assertTaggableProduct(productId, req, { ownerId: authorId }),
			charityId: authorRole === "CHARITY" ? authorId : undefined,
			authorId,
			authorRole,
			authorName: authorDisplayName(profile, authorRole),
			authorAvatar: profile?.profileImage || "",
			status,
			publishedAt: status === "published" ? new Date() : undefined,
			socialPosting: {
				...parseSocialPostingInput(socialPosting),
				autoPostOnPublish: true,
				twitter: false,
			},
			crossPost: parseCrossPost(crossPost, REEL_TARGETS),
		});

		if (status === "published" && item.socialPosting?.autoPostOnPublish) {
			await queueGallerySocialPost(item, isAdminRole(role) ? "admin" : "auto");
		}
		if (status === "published") {
			queueCreatorSocialPost("reel", item._id).catch((e) => console.error("creator reel queue:", e.message));
		}

		res.status(201).json({ message: "Gallery item saved.", item });
	} catch (error) {
		cleanupFile(req.file);
		console.error("createGalleryItem:", error);
		res.status(error.status || 500).json({ message: error.message || "Failed to create gallery item." });
	}
};

export const publishGalleryItem = async (req, res) => {
	try {
		const item = await GalleryItem.findById(req.params.id);
		if (!item) return res.status(404).json({ message: "Not found." });

		item.status = "published";
		item.publishedAt = new Date();
		await item.save();

		if (item.socialPosting?.autoPostOnPublish !== false) {
			await queueGallerySocialPost(item, "admin");
		}
		queueCreatorSocialPost("reel", item._id, "admin").catch((e) => console.error("creator reel queue:", e.message));

		res.json({ message: "Published.", item });
	} catch (error) {
		res.status(500).json({ message: "Failed to publish." });
	}
};

export const shareGalleryItem = async (req, res) => {
	try {
		const item = await GalleryItem.findById(req.params.id);
		if (!item) return res.status(404).json({ message: "Not found." });

		const ownerId = isCharityAccountRole(req.user.role)
			? resolveCharityId(req.user)
			: req.user.userId;
		const isOwner = item.authorId.toString() === ownerId?.toString();
		if (!isOwner && !isAdminRole(req.user.role)) {
			return res.status(403).json({ message: "Not authorized." });
		}

		const { platforms } = req.body;
		await enqueueJob("gallery-social-post", {
			galleryItemId: item._id.toString(),
			platforms,
			trigger: "manual",
			ownerId: req.user.userId,
		});

		res.json({ success: true, message: "Share queued to social platforms." });
	} catch (error) {
		res.status(400).json({ message: error.message });
	}
};

export const deleteGalleryItem = async (req, res) => {
	try {
		const item = await GalleryItem.findById(req.params.id);
		if (!item) return res.status(404).json({ message: "Not found." });

		const ownerId = isCharityAccountRole(req.user.role)
			? resolveCharityId(req.user)
			: req.user.userId;
		const isOwner = item.authorId.toString() === ownerId?.toString();
		if (!isOwner && !isAdminRole(req.user.role)) {
			return res.status(403).json({ message: "Not authorized." });
		}

		await item.deleteOne();
		res.json({ message: "Deleted." });
	} catch (error) {
		res.status(500).json({ message: "Failed to delete." });
	}
};

/** Copy a platform thumbnail to Cloudinary (TikTok/Instagram thumbnail URLs expire). */
const persistThumbnail = async (url) => {
	if (!url) return "";
	try {
		const r = await cloudinary.uploader.upload(url, { folder: "gallery/thumbnails" });
		return r.secure_url;
	} catch {
		return url;
	}
};

/**
 * POST /gallery/import
 * Body: { url } for a pasted link, or { provider, videoIds: [] } for videos picked
 * from a connected account; plus optional title, caption, tags, publishNow.
 * Videos are embedded with the platform player; nothing is downloaded.
 */
export const importGalleryItems = async (req, res) => {
	try {
		const { role } = req.user;
		const { url, provider, videoIds, title, caption, tags, publishNow, productId, productIds } = req.body || {};
		const owner = ownerOf(req.user);
		const authorId = owner.ownerId;
		const authorRole = owner.ownerRole;
		const profile = await getAuthorProfile(authorId, authorRole);

		let picked = [];
		if (url) {
			const r = await resolveLink(url);
			picked = [{ ...r, caption: "" }];
		} else if (provider && Array.isArray(videoIds) && videoIds.length) {
			if (!IMPORT_PROVIDERS.includes(provider)) return res.status(400).json({ message: "Videos can't be imported from this platform." });
			const wanted = new Set(videoIds.map(String).slice(0, 20));
			const token = await accessTokenFor(owner, provider);
			// only videos that really belong to the connected account
			let cursor;
			for (let page = 0; page < 6 && wanted.size > picked.length; page += 1) {
				const r = await listVideos(provider, token, { cursor });
				r.items.filter((v) => wanted.has(String(v.id))).forEach((v) =>
					picked.push({ provider, externalId: String(v.id), title: v.title, caption: v.caption, thumbnailUrl: v.thumbnailUrl, permalink: v.permalink, embedUrl: v.embedUrl, durationSec: v.durationSec }),
				);
				if (!r.nextCursor) break;
				cursor = r.nextCursor;
			}
			if (!picked.length) return res.status(404).json({ message: "Those videos weren't found on your account." });
		} else {
			return res.status(400).json({ message: "Paste a link or pick videos to import." });
		}

		// product tags: one for all, or per video { [videoId]: productId }
		const tagFor = {};
		for (const v of picked) {
			const pid = (productIds && typeof productIds === "object" && productIds[v.externalId]) || productId;
			tagFor[v.externalId] = await assertTaggableProduct(pid, req, owner);
		}

		const status = isAdminRole(role) && (publishNow === true || publishNow === "true") ? "published" : "pending_review";
		const created = [];
		const skipped = [];
		for (const v of picked) {
			const exists = await GalleryItem.findOne({ authorId, "media.source": v.provider, "media.externalId": v.externalId }).select("_id");
			if (exists) {
				skipped.push(v.externalId);
				continue;
			}
			const itemTitle = (picked.length === 1 && title?.trim()) || v.title || "Community story";
			let slug = slugify(itemTitle) || "story";
			if (await GalleryItem.findOne({ slug })) slug = `${slug}-${Date.now().toString(36)}`;
			const item = await GalleryItem.create({
				title: itemTitle.slice(0, 140),
				slug,
				caption: (picked.length === 1 && caption) || v.caption || "",
				media: {
					url: v.permalink || v.embedUrl,
					mediaType: "reel",
					thumbnailUrl: await persistThumbnail(v.thumbnailUrl),
					durationSec: v.durationSec,
					source: v.provider,
					externalId: v.externalId,
					embedUrl: v.embedUrl,
					permalink: v.permalink,
				},
				kind: "reel",
				productId: tagFor[v.externalId],
				tags: parseTags(tags).length ? parseTags(tags) : [tagFor[v.externalId] ? "product" : "impact"],
				charityId: authorRole === "CHARITY" ? authorId : undefined,
				authorId,
				authorRole,
				authorName: authorDisplayName(profile, authorRole),
				authorAvatar: profile?.profileImage || "",
				status,
				publishedAt: status === "published" ? new Date() : undefined,
				// already on the platform, so no cross-posting back out
				socialPosting: { facebook: false, instagram: false, tiktok: false, twitter: false, autoPostOnPublish: false },
				crossPost: { tiktok: false, instagram: false, youtube: false, facebook: false },
			});
			created.push(item);
		}

		res.status(created.length ? 201 : 200).json({
			message: created.length
				? `${created.length} video${created.length === 1 ? "" : "s"} ${status === "published" ? "published" : "sent for review"}.`
				: "Already imported.",
			items: created,
			skipped,
		});
	} catch (error) {
		console.error("importGalleryItems:", error.message);
		res.status(error.status || 400).json({ message: error.message || "Import failed." });
	}
};

export { runGallerySocialPostJob };
