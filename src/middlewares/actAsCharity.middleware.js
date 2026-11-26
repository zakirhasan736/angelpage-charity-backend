/**
 * Charity staff act for their charity on listing routes: a staff member with
 * the Listings permission creates, edits and sees the charity's own products
 * (so they appear on the storefront), never products owned by the staff login.
 * Staff without that permission are refused.
 */
export const actAsCharity = (req, res, next) => {
	const u = req.user;
	if (!u || u.role !== "CHARITY_STAFF") return next();
	if (!u.charityId || !(u.permissions || []).includes("listings")) {
		return res.status(403).json({ message: "Your charity hasn't given you access to listings." });
	}
	req.user = { ...u, staffUserId: u.userId, userId: u.charityId, role: "CHARITY" };
	next();
};
