/**
 * TikTok, Instagram and YouTube: OAuth sign-in, listing a creator's own
 * videos, and resolving a pasted link. Imported videos are embedded with the
 * platform's own player (never downloaded or re-hosted), which keeps us
 * inside each platform's terms.
 *
 * Env (each provider is optional; unset = "not configured" in the UI):
 *   API_PUBLIC_URL            public base of this API incl. /api, e.g. https://api.angelpage.com/api
 *   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET           (Login Kit, scopes user.info.basic,video.list)
 *   INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET            (Instagram API with Instagram Login, instagram_business_basic)
 *   GOOGLE_YOUTUBE_CLIENT_ID, GOOGLE_YOUTUBE_CLIENT_SECRET  (falls back to GOOGLE_CLIENT_ID/SECRET; scope youtube.readonly)
 *   FACEBOOK_APP_ID + FACEBOOK_CLIENT_TOKEN           (optional: Instagram link previews via oEmbed)
 */

const env = (k) => (process.env[k] || "").trim();
const ytId = () => env("GOOGLE_YOUTUBE_CLIENT_ID") || env("GOOGLE_CLIENT_ID");
const ytSecret = () => env("GOOGLE_YOUTUBE_CLIENT_SECRET") || env("GOOGLE_CLIENT_SECRET");

export const PROVIDERS = ["tiktok", "instagram", "youtube"];

export const callbackUrl = (provider) =>
	`${env("API_PUBLIC_URL").replace(/\/$/, "")}/social-connect/${provider}/callback`;

export function isConfigured(provider) {
	if (!env("API_PUBLIC_URL")) return false;
	if (provider === "tiktok") return Boolean(env("TIKTOK_CLIENT_KEY") && env("TIKTOK_CLIENT_SECRET"));
	if (provider === "instagram") return Boolean(env("INSTAGRAM_APP_ID") && env("INSTAGRAM_APP_SECRET"));
	if (provider === "youtube") return Boolean(ytId() && ytSecret());
	return false;
}

async function json(res) {
	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text };
	}
	if (!res.ok) {
		const msg = body?.error?.message || body?.error_description || body?.error?.code || body?.message || `HTTP ${res.status}`;
		throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
	}
	return body;
}

const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null));

/* ---------------- authorize URLs ---------------- */

export function authorizeUrl(provider, state, codeChallenge) {
	const redirect = callbackUrl(provider);
	if (provider === "tiktok") {
		const q = form({
			client_key: env("TIKTOK_CLIENT_KEY"),
			response_type: "code",
			scope: "user.info.basic,video.list",
			redirect_uri: redirect,
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
	}
	if (provider === "instagram") {
		const q = form({
			client_id: env("INSTAGRAM_APP_ID"),
			redirect_uri: redirect,
			response_type: "code",
			scope: "instagram_business_basic",
			state,
		});
		return `https://www.instagram.com/oauth/authorize?${q}`;
	}
	const q = form({
		client_id: ytId(),
		redirect_uri: redirect,
		response_type: "code",
		scope: "https://www.googleapis.com/auth/youtube.readonly",
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: "true",
		state,
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/* ---------------- code exchange ---------------- */

/** Returns { accessToken, refreshToken?, expiresIn?, accountId, accountName, accountAvatar, scopes } */
export async function exchangeCode(provider, code, codeVerifier) {
	const redirect = callbackUrl(provider);

	if (provider === "tiktok") {
		const t = await json(
			await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form({
					client_key: env("TIKTOK_CLIENT_KEY"),
					client_secret: env("TIKTOK_CLIENT_SECRET"),
					code,
					grant_type: "authorization_code",
					redirect_uri: redirect,
					code_verifier: codeVerifier,
				}),
			}),
		);
		if (t.error) throw new Error(t.error_description || t.error);
		const u = await json(
			await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
				headers: { Authorization: `Bearer ${t.access_token}` },
			}),
		);
		const user = u?.data?.user || {};
		return {
			accessToken: t.access_token,
			refreshToken: t.refresh_token,
			expiresIn: t.expires_in,
			accountId: user.open_id || t.open_id || "",
			accountName: user.display_name || "TikTok account",
			accountAvatar: user.avatar_url || "",
			scopes: String(t.scope || "").split(","),
		};
	}

	if (provider === "instagram") {
		const short = await json(
			await fetch("https://api.instagram.com/oauth/access_token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form({
					client_id: env("INSTAGRAM_APP_ID"),
					client_secret: env("INSTAGRAM_APP_SECRET"),
					grant_type: "authorization_code",
					redirect_uri: redirect,
					code,
				}),
			}),
		);
		// swap for a 60-day token
		const long = await json(
			await fetch(
				`https://graph.instagram.com/access_token?${form({
					grant_type: "ig_exchange_token",
					client_secret: env("INSTAGRAM_APP_SECRET"),
					access_token: short.access_token,
				})}`,
			),
		);
		const me = await json(
			await fetch(`https://graph.instagram.com/me?fields=user_id,username,profile_picture_url&access_token=${encodeURIComponent(long.access_token)}`),
		);
		return {
			accessToken: long.access_token,
			expiresIn: long.expires_in,
			accountId: String(me.user_id || short.user_id || ""),
			accountName: me.username ? `@${me.username}` : "Instagram account",
			accountAvatar: me.profile_picture_url || "",
			scopes: ["instagram_business_basic"],
		};
	}

	const t = await json(
		await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form({
				client_id: ytId(),
				client_secret: ytSecret(),
				code,
				grant_type: "authorization_code",
				redirect_uri: redirect,
			}),
		}),
	);
	const ch = await json(
		await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
			headers: { Authorization: `Bearer ${t.access_token}` },
		}),
	);
	const c = ch.items?.[0];
	if (!c) throw new Error("This Google account has no YouTube channel.");
	return {
		accessToken: t.access_token,
		refreshToken: t.refresh_token,
		expiresIn: t.expires_in,
		accountId: c.id,
		accountName: c.snippet?.title || "YouTube channel",
		accountAvatar: c.snippet?.thumbnails?.default?.url || "",
		scopes: String(t.scope || "").split(" "),
	};
}

/* ---------------- refresh ---------------- */

export async function refreshToken(provider, refresh, access) {
	if (provider === "tiktok") {
		const t = await json(
			await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form({
					client_key: env("TIKTOK_CLIENT_KEY"),
					client_secret: env("TIKTOK_CLIENT_SECRET"),
					grant_type: "refresh_token",
					refresh_token: refresh,
				}),
			}),
		);
		return { accessToken: t.access_token, refreshToken: t.refresh_token || refresh, expiresIn: t.expires_in };
	}
	if (provider === "instagram") {
		const t = await json(
			await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(access)}`),
		);
		return { accessToken: t.access_token, expiresIn: t.expires_in };
	}
	const t = await json(
		await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form({ client_id: ytId(), client_secret: ytSecret(), grant_type: "refresh_token", refresh_token: refresh }),
		}),
	);
	return { accessToken: t.access_token, refreshToken: refresh, expiresIn: t.expires_in };
}

/* ---------------- listing a creator's videos ---------------- */

/** Normalised: { id, title, caption, thumbnailUrl, permalink, embedUrl, durationSec, publishedAt } */
export async function listVideos(provider, accessToken, { cursor } = {}) {
	if (provider === "tiktok") {
		const r = await json(
			await fetch(
				"https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,embed_link,duration,create_time",
				{
					method: "POST",
					headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
					body: JSON.stringify({ max_count: 20, ...(cursor ? { cursor: Number(cursor) } : {}) }),
				},
			),
		);
		const d = r.data || {};
		return {
			items: (d.videos || []).map((v) => ({
				id: v.id,
				title: v.title || (v.video_description || "").slice(0, 80),
				caption: v.video_description || "",
				thumbnailUrl: v.cover_image_url || "",
				permalink: v.share_url || "",
				embedUrl: `https://www.tiktok.com/player/v1/${v.id}`,
				durationSec: v.duration,
				publishedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : undefined,
			})),
			nextCursor: d.has_more ? String(d.cursor) : null,
		};
	}

	if (provider === "instagram") {
		const url = cursor
			? cursor
			: `https://graph.instagram.com/me/media?fields=id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp&limit=25&access_token=${encodeURIComponent(accessToken)}`;
		if (cursor && !String(cursor).startsWith("https://graph.instagram.com/")) throw new Error("Bad cursor.");
		const r = await json(await fetch(url));
		return {
			items: (r.data || [])
				.filter((m) => m.media_type === "VIDEO")
				.map((m) => ({
					id: m.id,
					title: (m.caption || "").split("\n")[0].slice(0, 80) || (m.media_product_type === "REELS" ? "Instagram reel" : "Instagram video"),
					caption: m.caption || "",
					thumbnailUrl: m.thumbnail_url || "",
					permalink: m.permalink || "",
					embedUrl: m.permalink ? `${m.permalink.replace(/\/$/, "")}/embed` : "",
					publishedAt: m.timestamp,
				})),
			nextCursor: r.paging?.next || null,
		};
	}

	const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
	const ch = await json(await fetch("https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true", auth));
	const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
	if (!uploads) return { items: [], nextCursor: null };
	const r = await json(
		await fetch(
			`https://www.googleapis.com/youtube/v3/playlistItems?${form({ part: "snippet,contentDetails", playlistId: uploads, maxResults: "25", pageToken: cursor })}`,
			auth,
		),
	);
	return {
		items: (r.items || []).map((i) => {
			const id = i.contentDetails?.videoId || i.snippet?.resourceId?.videoId;
			const th = i.snippet?.thumbnails || {};
			return {
				id,
				title: i.snippet?.title || "YouTube video",
				caption: i.snippet?.description || "",
				thumbnailUrl: (th.maxres || th.high || th.medium || th.default || {}).url || "",
				permalink: `https://www.youtube.com/shorts/${id}`,
				embedUrl: `https://www.youtube.com/embed/${id}`,
				publishedAt: i.contentDetails?.videoPublishedAt || i.snippet?.publishedAt,
			};
		}),
		nextCursor: r.nextPageToken || null,
	};
}

/* ---------------- pasted links ---------------- */

export function detectProvider(rawUrl) {
	let u;
	try {
		u = new URL(String(rawUrl).trim());
	} catch {
		return null;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return null;
	const host = u.hostname.replace(/^www\.|^m\./, "");
	if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
	if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
	if (host === "instagram.com" || host === "instagr.am") return "instagram";
	return null;
}

function youtubeId(u) {
	if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0];
	const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{6,})/);
	return m ? m[2] : u.searchParams.get("v");
}

/** Resolve a public link to embed details, via each platform's oEmbed. */
export async function resolveLink(rawUrl) {
	const provider = detectProvider(rawUrl);
	if (!provider) throw new Error("Paste a TikTok, Instagram or YouTube link.");
	const u = new URL(String(rawUrl).trim());

	if (provider === "youtube") {
		const id = youtubeId(u);
		if (!id || !/^[\w-]{6,20}$/.test(id)) throw new Error("That YouTube link has no video in it.");
		const canonical = `https://www.youtube.com/watch?v=${id}`;
		let o = {};
		try {
			o = await json(await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonical)}`));
		} catch {
			throw new Error("That YouTube video is private or unavailable.");
		}
		return {
			provider,
			externalId: id,
			title: o.title || "YouTube video",
			authorName: o.author_name || "",
			thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
			permalink: u.pathname.includes("/shorts/") ? `https://www.youtube.com/shorts/${id}` : canonical,
			embedUrl: `https://www.youtube.com/embed/${id}`,
		};
	}

	if (provider === "tiktok") {
		let o;
		try {
			o = await json(await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(u.toString())}`));
		} catch {
			throw new Error("That TikTok video is private or unavailable.");
		}
		const id = o.embed_product_id || (u.pathname.match(/\/video\/(\d+)/) || [])[1];
		if (!id) throw new Error("Use the full TikTok video link (tiktok.com/@name/video/…).");
		return {
			provider,
			externalId: String(id),
			title: (o.title || "TikTok video").slice(0, 120),
			authorName: o.author_name || "",
			thumbnailUrl: o.thumbnail_url || "",
			permalink: `https://www.tiktok.com/@${o.author_unique_id || "_"}/video/${id}`,
			embedUrl: `https://www.tiktok.com/player/v1/${id}`,
		};
	}

	const m = u.pathname.match(/\/(reel|reels|p|tv)\/([\w-]+)/);
	if (!m) throw new Error("Use the link to a single Instagram reel or post.");
	const permalink = `https://www.instagram.com/${m[1] === "reels" ? "reel" : m[1]}/${m[2]}/`;
	let o = {};
	if (env("FACEBOOK_APP_ID") && env("FACEBOOK_CLIENT_TOKEN")) {
		try {
			o = await json(
				await fetch(
					`https://graph.facebook.com/v21.0/instagram_oembed?${form({ url: permalink, access_token: `${env("FACEBOOK_APP_ID")}|${env("FACEBOOK_CLIENT_TOKEN")}` })}`,
				),
			);
		} catch {
			/* preview is optional */
		}
	}
	return {
		provider,
		externalId: m[2],
		title: "Instagram reel",
		authorName: o.author_name || "",
		thumbnailUrl: o.thumbnail_url || "",
		permalink,
		embedUrl: `${permalink}embed`,
	};
}
