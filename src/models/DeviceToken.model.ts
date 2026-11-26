import mongoose, { Schema, Document } from "mongoose";

/** A phone that can receive native push (APNs today, FCM later). */
export interface IDeviceToken extends Document {
	userId: string;
	role: string;
	token: string;
	platform: "ios" | "android";
	environment: "production" | "sandbox";
	appVersion?: string;
	locale?: string;
	lastSeenAt: Date;
}

const deviceTokenSchema = new Schema<IDeviceToken>(
	{
		userId: { type: String, required: true, index: true },
		role: { type: String, required: true },
		token: { type: String, required: true, unique: true },
		platform: { type: String, enum: ["ios", "android"], default: "ios" },
		environment: { type: String, enum: ["production", "sandbox"], default: "production" },
		appVersion: String,
		locale: String,
		lastSeenAt: { type: Date, default: Date.now },
	},
	{ timestamps: true },
);

export default mongoose.model<IDeviceToken>("DeviceToken", deviceTokenSchema);
