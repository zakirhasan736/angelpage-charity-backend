import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { listConnections, startConnect, connectCallback, listMyVideos, disconnect, listTaggableProducts, mediaProxy } from "./socialConnect.controller.js";

/** Link TikTok, Instagram, YouTube, Facebook, LinkedIn, X: import past reels and auto-post. Sellers, charities and admins only. */
const router = Router();
const creators = authMiddleware(["USER", "CHARITY", "CHARITY_STAFF", "ADMIN"]);

router.get("/", creators, listConnections);
router.get("/my-products", creators, listTaggableProducts);
router.get("/media", mediaProxy); // public, Cloudinary-only (TikTok PULL_FROM_URL)
router.get("/:provider/start", creators, startConnect);
router.get("/:provider/callback", connectCallback); // platform redirect; trusted via encrypted state
router.get("/:provider/videos", creators, listMyVideos);
router.delete("/:provider", creators, disconnect);

export default router;
