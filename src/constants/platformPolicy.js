/** Platform policy constants — align with PRD / stakeholder decisions */

export const ESCROW_HOLD_DAYS = 14;
export const ALLOWED_SHIPPING_COUNTRIES = [
	"United States",
	"USA",
	"US",
	"United States of America",
	"Canada",
	"CA",
	"United Kingdom",
	"UK",
	"Great Britain",
	"GB",
	"England",
	"Scotland",
	"Wales",
	"Northern Ireland",
];
export const DEFAULT_COUNTRY = "United States";
export const TANGIBLE_PRODUCTS_ONLY = true;
export const CHARITY_SHARE_PERCENT = 90;
export const CHARITY_SHARE_RATE = CHARITY_SHARE_PERCENT / 100;
export const PLATFORM_FEE_RATE = 1 - CHARITY_SHARE_RATE;

/**
 * ISO 3166-1 alpha-2 code for a stored country name, limited to the markets
 * Angelpage operates in. Used where Stripe needs a country (Connect accounts).
 */
export const toMarketCountryCode = (country, fallback = "US") => {
	const v = String(country || "").trim().toLowerCase();
	if (!v) return fallback;
	if (["us", "usa", "united states", "united states of america"].includes(v)) return "US";
	if (["ca", "canada"].includes(v)) return "CA";
	if (["gb", "uk", "united kingdom", "great britain", "england", "scotland", "wales", "northern ireland"].includes(v)) return "GB";
	return fallback;
};
