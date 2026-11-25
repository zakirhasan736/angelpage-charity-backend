/**
 * Payments master switch.
 *
 * Angelpage launches with affiliate listings only (buyers check out on the
 * partner site). Card checkout, event donations, shipping labels, Stripe
 * Connect onboarding and payouts are all built but stay OFF until
 * PAYMENTS_ENABLED=true is set. Nothing in Stripe is called while it is off.
 *
 * Market: USA only for now. Stripe Connect accounts are created in US unless
 * STRIPE_CONNECT_COUNTRY overrides it.
 */
export const PAYMENTS_ENABLED = String(process.env.PAYMENTS_ENABLED || "").toLowerCase() === "true";
export const STRIPE_CONNECT_COUNTRY = (process.env.STRIPE_CONNECT_COUNTRY || "US").toUpperCase();
export const PAYMENTS_DISABLED_MESSAGE =
	"Payments aren’t open on Angelpage yet. Affiliate items can still be bought on the partner site.";

/** Express middleware: 503 with a stable code while payments are off. */
export const requirePayments = (req, res, next) => {
	if (PAYMENTS_ENABLED) return next();
	return res.status(503).json({ code: "PAYMENTS_DISABLED", message: PAYMENTS_DISABLED_MESSAGE, paymentsEnabled: false });
};
