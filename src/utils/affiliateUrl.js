/**
 * Outbound partner URL for an affiliate product (eBay, Amazon, other feeds),
 * or null for products that check out on Angelpage.
 * eBay items without a stored link fall back to ebay.com with our campaign.
 */
export const affiliateOutUrl = product => {
	if (!product) return null;
	const stored = product.affiliateUrl || product.ebayAffiliateUrl;
	if (stored && /^https?:\/\//i.test(stored)) return stored;
	if (product.ebayItemId) {
		const camp = process.env.EBAY_CAMPAIGN_ID ? `?campid=${process.env.EBAY_CAMPAIGN_ID}&customid=angelpage` : "";
		return `https://www.ebay.com/itm/${product.ebayItemId}${camp}`;
	}
	return null;
};

export const isAffiliateProduct = product =>
	Boolean(product) && (product.checkoutMode === "ebay_redirect" || product.checkoutMode === "affiliate_redirect") && Boolean(affiliateOutUrl(product));
