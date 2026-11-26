/**
 * Native push for the iOS app (APNs, token-based auth over HTTP/2).
 *
 * Configure with:
 *   APNS_KEY_ID      Key ID of the .p8 key (Apple Developer → Keys)
 *   APNS_TEAM_ID     Apple Team ID
 *   APNS_BUNDLE_ID   App bundle id, e.g. org.angelpage.app (the apns-topic)
 *   APNS_PRIVATE_KEY Contents of the .p8 file (\n escapes allowed)
 * Without these, sending is skipped silently so the web keeps working.
 * Device environment ("sandbox" for Xcode debug builds, "production" for
 * TestFlight/App Store) is stored per token and picks the APNs host.
 */
import http2 from "node:http2";
import jwt from "jsonwebtoken";
import DeviceToken from "../models/DeviceToken.model";

const HOSTS = {
	production: "https://api.push.apple.com",
	sandbox: "https://api.sandbox.push.apple.com",
};

const cfg = () => ({
	keyId: process.env.APNS_KEY_ID,
	teamId: process.env.APNS_TEAM_ID,
	bundleId: process.env.APNS_BUNDLE_ID,
	key: (process.env.APNS_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
});

export const nativePushConfigured = () => {
	const c = cfg();
	return Boolean(c.keyId && c.teamId && c.bundleId && c.key);
};

let cached = { token: "", at: 0 };
const providerToken = () => {
	// Apple accepts a provider token for up to 60 minutes; refresh at 50.
	if (cached.token && Date.now() - cached.at < 50 * 60 * 1000) return cached.token;
	const c = cfg();
	cached = {
		token: jwt.sign({ iss: c.teamId }, c.key, { algorithm: "ES256", keyid: c.keyId }),
		at: Date.now(),
	};
	return cached.token;
};

const sessions = {};
const sessionFor = env => {
	const s = sessions[env];
	if (s && !s.closed && !s.destroyed) return s;
	const next = http2.connect(HOSTS[env]);
	next.on("error", () => next.destroy());
	next.on("goaway", () => next.close());
	sessions[env] = next;
	return next;
};

const sendOne = (device, body) =>
	new Promise(resolve => {
		const c = cfg();
		const req = sessionFor(device.environment || "production").request({
			":method": "POST",
			":path": `/3/device/${device.token}`,
			authorization: `bearer ${providerToken()}`,
			"apns-topic": c.bundleId,
			"apns-push-type": "alert",
			"apns-priority": "10",
			"content-type": "application/json",
		});
		let status = 0;
		let data = "";
		req.on("response", h => (status = Number(h[":status"])));
		req.on("data", d => (data += d));
		req.on("end", () => resolve({ status, data }));
		req.on("error", () => resolve({ status: 0, data: "" }));
		req.setTimeout(10000, () => {
			req.close();
			resolve({ status: 0, data: "timeout" });
		});
		req.end(JSON.stringify(body));
	});

/**
 * Send an alert to every iOS device of a user. Never throws.
 * @param {string} userId
 * @param {{ title?: string, body: string, data?: Record<string, unknown>, badge?: number }} msg
 */
export async function sendNativePush(userId, msg) {
	if (!userId || !msg?.body || !nativePushConfigured()) return { sent: 0 };
	try {
		const devices = await DeviceToken.find({ userId: String(userId), platform: "ios" }).lean();
		if (!devices.length) return { sent: 0 };
		const payload = {
			aps: {
				alert: { title: msg.title || "Angelpage", body: String(msg.body).slice(0, 240) },
				sound: "default",
				...(typeof msg.badge === "number" ? { badge: msg.badge } : {}),
				"thread-id": msg.data?.type ? String(msg.data.type) : "angelpage",
			},
			...(msg.data || {}),
		};
		let sent = 0;
		for (const d of devices) {
			const r = await sendOne(d, payload);
			if (r.status === 200) sent += 1;
			// 410 Unregistered / 400 BadDeviceToken: the app was deleted or the token rotated
			if (r.status === 410 || (r.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(r.data))) {
				await DeviceToken.deleteOne({ _id: d._id });
			}
		}
		return { sent };
	} catch (e) {
		console.error("[push] send failed:", e?.message || e);
		return { sent: 0 };
	}
}

/** Short title per notification type, shown above the message on the lock screen. */
export const titleForType = type =>
	({
		PRODUCT_SOLD_SUCCESS: "You made a sale",
		NEW_MESSAGE: "New message",
		ORDER_SHIPPED: "Your order is on the way",
		ORDER_DELIVERED: "Delivered",
		PRODUCT_APPROVED: "Listing approved",
		PRODUCT_REJECTED: "Listing needs changes",
		PAYOUT_SENT: "Payout sent",
		EVENT_DONATION: "New donation",
	})[type] || "Angelpage";
