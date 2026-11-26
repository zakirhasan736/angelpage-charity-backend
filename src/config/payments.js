/**
 * Payments master switch.
 *
 * ON by default: card checkout, event donations, shipping labels, Stripe
 * Connect onboarding and payouts all work as normal. Set PAYMENTS_ENABLED=false
 * only to pause every money-moving route at once (they answer 503).
 * Affiliate items (eBay, Amazon) never use these routes — buyers go straight
 * to the partner site.
 *
 * Market: USA only for now. Stripe Connect accounts are created in US unless
 * STRIPE_CONNECT_COUNTRY overrides it.
 */
export const PAYMENTS_ENABLED = String(process.env.PAYMENTS_ENABLED ?? "true").toLowerCase() !== "false";
export const STRIPE_CONNECT_COUNTRY = (process.env.STRIPE_CONNECT_COUNTRY || "US").toUpperCase();
export const PAYMENTS_DISABLED_MESSAGE =
	"Payments are paused on Angelpage right now. Affiliate items can still be bought on the partner site.";

/** Express middleware: 503 with a stable code while payments are off. */
export const requirePayments = (req, res, next) => {
	if (PAYMENTS_ENABLED) return next();
	return res.status(503).json({ code: "PAYMENTS_DISABLED", message: PAYMENTS_DISABLED_MESSAGE, paymentsEnabled: false });
};
