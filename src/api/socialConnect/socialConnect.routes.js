import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { listConnections, startConnect, connectCallback, listMyVideos, disconnect } from "./socialConnect.controller.js";

/** Link TikTok / Instagram / YouTube to import past videos as reels. Sellers, charities and admins only. */
const router = Router();
const creators = authMiddleware(["USER", "CHARITY", "CHARITY_STAFF", "ADMIN"]);

router.get("/", creators, listConnections);
router.get("/:provider/start", creators, startConnect);
router.get("/:provider/callback", connectCallback); // platform redirect; trusted via encrypted state
router.get("/:provider/videos", creators, listMyVideos);
router.delete("/:provider", creators, disconnect);

export default router;
