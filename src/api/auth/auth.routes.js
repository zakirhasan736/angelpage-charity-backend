import { Router } from "express";
import {
	registerUser,
	loginUser,
	requestPasswordReset,
	resetPassword,
	deleteAccount,
	verifyEmail,
	fetchUserProfile,
	resendVerificationEmail,
	fetchCharityProfile,
	checkToken,
	refreshAccessToken,
	oauthLogin,
	mobileSocialLogin,
	claimGuestOrders,
} from "./auth.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
	verifyChallenge,
	resendChallengeEmail,
	getMfaStatus,
	startTotpSetup,
	confirmTotpSetup,
	sendManageEmailCode,
	confirmEmailSetup,
	disableMfa,
	regenerateRecoveryCodes,
	revokeOtherSessions,
} from "./mfa.controller.js";


import { verifyCaptcha } from "../../middlewares/captcha.middleware.js";
import { validateRegister } from "../../middlewares/validation.middleware";

const router = Router();

// Public routes
router.post("/register", verifyCaptcha, validateRegister, registerUser);
router.post("/verify-email", verifyEmail);
router.post("/resend-verify-email", resendVerificationEmail);
// own profile only (admins: anyone)
router.get("/profile/:email", authMiddleware(), fetchUserProfile);
router.get("/charity-profile/:email", authMiddleware(), fetchCharityProfile);
router.post("/login", verifyCaptcha, loginUser);
router.post("/request-password-reset", verifyCaptcha, requestPasswordReset);
router.post("/reset-password", resetPassword); 
router.get("/check-token", checkToken);
router.post("/refresh", refreshAccessToken);
router.post("/oauth", oauthLogin);

// Two-step sign-in: finish a sign-in that returned { mfaRequired, mfaToken }
router.post("/mfa/verify", verifyChallenge);
router.post("/mfa/resend", resendChallengeEmail);
// Two-step settings (any signed-in account: user, charity, staff, admin)
router.get("/mfa", authMiddleware(), getMfaStatus);
router.post("/mfa/totp/setup", authMiddleware(), startTotpSetup);
router.post("/mfa/totp/enable", authMiddleware(), confirmTotpSetup);
router.post("/mfa/email/send", authMiddleware(), sendManageEmailCode);
router.post("/mfa/email/enable", authMiddleware(), confirmEmailSetup);
router.post("/mfa/disable", authMiddleware(), disableMfa);
router.post("/mfa/recovery-codes", authMiddleware(), regenerateRecoveryCodes);
router.post("/sessions/revoke", authMiddleware(), revokeOtherSessions);
// iOS app: Sign in with Apple / Google (identity token verified server-side)
router.post("/mobile/social", mobileSocialLogin);
router.post("/claim-guest-orders", authMiddleware(), claimGuestOrders);
// Protected route
router.delete("/delete-account", authMiddleware(), deleteAccount); // Authenticated users can delete their account

export default router;
