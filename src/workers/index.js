import { initJobQueue, registerJobHandler } from "../services/jobQueue.service.js";
import { runAffiliateImportJob } from "../api/affiliate/affiliate.controller.js";
import {
	runSocialPostJob,
	runScheduledSocialPostJob,
} from "../api/social/socialPosts.controller.js";
import { runGallerySocialPostJob } from "../api/gallery/gallery.controller.js";
import { runCreatorSocialPostJob } from "../services/creatorSocialPost.service.js";

export async function startWorkers() {
	await initJobQueue();
	registerJobHandler("affiliate-import", runAffiliateImportJob);
	registerJobHandler("social-post", runSocialPostJob);
	registerJobHandler("gallery-social-post", runGallerySocialPostJob);
	registerJobHandler("scheduled-social-post", runScheduledSocialPostJob);
	registerJobHandler("creator-social-post", runCreatorSocialPostJob);
}
