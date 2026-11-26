/**
 * Auto-posting to a creator's OWN connected accounts (see SocialConnection).
 *
 *   Reels   → TikTok, Instagram Reels, YouTube Shorts, Facebook Page Reels
 *   Products→ Facebook Page, Instagram, TikTok (photo post), LinkedIn, X
 *
 * Angelpage's own brand pages are still handled by socialPosting.service.js.
 * Each function returns { platform, success, id?, url? } or throws.
 */

const env = (k) => (process.env[k] || "").trim();
const FB = () => `https://graph.facebook.com/${env("META_GRAPH_VERSION") || "v21.0"}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

async function json(res, label) {
	const text = await res.text();
	let body = {};
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text };
	}
	if (!res.ok || (body.error && body.error.code && body.error.code !== "ok")) {
		const e = body.error || {};
		throw new Error(`${label}: ${e.message || e.error_user_msg || body.detail || body.title || body.message || `HTTP ${res.status}`}`);
	}
	return body;
}

/**
 * Media for TikTok PULL_FROM_URL must come from a domain verified in the
 * TikTok developer portal. When SOCIAL_MEDIA_PROXY_URL is set (our API's
 * /social-connect/media proxy on a verified domain), route through it.
 */
export function publicMediaUrl(url) {
	const proxy = env("SOCIAL_MEDIA_PROXY_URL");
	return proxy && url ? `${proxy}?u=${encodeURIComponent(url)}` : url;
}

async function downloadVideo(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Could not read the video (${res.status}).`);
	const len = Number(res.headers.get("content-length") || 0);
	if (len > MAX_VIDEO_BYTES) throw new Error("Video is too large to cross-post.");
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_VIDEO_BYTES) throw new Error("Video is too large to cross-post.");
	return { buf, type: res.headers.get("content-type") || "video/mp4" };
}

const reelCaption = ({ caption, title, link }) => `${caption || title}\n\n${link}`.trim();
const productCaption = ({ title, price, link }) =>
	Number(price) > 0
		? `${title} · $${Number(price).toFixed(2).replace(/\.00$/, "")} on Angelpage. Up to 90% of the sale goes to charity.\n${link}`
		: `${title} on Angelpage.\n${link}`;

/* ---------------- TikTok ---------------- */

async function tiktokPrivacy(token) {
	const r = await json(
		await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
		}),
		"TikTok",
	);
	const opts = r.data?.privacy_level_options || [];
	// Apps that haven't passed TikTok's audit may only post privately.
	return opts.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : opts[0] || "SELF_ONLY";
}

async function tiktokReel(token, { videoUrl, caption, title, link }) {
	const { buf } = await downloadVideo(videoUrl);
	const privacy = await tiktokPrivacy(token);
	const init = await json(
		await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
			body: JSON.stringify({
				post_info: { title: reelCaption({ caption, title, link }).slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
				source_info: { source: "FILE_UPLOAD", video_size: buf.length, chunk_size: buf.length, total_chunk_count: 1 },
			}),
		}),
		"TikTok",
	);
	const up = await fetch(init.data.upload_url, {
		method: "PUT",
		headers: { "Content-Type": "video/mp4", "Content-Length": String(buf.length), "Content-Range": `bytes 0-${buf.length - 1}/${buf.length}` },
		body: buf,
	});
	if (!up.ok) throw new Error(`TikTok upload failed (${up.status}).`);
	return { platform: "tiktok", success: true, id: init.data.publish_id, privacy };
}

async function tiktokPhoto(token, { title, price, link, imageUrls }) {
	if (!imageUrls?.length) return { platform: "tiktok", skipped: true, reason: "Product needs a photo for TikTok" };
	const privacy = await tiktokPrivacy(token);
	const r = await json(
		await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
			body: JSON.stringify({
				post_info: { title: title.slice(0, 90), description: productCaption({ title, price, link }).slice(0, 4000), privacy_level: privacy, disable_comment: false, auto_add_music: true },
				source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: imageUrls.slice(0, 35).map(publicMediaUrl) },
				post_mode: "DIRECT_POST",
				media_type: "PHOTO",
			}),
		}),
		"TikTok",
	);
	return { platform: "tiktok", success: true, id: r.data?.publish_id, privacy };
}

/* ---------------- Instagram (Instagram API with Instagram Login) ---------------- */

async function igWaitAndPublish(token, igUserId, creationId) {
	for (let i = 0; i < 30; i += 1) {
		const s = await json(await fetch(`https://graph.instagram.com/${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`), "Instagram");
		if (s.status_code === "FINISHED") break;
		if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error("Instagram couldn't process the media.");
		await sleep(5000);
	}
	const p = await json(
		await fetch(`https://graph.instagram.com/${igUserId}/media_publish`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ creation_id: creationId, access_token: token }),
		}),
		"Instagram",
	);
	return p.id;
}

async function instagramReel(token, igUserId, { videoUrl, thumbnailUrl, caption, title, link }) {
	const c = await json(
		await fetch(`https://graph.instagram.com/${igUserId}/media`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ media_type: "REELS", video_url: videoUrl, caption: reelCaption({ caption, title, link }).slice(0, 2200), share_to_feed: "true", ...(thumbnailUrl ? { cover_url: thumbnailUrl } : {}), access_token: token }),
		}),
		"Instagram",
	);
	return { platform: "instagram", success: true, id: await igWaitAndPublish(token, igUserId, c.id) };
}

async function instagramPhoto(token, igUserId, { title, price, link, imageUrls }) {
	if (!imageUrls?.length) return { platform: "instagram", skipped: true, reason: "Product needs a photo for Instagram" };
	const c = await json(
		await fetch(`https://graph.instagram.com/${igUserId}/media`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ image_url: imageUrls[0], caption: productCaption({ title, price, link }).replace(link, "Link in bio").slice(0, 2200), access_token: token }),
		}),
		"Instagram",
	);
	return { platform: "instagram", success: true, id: await igWaitAndPublish(token, igUserId, c.id) };
}

/* ---------------- YouTube Shorts ---------------- */

async function youtubeShort(token, { videoUrl, caption, title, link, tags = [] }) {
	const { buf, type } = await downloadVideo(videoUrl);
	const meta = {
		snippet: {
			title: `${title}`.slice(0, 90).concat(" #Shorts"),
			description: `${caption || title}\n\n${link}\n\n#Shorts #charity`.slice(0, 4900),
			tags: [...tags, "Angelpage", "charity", "Shorts"].slice(0, 15),
			categoryId: "29", // Nonprofits & Activism
		},
		status: { privacyStatus: env("YOUTUBE_PRIVACY") || "public", selfDeclaredMadeForKids: false },
	};
	const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(buf.length), "X-Upload-Content-Type": type },
		body: JSON.stringify(meta),
	});
	if (!start.ok) await json(start, "YouTube");
	const r = await json(await fetch(start.headers.get("location"), { method: "PUT", headers: { "Content-Type": type, "Content-Length": String(buf.length) }, body: buf }), "YouTube");
	return { platform: "youtube", success: true, id: r.id, url: `https://www.youtube.com/shorts/${r.id}` };
}

/* ---------------- Facebook Page ---------------- */

async function facebookReel(token, pageId, { videoUrl, caption, title, link }) {
	const s = await json(
		await fetch(`${FB()}/${pageId}/video_reels`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ upload_phase: "start", access_token: token }),
		}),
		"Facebook",
	);
	const up = await fetch(`https://rupload.facebook.com/video-upload/${env("META_GRAPH_VERSION") || "v21.0"}/${s.video_id}`, {
		method: "POST",
		headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
	});
	if (!up.ok) await json(up, "Facebook upload");
	await json(
		await fetch(`${FB()}/${pageId}/video_reels?${new URLSearchParams({ upload_phase: "finish", video_id: s.video_id, video_state: "PUBLISHED", description: reelCaption({ caption, title, link }).slice(0, 2200), access_token: token })}`, { method: "POST" }),
		"Facebook",
	);
	return { platform: "facebook", success: true, id: s.video_id, url: `https://www.facebook.com/reel/${s.video_id}` };
}

async function facebookPost(token, pageId, { title, price, link }) {
	const r = await json(
		await fetch(`${FB()}/${pageId}/feed`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ message: productCaption({ title, price, link }), link, access_token: token }),
		}),
		"Facebook",
	);
	return { platform: "facebook", success: true, id: r.id };
}

/* ---------------- LinkedIn ---------------- */

async function linkedinPost(token, personId, { title, price, link, description }) {
	const res = await fetch("https://api.linkedin.com/rest/posts", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"LinkedIn-Version": env("LINKEDIN_API_VERSION") || "202501",
			"X-Restli-Protocol-Version": "2.0.0",
		},
		body: JSON.stringify({
			author: `urn:li:person:${personId}`,
			commentary: productCaption({ title, price, link }).replace(/[(){}[\]<>@|~_*#\\]/g, (c) => `\\${c}`),
			visibility: "PUBLIC",
			distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
			content: { article: { source: link, title: title.slice(0, 200), description: (description || "").slice(0, 250) } },
			lifecycleState: "PUBLISHED",
			isReshareDisabledByAuthor: false,
		}),
	});
	if (!res.ok) await json(res, "LinkedIn");
	return { platform: "linkedin", success: true, id: res.headers.get("x-restli-id") || "" };
}

/* ---------------- X ---------------- */

async function xPost(token, { title, price, link }) {
	const text = Number(price) > 0 ? `${title} · $${Number(price).toFixed(2).replace(/\.00$/, "")} on @Angelpage, up to 90% to charity ${link}` : `${title} ${link}`;
	const r = await json(
		await fetch("https://api.x.com/2/tweets", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ text: text.length > 280 ? `${title.slice(0, 280 - link.length - 4)}… ${link}` : text }),
		}),
		"X",
	);
	return { platform: "twitter", success: true, id: r.data?.id, url: r.data?.id ? `https://x.com/i/web/status/${r.data.id}` : undefined };
}

/* ---------------- entry points ---------------- */

/** conn: { provider, accountId }, token: decrypted access token */
export async function publishReel(conn, token, reel) {
	switch (conn.provider) {
		case "tiktok":
			return tiktokReel(token, reel);
		case "instagram":
			return instagramReel(token, conn.accountId, reel);
		case "youtube":
			return youtubeShort(token, reel);
		case "facebook":
			return facebookReel(token, conn.accountId, reel);
		default:
			return { platform: conn.provider, skipped: true, reason: "Reels can't be posted to this platform" };
	}
}

export async function publishProduct(conn, token, product) {
	switch (conn.provider) {
		case "facebook":
			return facebookPost(token, conn.accountId, product);
		case "instagram":
			return instagramPhoto(token, conn.accountId, product);
		case "tiktok":
			return tiktokPhoto(token, product);
		case "linkedin":
			return linkedinPost(token, conn.accountId, product);
		case "twitter":
			return xPost(token, product);
		default:
			return { platform: conn.provider, skipped: true, reason: "Products can't be posted to this platform" };
	}
}
