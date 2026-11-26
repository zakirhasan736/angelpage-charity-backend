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
 *   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET              (Facebook Login for Pages: import Page reels, post to the Page)
 *   FACEBOOK_CLIENT_TOKEN                             (optional: Instagram link previews via oEmbed)
 *   LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET        (Sign In with LinkedIn + Share on LinkedIn: w_member_social)
 *   X_CLIENT_ID, X_CLIENT_SECRET                      (X OAuth 2.0, tweet.write)
 */

const env = (k) => (process.env[k] || "").trim();
const ytId = () => env("GOOGLE_YOUTUBE_CLIENT_ID") || env("GOOGLE_CLIENT_ID");
const ytSecret = () => env("GOOGLE_YOUTUBE_CLIENT_SECRET") || env("GOOGLE_CLIENT_SECRET");

const FB_VERSION = () => env("META_GRAPH_VERSION") || "v21.0";

/** Every platform a creator can link. */
export const PROVIDERS = ["tiktok", "instagram", "youtube", "facebook", "linkedin", "twitter"];
/** Platforms we can pull existing short videos from. */
export const IMPORT_PROVIDERS = ["tiktok", "instagram", "youtube", "facebook"];
/** What each platform is used for once linked. */
export const CAPABILITIES = {
	tiktok: { importReels: true, postReels: true, postProducts: true },
	instagram: { importReels: true, postReels: true, postProducts: true },
	youtube: { importReels: true, postReels: true, postProducts: false },
	facebook: { importReels: true, postReels: true, postProducts: true },
	linkedin: { importReels: false, postReels: false, postProducts: true },
	twitter: { importReels: false, postReels: false, postProducts: true },
};

export const callbackUrl = (provider) =>
	`${env("API_PUBLIC_URL").replace(/\/$/, "")}/social-connect/${provider}/callback`;

export function isConfigured(provider) {
	if (!env("API_PUBLIC_URL")) return false;
	if (provider === "tiktok") return Boolean(env("TIKTOK_CLIENT_KEY") && env("TIKTOK_CLIENT_SECRET"));
	if (provider === "instagram") return Boolean(env("INSTAGRAM_APP_ID") && env("INSTAGRAM_APP_SECRET"));
	if (provider === "youtube") return Boolean(ytId() && ytSecret());
	if (provider === "facebook") return Boolean(env("FACEBOOK_APP_ID") && env("FACEBOOK_APP_SECRET"));
	if (provider === "linkedin") return Boolean(env("LINKEDIN_CLIENT_ID") && env("LINKEDIN_CLIENT_SECRET"));
	if (provider === "twitter") return Boolean(env("X_CLIENT_ID") && env("X_CLIENT_SECRET"));
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
			scope: "user.info.basic,video.list,video.publish",
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
			scope: "instagram_business_basic,instagram_business_content_publish",
			state,
		});
		return `https://www.instagram.com/oauth/authorize?${q}`;
	}
	if (provider === "facebook") {
		const q = form({
			client_id: env("FACEBOOK_APP_ID"),
			redirect_uri: redirect,
			state,
			response_type: "code",
			scope: "pages_show_list,pages_read_engagement,pages_manage_posts,business_management",
		});
		return `https://www.facebook.com/${FB_VERSION()}/dialog/oauth?${q}`;
	}
	if (provider === "linkedin") {
		const q = form({
			response_type: "code",
			client_id: env("LINKEDIN_CLIENT_ID"),
			redirect_uri: redirect,
			state,
			scope: "openid profile w_member_social",
		});
		return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
	}
	if (provider === "twitter") {
		const q = form({
			response_type: "code",
			client_id: env("X_CLIENT_ID"),
			redirect_uri: redirect,
			scope: "tweet.read tweet.write users.read offline.access",
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		return `https://x.com/i/oauth2/authorize?${q}`;
	}
	const q = form({
		client_id: ytId(),
		redirect_uri: redirect,
		response_type: "code",
		scope: "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload",
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
			scopes: ["instagram_business_basic", "instagram_business_content_publish"],
		};
	}

	if (provider === "facebook") {
		const g = `https://graph.facebook.com/${FB_VERSION()}`;
		const short = await json(
			await fetch(`${g}/oauth/access_token?${form({ client_id: env("FACEBOOK_APP_ID"), client_secret: env("FACEBOOK_APP_SECRET"), redirect_uri: redirect, code })}`),
		);
		const long = await json(
			await fetch(`${g}/oauth/access_token?${form({ grant_type: "fb_exchange_token", client_id: env("FACEBOOK_APP_ID"), client_secret: env("FACEBOOK_APP_SECRET"), fb_exchange_token: short.access_token })}`),
		);
		// Page tokens derived from a long-lived user token don't expire.
		const pages = await json(await fetch(`${g}/me/accounts?fields=id,name,access_token,picture{url}&limit=50&access_token=${encodeURIComponent(long.access_token)}`));
		const page = pages.data?.[0];
		if (!page) throw new Error("Pick at least one Facebook Page when connecting. Reels and posts go to a Page.");
		return {
			accessToken: page.access_token,
			accountId: page.id,
			accountName: page.name,
			accountAvatar: page.picture?.data?.url || "",
			scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
			meta: { pages: (pages.data || []).map((p) => ({ id: p.id, name: p.name })) },
		};
	}

	if (provider === "linkedin") {
		const t = await json(
			await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: env("LINKEDIN_CLIENT_ID"), client_secret: env("LINKEDIN_CLIENT_SECRET") }),
			}),
		);
		const me = await json(await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } }));
		return {
			accessToken: t.access_token,
			refreshToken: t.refresh_token,
			expiresIn: t.expires_in,
			accountId: me.sub,
			accountName: me.name || "LinkedIn profile",
			accountAvatar: me.picture || "",
			scopes: String(t.scope || "").split(/[ ,]/),
		};
	}

	if (provider === "twitter") {
		const basic = Buffer.from(`${env("X_CLIENT_ID")}:${env("X_CLIENT_SECRET")}`).toString("base64");
		const t = await json(
			await fetch("https://api.x.com/2/oauth2/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
				body: form({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: codeVerifier }),
			}),
		);
		const me = await json(await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url", { headers: { Authorization: `Bearer ${t.access_token}` } }));
		return {
			accessToken: t.access_token,
			refreshToken: t.refresh_token,
			expiresIn: t.expires_in,
			accountId: me.data?.id || "",
			accountName: me.data?.username ? `@${me.data.username}` : "X account",
			accountAvatar: me.data?.profile_image_url || "",
			scopes: String(t.scope || "").split(" "),
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
	if (provider === "twitter") {
		const basic = Buffer.from(`${env("X_CLIENT_ID")}:${env("X_CLIENT_SECRET")}`).toString("base64");
		const t = await json(
			await fetch("https://api.x.com/2/oauth2/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
				body: form({ grant_type: "refresh_token", refresh_token: refresh }),
			}),
		);
		return { accessToken: t.access_token, refreshToken: t.refresh_token || refresh, expiresIn: t.expires_in };
	}
	if (provider === "linkedin") {
		if (!refresh) throw new Error("Your LinkedIn connection expired. Connect it again.");
		const t = await json(
			await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form({ grant_type: "refresh_token", refresh_token: refresh, client_id: env("LINKEDIN_CLIENT_ID"), client_secret: env("LINKEDIN_CLIENT_SECRET") }),
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

	if (provider === "facebook") {
		const g = `https://graph.facebook.com/${FB_VERSION()}`;
		const url = cursor || `${g}/me/video_reels?fields=id,description,picture,permalink_url,length,created_time&limit=25&access_token=${encodeURIComponent(accessToken)}`;
		if (cursor && !String(cursor).startsWith("https://graph.facebook.com/")) throw new Error("Bad cursor.");
		const r = await json(await fetch(url));
		return {
			items: (r.data || []).map((v) => {
				const permalink = v.permalink_url ? (v.permalink_url.startsWith("http") ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`) : `https://www.facebook.com/reel/${v.id}`;
				return {
					id: v.id,
					title: (v.description || "").split("\n")[0].slice(0, 80) || "Facebook reel",
					caption: v.description || "",
					thumbnailUrl: v.picture || "",
					permalink,
					embedUrl: fbEmbed(permalink),
					durationSec: v.length,
					publishedAt: v.created_time,
				};
			}),
			nextCursor: r.paging?.next || null,
		};
	}
	if (provider !== "youtube") throw new Error("This platform doesn't support importing videos.");

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
	if (host === "facebook.com" || host === "fb.watch" || host.endsWith(".facebook.com")) return "facebook";
	return null;
}

export const fbEmbed = (permalink) =>
	`https://www.facebook.com/plugins/video.php?${new URLSearchParams({ href: permalink, show_text: "false", width: "476" })}`;

function youtubeId(u) {
	if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0];
	const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{6,})/);
	return m ? m[2] : u.searchParams.get("v");
}

/** Resolve a public link to embed details, via each platform's oEmbed. */
export async function resolveLink(rawUrl) {
	const provider = detectProvider(rawUrl);
	if (!provider) throw new Error("Paste a TikTok, Instagram, Facebook or YouTube link.");
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

	if (provider === "facebook") {
		const id = (u.pathname.match(/\/(?:reel|videos)\/(\d+)/) || [])[1] || u.searchParams.get("v") || (u.hostname === "fb.watch" ? u.pathname.slice(1).replace(/\/$/, "") : "");
		if (!id) throw new Error("Use the link to a single Facebook reel or video.");
		const permalink = u.hostname === "fb.watch" ? u.toString() : /^\d+$/.test(id) ? `https://www.facebook.com/reel/${id}` : u.toString();
		return { provider, externalId: id, title: "Facebook reel", authorName: "", thumbnailUrl: "", permalink, embedUrl: fbEmbed(permalink) };
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
