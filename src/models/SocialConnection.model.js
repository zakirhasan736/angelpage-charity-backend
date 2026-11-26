import mongoose from "mongoose";

/**
 * A creator's linked TikTok / Instagram / YouTube account, used only to list
 * their own past videos so they can import them as Angelpage reels.
 * Tokens are stored encrypted (utils/credentialCrypto) and never returned.
 */
const socialConnectionSchema = new mongoose.Schema(
	{
		ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
		ownerRole: { type: String, enum: ["USER", "CHARITY", "ADMIN"], required: true },
		provider: { type: String, enum: ["tiktok", "instagram", "youtube"], required: true },
		accountId: { type: String, default: "" },
		accountName: { type: String, default: "" },
		accountAvatar: { type: String, default: "" },
		accessTokenEncrypted: { type: String, select: false },
		refreshTokenEncrypted: { type: String, select: false },
		expiresAt: { type: Date },
		scopes: [{ type: String }],
	},
	{ timestamps: true },
);

socialConnectionSchema.index({ ownerId: 1, ownerRole: 1, provider: 1 }, { unique: true });

export default mongoose.model("SocialConnection", socialConnectionSchema);
