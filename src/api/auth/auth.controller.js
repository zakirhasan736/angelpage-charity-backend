// import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import User from "../../models/User.model";
import Charity from "../../models/Charity.model";
import CharityStaff from "../../models/CharityStaff.model";
import { resolveAdminPermissions } from "../../constants/adminPermissions.js";
import { resolveCharityStaffPermissions } from "../../constants/charityPermissions.js";
import Admin from "../../models/Admin.model";
import LoginActivity from '../../models/LoginActivity.model';
import {
	sendPasswordResetEmail,
	sendVerificationEmail,
	sendWelcomeEmail,
	sendWelcomeBackEmail,
	sendPasswordResetCompletionEmail,
	sendEmail,
} from "../../utils/email";
import { isAdminRole } from "../../constants/adminRoles.js";
import {
	fireMarketingEvent,
	JOURNEY_EVENTS,
} from "../../services/marketingJourneys.service.js";
import { linkGuestOrdersToAccount } from "../../services/guestOrderLink.service.js";
import { JWT_SECRET } from "../../config/jwtSecret.js";
import { verifyIdToken } from "../../services/idTokenVerify.service.js";
import crypto from "crypto";
import { publicAccount } from "../../models/plugins/accountSecurity.js";
import { issueChallenge, sendEmailCode, maskEmail, MFA_SELECT } from "../../services/mfa.service.js";

const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || "30m";
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || "7d";

/** Account model for a token role. */
export const modelForRole = (role) => {
	if (role === "USER") return User;
	if (role === "CHARITY") return Charity;
	if (role === "CHARITY_STAFF") return CharityStaff;
	if (isAdminRole(role)) return Admin;
	return null;
};

const generateAccessToken = (userId, role, extra = {}) =>
	jwt.sign({ userId, role, type: "access", ...extra }, JWT_SECRET, {
		expiresIn: ACCESS_TOKEN_EXPIRY,
	});

const generateRefreshToken = (userId, role, extra = {}) =>
	jwt.sign({ userId, role, type: "refresh", ...extra }, JWT_SECRET, {
		expiresIn: REFRESH_TOKEN_EXPIRY,
	});

// Backwards-compatible alias
const generateToken = generateAccessToken;

/**
 * Tokens + safe user for a successful sign-in. `mfa: true` marks a session
 * that passed two-step (required for admins when ADMIN_MFA_REQUIRED=true).
 * `tv` ties refresh tokens to the account's tokenVersion.
 */
export const issueSession = (user, charityId, { mfa = false } = {}) => {
	const tokenExtra = { ...buildAuthExtras(user, charityId), tv: user.tokenVersion || 0, ...(mfa ? { mfa: true } : {}) };
	const token = generateAccessToken(user._id.toString(), user.role, tokenExtra);
	const refreshToken = generateRefreshToken(user._id.toString(), user.role, tokenExtra);
	return {
		user: {
			...publicAccount(user),
			charityId,
			staffRole: user.staffRole,
			permissions: tokenExtra.permissions || [],
		},
		token,
		refreshToken,
	};
};

/** Password step passed: either a session, or a two-step challenge. */
const finishPasswordStep = async (res, user, charityId, message) => {
	if (user.mfa?.enabled) {
		if (user.mfa.method === "email") {
			const withSecrets = await user.constructor.findById(user._id).select(MFA_SELECT);
			await sendEmailCode(withSecrets, "login");
		}
		return res.status(200).json({
			mfaRequired: true,
			mfaToken: issueChallenge(user, { charityId }),
			method: user.mfa.method,
			emailHint: maskEmail(user.email),
			message: user.mfa.method === "email" ? "We emailed you a 6-digit code." : "Enter the 6-digit code from your authenticator app.",
		});
	}
	return res.status(200).json({ message, ...issueSession(user, charityId) });
};

const buildAuthExtras = (user, charityId) => {
	const extra = {};
	if (charityId) extra.charityId = charityId;
	if (user.role === "CHARITY_STAFF") {
		extra.permissions = resolveCharityStaffPermissions(
			user.staffRole,
			user.permissions,
		);
	} else if (isAdminRole(user.role)) {
		extra.permissions = resolveAdminPermissions(user.role, user.permissions);
	}
	return extra;
};


// Utility to compare passwords
const comparePassword = async (
  password,
  hashedPassword
) => {
  return bcrypt.compare(password, hashedPassword);
};
 
const generateVerificationCode = () => String(crypto.randomInt(100000, 1000000));


// Register User
export const registerUser = async (req, res) => {
  try {
		const { role, firstName, lastName, email, country, ...userData } = req.body;
		const name = `${firstName || ""} ${lastName || ""}`.trim();

		const PUBLIC_ROLES = ["USER", "CHARITY"];
		if (!PUBLIC_ROLES.includes(role)) {
			return res.status(403).json({
				message:
					"Admin accounts cannot be created via public registration. Use the admin team panel or a bootstrap seed.",
			});
		}

		const { isUkCountry } = await import("../../utils/ukValidation.js");
		const { DEFAULT_COUNTRY } = await import("../../constants/platformPolicy.js");
		const accountCountry = country || DEFAULT_COUNTRY;
		if (!isUkCountry(accountCountry)) {
			return res.status(400).json({
				message:
					"Angelpage starts in the United States and also welcomes people in Canada and the United Kingdom.",
			});
		}
        
		const isEmailTaken =
			(await User.findOne({ email })) ||
			(await Charity.findOne({ email })) ||
			(await Admin.findOne({ email }));

		if (isEmailTaken) {
			return res.status(400).json({
				message: `This email is already in use for the ${isEmailTaken.role} role.`,
			});
		}
		let newUser;
		switch (role) {
			case "USER":
				newUser = new User({ ...userData, firstName, lastName, name, email, role, country: accountCountry });
				break;
		case "CHARITY":
				if (!userData.charityNumber) {
					return res.status(400).json({
						message: "Charity registration number is required.",
					});
				}
				newUser = new Charity({ ...userData, firstName, lastName, name, email, role, registrationStatus: "REGISTERED", country: accountCountry });
				break;
			default:
				return res.status(400).json({ message: "Invalid role specified" });
		}

		// Generate a 6-digit verification code
		const verificationCode = generateVerificationCode();
		const verificationExpiry = new Date(Date.now() + 15 * 60 * 1000); // Expire in 15 minutes

		newUser.verificationCode = verificationCode;
		newUser.verificationExpiry = verificationExpiry;
        
		await newUser.save(); 

		if (role === "USER") {
			try {
				await linkGuestOrdersToAccount(newUser._id, email, role);
			} catch (linkErr) {
				console.error("Guest order link on register failed:", linkErr);
			}
		}

		try {
			await sendVerificationEmail({
				email: newUser.email,
				firstName,
				verificationCode,
			});
			await sendWelcomeEmail({
				email: newUser.email,
				firstName: newUser.firstName,
				userId: newUser._id.toString(),
				role: newUser.role,
			});
			fireMarketingEvent(JOURNEY_EVENTS.USER_REGISTERED, {
				email: newUser.email,
				firstName: newUser.firstName,
				role: newUser.role,
				userId: newUser._id.toString(),
			});
		} catch (emailError) {
			console.error("Registration emails failed (account still created):", emailError);
		}

		const token = jwt.sign(
			{ userId: newUser._id, role: newUser.role },
			JWT_SECRET,
			{ expiresIn: "15m" },
		);

		res.status(201).json({
			message: "Registration successful. Please verify your email.",
			user: publicAccount(newUser),
			token,
		});
	} catch (error) {
    console.error("Error during registration:", error);
    res
      .status(500)
      .json({ message: "Registration failed", error: error.message });
  }
};

// Verify Email (Handle Expired Codes by Allowing Resend)
export const verifyEmail = async (req, res) => {
	try {
		const { email, verificationCode } = req.body;
		const sel = "+verificationCode +verificationExpiry +verificationAttempts";
		const user =
			(await User.findOne({ email }).select(sel)) ||
			(await Charity.findOne({ email }).select(sel)) ||
			(await Admin.findOne({ email }).select(sel));

		if (!user) {
			return res.status(400).json({ message: "Invalid verification code." });
		}
		if (user.verified && !user.verificationCode) {
			return res.status(200).json({ message: "Email already verified." });
		}
		if ((user.verificationAttempts || 0) >= 5) {
			return res.status(429).json({ message: "Too many wrong codes. Request a new code." });
		}
		if (!user.verificationExpiry || user.verificationExpiry < new Date()) {
			return res.status(400).json({ message: "Verification code has expired. Please request a new code." });
		}
		const a = Buffer.from(String(user.verificationCode || ""));
		const b = Buffer.from(String(verificationCode || ""));
		if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
			user.verificationAttempts = (user.verificationAttempts || 0) + 1;
			await user.save();
			return res.status(400).json({ message: "Invalid verification code." });
		}

		user.verified = true;
		user.verificationCode = undefined;
		user.verificationExpiry = undefined;
		user.verificationAttempts = 0;
		await user.save();

		sendEmail({
			to: user.email,
			subject: "Email Verification Completed",
			text: `Hello ${user.firstName || ""}, your email verification is complete.`,
		}).catch((e) => console.error("verification-complete email:", e.message));

		res.status(200).json({ message: "Email verified successfully." });
	} catch (error) {
		console.error("Error verifying email:", error.message);
		res.status(400).json({ message: "Error verifying email." });
	}
};

// Resend Verification Code
export const resendVerificationEmail = async (req, res) => {
	try {
		const { email } = req.body;
		const user =
			(await User.findOne({ email })) ||
			(await Charity.findOne({ email })) ||
			(await Admin.findOne({ email }));

		// Same answer whether or not the email exists
		if (user && !user.verified) {
			const verificationCode = generateVerificationCode();
			user.verificationCode = verificationCode;
			user.verificationExpiry = new Date(Date.now() + 15 * 60 * 1000);
			user.verificationAttempts = 0;
			await user.save();
			await sendVerificationEmail({ email: user.email, firstName: user.firstName, verificationCode });
		}
		res.status(200).json({ message: "If that account needs verifying, a new code is on its way." });
	} catch (error) {
		console.error("Error resending verification email:", error.message);
		res.status(500).json({ message: "Failed to resend verification code." });
	}
};
// Login User
export const loginUser = async (req, res) => {
  try {
		const { email, password, role } = req.body;

		// Retrieve the user based on role
		let user;
		let charityId;
		switch (role) {
			case "USER":
				user = await User.findOne({ email });
				break;
			case "CHARITY":
				user = await Charity.findOne({ email });
				if (!user) {
					const staff = await CharityStaff.findOne({
						email,
						active: { $ne: false },
					});
					if (staff) {
						user = staff;
						charityId = staff.parentCharityId?.toString();
					}
				}
				break;
			case "CHARITY_STAFF":
				user = await CharityStaff.findOne({
					email,
					active: { $ne: false },
				});
				if (user) {
					charityId = user.parentCharityId?.toString();
				}
				break;
			case "ADMIN":
				user = await Admin.findOne({ email });
				break;
			default:
				return res.status(400).json({ message: "Invalid role specified" });
		}

		if (!user) {
			return res.status(400).json({ message: "Invalid email or password" });
		}

		if (user.role !== role) {
			if (!(role === "ADMIN" && isAdminRole(user.role))) {
				if (
					!(role === "CHARITY" && user.role === "CHARITY_STAFF") &&
					!(role === "CHARITY_STAFF" && user.role === "CHARITY_STAFF")
				) {
					return res.status(403).json({
						message: `This account is registered as ${user.role}. Please sign in with the correct account type.`,
					});
				}
			}
		}

		// Compare the password using bcrypt (social-only accounts may have none)
		const isMatch = Boolean(password && user.password) && (await comparePassword(String(password), user.password));

		if (!isMatch) {
			return res.status(400).json({ message: "Invalid email or password" });
		}

	    // Record login activity
		await LoginActivity.create({
			userId: user._id,
			role: user.role,
		});

		if (user.role === "USER") {
			try {
				await linkGuestOrdersToAccount(user._id, user.email, user.role);
			} catch (linkErr) {
				console.error("Guest order link on login failed:", linkErr);
			}
		}

		return finishPasswordStep(res, user, charityId, "Login successful");
	} catch (error) {
		console.error("Error during login:", error.message);
		res.status(500).json({ message: "Login failed" });
	}
};


// Send Password Reset Email
export const requestPasswordReset = async (req, res) => {
	const { email, role } = req.body;

	try {
		let user;
		switch (role) {
			case "USER":
				user = await User.findOne({ email });
				break;
			case "CHARITY":
				// Charity owners and their staff share the Charity login.
				user =
					(await Charity.findOne({ email })) ||
					(await CharityStaff.findOne({ email, active: { $ne: false } }));
				break;
			case "ADMIN":
				user = await Admin.findOne({ email });
				break;
			default:
				return res.status(400).json({ message: "Invalid role specified" });
		}

		const GENERIC = { message: "If an account exists for that email and account type, we've sent a reset link." };
		const roleOk =
			user &&
			(user.role === role || (role === "ADMIN" && isAdminRole(user.role)) || (role === "CHARITY" && user.role === "CHARITY_STAFF"));
		// Same answer either way, so the form can't be used to find out who has an account
		if (!roleOk) return res.json(GENERIC);

		// Short-lived reset token, signed with the current password hash so it
		// stops working as soon as the password changes (single use).
		const resetToken = jwt.sign(
			{ userId: user._id, role: user.role },
			resetSecretFor(user),
			{ expiresIn: "10m" },
		);

		await sendPasswordResetEmail({
			email: user.email,
			resetToken,
			firstName: user.firstName,
		});

		res.json({ message: "If an account exists for that email and account type, we've sent a reset link." });
	} catch (error) {
		console.error("Error sending password reset email:", error.response?.body || error.message || error);
		const hint =
			error.message?.includes("Failed to send")
				? " Email could not be sent — check SENDGRID_FROM is a verified sender."
				: "";
		res.status(500).json({ message: `Failed to send password reset email.${hint}` });
	}
};


/** Per-user secret for reset links: invalid once the password hash changes. */
const resetSecretFor = user => `${JWT_SECRET}:${String(user.password || "").slice(-16)}`;

// Reset Password
export const resetPassword = async (req, res) => {
	try {
		const { token, newPassword } = req.body;

		const unverified = jwt.decode(token);
		if (!unverified || typeof unverified !== "object") {
			return res.status(400).json({ message: "Invalid or expired reset token." });
		}
		const { userId, role } = unverified;

		if (!newPassword || String(newPassword).length < 8) {
			return res.status(400).json({ message: "Password must be at least 8 characters." });
		}

		// The token carries the account's own role: sub-admins (OPS_ADMIN etc.)
		// live in the Admin collection and charity staff in CharityStaff.
		let user;
		if (role === "USER") user = await User.findById(userId);
		else if (role === "CHARITY") user = await Charity.findById(userId);
		else if (role === "CHARITY_STAFF") user = await CharityStaff.findById(userId);
		else if (isAdminRole(role)) user = await Admin.findById(userId);
		else return res.status(400).json({ message: "Invalid role specified." });

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		// Throws if expired, tampered with, or already used (password changed).
		jwt.verify(token, resetSecretFor(user));

		// Directly update the password, Mongoose middleware will handle hashing.
		// Bumping tokenVersion signs out every other session.
		user.password = newPassword;
		user.tokenVersion = (user.tokenVersion || 0) + 1;
		await user.save();
		// Send password reset completion email
		await sendPasswordResetCompletionEmail({
			email: user.email,
			firstName: user.firstName,
		});
		res.status(200).json({ message: "Password reset successful." });
	} catch (error) {
		console.error("Error resetting password:", error);
		res.status(400).json({ message: "Invalid or expired reset token." });
	}
};

/** DELETE /auth/delete-account — closes the signed-in user's own account only. */
export const deleteAccount = async (req, res) => {
	try {
		const { userId, role } = req.user;
		if (role === "CHARITY_STAFF") {
			return res.status(403).json({ message: "Staff accounts are removed by the charity owner." });
		}
		if (role === "SUPER_ADMIN") {
			const others = await Admin.countDocuments({ role: "SUPER_ADMIN", _id: { $ne: userId } });
			if (!others) return res.status(400).json({ message: "Add another super admin before closing this account." });
		}
		const Model = modelForRole(role);
		if (!Model) return res.status(400).json({ message: "Invalid role specified" });
		const user = await Model.findByIdAndDelete(userId);
		if (!user) return res.status(404).json({ message: "User not found" });
		res.json({ message: "Account deleted successfully" });
	} catch (error) {
		console.error("Error deleting account:", error.message);
		res.status(500).json({ message: "Failed to delete account" });
	}
};

/** Profile endpoints: only your own profile (admins can look anyone up). */
const canReadProfile = (req, email) => {
	if (!req.user) return false;
	if (isAdminRole(req.user.role)) return true;
	return Boolean(req.user.email && String(req.user.email).toLowerCase() === String(email).toLowerCase());
};

// Fetch User Profile Data
export const fetchUserProfile = async (req, res) => {
	try {
		const { email } = req.params;
		if (req.user && !req.user.email) {
			const me = await modelForRole(req.user.role)?.findById(req.user.userId).select("email");
			req.user.email = me?.email;
		}
		if (!canReadProfile(req, email)) {
			return res.status(403).json({ message: "You can only view your own profile." });
		}

		// Find user by email
		const user =
			(await User.findOne({ email })) ||
			(await Charity.findOne({ email })) ||
			(await Admin.findOne({ email }));

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		// Calculate profile completion percentage
		const fields = [
			"firstName",
			"lastName",
			"email",
			"userName",
			"dateBirth",
			"profileImage",
			"addresses",
			"payments",
		];
		let fieldsCompleted = 0;

		fields.forEach(field => {
			if (Array.isArray(user[field])) {
				if (user[field] && user[field].length > 0) fieldsCompleted++;
			} else {
				if (user[field]) fieldsCompleted++;
			}
		});

		const totalFields = fields.length;
		const profileCompletionPercentage = (fieldsCompleted / totalFields) * 100;
		const profileCompleted = profileCompletionPercentage === 100;

		// Update the profileCompleted property if necessary
		if (user.profileCompleted !== profileCompleted) {
			user.profileCompleted = profileCompleted;
			await user.save();
		}

		// Return user profile data without sensitive information like password or verification codes
		const profileData = publicAccount(user);

		res.status(200).json({
			user: profileData,
			profileCompletionPercentage,
		});
	} catch (error) {
		console.error("Error fetching user data:", error);
		res.status(500).json({ message: "Error fetching user data." });
	}
};
export const fetchCharityProfile = async (req, res) => {
	try {
		const { email } = req.params;
		if (req.user && !req.user.email) {
			const me = await modelForRole(req.user.role)?.findById(req.user.userId).select("email");
			req.user.email = me?.email;
		}
		if (!canReadProfile(req, email)) {
			return res.status(403).json({ message: "You can only view your own profile." });
		}

		// Find user by email
		const user =
			(await User.findOne({ email })) ||
			(await Charity.findOne({ email })) ||
			(await Admin.findOne({ email }));

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		// Calculate profile completion percentage
		const fields = [
			"firstName",
			"lastName",
			"charityName",
			"charityNumber",
			"charityID",
			"email",
			"userName",
			"profileImage",
			"addresses",
			"payments",
		];
		let fieldsCompleted = 0;

		fields.forEach(field => {
			if (Array.isArray(user[field])) {
				if (user[field] && user[field].length > 0) fieldsCompleted++;
			} else {
				if (user[field]) fieldsCompleted++;
			}
		});

		const totalFields = fields.length;
		const profileCompletionPercentage = (fieldsCompleted / totalFields) * 100;
		const profileCompleted = profileCompletionPercentage === 100;

		// Update the profileCompleted property if necessary
		if (user.profileCompleted !== profileCompleted) {
			user.profileCompleted = profileCompleted;
			await user.save();
		}

		// Return user profile data without sensitive information like password or verification codes
		const profileData = publicAccount(user);

		res.status(200).json({
			user: profileData,
			profileCompletionPercentage,
		});
	} catch (error) {
		console.error("Error fetching user data:", error);
		res.status(500).json({ message: "Error fetching user data." });
	}
};

// Endpoint to check if the token is valid
export const checkToken = (req, res) => {
	const authHeader = req.header("Authorization");

	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return res.status(401).json({ message: "Access denied. No token provided." });
	}

	const token = authHeader.replace("Bearer ", "");

	try {
		const decoded = jwt.verify(token, JWT_SECRET);

		if (decoded.type === "refresh") {
			return res.status(401).json({ message: "Access token required." });
		}

		if (Date.now() >= decoded.exp * 1000) {
			return res.status(401).json({ message: "Token has expired." });
		}

		return res.status(200).json({
			valid: true,
			userId: decoded.userId,
			role: decoded.role,
			charityId: decoded.charityId,
		});
	} catch (error) {
		console.error("Token validation error:", error.message);
		return res.status(401).json({ message: "Invalid or expired token." });
	}
};

export const refreshAccessToken = async (req, res) => {
	try {
		const { refreshToken } = req.body;

		if (!refreshToken) {
			return res.status(400).json({ message: "Refresh token is required." });
		}

		const decoded = jwt.verify(refreshToken, JWT_SECRET);

		if (decoded.type !== "refresh") {
			return res.status(401).json({ message: "Invalid refresh token." });
		}

		// Refuse refresh tokens from before a password reset, and for deleted accounts
		const Model = modelForRole(decoded.role);
		const account = Model ? await Model.findById(decoded.userId).select("tokenVersion") : null;
		if (!account || (account.tokenVersion || 0) !== (decoded.tv || 0)) {
			return res.status(401).json({ message: "Session ended. Please sign in again." });
		}

		const tokenExtra = {
			...(decoded.charityId ? { charityId: decoded.charityId } : {}),
			...(decoded.permissions ? { permissions: decoded.permissions } : {}),
			tv: decoded.tv || 0,
			...(decoded.mfa ? { mfa: true } : {}),
		};
		const token = generateAccessToken(
			decoded.userId,
			decoded.role,
			tokenExtra,
		);

		// Keep the same refresh token until it expires to avoid session races
		// that can invalidate the client copy and force an automatic logout.
		return res.status(200).json({
			token,
			refreshToken,
			userId: decoded.userId,
			role: decoded.role,
		});
	} catch (error) {
		console.error("Refresh token error:", error.message);
		return res.status(401).json({ message: "Invalid or expired refresh token." });
	}
};

/**
 * Server-to-server bridge used by the website's NextAuth callback after it
 * has verified Google/Facebook. The email in the body is trusted, so the
 * caller must present OAUTH_BRIDGE_SECRET. Without it this would let anyone
 * sign in as any email address.
 */
export const oauthLogin = async (req, res) => {
	const secret = process.env.OAUTH_BRIDGE_SECRET;
	const internalCall = req.oauthVerified === true;
	if (!internalCall) {
		if (!secret) {
			if (process.env.NODE_ENV === "production") {
				return res.status(503).json({ message: "Social sign-in is not configured (OAUTH_BRIDGE_SECRET)." });
			}
		} else if (req.get("x-angelpage-oauth-secret") !== secret) {
			return res.status(401).json({ message: "Unauthorized." });
		}
	}
	return oauthLoginCore(req, res);
};

/**
 * Native app sign-in: POST /auth/mobile/social { provider: "apple"|"google", idToken, intendedRole, name? }
 * The identity token is verified against Apple/Google keys before signing in.
 */
export const mobileSocialLogin = async (req, res) => {
	const { provider, idToken, intendedRole = "USER", name } = req.body || {};
	if (!["apple", "google"].includes(provider) || typeof idToken !== "string") {
		return res.status(400).json({ message: "provider (apple|google) and idToken are required." });
	}
	try {
		const identity = await verifyIdToken(provider, idToken);
		req.body = {
			email: identity.email,
			// Apple only sends the name on first sign-in, from the app
			name: identity.name || name || "",
			image: identity.picture || "",
			provider,
			providerId: identity.providerId,
			intendedRole: intendedRole === "CHARITY" ? "CHARITY" : "USER",
		};
		req.oauthVerified = true;
		return oauthLoginCore(req, res);
	} catch (e) {
		return res.status(401).json({ message: e?.message || "Could not verify sign-in." });
	}
};

const oauthLoginCore = async (req, res) => {
	try {
		const { email, name, image, provider, providerId, intendedRole = "USER" } =
			req.body;

		if (!email || !provider) {
			return res.status(400).json({ message: "Email and provider are required." });
		}

		let user;
		let charityId;

		if (intendedRole === "CHARITY") {
			user = await Charity.findOne({ email });
			if (!user) {
				const staff = await CharityStaff.findOne({
					email,
					active: { $ne: false },
				});
				if (staff) {
					user = staff;
					charityId = staff.parentCharityId?.toString();
				}
			}
			if (!user) {
				return res.status(404).json({
					message:
						"No charity or staff account found for this email. Register your charity first.",
				});
			}
		} else if (intendedRole === "ADMIN") {
			user = await Admin.findOne({ email });
			if (!user || !isAdminRole(user.role)) {
				return res.status(404).json({
					message: "No admin account found for this email.",
				});
			}
		} else {
			user = await User.findOne({ email });

			if (!user) {
				const nameParts = (name || "Angelpage User").trim().split(" ");
				const firstName = nameParts[0] || "User";
				const lastName = nameParts.slice(1).join(" ") || "Member";
				const randomPassword = crypto.randomBytes(32).toString("base64url");

				user = new User({
					email,
					firstName,
					lastName,
					userName: `${email.split("@")[0]}_${Date.now()}`,
					password: randomPassword,
					role: "USER",
					verified: true,
					profileImage: image || "",
					profileCompleted: false,
				});
				await user.save();
			}
		}

		if (user.role === "USER") {
			try {
				await linkGuestOrdersToAccount(user._id, email, user.role);
			} catch (linkErr) {
				console.error("Guest order link on OAuth failed:", linkErr);
			}
		}

		return finishPasswordStep(res, user, charityId, "OAuth login successful");
	} catch (error) {
		console.error("OAuth login error:", error.message);
		return res.status(500).json({ message: "OAuth login failed." });
	}
};

export const claimGuestOrders = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const role = req.user?.role;

		if (!userId) {
			return res.status(400).json({ message: "User context required." });
		}

		const user = await User.findById(userId).select("email role");
		if (!user?.email) {
			return res.status(404).json({ message: "User not found." });
		}

		const result = await linkGuestOrdersToAccount(
			userId,
			user.email,
			user.role || role,
		);

		return res.status(200).json({
			message:
				result.linked > 0
					? `Linked ${result.linked} guest order(s) to your account.`
					: "No guest orders found for this email.",
			...result,
		});
	} catch (error) {
		console.error("claimGuestOrders:", error);
		return res.status(500).json({ message: "Failed to link guest orders." });
	}
};